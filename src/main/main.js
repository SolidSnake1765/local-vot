// Главный процесс: окно, вход в Яндекс, очередь заданий перевода.
import { app, BrowserWindow, dialog, ipcMain, nativeImage, Notification, screen, shell } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as auth from "./auth.js";
import { getCredentials, loadSettings, loadWindowState, saveSettings, saveWindowState } from "./config.js";
import * as disk from "./yadisk.js";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { describeMix, origAudio, origAudioPath, reserveDiskTurn, runJob, STEPS, translationCacheDir } from "./pipeline.js";
import { grabFrame, probe, renderPreview, setTempDir } from "./media.js";
import { limiter } from "./limit.js";
import { isPortable, setupDataPaths, workRoot } from "./paths.js";
import { LIVELY_LANG, SOURCE_LANGS } from "./languages.js";
import { hide, hideVideo, initLog, log, logDir } from "./log.js";
import os from "node:os";
import { execFileSync } from "node:child_process";

// портативная версия — все данные в папке data рядом с программой (до готовности приложения)
setupDataPaths();
setTempDir(workRoot());
initLog(path.join(app.getPath("userData"), "logs"));
// ключ приложения и папка сохранения — личное, в журнале их не будет
try { hide(getCredentials().secret, "<секрет приложения>"); } catch { /* ключей нет — войти не получится, это видно и так */ }
hide(loadSettings().outputDir, "<папка сохранения>");
process.on("uncaughtException", (e) => log.error("программа", e));
process.on("unhandledRejection", (e) => log.error("программа", e instanceof Error ? e : new Error(String(e))));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// всё, что читает встроенный ffmpeg; тот же список показывает интерфейс
const VIDEO_EXT = ["mp4", "mkv", "mov", "avi", "webm", "m4v", "wmv", "flv", "ts",
  "mpg", "mpeg", "m2ts", "mts", "3gp", "vob", "ogv"];

let win = null;
const send = (channel, payload) => win?.webContents.send(channel, payload);

// ---------- очередь: до parallelJobs видео одновременно, работа с диском — по одному (см. pipeline.js) ----------
// job: { id, file, name, state, controller, lively, lang, diskPath, duration, voiceUsed, langUsed, outputs, replace }
// outputs — файлы, сохранённые для этого видео; replace — новая версия заменяет их (прежние — в Корзину)
// diskPath — закрытая копия на Диске: держим, пока видео в списке, чтобы переводить заново без загрузки
const jobs = new Map();
const queue = [];
let jobCounter = 0; // номер видео в журнале: «видео #3» вместо имени файла
// порядок карточек в списке (id сверху вниз): очередь выполняется в этом порядке, его меняют перетаскиванием
let order = [];
// видео, которые переводятся прямо сейчас: id → промис (при выходе ждём, пока они закроют ссылки)
const running = new Map();
// итог текущей «пачки» — для уведомления, когда очередь закончится
let batch = { done: 0, failed: 0 };

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
  sortQueue();
  send("job:update", { id: job.id, state: "queued", reset: true });
  queueMicrotask(pump);
}

/** Очередь — в порядке карточек в списке. */
function sortQueue() {
  const pos = new Map(order.map((id, i) => [id, i]));
  queue.sort((a, b) => (pos.get(a.id) ?? Infinity) - (pos.get(b.id) ?? Infinity));
}

/** Видео ни разу не запускалось (нет ни перевода, ни копии на Диске, ни файлов) — можно вернуть в «ожидает». */
const neverRan = (job) => !job.translation && !job.diskPath && !job.outputs?.length;

/** Сколько видео переводить одновременно (настройка «Одновременно переводить»). */
const parallelLimit = () => Math.min(8, Math.max(1, Number(loadSettings().parallelJobs) || 1));

/**
 * Запускает видео из очереди, пока есть свободные места. Загрузка и перевод идут параллельно;
 * чтение исходника и сохранение pipeline сам пускает по одному (очередь на диск).
 */
function pump() {
  while (running.size < parallelLimit() && queue.length) {
    const job = queue.shift();
    running.set(job.id, runOne(job));
  }
}

