// Журнал работы программы: один файл на день в папке logs (у установленной — %APPDATA%\Local VOT\logs,
// у портативной — data\profile\logs), хранятся последние 14 дней.
//
// Логи прикладывают к жалобам на GitHub, т.е. выкладывают публично, поэтому в журнал НЕ попадают:
// имена и пути видео (вместо них «видео #N»), папки, которые выбрал пользователь, папка его профиля
// Windows, ключи приложения и токены, ссылки на копию на Диске. Всё личное вычищается из каждой строки
// перед записью (scrub) — даже из текста ошибок ffmpeg и Windows, где путь к файлу обычно есть.
// Модуль не зависит от Electron — его можно подключать и из media.js / yadisk.js.
import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const KEEP_DAYS = 14;
let dir = null;
const early = []; // строки до init — дописываются в файл, как только станет известна папка

// личное: [строка, чем заменить]; длинные — первыми, чтобы путь заменялся целиком, а не по частям
const secrets = [];

/** Запомнить личную строку (путь, имя файла, токен) — в журнале она будет заменена на label. */
export function hide(value, label) {
  if (!value || String(value).length < 3) return;
  const v = String(value);
  if (secrets.some(([s]) => s === v)) return;
  secrets.push([v, label]);
  secrets.sort((a, b) => b[0].length - a[0].length);
}

/**
 * Видео попадает в журнал только как «видео #N»: прячем полный путь, имя с расширением и без него
 * (из имени без расширения строятся имена готовых файлов), а также папку, где оно лежит.
 */
export function hideVideo(file, no) {
  const label = `<видео #${no}>`;
  const { dir: folder, base, name } = path.parse(file);
  hide(file, label);
  hide(base, label);
  hide(name, label);
  hide(folder, "<папка видео>");
}

/** Убирает из текста всё личное. */
export function scrub(text) {
  let s = String(text);
  for (const [value, label] of secrets) s = s.split(value).join(label);
  const home = os.homedir();
  if (home) s = s.split(home).join("<профиль>");
  return s
    .replace(/\bOAuth\s+[\w.-]+/gi, "OAuth <токен>")
    .replace(/\by[0-3]_[\w-]{20,}/g, "<токен>")
    .replace(/("?(?:access_token|refresh_token|client_secret|device_code)"?\s*[:=]\s*"?)(?!<)[^"&\s,}]+/gi, "$1<скрыто>")
    .replace(/https?:\/\/(?:disk\.yandex\.\w+|yadi\.sk)\/[^\s"')]+/gi, "<ссылка на Диск>")
    // адреса загрузки и скачивания Диска — с подписью доступа внутри
    .replace(/https?:\/\/[\w.-]*yandex\.net\b[^\s"')]*/gi, "<ссылка Яндекса>")
    .replace(/\bapp:\/[^\s"')]+/g, "app:/<копия>");
}

const pad = (n, w = 2) => String(n).padStart(w, "0");
const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const stamp = (d) => `${day(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;

function write(level, scope, message, extra) {
  const d = new Date();
  let text = message instanceof Error ? message.message : String(message);
  if (extra !== undefined) {
    text += " " + (extra instanceof Error ? (extra.stack ?? extra.message) : typeof extra === "string" ? extra : JSON.stringify(extra));
  }
  if (message instanceof Error && message.stack) text += `\n    ${message.stack.split("\n").slice(1, 6).map((l) => l.trim()).join("\n    ")}`;
  const line = scrub(`${stamp(d)} ${level.padEnd(5)} [${scope}] ${text}`) + "\n";
  if (!process.versions.electron) return; // вне программы (скрипты проверки на обычном Node) — молчим
  if (!dir) {
    early.push(line);
    return;
  }
  try {
    appendFileSync(path.join(dir, `local-vot-${day(d)}.log`), line);
  } catch { /* журнал — не повод ронять программу */ }
}

export const log = {
  info: (scope, message, extra) => write("INFO", scope, message, extra),
  warn: (scope, message, extra) => write("WARN", scope, message, extra),
  error: (scope, message, extra) => write("ERROR", scope, message, extra),
};

/** Папка журнала: создать, дописать ранние строки, удалить файлы старше 14 дней. */
export function initLog(logDir) {
  dir = logDir;
  try {
    mkdirSync(dir, { recursive: true });
    const border = day(new Date(Date.now() - KEEP_DAYS * 86_400_000));
    for (const f of readdirSync(dir)) {
      const m = /^local-vot-(\d{4}-\d{2}-\d{2})\.log$/.exec(f);
      if (m && m[1] < border) rmSync(path.join(dir, f), { force: true });
    }
    if (early.length) appendFileSync(path.join(dir, `local-vot-${day(new Date())}.log`), early.splice(0).join(""));
  } catch { /* нет доступа к папке — работаем без журнала */ }
}

export const logDir = () => dir;
