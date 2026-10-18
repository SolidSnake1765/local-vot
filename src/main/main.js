// Главный процесс: окно, вход в Яндекс, очередь заданий перевода.
import { app, BrowserWindow, dialog, ipcMain, Notification, screen, shell } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudById, cloudOf, CLOUDS, livelyCloud, publicClouds } from "./clouds.js";
import { getCredentials, getGoogleCredentials, loadSettings, loadWindowState, saveSettings, saveWindowState } from "./config.js";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { readdir, rename, rm, stat } from "node:fs/promises";
import { describeMix, origAudio, origAudioPath, profilePath, reserveDiskTurn, runJob, STEPS, translationCacheDir, wakeDiskTurn } from "./pipeline.js";
import { loadQueue, removeQueueFile, saveQueue, serializeJob } from "./persist.js";
import { grabFrame, probe, renderPreview, setTempDir } from "./media.js";
import { limiter } from "./limit.js";
import { stopThumbHelper, windowsThumb } from "./thumbs.js";
import { isPortable, setupDataPaths, workRoot } from "./paths.js";
import { LIVELY_LANG, SOURCE_LANGS } from "./languages.js";
import { hide, hideVideo, initLog, log, logDir } from "./log.js";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// портативная версия — все данные в папке data рядом с программой (до готовности приложения)
setupDataPaths();
// Одна копия программы: вторая при запуске чистит временную папку и копии на Диске — у первой пропали бы
// идущие переводы (двойной щелчок по ярлыку — частое дело). Вторая просто показывает окно первой.
// Замок — по папке данных: установленная, портативная и разработка друг другу не мешают.
const primary = app.requestSingleInstanceLock();
if (!primary) app.exit(0);
setTempDir(workRoot());
initLog(path.join(app.getPath("userData"), "logs"));
// ключ приложения и папка сохранения — личное, в журнале их не будет
try { hide(getCredentials().secret, "<секрет приложения>"); } catch { /* ключей нет — войти не получится, это видно и так */ }
try { hide(getGoogleCredentials().secret, "<секрет приложения Google>"); } catch { /* то же для Google */ }
hide(loadSettings().outputDir, "<папка сохранения>");
process.on("uncaughtException", (e) => log.error("программа", e));
process.on("unhandledRejection", (e) => log.error("программа", e instanceof Error ? e : new Error(String(e))));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// всё, что читает встроенный ffmpeg; тот же список показывает интерфейс
const VIDEO_EXT = ["mp4", "mkv", "mov", "avi", "webm", "m4v", "wmv", "flv", "ts",
  "mpg", "mpeg", "m2ts", "mts", "3gp", "vob", "ogv"];

// Куда загружается облегчённая копия для переводчика (кнопка «Облако»): список облаков — clouds.js.
// Копия видео помнит своё облако по пути (job.diskPath, см. cloudOf).
const currentCloud = () => cloudById(loadSettings().storage);

let win = null;
const send = (channel, payload) => {
  win?.webContents.send(channel, payload);
  if (channel === "job:update" && (payload?.state || payload?.outputs)) schedulePersist();
};

// ---------- очередь: до parallelJobs видео одновременно, копия и сборка — по настройке diskJobs (см. pipeline.js) ----------
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
// из них — занявшие место в «Одновременно переводить» (копия, загрузка, перевод); собирающиеся его уже отдали
const slots = new Set();
// итог текущей «пачки» — для уведомления, когда очередь закончится
let batch = { done: 0, failed: 0 };

function publicJob(j) {
  return { id: j.id, file: j.file, name: j.name, state: j.state, lively: j.lively, lang: j.lang,
    voiceUsed: j.voiceUsed, langUsed: j.langUsed, save: j.save ?? null };
}

/**
 * Ход работы видео — в окно. Загрузка сообщает о каждых 64 КБ, ffmpeg — о каждой строке вывода: это сотни
 * сообщений в секунду, и окно тратило бы время на перерисовку цифр, которых глаз не успевает увидеть.
 * Поэтому проценты и подписи одного шага копятся и уходят не чаще раза в PROGRESS_MS; смена состояния
 * (шаг начат, готов, ошибка; видео готово) — сразу, вместе с накопленным.
 */
