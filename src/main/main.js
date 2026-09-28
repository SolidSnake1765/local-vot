// Главный процесс: окно, вход в Яндекс, очередь заданий перевода.
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as auth from "./auth.js";
import { loadSettings, saveSettings } from "./config.js";
import * as disk from "./yadisk.js";
import { existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { describeMix, origAudio, origAudioPath, runJob, STEPS, translationCacheDir } from "./pipeline.js";
import { renderPreview } from "./media.js";
import { LIVELY_LANG, SOURCE_LANGS } from "./languages.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// всё, что читает встроенный ffmpeg; тот же список показывает интерфейс
const VIDEO_EXT = ["mp4", "mkv", "mov", "avi", "webm", "m4v", "wmv", "flv", "ts",
  "mpg", "mpeg", "m2ts", "mts", "3gp", "vob", "ogv"];

let win = null;
const send = (channel, payload) => win?.webContents.send(channel, payload);

// ---------- очередь: задания выполняются по одному ----------
// job: { id, file, name, state, controller, lively, lang, diskPath, duration, voiceUsed, langUsed, outputs, replace }
// outputs — файлы, сохранённые для этого видео; replace — новая версия заменяет их (прежние — в Корзину)
// diskPath — закрытая копия на Диске: держим, пока видео в списке, чтобы переводить заново без загрузки
const jobs = new Map();
const queue = [];
let running = false;
let currentRun = null; // промис текущего задания — при выходе ждём, пока оно закроет ссылку

function publicJob(j) {
  return { id: j.id, file: j.file, name: j.name, state: j.state, lively: j.lively, lang: j.lang,
    voiceUsed: j.voiceUsed, langUsed: j.langUsed };
}

function enqueue(job, mode = "translate", replace = false) {
  job.controller = new AbortController();
  job.mode = mode;
  job.replace = replace;
  job.state = "queued";
  queue.push(job);
  send("job:update", { id: job.id, state: "queued", reset: true });
  queueMicrotask(pump);
}

async function pump() {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  running = true;
  job.state = "running";
  send("job:update", { id: job.id, state: "running" });
  try {
    const token = await auth.getToken();
    if (!token) throw new Error("Войдите в Яндекс, чтобы переводить видео");
    currentRun = runJob(job, { getOptions: loadSettings, token, mode: job.mode },
      (patch) => send("job:update", { id: job.id, ...patch }), job.controller.signal);
    const { outputs, lively, lang } = await currentRun;
    const { files, stuck } = await replaceOutputs(job.replace ? (job.outputs ?? []) : [], outputs);
    job.outputs = [...(job.replace ? [] : job.outputs ?? []), ...files];
    job.state = "done";
    job.voiceUsed = lively;
    job.langUsed = lang;
    send("job:update", { id: job.id, state: "done", outputs: job.outputs, voiceUsed: lively, langUsed: lang,
      hasTranslation: true, preview: previewInfo(job),
      note: stuck ? `Прежнюю версию убрать не удалось (файлов: ${stuck}) — возможно, она открыта в плеере. Новая сохранена рядом.` : "" });
  } catch (e) {
    job.state = job.controller.signal.aborted ? "cancelled" : "error";
    send("job:update", { id: job.id, state: job.state, error: job.state === "error" ? e.message : "",
      hasTranslation: Boolean(job.translation), preview: previewInfo(job) });
  } finally {
    job.mode = "translate";
    running = false;
    currentRun = null;
    pump();
  }
}

const isVideo = (file) => VIDEO_EXT.includes(path.extname(file).slice(1).toLowerCase());
// наши же результаты: «имя [RU].mkv», «имя [RU живые] (2).mkv» — их переводить не надо
const isOurOutput = (file) => /\[RU[^\]]*\]( \(\d+\))?$/.test(path.parse(file).name);

/** Перевод этого видео уже лежит рядом с ним или в папке сохранения (любой из наших файлов). */
function alreadyTranslated(file, outputDir) {
  const { dir, name } = path.parse(file);
  const names = [];
  for (const tag of ["RU", "RU живые"]) {
    names.push(...VIDEO_EXT.map((e) => `${name} [${tag}].${e}`), `${name} [${tag}].m4a`, `${name} [${tag}, голос].mp3`);
  }
  names.push(`${name} [RU].srt`);
  return [dir, outputDir].filter(Boolean).some((d) => names.some((n) => existsSync(path.join(d, n))));
}

/** Все видео папки, включая вложенные, по порядку имён. */
function videosInFolder(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isFile() && isVideo(e.name))
    .map((e) => path.join(e.parentPath, e.name))
    .sort((a, b) => a.localeCompare(b, "ru", { numeric: true }));
}

