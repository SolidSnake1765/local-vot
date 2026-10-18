// Google Диск через Drive API v3 — то же, что yadisk.js для Яндекс Диска: загрузка копии, доступ по ссылке,
// закрытие доступа, удаление. Право программы — drive.file: она видит только свои файлы. Копии лежат в папке
// «Local VOT — копии для перевода»; свои файлы программа узнаёт по пометке appProperties (localvot).
// Путь копии в задании — «gdrive:<id файла>» (так main.js отличает её от копии на Яндекс Диске).
import { createReadStream, statSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { log } from "./log.js";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const FOLDER_NAME = "Local VOT — копии для перевода";
export const PREFIX = "gdrive:";
const RETRY_DELAYS = [2_000, 5_000, 10_000];
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new Error("Отменено"));
  const onAbort = () => { clearTimeout(t); reject(new Error("Отменено")); };
  const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
});

const fileId = (ref) => String(ref).slice(PREFIX.length);
const q = (s) => encodeURIComponent(s);

/** Ошибка Google → понятная; retry — временная (повторить). */
function driveError(status, data, text) {
  const reason = data.error?.errors?.[0]?.reason ?? data.error?.status ?? "";
  const message = data.error?.message ?? text.slice(0, 200);
  if (status === 401) return new Error("Вход в Google устарел — войдите заново");
  if (/storageQuotaExceeded|quotaExceeded/.test(reason) && !/rate/i.test(reason)) return new Error("На Google Диске не хватает места");
  const retry = status >= 500 || status === 429 || /rateLimitExceeded|userRateLimitExceeded|backendError/.test(reason);
  return Object.assign(new Error(`Google Диск: ${message} (${status})`), { retry, status });
}

async function api(token, method, url, { body, signal, ok404 = false } = {}) {
  // Google иногда отвечает 500/503 и «слишком часто» (429, 403 rateLimit) — повторяем; остальное — сразу
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { method, signal, headers: { Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json; charset=UTF-8" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    } catch (e) {
      if (signal?.aborted || attempt >= RETRY_DELAYS.length) throw e;
      log.warn("Google Диск", `${method}: сбой сети, повтор ${attempt + 1}`, e);
      await sleep(RETRY_DELAYS[attempt], signal);
      continue;
    }
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { /* не JSON */ }
    if (res.ok || (ok404 && res.status === 404)) return data;
    const e = driveError(res.status, data, text);
    if (e.retry && attempt < RETRY_DELAYS.length) {
      log.warn("Google Диск", `${method}: ответ ${res.status}, повтор ${attempt + 1}`);
      await sleep(RETRY_DELAYS[attempt], signal);
      continue;
    }
    log.warn("Google Диск", `${method}: ответ ${res.status}`, data.error?.message ?? text.slice(0, 300));
    throw e;
  }
}

/** Папка для копий: своя, созданная программой (её человек может и удалить — тогда создаём заново). */
async function folder(token, signal) {
  const found = await api(token, "GET", `${API}/files?q=${q("appProperties has { key='localvot' and value='folder' } and trashed=false")}`
    + "&fields=files(id)&pageSize=1&spaces=drive", { signal });
  if (found.files?.[0]) return found.files[0].id;
  const created = await api(token, "POST", `${API}/files?fields=id`, { signal,
    body: { name: FOLDER_NAME, mimeType: FOLDER_MIME, appProperties: { localvot: "folder" } } });
  return created.id;
}

