// Миниатюры видео, как в проводнике, — через скрытый помощник (thumbs-helper.js в отдельном процессе).
// Помощник запускается при первой миниатюре и сам закрывается, когда миниатюр долго не просят.
import { app } from "electron";
import { spawn } from "node:child_process";
import path from "node:path";
import { log } from "./log.js";
import { workRoot } from "./paths.js";

const IDLE_MS = 30_000;    // столько без запросов — и помощник закрывается
const TIMEOUT_MS = 20_000; // одна миниатюра дольше — помощника перезапускаем, а эту делает ffmpeg

let child = null;
let seq = 0;
const pending = new Map(); // id запроса → { resolve, timer }
let idleTimer = null;
let broken = false; // помощник не запускается вообще — дальше сразу ffmpeg

function startHelper() {
  // у собранной программы ключи идут сразу ей; у запуска из исходников первым идёт путь к проекту
  const args = [...(app.isPackaged ? [] : [app.getAppPath()]), "--thumbs-helper",
    `--thumbs-dir=${path.join(workRoot(), "thumbs-helper")}`];
  const proc = spawn(process.execPath, args, { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
  proc.on("error", (e) => {
    log.warn("миниатюры", "помощник не запустился — миниатюры через ffmpeg", e);
    broken = true;
    if (child === proc) child = null;
  });
  proc.on("exit", () => {
    if (child === proc) child = null;
    // недоделанные — через ffmpeg
    for (const { resolve, timer } of pending.values()) {
      clearTimeout(timer);
      resolve(null);
    }
    pending.clear();
  });
  proc.on("message", (msg) => {
    const req = pending.get(msg?.id);
    if (!req) return;
    pending.delete(msg.id);
    clearTimeout(req.timer);
    req.resolve(typeof msg.url === "string" ? msg.url : null);
    if (!pending.size) armIdle();
  });
  return proc;
}

function armIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(stopThumbHelper, IDLE_MS);
}

/** Миниатюра от Windows (data:-адрес PNG) или null — не вышло, пусть кадр сделает ffmpeg. */
export function windowsThumb(file) {
  if (broken) return Promise.resolve(null);
  clearTimeout(idleTimer);
  child ??= startHelper();
  const proc = child;
  if (!proc.connected) return Promise.resolve(null);
  const id = ++seq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      log.warn("миниатюры", "Windows делает миниатюру слишком долго — перезапуск помощника");
      pending.delete(id);
      resolve(null);
      if (child === proc) child = null;
      proc.kill(); // остальные ожидающие получат null при выходе помощника
    }, TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    proc.send({ id, file }, (e) => {
      if (!e) return;
      clearTimeout(timer);
      pending.delete(id);
      resolve(null);
    });
  });
}

/**
 * Закрыть помощника (простой или выход из программы). Промис — когда процесс завершился
 * (при выходе после этого убирается временная папка, где лежат его служебные файлы).
 */
export function stopThumbHelper() {
  clearTimeout(idleTimer);
  const proc = child;
  child = null;
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => proc.kill(), 3000); // не вышел сам — закрываем
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    if (proc.connected) proc.disconnect(); // помощник выходит сам, когда канал закрыт
    else proc.kill();
  });
}