const PROGRESS_MS = 150;
function progressSender(id) {
  let pending = null;
  let timer = null;
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    if (pending) send("job:update", pending);
    pending = null;
  };
  const push = (patch) => {
    if (pending && pending.step !== patch.step) flush();
    pending = { ...(pending ?? { id }), ...patch };
    if (patch.state !== undefined) flush();
    else timer ??= setTimeout(flush, PROGRESS_MS);
  };
  return { push, flush };
}

function enqueue(job, mode = "translate", replace = false) {
  job.controller = new AbortController();
  job.mode = mode;
  job.replace = replace;
  job.state = "queued";
  job.steps = {};
  job.error = "";
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
 * Запускает видео из очереди, пока есть свободные места. Место занято от облегчённой копии до получения
 * перевода; сборку видео ждёт и делает уже без места. Копию и сборку pipeline пускает к диску по настройке
 * «Копия и сборка».
 */
function pump() {
  if (holdQueue) return;
  while (slots.size < parallelLimit() && queue.length) {
    const job = queue.shift();
    slots.add(job.id);
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
  let progress = null; // ход работы в окно (см. progressSender); перед итогом — сначала накопленное
  log.info(scope, job.mode === "remux" ? "пересборка из готового перевода"
    : `перевод: ${job.lively ? "живые" : "обычные"} голоса, язык ${job.lang}${job.replace ? ", заменить прежнюю версию" : ""}`);
  try {
    // вход в выбранное облако — чтобы загрузить копию (пересборке облако не нужно); вход в Яндекс — ещё и ради
    // живых голосов: при другом облаке он по желанию
    const cloud = currentCloud();
    let storeToken = null;
    if (job.mode !== "remux") {
      storeToken = await cloud.auth.getToken();
      if (!storeToken) {
        throw new Error(`Войдите в ${cloud.who} (кнопка «Облако» вверху), чтобы переводить через ${cloud.title}, или выберите там другое облако`);
      }
      // копия лежит в другом облаке (выбор облака поменяли) — убираем её, загрузится заново
      if (job.diskPath && cloudOf(job.diskPath) !== cloud) await removeDiskCopy(job);
    }
    const voice = livelyCloud();
    const token = voice === cloud && storeToken ? storeToken : await voice.auth.getToken().catch(() => null);
    // настройки читаются в момент сохранения: общие + что сохранять и звук этого видео (если их меняли в карточке)
    let soundUsed = null;
    const getOptions = () => {
      const options = { ...loadSettings(), ...(job.save ?? {}), ...(job.sound ?? {}) };
      soundUsed = pickSound(options);
      return options;
    };
    progress = progressSender(job.id);
    const freeSlot = () => { if (slots.delete(job.id)) pump(); };
    const store = storeToken ? { id: cloud.id, where: cloud.where, throttledBps: cloud.throttledBps, api: cloud.api, token: storeToken } : null;
    const run = runJob(job, { getOptions, token, store, mode: job.mode, makeDiskRoom: () => makeDiskRoom(cloud), lightTurn,
      listPosition, freeSlot }, (patch) => {
      if (patch.state) log[patch.state === "error" ? "warn" : "info"](scope, `${patch.step}: ${patch.state}${patch.detail ? ` — ${patch.detail}` : ""}`);
      // последнее состояние и подпись каждого шага — чтобы восстановленная карточка выглядела так же
      if (patch.step) {
        const prev = job.steps?.[patch.step] ?? {};
        job.steps = { ...job.steps, [patch.step]: { state: patch.state ?? prev.state ?? null, detail: patch.detail ?? prev.detail ?? "" } };
      }
      progress.push(patch);
    }, job.controller.signal);
    const { outputs, lively, lang } = await run;
    progress.flush();
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
    send("job:update", { id: job.id, state: "done", outputs: job.outputs, voiceUsed: lively, langUsed: lang, lively: job.lively, lang: job.lang,
      hasTranslation: true, preview: previewInfo(job),
      note: stuck ? `Прежнюю версию убрать не удалось (файлов: ${stuck}) — возможно, она открыта в плеере. Новая сохранена рядом.` : "" });
  } catch (e) {
    progress?.flush();
    job.state = job.controller.signal.aborted ? "cancelled" : "error";
    job.error = job.state === "error" ? e.message : "";
    if (job.state === "cancelled") log.info(scope, `отменено через ${Math.round((Date.now() - t0) / 1000)} с`);
    else {
      log.error(scope, e);
      batch.failed++;
      notify(`Ошибка: ${job.name}`, e.message);
    }
    // перевод получен, а сохранить не вышло — звук для карточки всё равно закрепляем (от настроек по умолчанию)
    if (job.translation && !job.sound) job.sound = pickSound(loadSettings());
    send("job:update", { id: job.id, state: job.state, error: job.state === "error" ? e.message : "", lively: job.lively, lang: job.lang,
      hasTranslation: Boolean(job.translation), preview: previewInfo(job) });
  } finally {
    lightTurn?.then((release) => release(), () => {}); // не дошли до копии (ошибка, отмена) — место отдаём
    job.mode = "translate";
    running.delete(job.id);
    slots.delete(job.id);
    pump();
    // очередь закончилась — одно общее уведомление, если видео было больше одного
    if (!running.size && !queue.length) {
      const { done, failed } = batch;
      batch = { done: 0, failed: 0 };
      if (done + failed > 1) {
        notify("Очередь переведена", `Готово: ${done}${failed ? ` · с ошибкой: ${failed}` : ""}`);
      }
      // всё отменили сами — значит, человек у компьютера, выключать не надо
      if (shutdownAfter && done + failed > 0) startShutdownCountdown();
    }
  }
}

// ---------- выключить компьютер, когда очередь закончится ----------
// Галочка — только на этот запуск (в настройки не пишется: компьютер не должен выключиться в другой раз
// неожиданно). Отсчёт ведёт главный процесс: таймеры свёрнутого окна Chromium замедляет до раза в минуту.
// Перед выключением — то же, что при закрытии: копии с Диска, временные файлы.
// проверки (tests/app.test.mjs) укорачивают отсчёт — только при запуске из исходников
const SHUTDOWN_SECONDS = (!app.isPackaged && Number(process.env.LOCAL_VOT_SHUTDOWN_SECONDS)) || 60;
let shutdownAfter = false;
let shutdownTimer = null;

function startShutdownCountdown() {
  shutdownAfter = false;
  clearTimeout(shutdownTimer);
  log.info("выключение", `очередь закончилась — компьютер выключится через ${SHUTDOWN_SECONDS} с, если не отменить`);
  send("app:shutdown", { seconds: SHUTDOWN_SECONDS, keepQueue: Boolean(loadSettings().keepQueue) });
  win?.flashFrame(true);
  shutdownTimer = setTimeout(shutdownComputer, SHUTDOWN_SECONDS * 1000);
}

async function shutdownComputer() {
  shutdownTimer = null;
  log.info("выключение", "выключаем компьютер");
  await shutdown();
  // проверка без настоящего выключения
  if (process.env.LOCAL_VOT_DRY_SHUTDOWN) {
    log.info("выключение", "(проверка: компьютер не выключается)");
  } else {
    // 10 с — программа успеет закрыться сама; Windows покажет своё предупреждение
    await promisify(execFile)("shutdown", ["/s", "/t", "10", "/c", "Local VOT: очередь переведена — компьютер выключается"],
      { windowsHide: true }).catch((e) => log.error("выключение", "Windows не приняла команду выключения", e));
  }
  quittingAfterShutdown = true; // уборка уже сделана — закрытие окна не должно делать её второй раз
  app.quit();
}
let quittingAfterShutdown = false;

ipcMain.handle("app:setShutdownAfter", (_e, on) => {
  shutdownAfter = Boolean(on);
  log.info("выключение", on ? "выключить компьютер после очереди — включено" : "выключить компьютер после очереди — выключено");
});
ipcMain.handle("app:cancelShutdown", () => {
  if (!shutdownTimer) return;
  clearTimeout(shutdownTimer);
  shutdownTimer = null;
  log.info("выключение", "отменено");
});

/**
 * В облаке cloud не хватает места для новой копии — убираем копии видео, которые сейчас не переводятся
 * (готовые, с ошибкой, отменённые): они нужны только для «Перевести заново» без повторной загрузки.
 * Если такое видео переведут заново, копия просто загрузится ещё раз. Возвращает, сколько копий убрано.
 */
async function makeDiskRoom(cloud) {
  let removed = 0;
  for (const job of jobs.values()) {
    if (!job.diskPath || cloudOf(job.diskPath) !== cloud || ["queued", "running"].includes(job.state)) continue;
    // мимо Корзины: в Корзине копия продолжала бы занимать место. Это временная копия программы
    // (чёрный кадр + звук), не файл пользователя
    await removeDiskCopy(job, { permanently: true });
    removed++;
  }
  if (removed) log.info("Диск", `не хватало места — убраны копии готовых видео: ${removed}`);
  return removed;
}

// ---------- список видео между запусками (настройка keepQueue, см. persist.js) ----------
// Сохраняем через 3 с после изменения (событий бывает много подряд, а в списке из сотни видео — мегабайты)
// и по очереди — записи не пересекаются.
let persistTimer = null;
let persistChain = Promise.resolve();
// восстановленные недоделанные видео ждут, пока окно покажет список: иначе свежие события карточки пришли бы
// раньше сохранённых шагов и были бы ими затёрты
let holdQueue = false;

function schedulePersist() {
  if (!loadSettings().keepQueue) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => persistNow(), 3000);
}

function persistNow() {
  clearTimeout(persistTimer);
  persistTimer = null;
  persistChain = persistChain.then(async () => {
    const list = order.map((id) => jobs.get(id)).filter(Boolean);
    await saveQueue(list.map((j) => serializeJob(j, profilePath(j.id))), order);
  }).catch((e) => log.warn("очередь", "список видео не сохранён", e));
  return persistChain;
}

/** Временная папка прошлого запуска: всё, кроме кэша восстановленных видео (их переводы и звук оригинала). */
function cleanWorkRoot(keepIds) {
  const root = workRoot();
  const cache = path.join(root, "cache");
  try {
    if (!keepIds.length) {
      rmSync(root, { recursive: true, force: true });
      return;
    }
    for (const name of readdirSync(root)) if (name !== "cache") rmSync(path.join(root, name), { recursive: true, force: true });
    for (const name of readdirSync(cache)) {
      if (!keepIds.some((id) => name.startsWith(id))) rmSync(path.join(cache, name), { recursive: true, force: true });
    }
  } catch (e) {
    if (e.code !== "ENOENT") log.warn("запуск", "временные файлы прошлого запуска убраны не все", e);
  }
}

/** Видео прошлого запуска — в список; недоделанные — в очередь (продолжатся, когда окно покажет список). */
function restoreJobs(saved) {
  for (const rec of saved.jobs) {
    const job = { ...rec, controller: new AbortController(), no: ++jobCounter };
    if (job.state !== "queued" || (job.mode === "remux" && !job.translation)) job.mode = "translate";
    job.mode ??= "translate";
    hideVideo(job.file, job.no);
    jobs.set(job.id, job);
  }
  order = [...new Set([...saved.order.filter((id) => jobs.has(id)), ...jobs.keys()])];
  for (const id of order) if (jobs.get(id).state === "queued") queue.push(jobs.get(id));
  holdQueue = queue.length > 0;
  // окно не спросило список (сбой интерфейса) — не держим очередь вечно
  if (holdQueue) setTimeout(() => { holdQueue = false; pump(); }, 15_000);
  log.info("очередь", `восстановлено видео: ${jobs.size}${queue.length ? `, продолжаются: ${queue.length}` : ""}`);
}

// окно при запуске: восстановленный список (карточки с шагами, файлами и прослушиванием)
ipcMain.handle("jobs:list", () => {
  const list = order.map((id) => jobs.get(id)).filter(Boolean).map((j) => ({
    ...publicJob(j), outputs: j.outputs ?? [], hasTranslation: Boolean(j.translation), preview: previewInfo(j), error: j.error ?? "",
    steps: j.state === "queued" ? null : (j.steps ?? null),
  }));
  if (holdQueue) {
    holdQueue = false;
    setTimeout(pump, 0); // после ответа окну
  }
  return list;
});

// ---------- уведомления Windows ----------
// Имя программы для Windows (AppUserModelID). У установленной оно же стоит на ярлыке в «Пуске».
const AUMID = app.isPackaged ? "io.github.solidsnake1765.localvot" : "io.github.solidsnake1765.localvot.dev";
let aumidRegistered = null; // промис регистрации (делается один раз)

/**
 * Windows показывает уведомления только «знакомым» программам. У запуска из исходников и у портативной
 * версии нет ярлыка в «Пуске», поэтому регистрируем имя и значок в реестре пользователя
 * (HKCU\Software\Classes\AppUserModelId\<AUMID>) — официальный способ для программ без ярлыка.
 * Делается при первом уведомлении (выключены — в реестр ничего не пишем); деинсталлятор ключ убирает.
 */
function registerAumid() {
  if (process.platform !== "win32") return Promise.resolve();
  aumidRegistered ??= writeAumid();
  return aumidRegistered;
}
async function writeAumid() {
  const key = `HKCU\\Software\\Classes\\AppUserModelId\\${AUMID}`;
  const icon = app.isPackaged ? path.join(process.resourcesPath, "icon.png") : path.join(ROOT, "assets", "icon-512.png");
  const name = app.isPackaged ? "Local VOT" : "Local VOT (разработка)";
  try {
    for (const [value, data] of [["DisplayName", name], ["IconUri", icon]]) {
      await promisify(execFile)("reg", ["add", key, "/v", value, "/t", "REG_SZ", "/d", data, "/f"], { windowsHide: true });
    }
  } catch (e) {
    log.warn("уведомления", "не удалось зарегистрировать программу в Windows", e);
  }
}

/**
 * Уведомление — только если окно не на переднем плане (иначе и так всё видно) и не выключено в
 * настройках (force — кнопка «Проверить»). Плюс мигание значка на панели задач, пока окно не откроют.
 */
async function notify(title, body, { force = false } = {}) {
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
  await registerAumid(); // до первого показа: иначе Windows не знает программу и молча не покажет
  if (!win) return false;
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

/**
 * Перевод этого видео уже лежит рядом с ним или в папке сохранения (любой из наших файлов).
 * existing — все файлы этих папок (полные пути в нижнем регистре): папку читаем один раз, а не
 * проверяем каждое возможное имя на диске — на жёстком диске это сотни обращений на каждое видео.
 */
function alreadyTranslated(file, outputDir, existing) {
  const { dir, name } = path.parse(file);
  const names = [];
  for (const tag of ["RU", "RU живые"]) {
    names.push(...VIDEO_EXT.map((e) => `${name} [${tag}].${e}`), `${name} [${tag}].m4a`, `${name} [${tag}, голос].mp3`);
  }
  names.push(`${name} [RU].srt`);
  return [dir, outputDir].filter(Boolean).some((d) => names.some((n) => existing.has(path.join(d, n).toLowerCase())));
}

/** Все файлы папки, включая вложенные (полные пути); нет доступа — пусто. */
async function filesInFolder(dir, recursive = true) {
  try {
    const entries = await readdir(dir, { recursive, withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
  } catch {
    return [];
  }
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
    if (!(await stat(p).catch(() => null))) continue;
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
      await rename(files[i], p);
      files[i] = p;
    } catch { /* остаётся с номером — не страшно */ }
  }
  return { files: [...kept, ...files], stuck };
}

/**
 * Добавляет в очередь файлы и папки. Из папок берём только то, что ещё не переведено; видео,
 * которые уже есть в списке, не дублируем. Возвращает добавленные задания и пояснение, что пропущено.
 */
async function addJobs(paths) {
  const settings = loadSettings();
  const { livelyVoice: lively, sourceLang } = settings;
  const lang = lively ? LIVELY_LANG : sourceLang;
  const skipped = { inList: 0, translated: 0, outputs: 0 };
  let foldersEmpty = 0;
  const rejected = []; // отдельные файлы, которые не видео (в папках прочие файлы просто не берём)
  const files = [];
  // папка сохранения — один раз на всё добавление (в ней ищем уже готовые переводы)
  let outputFiles = null;
  for (const p of paths) {
    const info = await stat(p).catch(() => null);
    if (!info) { rejected.push(p); continue; }
    if (!info.isDirectory()) {
      if (isVideo(p)) files.push(p);
      else rejected.push(p);
      continue;
    }
    const all = await filesInFolder(p);
    if (settings.outputDir && !outputFiles) outputFiles = await filesInFolder(settings.outputDir, false);
    const existing = new Set([...all, ...(outputFiles ?? [])].map((f) => f.toLowerCase()));
    const found = all.filter(isVideo).sort((a, b) => a.localeCompare(b, "ru", { numeric: true }));
    if (!found.length) foldersEmpty++;
    for (const file of found) {
      if (isOurOutput(file)) skipped.outputs++;
      else if (alreadyTranslated(file, settings.outputDir, existing)) skipped.translated++;
      else files.push(file);
    }
  }
  // размеры — только для журнала; все сразу, а не по одному
  const sizes = new Map(await Promise.all(files.map(async (f) => [f, (await stat(f).catch(() => null))?.size ?? 0])));
  // что уже в списке — после всех ожиданий: пока читались папки, могли добавить что-то ещё (вторую папку);
  // дальше до конца функции ожиданий нет, так что одно видео дважды не попадёт
  const inList = new Set([...jobs.values()].map((j) => path.resolve(j.file).toLowerCase()));
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
    const bytes = sizes.get(file) ?? 0;
    log.info(`видео #${no}`, `добавлено: ${path.extname(file).slice(1).toUpperCase()}, ${(bytes / 1024 ** 3).toFixed(2)} ГБ`);
    const job = { id: randomUUID(), no, file, name: path.basename(file), state: settings.autoStart ? "queued" : "idle",
      controller: new AbortController(), lively, lang, diskPath: null, duration: null, voiceUsed: null, langUsed: null };
    jobs.set(job.id, job);
    order.push(job.id);
    if (settings.autoStart) queue.push(job);
    added.push(publicJob(job));
  }
  queueMicrotask(pump);
  schedulePersist();
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
  schedulePersist();
});

