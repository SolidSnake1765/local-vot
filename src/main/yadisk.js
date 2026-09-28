// Яндекс Диск через официальный REST API: загрузка в папку приложения
// («Приложения/<имя приложения>»), публикация, снятие публикации, удаление.
import { createReadStream, statSync } from "node:fs";
import https from "node:https";
import path from "node:path";
import { log } from "./log.js";

const API = "https://cloud-api.yandex.net/v1/disk";
const RETRY_DELAYS = [2_000, 5_000, 10_000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Диск режет загрузку через API до ~128 КиБ/с для видео, архивов и т.п. — скорость назначается
// при выдаче ссылки на загрузку. Если запросить ссылку от имени официальной программы Диска,
// ограничения нет (так делает библиотека yadisk, spoof_user_agent). Проверено 2026-09-28:
// 20 МБ за 1 с вместо 160 с. Намеренное ограничение Яндекса — лазейку могут закрыть.
const UPLOAD_LINK_HEADERS = { "User-Agent": 'Yandex.Disk {"os":"windows"}' };

async function api(token, method, endpoint, params = {}, signal, extraHeaders = {}) {
  const url = `${API}${endpoint}?${new URLSearchParams(params)}`;
  // Диск иногда отвечает 500/503 на ровном месте — повторяем; 4xx (нет прав, нет файла) не повторяем
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { method, headers: { ...extraHeaders, Authorization: `OAuth ${token}` }, signal });
    } catch (e) {
      if (signal?.aborted || attempt >= RETRY_DELAYS.length) throw e;
      log.warn("Диск", `${method} ${endpoint}: сбой сети, повтор ${attempt + 1}`, e);
      await sleep(RETRY_DELAYS[attempt]);
      continue;
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (res.ok) return data;
    if (res.status >= 500 && attempt < RETRY_DELAYS.length) {
      log.warn("Диск", `${method} ${endpoint}: ответ ${res.status}, повтор ${attempt + 1}`);
      await sleep(RETRY_DELAYS[attempt]);
      continue;
    }
    log.warn("Диск", `${method} ${endpoint}: ответ ${res.status}`, data.message ?? data.error ?? text.slice(0, 300));
    if (res.status === 401) throw new Error("Вход в Яндекс устарел — войдите заново");
    if (res.status === 507) throw new Error("На Яндекс Диске не хватает места");
    throw new Error(`Диск: ${data.message ?? data.error ?? text} (${res.status})`);
  }
}

/** Отправляет файл по адресу загрузки с отслеживанием прогресса. */
function putFile(href, file, onProgress, signal) {
  const size = statSync(file).size;
  return new Promise((resolve, reject) => {
    const req = https.request(href, { method: "PUT", headers: { "Content-Length": size }, signal }, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => (res.statusCode < 300
        ? resolve()
        : reject(new Error(`Диск: загрузка не удалась (${res.statusCode}) ${body}`))));
    });
    req.on("error", (e) => reject(signal?.aborted ? new Error("Отменено") : e));
    let sent = 0;
    const stream = createReadStream(file, { highWaterMark: 64 * 1024 });
    stream.on("data", (chunk) => {
      sent += chunk.length;
      onProgress?.({ phase: "sending", sent, size });
    });
    // Если ограничение скорости всё же сработало, байты уходят из программы за секунды (их забирает
    // сеть / VPN-клиент), а сервер отвечает «принято» минуты спустя — это отдельная фаза ожидания.
    stream.on("end", () => onProgress?.({ phase: "waiting", sent: size, size }));
    stream.on("error", reject);
    stream.pipe(req);
  });
}

/** Загружает файл в папку приложения, возвращает путь на Диске (app:/...). */
export async function upload(token, file, onProgress, signal) {
  const diskPath = `app:/${Date.now()}-${path.basename(file).replace(/[^\w.-]+/g, "_")}`;
  const { href } = await api(token, "GET", "/resources/upload", { path: diskPath, overwrite: "true" }, signal,
    UPLOAD_LINK_HEADERS);
  await putFile(href, file, onProgress, signal);
  return diskPath;
}

/** Публикует файл и возвращает публичную ссылку (https://disk.yandex.ru/i/...). */
export async function publish(token, diskPath, signal) {
  await api(token, "PUT", "/resources/publish", { path: diskPath }, signal);
  const meta = await api(token, "GET", "/resources", { path: diskPath, fields: "public_url" }, signal);
  if (!meta.public_url) throw new Error("Диск не выдал публичную ссылку");
  return meta.public_url;
}

export async function unpublish(token, diskPath) {
  await api(token, "PUT", "/resources/unpublish", { path: diskPath });
}

/** Свободное место на Яндекс Диске, байт. */
export async function freeSpace(token, signal) {
  const d = await api(token, "GET", "", { fields: "total_space,used_space" }, signal);
  return d.total_space - d.used_space;
}

/** Файлы в папке приложения на Диске (там лежат только наши копии). */
export async function listAppFolder(token) {
  try {
    const data = await api(token, "GET", "/resources", { path: "app:/", limit: "200", fields: "_embedded.items.path" });
    return (data._embedded?.items ?? []).map((i) => i.path);
  } catch {
    return []; // папки ещё нет — значит, и убирать нечего
  }
}

/** Удаляет файл: в Корзину Диска или насовсем. */
export async function remove(token, diskPath, { permanently = false } = {}) {
  const data = await api(token, "DELETE", "/resources", { path: diskPath, permanently: String(permanently) });
  // удаление может идти в фоне — ждём завершения операции
  if (!data.href?.includes("/operations/")) return;
  const opId = data.href.split("/operations/")[1];
  for (let i = 0; i < 60; i++) {
    const op = await api(token, "GET", `/operations/${opId}`);
    if (op.status === "success") return;
    if (op.status === "failed") throw new Error("Диск: удаление не удалось");
    await sleep(1000);
  }
}