/**
 * Новая версия сохранена — прежние файлы того же вида (видео любого формата, .m4a, .mp3, .srt) уходят
 * в Корзину, а новые занимают их имена: «имя [RU] (2).mkv» → «имя [RU].mkv». Других видов не трогаем.
 * Возвращает итоговый список файлов видео и сколько прежних убрать не удалось (открыты в плеере).
 */
async function replaceOutputs(old, fresh) {
  const ext = (p) => path.extname(p).toLowerCase();
  const base = (p) => path.join(path.dirname(p), path.parse(p).name.replace(/ \(\d+\)$/, "")).toLowerCase();
  // видео — один вид, в каком бы формате ни было: был .mkv, стал .mp4 — прежний .mkv тоже заменяется
  const kind = (p) => (VIDEO_EXT.includes(ext(p).slice(1)) ? "video" : ext(p));
  const kinds = new Set(fresh.map(kind));
  const files = [...fresh];
  const kept = [];
  let stuck = 0;
  for (const p of old) {
    if (!existsSync(p)) continue;
    if (!kinds.has(kind(p))) {
      kept.push(p);
      continue;
    }
    try {
      await shell.trashItem(p);
    } catch {
      kept.push(p);
      stuck++;
      continue;
    }
    const i = files.findIndex((n) => ext(n) === ext(p) && base(n) === base(p));
    if (i < 0) continue;
    try {
      renameSync(files[i], p);
      files[i] = p;
    } catch { /* остаётся с номером — не страшно */ }
  }
  return { files: [...kept, ...files], stuck };
}

/**
 * Добавляет в очередь файлы и папки. Из папок берём только то, что ещё не переведено; видео,
 * которые уже есть в списке, не дублируем. Возвращает добавленные задания и пояснение, что пропущено.
 */
function addJobs(paths) {
  const settings = loadSettings();
  const { livelyVoice: lively, sourceLang } = settings;
  const lang = lively ? LIVELY_LANG : sourceLang;
  const inList = new Set([...jobs.values()].map((j) => path.resolve(j.file).toLowerCase()));
  const skipped = { inList: 0, translated: 0, outputs: 0 };
  let foldersEmpty = 0;
  const rejected = []; // отдельные файлы, которые не видео (в папках прочие файлы просто не берём)
  const files = [];
  for (const p of paths) {
    let isDir = false;
    try { isDir = statSync(p).isDirectory(); } catch { rejected.push(p); continue; }
    if (!isDir) {
      if (isVideo(p)) files.push(p);
      else rejected.push(p);
      continue;
    }
    const found = videosInFolder(p);
    if (!found.length) foldersEmpty++;
    for (const file of found) {
      if (isOurOutput(file)) skipped.outputs++;
      else if (alreadyTranslated(file, settings.outputDir)) skipped.translated++;
      else files.push(file);
    }
  }
  const added = [];
  for (const file of files) {
    const key = path.resolve(file).toLowerCase();
    if (inList.has(key)) {
      skipped.inList++;
      continue;
    }
    inList.add(key);
    const job = { id: randomUUID(), file, name: path.basename(file), state: "queued", controller: new AbortController(),
      lively, lang, diskPath: null, duration: null, voiceUsed: null, langUsed: null };
    jobs.set(job.id, job);
    queue.push(job);
    added.push(publicJob(job));
  }
  queueMicrotask(pump);
  const note = [];
  if (skipped.translated) note.push(`уже переведены: ${skipped.translated}`);
  if (skipped.inList) note.push(`уже в списке: ${skipped.inList}`);
  if (skipped.outputs) note.push(`наши готовые файлы: ${skipped.outputs}`);
  let text = note.length ? `Добавлено видео: ${added.length}. Пропущено — ${note.join(", ")}.` : "";
  if (foldersEmpty && !added.length && !note.length) text = "В папке нет видео.";
  let error = "";
  if (rejected.length) {
    const names = rejected.slice(0, 3).map((p) => `«${path.basename(p)}»`).join(", ")
      + (rejected.length > 3 ? ` и ещё ${rejected.length - 3}` : "");
    error = `Не подходит: ${names} — это не видео или такой формат не поддерживается.`
      + ` Подходят: ${VIDEO_EXT.map((e) => e.toUpperCase()).join(", ")}.`;
    if (added.length) error = `Добавлено видео: ${added.length}. ${error}`;
  }
  return { added, note: text, error };
}

// ---------- предпрослушивание ----------
const PREVIEW_SECONDS = 20;
const previewControllers = new Map(); // id → AbortController текущей сборки куска