// ---------- что сохранять для видео ----------
// Как со звуком: пока в карточке ничего не меняли (save = null), видео сохраняется по настройкам справа
// (и следует за их изменениями); поменяли в карточке — у видео свой набор, сброс — снова как в настройках.
const SAVE_KEYS = ["saveVideo", "videoFormat", "embedSubs", "saveAudio", "saveVoice", "saveSubs"];
const pickSave = (o) => Object.fromEntries(SAVE_KEYS.map((k) => [k, o[k]]));

ipcMain.handle("jobs:setSave", (_e, id, patch) => {
  const job = jobs.get(id);
  if (!job) return null;
  if (patch === null) {
    job.save = null;
  } else {
    const clean = Object.fromEntries(Object.entries(patch ?? {}).filter(([k]) => SAVE_KEYS.includes(k)));
    job.save = { ...(job.save ?? pickSave(loadSettings())), ...clean };
  }
  schedulePersist();
  return job.save;
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
      { ...settings, origLoudness: job.origLoudness ?? null, origProfile: job.origProfile ?? null,
        voiceAnalysis: job.translation.analysis },
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
  // не ждём: удаление сотен мегабайт не должно задерживать окно (при выходе папку всё равно уберёт shutdown)
  rm(translationCacheDir(job.id), { recursive: true, force: true }).catch(() => {});
  rm(origAudioPath(job.id), { force: true }).catch(() => {});
  rm(profilePath(job.id), { force: true }).catch(() => {});
}

/** permanently — мимо Корзины Диска независимо от настройки (Корзина тоже занимает место на Диске). */
async function removeDiskCopy(job, { permanently = null } = {}) {
  if (!job.diskPath) return;
  const diskPath = job.diskPath;
  job.diskPath = null;
  const cloud = cloudOf(diskPath);
  const token = await cloud.auth.getToken().catch(() => null);
  if (!token) return;
  const { deletePermanently } = loadSettings();
  await cloud.api.unpublish(token, diskPath).catch(() => {});
  await cloud.api.remove(token, diskPath, { permanently: permanently ?? deletePermanently }).catch(() => {});
}

/**
 * Останавливает всё и ждёт идущие задания (не дольше 20 с). Дальше — по настройке keepQueue:
 * выключена — убирает копии с Диска и всю временную папку; включена — сохраняет список (идущие и ждущие
 * видео продолжатся при следующем запуске), копии на Диске и кэш переводов оставляет.
 */
async function shutdown() {
  const keep = Boolean(loadSettings().keepQueue);
  log.info("выход", `закрытие программы; видео в списке: ${jobs.size}${running.size ? `, идёт перевод: ${running.size} — прерываем` : ""}`
    + (keep ? "; список сохраняется" : ""));
  // недоделанные продолжатся при следующем запуске — тем же делом (идущее после отмены станет «отменено»,
  // а его mode сбросится на перевод — запоминаем до отмены)
  for (const j of jobs.values()) {
    if (["queued", "running"].includes(j.state)) Object.assign(j, { resume: true, resumeMode: j.mode });
  }
  queue.length = 0;
  for (const j of jobs.values()) j.controller.abort();
  if (running.size) {
    await Promise.race([Promise.all(running.values()), new Promise((r) => setTimeout(r, 20_000))]);
  }
  await stopThumbHelper(); // его служебные файлы — во временной папке
  if (keep) {
    await persistNow();
    cleanWorkRoot([...jobs.keys()]);
    return;
  }
  removeQueueFile();
  await Promise.race([
    Promise.all([...jobs.values()].map(removeDiskCopy)),
    new Promise((r) => setTimeout(r, 20_000)),
  ]);
  await rm(workRoot(), { recursive: true, force: true, maxRetries: 3 }).catch((e) => log.warn("выход", "временная папка убрана не вся", e));
}

/** Копии, оставшиеся с прошлого раза (приложение упало или его закрыли снятием задачи); only — одно облако. */
async function purgeLeftovers(only = null) {
  const { deletePermanently } = loadSettings();
  const inUse = new Set([...jobs.values()].map((j) => j.diskPath).filter(Boolean));
  for (const cloud of CLOUDS) {
    if (only && cloud !== only) continue;
    const token = await cloud.auth.getToken().catch(() => null);
    if (!token) continue;
    let removed = 0;
    for (const p of await cloud.api.listAppFolder(token)) {
      if (inUse.has(p)) continue;
      await cloud.api.remove(token, p, { permanently: deletePermanently })
        .then(() => { removed++; })
        .catch((e) => log.warn(cloud.title, "не удалось убрать старую копию", e));
    }
    if (removed) log.info(cloud.title, `убрано копий с прошлого запуска: ${removed}`);
  }
}

// ---------- облака: вход и выход (одинаково для всех, см. clouds.js) ----------
/** Вход в облако: { loggedIn, name, usedBytes, totalBytes } (offline — вход есть, но облако не ответило). */
async function cloudStatus(cloud) {
  const token = await cloud.auth.getToken().catch(() => null);
  if (!token) return { loggedIn: false };
  try {
    const account = await cloud.auth.getAccount(token);
    return account ? { loggedIn: true, ...account } : { loggedIn: false };
  } catch (e) {
    return { loggedIn: true, name: cloud.who, offline: e.message };
  }
}

let login = null; // { cloud, controller, codeUrl } — идущий вход (один на всех)
ipcMain.handle("cloud:list", () => publicClouds());
ipcMain.handle("cloud:status", async () =>
  Object.fromEntries(await Promise.all(CLOUDS.map(async (c) => [c.id, await cloudStatus(c)]))));
ipcMain.handle("cloud:login", async (_e, id) => {
  const cloud = cloudById(id);
  login?.controller.abort();
  const current = { cloud, controller: new AbortController(), codeUrl: "" };
  login = current;
  // что показать человеку — по способу входа облака: код на странице сервиса или страница в браузере
  const ui = {
    showCode: (code) => {
      current.codeUrl = code.url;
      send("cloud:code", { id: cloud.id, ...code });
      shell.openExternal(code.url);
    },
    openUrl: (url) => shell.openExternal(url),
  };
  try {
    await cloud.auth.login(ui, current.controller.signal);
    purgeLeftovers(cloud);
    log.info("вход", `вход в ${cloud.who} выполнен`);
    return { ok: true };
  } catch (e) {
    if (!/отмен/i.test(e.message)) log.warn("вход", `вход в ${cloud.who} не удался`, e);
    return { ok: false, error: e.message };
  } finally {
    if (login === current) login = null;
  }
});
ipcMain.handle("cloud:cancel", () => login?.controller.abort());
ipcMain.handle("cloud:logout", async (_e, id) => {
  const cloud = cloudById(id);
  log.info("вход", `выход из ${cloud.who}`);
  // Копии видео лежат в облаке этого аккаунта: после выхода их уже не убрать, а «Перевести заново» искало бы
  // их в облаке нового аккаунта (и падало с «копия пропала»). Убираем сейчас, пока вход действует; идущие
  // переводы окно перед этим отменило — дожидаемся, пока они закроют ссылки
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  if (running.size) await Promise.race([Promise.all(running.values()), wait(20_000)]);
  const own = [...jobs.values()].filter((j) => j.diskPath && cloudOf(j.diskPath) === cloud);
  await Promise.race([Promise.all(own.map((j) => removeDiskCopy(j))), wait(20_000)]);
  await cloud.auth.logout();
});
// страница для кода входа — только та, что программа сама показала (адрес приходит из интерфейса)
ipcMain.handle("cloud:openCodePage", () => { if (login?.codeUrl) shell.openExternal(login.codeUrl); });

// ---------- IPC ----------
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
  if (patch && "diskJobs" in patch) wakeDiskTurn();
  if (patch && "keepQueue" in patch) {
    if (patch.keepQueue) persistNow();
    else removeQueueFile();
  }
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
  schedulePersist();
});
// голос для видео: пока перевод не начался — просто запоминаем; после — интерфейс предложит пересоздать
ipcMain.handle("jobs:setVoice", (_e, id, lively) => {
  const job = jobs.get(id);
  if (job) job.lively = Boolean(lively);
  schedulePersist();
});
ipcMain.handle("jobs:setLang", (_e, id, lang) => {
  const job = jobs.get(id);
  if (job && SOURCE_LANGS.some((l) => l.code === lang)) job.lang = lang;
  schedulePersist();
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
  schedulePersist();
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
// «Показать в папке» у видео в очереди — сам исходник (только видео из списка, по id)
ipcMain.handle("jobs:showSource", (_e, id) => {
  const job = jobs.get(id);
  if (job) shell.showItemInFolder(path.normalize(job.file));
});

// ---------- миниатюры видео ----------
// Как в проводнике: миниатюру даёт сама Windows (тем же механизмом, что и проводник, из её кэша — мгновенно).
// Делает её скрытый помощник в отдельном процессе (thumbs.js): Windows занимает поток, пока читает видео,
// и в самой программе окно стояло бы — на жёстком диске секундами на каждое видео.
// Не умеет (нет кодека, например HEVC без расширения) — кадр через ffmpeg. Не больше двух сразу, чтобы
// добавление папки из десятков видео не нагружало компьютер. Готовые храним, пока видео в списке.
const thumbs = new Map(); // id → промис data:-адреса картинки (или null)
const thumbTurn = limiter(2);

async function makeThumb(job) {
  const release = await thumbTurn.acquire();
  try {
    if (!jobs.has(job.id)) return null; // пока ждало очереди, видео убрали из списка
    const file = path.normalize(job.file); // Windows нужен путь с обратными слэшами
    const url = await windowsThumb(file);
    if (url) return url;
    const { duration } = await probe(file, undefined, 20_000).catch(() => ({ duration: 0 }));
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
    // со «Сохранять список» — всегда через shutdown: он дописывает список (последние изменения ждут секунду)
    if (closing || quittingAfterShutdown || (!running.size && queue.length === 0 && !hasCopies && !loadSettings().keepQueue)) return;
    e.preventDefault();
    if (running.size || queue.length) {
      const { response } = await dialog.showMessageBox(win, {
        type: "question",
        buttons: ["Закрыть", "Продолжить перевод"],
        defaultId: 1,
        cancelId: 1,
        title: "Local VOT",
        message: "Идёт перевод. Закрыть приложение?",
        detail: loadSettings().keepQueue
          ? "Перевод прервётся и продолжится при следующем запуске программы."
          : "Перевод прервётся, загруженные копии будут удалены с Диска.",
      });
      if (response !== 0) return;
    }
    closing = true;
    win.setTitle(loadSettings().keepQueue ? "Local VOT — сохраняем список…" : "Local VOT — убираем файлы с Диска…");
    await shutdown();
    win.close();
  });
  win.on("focus", () => win.flashFrame(false)); // уведомление увидели — значок больше не мигает
  win.on("closed", () => { win = null; });
}

if (process.platform === "win32") app.setAppUserModelId(AUMID);
app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});
if (primary) app.whenReady().then(() => {
  log.info("запуск", `Local VOT ${app.getVersion()} (${isPortable() ? "портативная" : app.isPackaged ? "установленная" : "разработка"}), `
    + `Windows ${os.release()} ${process.arch}, Electron ${process.versions.electron}, ffmpeg встроенный`);
  // список прошлого запуска (настройка «Сохранять список видео») — до уборки: его кэш и копии на Диске остаются;
  // остальное во временной папке (и всё, если списка нет) — от прошлого запуска, в том числе аварийного
  const saved = loadSettings().keepQueue ? loadQueue() : null;
  if (saved?.jobs.length) restoreJobs(saved);
  cleanWorkRoot([...jobs.keys()]);
  createWindow();
  purgeLeftovers(); // копии восстановленных видео не трогает: они в jobs
});
app.on("window-all-closed", () => app.quit());
