// Вход в Google для Google Диска: страница входа Google открывается в браузере, ответ принимает маленький
// сервер программы на 127.0.0.1 (так Google велит делать настольным программам — loopback + PKCE).
// Пароль программа не видит. Право — только drive.file: программа видит лишь файлы, которые создала сама.
// Токен хранится зашифрованным (secret.js).
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { getGoogleCredentials } from "./config.js";
import { tokenStore } from "./secret.js";

export const SCOPE = "https://www.googleapis.com/auth/drive.file";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const LOGIN_TIMEOUT = 10 * 60_000;
const store = tokenStore("google-token.bin");

const page = (title, text) => `<!doctype html><meta charset="utf-8"><title>Local VOT</title>
<body style="font:16px system-ui,sans-serif;background:#0f1320;color:#e6e9f2;display:grid;place-items:center;height:90vh">
<div style="text-align:center"><h2>${title}</h2><p>${text}</p></div>`;

async function postForm(params, signal) {
  const res = await fetch(TOKEN_URL, { method: "POST", body: new URLSearchParams(params), signal });
  let data = {};
  try { data = await res.json(); } catch { /* не JSON */ }
  return { ok: res.ok, data };
}

/**
 * Вход: ui.openUrl(url) открывает страницу Google в браузере (ui — общий для всех облаков, см. clouds.js);
 * вернётся, когда человек разрешит доступ.
 */
export async function login(ui, signal) {
  const { id, secret } = getGoogleCredentials();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const redirect = `http://127.0.0.1:${server.address().port}`;
  try {
    const code = await new Promise((resolve, reject) => {
      const fail = (e) => reject(e);
      const timer = setTimeout(() => fail(new Error("Вход не завершён за 10 минут — начните заново")), LOGIN_TIMEOUT);
      signal?.addEventListener("abort", () => fail(new Error("Вход отменён")), { once: true });
      server.on("request", (req, res) => {
        const q = new URL(req.url, redirect).searchParams;
        // чужие запросы (значок вкладки и т. п.) — мимо
        if (q.get("state") !== state) {
          res.writeHead(404).end();
          return;
        }
        const error = q.get("error");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(error ? page("Вход не выполнен", "Вернитесь в Local VOT.") : page("Вход выполнен", "Окно можно закрыть и вернуться в Local VOT."));
        clearTimeout(timer);
        if (error) fail(new Error(error === "access_denied" ? "Вход отменён в браузере" : `Google: ${error}`));
        else resolve(q.get("code"));
      });
      ui.openUrl(`${AUTH_URL}?${new URLSearchParams({
        client_id: id, redirect_uri: redirect, response_type: "code", scope: SCOPE, state,
        code_challenge: challenge, code_challenge_method: "S256",
        access_type: "offline", // ключ для обновления — чтобы не входить каждый час
        prompt: "consent",      // иначе при повторном входе Google не выдаёт ключ для обновления
      })}`);
    });
    const tok = await postForm({ client_id: id, client_secret: secret, code, code_verifier: verifier,
      grant_type: "authorization_code", redirect_uri: redirect }, signal);
    if (!tok.ok) throw new Error(`Google не выдал доступ: ${tok.data.error_description ?? tok.data.error ?? "нет ответа"}`);
    // на странице Google галочку доступа к Диску можно снять — тогда загружать некуда
    if (!String(tok.data.scope ?? "").split(" ").includes(SCOPE)) {
      throw new Error("Google не дал доступ к Диску: на странице входа отметьте галочку доступа к файлам Google Диска и войдите снова.");
    }
    store.save({ ...tok.data, obtained_at: Date.now() });
  } finally {
    server.close();
  }
}

async function refresh(token) {
  const { id, secret } = getGoogleCredentials();
  const tok = await postForm({ client_id: id, client_secret: secret, refresh_token: token.refresh_token, grant_type: "refresh_token" });
  if (!tok.ok) return null; // отозвали доступ или ключ устарел — нужен новый вход
  // ключ для обновления Google при обновлении обычно не присылает — сохраняем прежний
  const fresh = { ...token, ...tok.data, refresh_token: tok.data.refresh_token ?? token.refresh_token, obtained_at: Date.now() };
  store.save(fresh);
  return fresh;
}

// обновление токена — одно на всех: несколько видео спрашивают токен одновременно
let refreshing = null;

/** Действующий токен (живёт час, обновляется заранее) или null, если нужен вход. */
export async function getToken() {
  const token = store.load();
  if (!token) return null;
  if (Date.now() < token.obtained_at + (token.expires_in - 300) * 1000) return token.access_token;
  if (!token.refresh_token) return null;
  refreshing ??= refresh(token).finally(() => { refreshing = null; });
  return (await refreshing)?.access_token ?? null;
}

/** Имя (почта) и место на Google Диске — заодно проверка, что вход рабочий; null — вход устарел. */
export async function getAccount(token) {
  const res = await fetch("https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress),storageQuota(limit,usage)",
    { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message ?? `Google Диск ответил ${res.status}`);
  const q = data.storageQuota ?? {};
  return {
    name: data.user?.emailAddress || data.user?.displayName || "Google",
    usedBytes: Number(q.usage) || 0,
    totalBytes: Number(q.limit) || 0, // у безлимитных тарифов limit нет
  };
}

/** Выход: доступ программы отзывается и у Google (не только забывается здесь). */
export async function logout() {
  const token = store.load();
  store.clear();
  if (token?.refresh_token || token?.access_token) {
    await fetch("https://oauth2.googleapis.com/revoke", { method: "POST",
      body: new URLSearchParams({ token: token.refresh_token ?? token.access_token }) }).catch(() => {});
  }
}