async function runOne(job) {
  // место в очереди на диск (облегчённая копия) — сразу, до любого ожидания: так видео идут к диску
  // в порядке списка. Пересборке и видео, чья копия уже на Диске, облегчённая копия не нужна
  // место в списке — приоритет у диска: из ожидающих первым идёт видео выше по списку (учитывает и
  // перетаскивание, пока ждёт); видео уже убрали из списка — в самый конец
  const listPosition = () => { const i = order.indexOf(job.id); return i < 0 ? Infinity : i; };
  const lightTurn = job.mode === "remux" || job.diskPath ? null : reserveDiskTurn(job.controller.signal, listPosition);
  lightTurn?.catch(() => {}); // отмена в ожидании — не ошибка
  job.state = "running";
  send("job:update", { id: job.id, state: "running" });
  const scope = `видео #${job.no}`;
  const t0 = Date.now();
  log.info(scope, job.mode === "remux" ? "пересборка из готового перевода"
    : `перевод: ${job.lively ? "живые" : "обычные"} голоса, язык ${job.lang}${job.replace ? ", заменить прежнюю версию" : ""}`);
  try {
    const token = await auth.getToken();
    if (!token) throw new Error("Войдите в Яндекс, чтобы переводить видео");
    // настройки читаются в момент сохранения: общие + звук этого видео (если его уже настраивали в карточке)
    let soundUsed = null;
    const getOptions = () => {
      const options = { ...loadSettings(), ...(job.sound ?? {}) };
      soundUsed = pickSound(options);
      return options;
    };
    const run = runJob(job, { getOptions, token, mode: job.mode, makeDiskRoom, lightTurn, listPosition }, (patch) => {
      if (patch.state) log[patch.state === "error" ? "warn" : "info"](scope, `${patch.step}: ${patch.state}${patch.detail ? ` — ${patch.detail}` : ""}`);
      send("job:update", { id: job.id, ...patch });
    }, job.controller.signal);
    const { outputs, lively, lang } = await run;
    const { files, stuck } = await replaceOutputs(job.replace ? (job.outputs ?? []) : [], outputs);
    job.outputs = [...(job.replace ? [] : job.outputs ?? []), ...files];
    // звук, с которым собраны файлы, закрепляется за видео: дальше его меняют только в карточке
    job.sound = soundUsed;
    job.savedSound = soundUsed;
    job.state = "done";
    job.voiceUsed = lively;
    job.langUsed = lang;
    log.info(scope, `готово за ${Math.round((Date.now() - t0) / 1000)} с: ${files.map((p) => path.extname(p)).join(", ")}`
      + (stuck ? `; прежнюю версию убрать не удалось (файлов: ${stuck})` : ""), soundUsed);
    batch.done++;
    notify(`Готово: ${job.name}`, `Сохранено: ${files.map((p) => path.extname(p).slice(1).toUpperCase()).join(", ")}`);
    send("job:update", { id: job.id, state: "done", outputs: job.outputs, voiceUsed: lively, langUsed: lang,
      hasTranslation: true, preview: previewInfo(job),
      note: stuck ? `Прежнюю версию убрать не удалось (файлов: ${stuck}) — возможно, она открыта в плеере. Новая сохранена рядом.` : "" });
  } catch (e) {
    job.state = job.controller.signal.aborted ? "cancelled" : "error";
    if (job.state === "cancelled") log.info(scope, `отменено через ${Math.round((Date.now() - t0) / 1000)} с`);
    else {
      log.error(scope, e);
      batch.failed++;
      notify(`Ошибка: ${job.name}`, e.message);
    }
    // перевод получен, а сохранить не вышло — звук для карточки всё равно закрепляем (от настроек по умолчанию)
    if (job.translation && !job.sound) job.sound = pickSound(loadSettings());
    send("job:update", { id: job.id, state: job.state, error: job.state === "error" ? e.message : "",
      hasTranslation: Boolean(job.translation), preview: previewInfo(job) });
  } finally {
    lightTurn?.then((release) => release(), () => {}); // не дошли до копии (ошибка, отмена) — место отдаём
    job.mode = "translate";
    running.delete(job.id);
    pump();
    // очередь закончилась — одно общее уведомление, если видео было больше одного
    if (!running.size && !queue.length) {
      const { done, failed } = batch;
      batch = { done: 0, failed: 0 };
      if (done + failed > 1) {
        notify("Очередь переведена", `Готово: ${done}${failed ? ` · с ошибкой: ${failed}` : ""}`);
      }
    }
  }
}

