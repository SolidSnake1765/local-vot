// Работа с Яндекс Диском через официальный REST API: загрузка в папку приложения
// («Приложения/<имя приложения>»), публикация, снятие публикации, удаление.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const API = "https://cloud-api.yandex.net/v1/disk";

const RETRY_DELAYS = [2_000, 5_000, 10_000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(token, method, endpoint, params = {}) {
  const url = `${API}${endpoint}?${new URLSearchParams(params)}`;
  // Диск иногда отвечает 500/503 на ровном месте — повторяем; 4xx (нет прав, нет файла) не повторяем
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { method, headers: { Authorization: `OAuth ${token}` } });
    } catch (e) {
      if (attempt >= RETRY_DELAYS.length) throw e;
      await sleep(RETRY_DELAYS[attempt]);
      continue;
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (res.ok) return data;
    if (res.status >= 500 && attempt < RETRY_DELAYS.length) {
      await sleep(RETRY_DELAYS[attempt]);
      continue;
    }
    throw new Error(`Диск: ${method} ${endpoint} → ${res.status} ${data.message ?? data.error ?? text}`);
  }
}

/** Ждёт завершения асинхронной операции Диска (удаление папок и т.п. могут идти в фоне). */
async function waitOperation(token, data) {
  if (!data.href || !data.href.includes("/operations/")) return;
  const id = data.href.split("/operations/")[1];
  for (let i = 0; i < 60; i++) {
    const op = await api(token, "GET", `/operations/${id}`);
    if (op.status === "success") return;
    if (op.status === "failed") throw new Error("Диск: операция не удалась");
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Загружает файл в папку приложения, возвращает путь на Диске (app:/...). */
export async function upload(token, file, onProgress) {
  const diskPath = `app:/${Date.now()}-${path.basename(file).replace(/[^\w.-]+/g, "_")}`;
  const { href, method } = await api(token, "GET", "/resources/upload", { path: diskPath, overwrite: "true" });
  const size = statSync(file).size;
  onProgress?.(0, size);
  // файл облегчённый (десятки МБ) — читаем целиком, без потоковой отправки
  const res = await fetch(href, { method, body: readFileSync(file) });
  if (!res.ok) throw new Error(`Диск: загрузка не удалась → ${res.status} ${await res.text()}`);
  onProgress?.(size, size);
  return diskPath;
}

/** Публикует файл и возвращает публичную ссылку (https://disk.yandex.ru/i/...). */
export async function publish(token, diskPath) {
  await api(token, "PUT", "/resources/publish", { path: diskPath });
  const meta = await api(token, "GET", "/resources", { path: diskPath, fields: "public_url" });
  if (!meta.public_url) throw new Error("Диск не выдал публичную ссылку");
  return meta.public_url;
}

export async function unpublish(token, diskPath) {
  await api(token, "PUT", "/resources/unpublish", { path: diskPath });
}

/** Удаляет файл. permanently=false — в Корзину Диска (можно восстановить). */
export async function remove(token, diskPath, { permanently = false } = {}) {
  const data = await api(token, "DELETE", "/resources", { path: diskPath, permanently: String(permanently) });
  await waitOperation(token, data);
}
