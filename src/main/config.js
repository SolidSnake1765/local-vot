// Ключи приложения Яндекса и пользовательские настройки.
import { app } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ClientID / Client secret приложения с oauth.yandex.ru. При разработке — из .env в корне проекта,
 * в собранной программе — из credentials.json рядом с этим файлом (его пишет scripts/embed-credentials.mjs).
 */
export function getCredentials() {
  const envFile = path.join(app.getAppPath(), ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  let { YANDEX_CLIENT_ID: id, YANDEX_CLIENT_SECRET: secret } = process.env;
  const embedded = path.join(path.dirname(fileURLToPath(import.meta.url)), "credentials.json");
  if ((!id || !secret) && existsSync(embedded)) ({ id, secret } = JSON.parse(readFileSync(embedded, "utf8")));
  if (!id || !secret) {
    throw new Error("Не заданы ключи приложения Яндекса: YANDEX_CLIENT_ID и YANDEX_CLIENT_SECRET в файле .env");
  }
  return { id, secret };
}

export const DEFAULT_SETTINGS = {
  outputDir: "",            // пусто — рядом с исходным видео
  saveVideo: true,          // видео с дорожкой перевода
  videoFormat: "source",    // source — в формате исходника, если он позволяет (иначе .mkv); mkv — всегда .mkv
  embedSubs: true,          // вшить русские субтитры в видео
  saveAudio: false,         // звуковая дорожка отдельно: оригинал + перевод, как в видео (.m4a)
  saveVoice: false,         // только голос перевода, как его отдал Яндекс (.mp3)
  saveSubs: false,          // субтитры отдельно (.srt)
  autoStart: false,         // запускать перевод сразу после добавления (иначе — кнопки «Старт» / «Запустить все»)
  parallelJobs: 3,          // сколько видео переводить одновременно (чтение исходника и сохранение — всё равно по одному)
  notifications: true,      // уведомления Windows, когда видео или вся очередь готовы (только если окно не на переднем плане)
  livelyVoice: true,        // «живые голоса» Яндекса — похожи на оригинальных говорящих (только с английского)
  sourceLang: "auto",       // язык видео для новых видео, если живые голоса выключены
  voiceGain: 1.0,           // громкость перевода
  mixMode: "duck",          // duck — приглушать оригинал под переводом; constant — постоянные уровни
  originalVolume: 30,       // громкость оригинала, % (duck — пока звучит перевод; constant — всегда)
  autoLevel: true,          // подстраивать громкость перевода под громкость оригинала
  fastAudio: false,         // быстрый режим AAC-кодировщика: вдвое быстрее, качество чуть ниже
  deletePermanently: false, // удалять копию с Диска мимо Корзины
};

const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

export function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(settingsFile(), "utf8")) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  writeFileSync(settingsFile(), JSON.stringify(next, null, 1));
  return next;
}

// ---------- размер и положение окна: как закрыли, так и откроется ----------
const windowFile = () => path.join(app.getPath("userData"), "window.json");

/** { x, y, width, height, maximized } с прошлого запуска или null. */
export function loadWindowState() {
  try {
    const s = JSON.parse(readFileSync(windowFile(), "utf8"));
    return Number.isFinite(s.width) && Number.isFinite(s.height) ? s : null;
  } catch {
    return null;
  }
}

export function saveWindowState(state) {
  try {
    writeFileSync(windowFile(), JSON.stringify(state));
  } catch { /* не запомнили размер — не страшно */ }
}