/** Отправляет файл в начатую загрузку (сессию) с отслеживанием прогресса; вернёт id файла. */
function putFile(session, file, onProgress, signal) {
  const size = statSync(file).size;
  return new Promise((resolve, reject) => {
    // Google даёт адрес https; http — только у подставного сервера в проверках (tests/gdrive.test.mjs)
    const req = (session.startsWith("http:") ? http : https).request(session, { method: "PUT", headers: { "Content-Length": size, "Content-Type": "video/mp4" }, signal }, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => {
        let data = {};
        try { data = JSON.parse(body); } catch { /* не JSON */ }
        if (res.statusCode < 300 && data.id) return resolve(data.id);
        reject(driveError(res.statusCode, data, body));
      });
    });
    req.on("error", (e) => reject(signal?.aborted ? new Error("Отменено") : Object.assign(e, { retry: true })));
    let sent = 0;
    const stream = createReadStream(file, { highWaterMark: 64 * 1024 });
    stream.on("data", (chunk) => {
      sent += chunk.length;
      onProgress?.({ phase: "sending", sent, size });
    });
    stream.on("end", () => onProgress?.({ phase: "waiting", sent: size, size }));
    stream.on("error", reject);
    stream.pipe(req);
  });
}

/** Загружает файл в папку копий, возвращает «gdrive:<id>». */
export async function upload(token, file, onProgress, signal) {
  const parent = await folder(token, signal);
  const size = statSync(file).size;
  // обрыв связи или 5xx посреди загрузки — заново, с новой сессией; нехватка места — сразу
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${UPLOAD}?uploadType=resumable&fields=id`, { method: "POST", signal, headers: {
        Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": "video/mp4", "X-Upload-Content-Length": String(size),
      }, body: JSON.stringify({ name: `${Date.now()}-${path.basename(file)}`, mimeType: "video/mp4", parents: [parent],
        appProperties: { localvot: "copy" } }) });
      if (!res.ok) {
        const text = await res.text();
        let data = {};
        try { data = JSON.parse(text); } catch { /* не JSON */ }
        throw driveError(res.status, data, text);
      }
      return PREFIX + await putFile(res.headers.get("location"), file, onProgress, signal);
    } catch (e) {
      if (signal?.aborted) throw new Error("Отменено");
      if (!(e.retry || e instanceof TypeError) || attempt >= RETRY_DELAYS.length) throw e;
      log.warn("Google Диск", `загрузка: ${e.message}, повтор ${attempt + 1}`);
      await sleep(RETRY_DELAYS[attempt], signal);
    }
  }
}

/**
 * Открывает доступ «всем, у кого есть ссылка» и возвращает ссылку для переводчика. Каждый раз — новая
 * (добавка в конце): Яндекс помнит перевод по ссылке, а «Перевести заново» должно переводить заново.
 * Проверено 18.10: такую ссылку Яндекс переводит, а vot.js узнаёт по ней Google Диск.
 */
export async function publish(token, ref, signal) {
  const id = fileId(ref);
  await api(token, "POST", `${API}/files/${id}/permissions?fields=id`, { signal, body: { type: "anyone", role: "reader" } });
  return `https://drive.google.com/file/d/${id}/view?usp=sharing&lv=${Date.now().toString(36)}`;
}

export async function unpublish(token, ref) {
  // у доступа «всем по ссылке» постоянный id; уже закрыт — не ошибка
  await api(token, "DELETE", `${API}/files/${fileId(ref)}/permissions/anyoneWithLink`, { ok404: true });
}

/** Свободное место на Google Диске, байт (безлимитный — Infinity). */
export async function freeSpace(token, signal) {
  const { storageQuota: s = {} } = await api(token, "GET", `${API}/about?fields=storageQuota(limit,usage)`, { signal });
  return s.limit ? Number(s.limit) - Number(s.usage ?? 0) : Infinity;
}

/** Копии программы на Google Диске (по пометке, где бы они ни лежали). */
export async function listAppFolder(token) {
  try {
    const data = await api(token, "GET", `${API}/files?q=${q("appProperties has { key='localvot' and value='copy' } and trashed=false")}`
      + "&fields=files(id)&pageSize=200&spaces=drive");
    return (data.files ?? []).map((f) => PREFIX + f.id);
  } catch {
    return [];
  }
}

/** Удаляет копию: в Корзину Google Диска или насовсем. */
export async function remove(token, ref, { permanently = false } = {}) {
  const url = `${API}/files/${fileId(ref)}`;
  if (permanently) await api(token, "DELETE", url, { ok404: true });
  else await api(token, "PATCH", `${url}?fields=id`, { ok404: true, body: { trashed: true } });
}
