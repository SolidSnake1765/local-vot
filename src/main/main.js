// Главный процесс: окно, вход в Яндекс, очередь заданий перевода.
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as auth from "./auth.js";
import { loadSettings, saveSettings } from "./config.js";
import * as disk from "./yadisk.js";
import { runJob, STEPS } from "./pipeline.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VIDEO_EXT = ["mp4", "mkv", "mov", "avi", "webm", "m4v", "wmv", "flv", "ts"];

let win = null;
const send = (channel, payload) => win?.webContents.send(channel, payload);

// ---------- очередь: задания выполняются по одному ----------
// job: { id, file, name, state, controller, lively, diskPath, duration, voiceUsed }
// diskPath — закрытая копия на Диске: держим, пока видео в списке, чтобы переводить заново без загрузки
const jobs = new Map();
const queue = [];
let running = false;
let currentRun = null; // промис текущего задания — при выходе ждём, пока оно закроет ссылку

function publicJob(j) {
  return { id: j.id, file: j.file, name: j.name, state: j.state, lively: j.lively, voiceUsed: j.voiceUsed };
}

function enqueue(job) {
  job.controller = new AbortController();
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
    currentRun = runJob(job, { options: loadSettings(), token },
      (patch) => send("job:update", { id: job.id, ...patch }), job.controller.signal);
    const { outputs, lively } = await currentRun;
    job.state = "done";
    job.voiceUsed = lively;
    send("job:update", { id: job.id, state: "done", outputs, voiceUsed: lively });
  } catch (e) {
    job.state = job.controller.signal.aborted ? "cancelled" : "error";
    send("job:update", { id: job.id, state: job.state, error: job.state === "error" ? e.message : "" });
  } finally {
    running = false;
    currentRun = null;
    pump();
  }
}

function addJobs(files) {
  const lively = loadSettings().livelyVoice;
  const added = [];
  for (const file of files) {
    const ext = path.extname(file).slice(1).toLowerCase();
    if (!VIDEO_EXT.includes(ext)) continue;
    const job = { id: randomUUID(), file, name: path.basename(file), state: "queued", controller: new AbortController(),
      lively, diskPath: null, duration: null, voiceUsed: null };
    jobs.set(job.id, job);
    queue.push(job);
    added.push(publicJob(job));
  }
  queueMicrotask(pump);
  return added;
}

// ---------- копии на Диске ----------
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

ipcMain.handle("app:info", () => ({ steps: STEPS, version: app.getVersion() }));
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
// ещё один запрос к Яндексу (новая ссылка → свежий перевод) текущим голосом видео
ipcMain.handle("jobs:retranslate", (_e, id) => {
  const job = jobs.get(id);
  if (!job || !["done", "error", "cancelled"].includes(job.state)) return;
  enqueue(job);
});
ipcMain.handle("jobs:remove", async (_e, id) => {
  const job = jobs.get(id);
  if (!job || ["queued", "running"].includes(job.state)) return false;
  jobs.delete(id);
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
  createWindow();
  purgeLeftovers();
});
app.on("window-all-closed", () => app.quit());
