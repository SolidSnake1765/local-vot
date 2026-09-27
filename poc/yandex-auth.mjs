// Вход в Яндекс по коду подтверждения (OAuth device flow): приложение показывает код,
// пользователь вводит его на странице Яндекса и разрешает доступ. Пароль приложение не видит.
// Токен сохраняется в .yandex-token.json (в git не попадает).
//
// node poc/yandex-auth.mjs          — войти (или показать, что уже вошли)
// node poc/yandex-auth.mjs logout   — забыть токен
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN_FILE = path.join(ROOT, ".yandex-token.json");
const OAUTH = "https://oauth.yandex.ru";

function appCredentials() {
  if (existsSync(path.join(ROOT, ".env"))) process.loadEnvFile(path.join(ROOT, ".env"));
  const { YANDEX_CLIENT_ID: id, YANDEX_CLIENT_SECRET: secret } = process.env;
  if (!id || !secret) throw new Error("Нет YANDEX_CLIENT_ID / YANDEX_CLIENT_SECRET в .env (см. .env.example)");
  return { id, secret };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postForm(url, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  return { status: res.status, data: await res.json() };
}

export async function login() {
  const { id, secret } = appCredentials();
  const code = await postForm(`${OAUTH}/device/code`, {
    client_id: id,
    device_id: `local-vot-${hostname()}`.replace(/[^\x21-\x7e]/g, "").slice(0, 50).padEnd(6, "0"),
    device_name: `Local VOT (${hostname()})`.slice(0, 100),
  });
  if (code.status !== 200) throw new Error(`Яндекс не выдал код: ${JSON.stringify(code.data)}`);
  const { device_code, user_code, verification_url, interval = 5, expires_in = 300 } = code.data;

  console.log(`\nОткройте ${verification_url} и введите код:  ${user_code}\n`);
  spawn("cmd", ["/c", "start", "", verification_url], { detached: true, stdio: "ignore" }).unref();

  const deadline = Date.now() + expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const tok = await postForm(`${OAUTH}/token`, {
      grant_type: "device_code", code: device_code, client_id: id, client_secret: secret,
    });
    if (tok.status === 200) {
      const token = { ...tok.data, obtained_at: Date.now() };
      writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 1));
      return token;
    }
    if (tok.data.error !== "authorization_pending") {
      throw new Error(`Вход не удался: ${tok.data.error} ${tok.data.error_description ?? ""}`);
    }
  }
  throw new Error("Код устарел — запустите вход заново");
}

async function refresh(token) {
  const { id, secret } = appCredentials();
  const tok = await postForm(`${OAUTH}/token`, {
    grant_type: "refresh_token", refresh_token: token.refresh_token, client_id: id, client_secret: secret,
  });
  if (tok.status !== 200) return null;
  const fresh = { ...tok.data, obtained_at: Date.now() };
  writeFileSync(TOKEN_FILE, JSON.stringify(fresh, null, 1));
  return fresh;
}

/** Действующий токен: из файла, при необходимости обновлённый; иначе — вход заново. */
export async function getToken() {
  if (existsSync(TOKEN_FILE)) {
    let token = JSON.parse(readFileSync(TOKEN_FILE, "utf8"));
    const expiresAt = token.obtained_at + token.expires_in * 1000;
    if (Date.now() < expiresAt - 24 * 3600_000) return token.access_token;
    token = token.refresh_token ? await refresh(token) : null;
    if (token) return token.access_token;
  }
  return (await login()).access_token;
}

export function logout() {
  rmSync(TOKEN_FILE, { force: true });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv[2] === "logout") {
    logout();
    console.log("Токен удалён");
  } else {
    const access = await getToken();
    const me = await fetch("https://cloud-api.yandex.net/v1/disk/", { headers: { Authorization: `OAuth ${access}` } });
    const disk = await me.json();
    if (!me.ok) throw new Error(`Диск не отвечает: ${JSON.stringify(disk)}`);
    const gb = (b) => (b / 1024 ** 3).toFixed(1);
    console.log(`Вход выполнен: ${disk.user?.display_name ?? disk.user?.login}. Диск: занято ${gb(disk.used_space)} из ${gb(disk.total_space)} ГБ`);
  }
}
