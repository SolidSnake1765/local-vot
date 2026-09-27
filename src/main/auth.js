// Вход в Яндекс по коду подтверждения (OAuth device flow): приложение показывает код,
// пользователь вводит его на странице Яндекса и разрешает доступ. Пароль приложение не видит.
// Токен хранится в папке данных приложения, зашифрованный средствами Windows (safeStorage).
import { app, safeStorage } from "electron";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { getCredentials } from "./config.js";

const OAUTH = "https://oauth.yandex.ru";
const tokenFile = () => path.join(app.getPath("userData"), "yandex-token.bin");
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("Вход отменён")); }, { once: true });
});

function saveToken(token) {
  const json = JSON.stringify(token);
  const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json);
  writeFileSync(tokenFile(), data);
}

function loadToken() {
  if (!existsSync(tokenFile())) return null;
  const buf = readFileSync(tokenFile());
  try {
    return JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString());
  } catch {
    return null;
  }
}

async function postForm(url, params, signal) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    signal,
  });
  return { status: res.status, data: await res.json() };
}

/**
 * Вход. onCode({ userCode, url, expiresIn }) вызывается, когда код готов — его показывают пользователю.
 */
export async function login(onCode, signal) {
  const { id, secret } = getCredentials();
  const code = await postForm(`${OAUTH}/device/code`, {
    client_id: id,
    device_id: `local-vot-${hostname()}`.replace(/[^\x21-\x7e]/g, "").slice(0, 50).padEnd(6, "0"),
    device_name: `Local VOT (${hostname()})`.slice(0, 100),
  }, signal);
  if (code.status !== 200) throw new Error(`Яндекс не выдал код: ${code.data.error_description ?? code.data.error}`);
  const { device_code, user_code, verification_url, interval = 5, expires_in = 300 } = code.data;
  onCode({ userCode: user_code, url: verification_url, expiresIn: expires_in });

  const deadline = Date.now() + expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(interval * 1000, signal);
    const tok = await postForm(`${OAUTH}/token`, {
      grant_type: "device_code", code: device_code, client_id: id, client_secret: secret,
    }, signal);
    if (tok.status === 200) {
      saveToken({ ...tok.data, obtained_at: Date.now() });
      return;
    }
    if (tok.data.error !== "authorization_pending") {
      throw new Error(`Вход не удался: ${tok.data.error_description ?? tok.data.error}`);
    }
  }
  throw new Error("Код устарел — начните вход заново");
}

async function refresh(token) {
  const { id, secret } = getCredentials();
  const tok = await postForm(`${OAUTH}/token`, {
    grant_type: "refresh_token", refresh_token: token.refresh_token, client_id: id, client_secret: secret,
  });
  if (tok.status !== 200) return null;
  const fresh = { ...tok.data, obtained_at: Date.now() };
  saveToken(fresh);
  return fresh;
}

/** Действующий токен (при необходимости обновлённый) или null, если нужен вход. */
export async function getToken() {
  let token = loadToken();
  if (!token) return null;
  const expiresAt = token.obtained_at + token.expires_in * 1000;
  if (Date.now() < expiresAt - 24 * 3600_000) return token.access_token;
  token = token.refresh_token ? await refresh(token) : null;
  return token?.access_token ?? null;
}

/** Имя пользователя и место на Диске — заодно проверка, что токен рабочий. */
export async function getAccount(token) {
  const res = await fetch("https://cloud-api.yandex.net/v1/disk/", { headers: { Authorization: `OAuth ${token}` } });
  const disk = await res.json();
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(disk.message ?? `Диск ответил ${res.status}`);
  return {
    name: disk.user?.display_name || disk.user?.login || "Яндекс",
    usedBytes: disk.used_space,
    totalBytes: disk.total_space,
  };
}

export function logout() {
  rmSync(tokenFile(), { force: true });
}
