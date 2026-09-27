// Главный процесс: окно, вход в Яндекс, очередь заданий перевода.
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as auth from "./auth.js";
import { loadSettings, saveSettings } from "./config.js";
import { runJob, STEPS } from "./pipeline.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VIDEO_EXT = ["mp4", "mkv", "mov", "avi", "webm", "m4v", "wmv", "flv", "ts"];

let win = null;
const send = (channel, payload) => win?.webContents.send(channel, payload);

// ---------- очередь: задания выполняются по одному ----------
const jobs = new Map(); // id → { id, file, name, state, controller }
const queue = [];
let running = false;
let currentRun = null; // промис текущего задания — при выходе ждём его уборку на Диске

function publicJob(j) {
  return { id: j.id, file: j.file, name: j.name, state: j.state };
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
    currentRun = runJob(
      { id: job.id, file: job.file, options: loadSettings(), token },
      (patch) => send("job:update", { id: job.id, ...patch }),
      job.controller.signal,
    );
    const outputs = await currentRun;
    job.state = "done";
    send("job:update", { id: job.id, state: "done", outputs });
  } catch (e) {
    job.state = job.controller.signal.aborted ? "cancelled" : "error";
    send("job:update", { id: job.id, state: job.state, error: job.state === "error" ? e.message : "" });
  } finally {
    running = false;
    currentRun = null;
    pump();
  }
}

/** Останавливает всё и ждёт, пока текущее задание уберёт файл с Диска (не дольше 20 с). */
async function stopAll() {
  queue.length = 0;
  for (const j of jobs.values()) j.controller.abort();
  if (currentRun) {
    await Promise.race([currentRun.catch(() => {}), new Promise((r) => setTimeout(r, 20_000))]);
  }
}

function addJobs(files) {
  const added = [];
  for (const file of files) {
    const ext = path.extname(file).slice(1).toLowerCase();
    if (!VIDEO_EXT.includes(ext)) continue;
    const job = { id: randomUUID(), file, name: path.basename(file), state: "queued", controller: new AbortController() };
    jobs.set(job.id, job);
    queue.push(job);
    added.push(publicJob(job));
  }
  queueMicrotask(pump);
  return added;
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
ipcMain.handle("shell:showItem", (_e, p) => shell.showItemInFolder(p));

// ---------- окно ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 760,
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

  // закрытие посреди перевода: спросить и дать заданию убрать файл с Диска
  let closing = false;
  win.on("close", async (e) => {
    if (closing || (!running && queue.length === 0)) return;
    e.preventDefault();
    const { response } = await dialog.showMessageBox(win, {
      type: "question",
      buttons: ["Закрыть", "Продолжить перевод"],
      defaultId: 1,
      cancelId: 1,
      title: "Local VOT",
      message: "Идёт перевод. Закрыть приложение?",
      detail: "Перевод прервётся, загруженная копия будет удалена с Яндекс Диска.",
    });
    if (response !== 0) return;
    closing = true;
    win.setTitle("Local VOT — убираем файл с Диска…");
    await stopAll();
    win.close();
  });
  win.on("closed", () => { win = null; });
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