/**
 * На Яндекс Диске не хватает места для новой копии — убираем копии видео, которые сейчас не переводятся
 * (готовые, с ошибкой, отменённые): они нужны только для «Перевести заново» без повторной загрузки.
 * Если такое видео переведут заново, копия просто загрузится ещё раз. Возвращает, сколько копий убрано.
 */
async function makeDiskRoom() {
  let removed = 0;
  for (const job of jobs.values()) {
    if (!job.diskPath || ["queued", "running"].includes(job.state)) continue;
    // мимо Корзины: в Корзине копия продолжала бы занимать место. Это временная копия программы
    // (чёрный кадр + звук), не файл пользователя
    await removeDiskCopy(job, { permanently: true });
    removed++;
  }
  if (removed) log.info("Диск", `не хватало места — убраны копии готовых видео: ${removed}`);
  return removed;
}

// ---------- уведомления Windows ----------
// Имя программы для Windows (AppUserModelID). У установленной оно же стоит на ярлыке в «Пуске».
const AUMID = app.isPackaged ? "io.github.solidsnake1765.localvot" : "io.github.solidsnake1765.localvot.dev";
let aumidRegistered = false;

/**
 * Windows показывает уведомления только «знакомым» программам. У запуска из исходников и у портативной
 * версии нет ярлыка в «Пуске», поэтому регистрируем имя и значок в реестре пользователя
 * (HKCU\Software\Classes\AppUserModelId\<AUMID>) — официальный способ для программ без ярлыка.
 * Делается при первом уведомлении (выключены — в реестр ничего не пишем); деинсталлятор ключ убирает.
 */
function registerAumid() {
  if (aumidRegistered || process.platform !== "win32") return;
  aumidRegistered = true;
  const key = `HKCU\\Software\\Classes\\AppUserModelId\\${AUMID}`;
  const icon = app.isPackaged ? path.join(process.resourcesPath, "icon.png") : path.join(ROOT, "assets", "icon-512.png");
  const name = app.isPackaged ? "Local VOT" : "Local VOT (разработка)";
  try {
    for (const [value, data] of [["DisplayName", name], ["IconUri", icon]]) {
      execFileSync("reg", ["add", key, "/v", value, "/t", "REG_SZ", "/d", data, "/f"], { windowsHide: true, stdio: "ignore" });
    }
  } catch (e) {
    log.warn("уведомления", "не удалось зарегистрировать программу в Windows", e);
  }
}

/**
 * Уведомление — только если окно не на переднем плане (иначе и так всё видно) и не выключено в
 * настройках (force — кнопка «Проверить»). Плюс мигание значка на панели задач, пока окно не откроют.
 */