/** Что нужно интерфейсу для ползунка: длительность и где начинается первая фраза перевода. */
function previewInfo(job) {
  if (!job.translation?.analysis) return null;
  const first = job.translation.analysis.segments[0]?.[0] ?? 0;
  return { duration: job.duration, start: Math.max(0, first - 1), length: PREVIEW_SECONDS };
}

// кусок звука с текущими настройками; повторный запрос для того же видео отменяет предыдущий
ipcMain.handle("jobs:preview", async (_e, id, start) => {
  const job = jobs.get(id);
  if (!job?.translation?.analysis) return { ok: false, error: "Готового перевода нет" };
  previewControllers.get(id)?.abort();
  const controller = new AbortController();
  previewControllers.set(id, controller);
  const from = Math.max(0, Math.min(Number(start) || 0, Math.max(0, job.duration - PREVIEW_SECONDS)));
  try {
    const settings = loadSettings();
    // звук оригинала — из копии рядом с кэшем: прыжок по ней мгновенный даже на 40-ГБ видео
    const { data, autoGainDb } = await renderPreview(origAudio(job), job.translation.audio, from, PREVIEW_SECONDS,
      { ...settings, origLoudness: job.origLoudness ?? null, voiceAnalysis: job.translation.analysis },
      controller.signal);
    // какие настройки применились — чтобы на слух не гадать, дошла ли смена настроек
    return { ok: true, data, start: from, note: describeMix(settings, autoGainDb) };
  } catch (e) {
    return { ok: false, error: controller.signal.aborted ? "" : e.message };
  } finally {
    if (previewControllers.get(id) === controller) previewControllers.delete(id);
  }
});

// ---------- копии на Диске и сохранённые переводы ----------
function removeTranslationCache(job) {
  job.translation = null;
  rmSync(translationCacheDir(job.id), { recursive: true, force: true });
  rmSync(origAudioPath(job.id), { force: true });
}

async function removeDiskCopy(job) {
  if (!job.diskPath) return;
  const diskPath = job.diskPath;
  job.diskPath = null;
  const token = await auth.getToken().catch(() => null);
  if (!token) return;
  const { deletePermanently } = loadSettings();
  await disk.unpublish(token, diskPath).catch(() => {});
  await disk.remove(token, diskPath, { permanently: deletePermanently }).catch(() => {});
}

/** Останавливает всё, ждёт текущее задание (не дольше 20 с) и убирает копии с Диска. */
async function shutdown() {
  queue.length = 0;
  for (const j of jobs.values()) j.controller.abort();
  if (currentRun) {
    await Promise.race([currentRun.catch(() => {}), new Promise((r) => setTimeout(r, 20_000))]);
  }
  await Promise.race([
    Promise.all([...jobs.values()].map(removeDiskCopy)),
    new Promise((r) => setTimeout(r, 20_000)),
  ]);
  rmSync(path.join(app.getPath("temp"), "local-vot"), { recursive: true, force: true });
}

/** Копии, оставшиеся с прошлого раза (приложение упало или его закрыли снятием задачи). */
async function purgeLeftovers() {
  const token = await auth.getToken().catch(() => null);
  if (!token) return;
  const { deletePermanently } = loadSettings();
  const inUse = new Set([...jobs.values()].map((j) => j.diskPath).filter(Boolean));
  for (const p of await disk.listAppFolder(token)) {
    if (inUse.has(p)) continue;
    await disk.remove(token, p, { permanently: deletePermanently }).catch(() => {});
  }
}

// ---------- IPC ----------
async function authStatus() {
  const token = await auth.getToken().catch(() => null);
  if (!token) return { loggedIn: false };
  try {
    const account = await auth.getAccount(token);
    return account ? { loggedIn: true, ...account } : { loggedIn: false };
  } catch (e) {
    return { loggedIn: true, name: "Яндекс", offline: e.message };
  }
}

