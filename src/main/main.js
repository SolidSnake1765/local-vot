// Главный процесс: окно, вход в Яндекс, очередь заданий перевода.
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as auth from "./auth.js";
import { loadSettings, saveSettings } from "./config.js";
import * as disk from "./yadisk.js";
import { rmSync } from "node:fs";
import { describeMix, runJob, STEPS, translationCacheDir } from "./pipeline.js";
import { renderPreview } from "./media.js";
import { LIVELY_LANG, SOURCE_LANGS } from "./languages.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VIDEO_EXT = ["mp4", "mkv", "mov", "avi", "webm", "m4v", "wmv", "flv", "ts"];

let win = null;
const send = (channel, payload) => win?.webContents.send(channel, payload);

// ---------- очередь: задания выполняются по одному ----------
// job: { id, file, name, state, controller, lively, lang, diskPath, duration, voiceUsed, langUsed }
// diskPath — закрытая копия на Диске: держим, пока видео в списке, чтобы переводить заново без загрузки
const jobs = new Map();
const queue = [];
let running = false;
let currentRun = null; // промис текущего задания — при выходе ждём, пока оно закроет ссылку

function publicJob(j) {
  return { id: j.id, file: j.file, name: j.name, state: j.state, lively: j.lively, lang: j.lang,
    voiceUsed: j.voiceUsed, langUsed: j.langUsed };
}

function enqueue(job, mode = "translate") {
  job.controller = new AbortController();
  job.mode = mode;
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
    job.state = "done";
    job.voiceUsed = lively;
    job.langUsed = lang;
    send("job:update", { id: job.id, state: "done", outputs, voiceUsed: lively, langUsed: lang, hasTranslation: true,
      preview: previewInfo(job) });
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

function addJobs(files) {
  const { livelyVoice: lively, sourceLang } = loadSettings();
  const lang = lively ? LIVELY_LANG : sourceLang;
  const added = [];
  for (const file of files) {
    const ext = path.extname(file).slice(1).toLowerCase();
    if (!VIDEO_EXT.includes(ext)) continue;
    const job = { id: randomUUID(), file, name: path.basename(file), state: "queued", controller: new AbortController(),
      lively, lang, diskPath: null, duration: null, voiceUsed: null, langUsed: null };
    jobs.set(job.id, job);
    queue.push(job);
    added.push(publicJob(job));
  }
  queueMicrotask(pump);
  return added;
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
    const { data, autoGainDb } = await renderPreview(job.file, job.translation.audio, from, PREVIEW_SECONDS,
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

ipcMain.handle("app:info", () => ({ steps: STEPS, version: app.getVersion(), languages: SOURCE_LANGS, livelyLang: LIVELY_LANG }));
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
// ещё один запрос к Яндексу (новая ссылка → свежий перевод) текущим голосом видео
ipcMain.handle("jobs:retranslate", (_e, id) => {
  const job = jobs.get(id);
  if (!job || !["done", "error", "cancelled"].includes(job.state)) return;
  enqueue(job);
});
// собрать видео заново из уже полученного перевода — с текущими настройками звука и сохранения
ipcMain.handle("jobs:remux", (_e, id) => {
  const job = jobs.get(id);
  if (!job?.translation || !["done", "error", "cancelled"].includes(job.state)) return;
  enqueue(job, "remux");
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