function notify(title, body, { force = false } = {}) {
  if (!win) return false;
  if (!force && !loadSettings().notifications) return false;
  if (!force && win.isFocused()) {
    log.info("уведомления", "не показано: окно на переднем плане");
    return false;
  }
  if (!force) win.flashFrame(true);
  if (!Notification.isSupported()) {
    log.warn("уведомления", "Windows сообщает, что уведомления не поддерживаются");
    return false;
  }
  registerAumid();
  const n = new Notification({ title, body: String(body ?? "").slice(0, 200), icon: path.join(ROOT, "assets", "icon-512.png") });
  shownNotifications.add(n); // держим ссылку, иначе уведомление может пропасть раньше, чем по нему нажмут
  const forget = () => shownNotifications.delete(n);
  n.on("click", () => {
    forget();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  n.on("close", forget);
  n.on("failed", (_e, error) => { forget(); log.warn("уведомления", "Windows не показала уведомление", error); });
  n.on("show", () => log.info("уведомления", "показано"));
  n.show();
  return true;
}
const shownNotifications = new Set();

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
    // без «Запускать сразу» видео ждёт кнопки «Старт» / «Запустить все» — можно расставить порядок
    const no = ++jobCounter;
    hideVideo(file, no);
    let bytes = 0;
    try { bytes = statSync(file).size; } catch { /* размер не важен для добавления */ }
    log.info(`видео #${no}`, `добавлено: ${path.extname(file).slice(1).toUpperCase()}, ${(bytes / 1024 ** 3).toFixed(2)} ГБ`);
    const job = { id: randomUUID(), no, file, name: path.basename(file), state: settings.autoStart ? "queued" : "idle",
      controller: new AbortController(), lively, lang, diskPath: null, duration: null, voiceUsed: null, langUsed: null };
    jobs.set(job.id, job);
    order.push(job.id);
    if (settings.autoStart) queue.push(job);
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
  if (skipped.translated || skipped.inList || skipped.outputs || rejected.length) {
    log.info("очередь", `пропущено: уже переведены ${skipped.translated}, уже в списке ${skipped.inList}, `
      + `наши файлы ${skipped.outputs}, не видео ${rejected.length}`);
  }
  return { added, note: text, error };
}

// ---------- предпрослушивание ----------
const PREVIEW_SECONDS = 20;
const previewControllers = new Map(); // id → AbortController текущей сборки куска

/**
 * Что нужно блоку «Звук этого видео»: длительность, где начинается первая фраза перевода, звук видео
 * (sound) и звук, с которым собраны сохранённые файлы (savedSound; null — файлов ещё нет).
 */
function previewInfo(job) {
  if (!job.translation?.analysis) return null;
  const first = job.translation.analysis.segments[0]?.[0] ?? 0;
  return { duration: job.duration, start: Math.max(0, first - 1), length: PREVIEW_SECONDS,
    sound: job.sound ?? pickSound(loadSettings()), savedSound: job.savedSound ?? null };
}

// ---------- звук видео ----------
// У каждого видео свой звук: до первого сохранения — настройки по умолчанию (панель справа),
// после — закреплённый за видео, его меняют ползунки в карточке.
const SOUND_KEYS = ["mixMode", "originalVolume", "voiceGain", "autoLevel"];
const pickSound = (o) => Object.fromEntries(SOUND_KEYS.map((k) => [k, o[k]]));

ipcMain.handle("jobs:setSound", (_e, id, patch) => {
  const job = jobs.get(id);
  if (!job) return;
  const clean = Object.fromEntries(Object.entries(patch ?? {}).filter(([k]) => SOUND_KEYS.includes(k)));
  job.sound = { ...(job.sound ?? pickSound(loadSettings())), ...clean };
});

// кусок звука с текущими настройками; повторный запрос для того же видео отменяет предыдущий
ipcMain.handle("jobs:preview", async (_e, id, start) => {
  const job = jobs.get(id);
  if (!job?.translation?.analysis) return { ok: false, error: "Готового перевода нет" };
  previewControllers.get(id)?.abort();
  const controller = new AbortController();
  previewControllers.set(id, controller);
  const from = Math.max(0, Math.min(Number(start) || 0, Math.max(0, job.duration - PREVIEW_SECONDS)));
  try {
    const settings = { ...loadSettings(), ...(job.sound ?? {}) }; // звук этого видео — как при сохранении
    // звук оригинала — из копии рядом с кэшем: прыжок по ней мгновенный даже на 40-ГБ видео
    const { data, autoGainDb } = await renderPreview(origAudio(job), job.translation.audio, from, PREVIEW_SECONDS,
      { ...settings, origLoudness: job.origLoudness ?? null, voiceAnalysis: job.translation.analysis },
      controller.signal);
    // какие настройки применились — чтобы на слух не гадать, дошла ли смена настроек
    return { ok: true, data, start: from, note: describeMix(settings, autoGainDb) };
  } catch (e) {
    if (!controller.signal.aborted) log.warn(`видео #${job.no}`, "прослушивание не собралось", e);
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

/** permanently — мимо Корзины Диска независимо от настройки (Корзина тоже занимает место на Диске). */
async function removeDiskCopy(job, { permanently = null } = {}) {
  if (!job.diskPath) return;
  const diskPath = job.diskPath;
  job.diskPath = null;
  const token = await auth.getToken().catch(() => null);
  if (!token) return;
  const { deletePermanently } = loadSettings();
  await disk.unpublish(token, diskPath).catch(() => {});
  await disk.remove(token, diskPath, { permanently: permanently ?? deletePermanently }).catch(() => {});
}

/** Останавливает всё, ждёт идущие задания (не дольше 20 с) и убирает копии с Диска. */
async function shutdown() {
  log.info("выход", `закрытие программы; видео в списке: ${jobs.size}${running.size ? `, идёт перевод: ${running.size} — прерываем` : ""}`);
  queue.length = 0;
  for (const j of jobs.values()) j.controller.abort();
  if (running.size) {
    await Promise.race([Promise.all(running.values()), new Promise((r) => setTimeout(r, 20_000))]);
  }
  await Promise.race([
    Promise.all([...jobs.values()].map(removeDiskCopy)),
    new Promise((r) => setTimeout(r, 20_000)),
  ]);
  rmSync(workRoot(), { recursive: true, force: true });
}

/** Копии, оставшиеся с прошлого раза (приложение упало или его закрыли снятием задачи). */
async function purgeLeftovers() {
  const token = await auth.getToken().catch(() => null);
  if (!token) return;
  const { deletePermanently } = loadSettings();
  const inUse = new Set([...jobs.values()].map((j) => j.diskPath).filter(Boolean));
  let removed = 0;
  for (const p of await disk.listAppFolder(token)) {
    if (inUse.has(p)) continue;
    await disk.remove(token, p, { permanently: deletePermanently })
      .then(() => { removed++; })
      .catch((e) => log.warn("Диск", "не удалось убрать старую копию", e));
  }
  if (removed) log.info("Диск", `убрано копий с прошлого запуска: ${removed}`);
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
    log.info("вход", "вход в Яндекс выполнен");
    return { ok: true, status: await authStatus() };
  } catch (e) {
    if (!/отмен/i.test(e.message)) log.warn("вход", "вход в Яндекс не удался", e);
    return { ok: false, error: e.message };
  } finally {
    loginController = null;
  }
});
ipcMain.handle("auth:cancel", () => loginController?.abort());
ipcMain.handle("auth:logout", () => { log.info("вход", "выход из Яндекса"); return auth.logout(); });
ipcMain.handle("auth:openPage", (_e, url) => {
  // открываем только страницы Яндекса — адрес приходит из интерфейса
  if (/^https:\/\/([a-z0-9-]+\.)*(ya\.ru|yandex\.ru)\//.test(url)) shell.openExternal(url);
});

// страница программы на GitHub — из package.json (repository.url), без «git+» и «.git»
const REPO_URL = (() => {
  try {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const url = (pkg.repository?.url ?? pkg.repository ?? "").replace(/^git\+/, "").replace(/\.git$/, "");
    return /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(url) ? url : "";
  } catch {
    return "";
  }
})();
ipcMain.handle("app:info", () => ({ steps: STEPS, version: app.getVersion(), languages: SOURCE_LANGS, livelyLang: LIVELY_LANG,
  videoExt: VIDEO_EXT, repoUrl: REPO_URL, portable: isPortable() }));
ipcMain.handle("app:openRepo", () => { if (REPO_URL) shell.openExternal(REPO_URL); });
ipcMain.handle("settings:get", () => loadSettings());
ipcMain.handle("settings:set", (_e, patch) => {
  if (patch?.outputDir) hide(patch.outputDir, "<папка сохранения>");
  const next = saveSettings(patch);
  if (patch && "parallelJobs" in patch) pump();
  return next;
});
// ошибки окна (интерфейса) — в тот же журнал
ipcMain.handle("log:renderer", (_e, message) => log.error("окно", String(message).slice(0, 4000)));
ipcMain.handle("app:openLogs", () => { if (logDir()) shell.openPath(logDir()); });

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
function cancelJob(job, why) {
  log.info(`видео #${job.no}`, why);
  job.controller.abort();
  const i = queue.indexOf(job);
  if (i >= 0) {
    queue.splice(i, 1);
    // ещё не начатое видео снова просто ждёт «Старт»; начатое раньше — «Отменено» со своими кнопками
    job.state = neverRan(job) ? "idle" : "cancelled";
    send("job:update", { id: job.id, state: job.state, reset: job.state === "idle" });
  }
}
ipcMain.handle("jobs:cancel", (_e, id) => {
  const job = jobs.get(id);
  if (job) cancelJob(job, "отмена по кнопке");
});
// «Отменить все»: сначала очередь (иначе освободившиеся места тут же займут следующие видео), потом идущие
ipcMain.handle("jobs:cancelAll", () => {
  const all = [...jobs.values()];
  for (const job of all.filter((j) => j.state === "queued")) cancelJob(job, "отменить все");
  for (const job of all.filter((j) => j.state === "running")) cancelJob(job, "отменить все");
});
ipcMain.handle("app:testNotification", () =>
  notify("Local VOT", "Уведомления работают: так придёт сообщение о готовом видео.", { force: true }));
// «Старт» у видео, которое ждёт запуска
ipcMain.handle("jobs:start", (_e, id) => {
  const job = jobs.get(id);
  if (job?.state === "idle") enqueue(job);
});
// «Запустить все»: все ждущие — по порядку в списке
ipcMain.handle("jobs:startAll", () => {
  for (const id of order) {
    const job = jobs.get(id);
    if (job?.state === "idle") enqueue(job);
  }
});
// новый порядок карточек после перетаскивания (id сверху вниз)
ipcMain.handle("jobs:reorder", (_e, ids) => {
  if (!Array.isArray(ids)) return;
  const known = ids.filter((id) => jobs.has(id));
  order = [...new Set([...known, ...order.filter((id) => jobs.has(id))])];
  sortQueue();
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
/** Убрать видео из списка: вместе с сохранённым переводом и копией на Диске (файлы на компьютере остаются). */
function dropJob(job) {
  thumbs.delete(job.id);
  const i = queue.indexOf(job);
  if (i >= 0) queue.splice(i, 1);
  jobs.delete(job.id);
  order = order.filter((x) => x !== job.id);
  removeTranslationCache(job);
  removeDiskCopy(job);
}

ipcMain.handle("jobs:remove", async (_e, id) => {
  const job = jobs.get(id);
  if (!job || ["queued", "running"].includes(job.state)) return false;
  dropJob(job);
  return true;
});
// «Очистить список»: сколько видео можно убрать (для вопроса в окне программы)
ipcMain.handle("jobs:clearInfo", () => {
  const removable = [...jobs.values()].filter((j) => j.state !== "running");
  return { all: removable.length, done: removable.filter((j) => j.state === "done").length, running: running.size };
});
// mode: "all" — все, кроме идущих прямо сейчас; "done" — только готовые. Возвращает id убранных видео.
ipcMain.handle("jobs:clear", (_e, mode) => {
  const removable = [...jobs.values()].filter((j) => j.state !== "running");
  const targets = mode === "done" ? removable.filter((j) => j.state === "done") : removable;
  for (const job of targets) {
    job.controller.abort(); // видео в очереди — больше не запустится
    dropJob(job);
  }
  log.info("очередь", `очищено видео: ${targets.length}`);
  return targets.map((j) => j.id);
});
ipcMain.handle("shell:showItem", (_e, p) => shell.showItemInFolder(p));

// ---------- миниатюры видео ----------
// Как в проводнике: миниатюру даёт сама Windows (тем же механизмом, что и проводник, из её кэша — мгновенно).
// Не умеет (нет кодека, например HEVC без расширения) — кадр через ffmpeg. Не больше двух сразу, чтобы
// добавление папки из десятков видео не нагружало компьютер. Готовые храним, пока видео в списке.
const thumbs = new Map(); // id → промис data:-адреса картинки (или null)
const thumbTurn = limiter(2);

async function makeThumb(job) {
  const release = await thumbTurn.acquire();
  try {
    const file = path.normalize(job.file); // Windows нужен путь с обратными слэшами
    try {
      const img = await nativeImage.createThumbnailFromPath(file, { width: 320, height: 180 });
      if (!img.isEmpty()) return img.toDataURL();
    } catch { /* Windows не смогла — пробуем ffmpeg */ }
    const { duration } = await probe(file).catch(() => ({ duration: 0 }));
    const jpeg = await grabFrame(file, duration);
    return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  } catch (e) {
    log.warn(`видео #${job.no}`, "миниатюра не получилась", e);
    return null;
  } finally {
    release();
  }
}
ipcMain.handle("jobs:thumb", (_e, id) => {
  const job = jobs.get(id);
  if (!job) return null;
  if (!thumbs.has(id)) thumbs.set(id, makeThumb(job));
  return thumbs.get(id);
});
// клик по миниатюре — открыть видео в плеере по умолчанию (только видео из списка, по id)
ipcMain.handle("jobs:openVideo", (_e, id) => {
  const job = jobs.get(id);
  if (job) shell.openPath(job.file);
});

// ---------- окно ----------
/**
 * Размер окна: как было при прошлом закрытии (если тот экран ещё подключён), иначе — крупное окно
 * по центру (1440×940, но не больше 90 % рабочей области экрана).
 */
function initialBounds() {
  const saved = loadWindowState();
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    const area = screen.getDisplayMatching(saved).workArea;
    const visible = saved.x < area.x + area.width - 100 && saved.x + saved.width > area.x + 100
      && saved.y >= area.y - 10 && saved.y < area.y + area.height - 100;
    const { x, y, width, height } = saved;
    if (visible) return { bounds: { x, y, width, height }, maximized: Boolean(saved.maximized) };
  }
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(1440, Math.round(area.width * 0.9));
  const height = Math.min(940, Math.round(area.height * 0.9));
  return { bounds: { width, height }, maximized: Boolean(saved?.maximized) };
}

function createWindow() {
  const { bounds, maximized } = initialBounds();
  win = new BrowserWindow({
    ...bounds,
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
  if (maximized) win.maximize();
  win.loadFile(path.join(ROOT, "src", "renderer", "index.html"));
  // размер запоминаем до всех вопросов при закрытии; у развёрнутого окна — его обычный размер
  win.on("close", () => {
    if (!win.isMinimized()) saveWindowState({ ...win.getNormalBounds(), maximized: win.isMaximized() });
  });
  // брошенный в окно файл не должен открываться вместо интерфейса; внешние ссылки — в браузере
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  // при закрытии: спросить, если идёт перевод, и убрать копии с Диска
  let closing = false;
  win.on("close", async (e) => {
    const hasCopies = [...jobs.values()].some((j) => j.diskPath);
    if (closing || (!running.size && queue.length === 0 && !hasCopies)) return;
    e.preventDefault();
    if (running.size || queue.length) {
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
  win.on("focus", () => win.flashFrame(false)); // уведомление увидели — значок больше не мигает
  win.on("closed", () => { win = null; });
}

if (process.platform === "win32") app.setAppUserModelId(AUMID);
app.whenReady().then(() => {
  log.info("запуск", `Local VOT ${app.getVersion()} (${isPortable() ? "портативная" : app.isPackaged ? "установленная" : "разработка"}), `
    + `Windows ${os.release()} ${process.arch}, Electron ${process.versions.electron}, ffmpeg встроенный`);
  // временные файлы и сохранённые переводы прошлого запуска (если он завершился аварийно)
  rmSync(workRoot(), { recursive: true, force: true });
  createWindow();
  purgeLeftovers();
});
app.on("window-all-closed", () => app.quit());