let loginController = null;
ipcMain.handle("auth:status", authStatus);
ipcMain.handle("auth:login", async () => {
  loginController?.abort();
  loginController = new AbortController();
  try {
    await auth.login((code) => {
      send("auth:code", code);
      shell.openExternal(code.url);
    }, loginController.signal);
    purgeLeftovers();
    return { ok: true, status: await authStatus() };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    loginController = null;
  }
});
ipcMain.handle("auth:cancel", () => loginController?.abort());
ipcMain.handle("auth:logout", () => auth.logout());
ipcMain.handle("auth:openPage", (_e, url) => {
  // открываем только страницы Яндекса — адрес приходит из интерфейса
  if (/^https:\/\/([a-z0-9-]+\.)*(ya\.ru|yandex\.ru)\//.test(url)) shell.openExternal(url);
});

ipcMain.handle("app:info", () => ({ steps: STEPS, version: app.getVersion(), languages: SOURCE_LANGS, livelyLang: LIVELY_LANG,
  videoExt: VIDEO_EXT }));
ipcMain.handle("settings:get", () => loadSettings());
ipcMain.handle("settings:set", (_e, patch) => saveSettings(patch));

ipcMain.handle("dialog:pickVideos", async () => {
  const r = await dialog.showOpenDialog(win, {
    title: "Выберите видео",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Видео", extensions: VIDEO_EXT }],
  });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle("dialog:pickVideoFolder", async () => {
  const r = await dialog.showOpenDialog(win, { title: "Папка с видео для перевода", properties: ["openDirectory"] });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle("dialog:pickFolder", async () => {
  const r = await dialog.showOpenDialog(win, { title: "Куда сохранять результат", properties: ["openDirectory", "createDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle("jobs:add", (_e, files) => addJobs(files));
ipcMain.handle("jobs:cancel", (_e, id) => {
  const job = jobs.get(id);
  if (!job) return;
  job.controller.abort();
  const i = queue.indexOf(job);
  if (i >= 0) {
    queue.splice(i, 1);
    job.state = "cancelled";
    send("job:update", { id, state: "cancelled" });
  }
});
// голос для видео: пока перевод не начался — просто запоминаем; после — интерфейс предложит пересоздать
ipcMain.handle("jobs:setVoice", (_e, id, lively) => {
  const job = jobs.get(id);
  if (job) job.lively = Boolean(lively);
});
ipcMain.handle("jobs:setLang", (_e, id, lang) => {
  const job = jobs.get(id);
  if (job && SOURCE_LANGS.some((l) => l.code === lang)) job.lang = lang;
});
// ещё один запрос к Яндексу (новая ссылка → свежий перевод) текущим голосом видео. Те же голос и язык —
// «Перевести заново»: новая версия заменяет прежнюю; другие — «Пересоздать»: прежняя остаётся
ipcMain.handle("jobs:retranslate", (_e, id) => {
  const job = jobs.get(id);
  if (!job || !["done", "error", "cancelled"].includes(job.state)) return;
  const same = job.voiceUsed === null || (job.lively === job.voiceUsed && job.lang === job.langUsed);
  enqueue(job, "translate", same);
});
// собрать видео заново из уже полученного перевода — с текущими настройками звука и сохранения
ipcMain.handle("jobs:remux", (_e, id) => {
  const job = jobs.get(id);
  if (!job?.translation || !["done", "error", "cancelled"].includes(job.state)) return;
  enqueue(job, "remux", true);
});
ipcMain.handle("jobs:remove", async (_e, id) => {
  const job = jobs.get(id);
  if (!job || ["queued", "running"].includes(job.state)) return false;
  jobs.delete(id);
  removeTranslationCache(job);
  removeDiskCopy(job);
  return true;
});
ipcMain.handle("shell:showItem", (_e, p) => shell.showItemInFolder(p));

// ---------- окно ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 780,
    minWidth: 780,
    minHeight: 560,
    title: "Local VOT",
    icon: path.join(ROOT, "assets", "icon-512.png"),
    backgroundColor: "#0f1320",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(ROOT, "src", "preload", "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(ROOT, "src", "renderer", "index.html"));
  // брошенный в окно файл не должен открываться вместо интерфейса; внешние ссылки — в браузере
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  // при закрытии: спросить, если идёт перевод, и убрать копии с Диска
  let closing = false;
  win.on("close", async (e) => {
    const hasCopies = [...jobs.values()].some((j) => j.diskPath);
    if (closing || (!running && queue.length === 0 && !hasCopies)) return;
    e.preventDefault();
    if (running || queue.length) {
      const { response } = await dialog.showMessageBox(win, {
        type: "question",
        buttons: ["Закрыть", "Продолжить перевод"],
        defaultId: 1,
        cancelId: 1,
        title: "Local VOT",
        message: "Идёт перевод. Закрыть приложение?",
        detail: "Перевод прервётся, загруженные копии будут удалены с Яндекс Диска.",
      });
      if (response !== 0) return;
    }
    closing = true;
    win.setTitle("Local VOT — убираем файлы с Диска…");
    await shutdown();
    win.close();
  });
  win.on("closed", () => { win = null; });
}

app.whenReady().then(() => {
  // временные файлы и сохранённые переводы прошлого запуска (если он завершился аварийно)
  rmSync(path.join(app.getPath("temp"), "local-vot"), { recursive: true, force: true });
  createWindow();
  purgeLeftovers();
});
app.on("window-all-closed", () => app.quit());
