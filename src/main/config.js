// Ключи приложения Яндекса и пользовательские настройки.
import { app } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** ClientID / Client secret приложения с oauth.yandex.ru. Пока — из .env в корне проекта. */
export function getCredentials() {
  const envFile = path.join(app.getAppPath(), ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const { YANDEX_CLIENT_ID: id, YANDEX_CLIENT_SECRET: secret } = process.env;
  if (!id || !secret) {
    throw new Error("Не заданы ключи приложения Яндекса: YANDEX_CLIENT_ID и YANDEX_CLIENT_SECRET в файле .env");
  }
  return { id, secret };
}

export const DEFAULT_SETTINGS = {
  outputDir: "",            // пусто — рядом с исходным видео
  saveVideo: true,          // видео с дорожкой перевода (.mkv)
  embedSubs: true,          // вшить русские субтитры в видео
  saveAudio: false,         // дорожка перевода отдельно (.mp3)
  saveSubs: false,          // субтитры отдельно (.srt)
  livelyVoice: true,        // «живые голоса» Яндекса — похожи на оригинальных говорящих
  voiceGain: 1.0,           // громкость перевода
  duck: "medium",           // насколько приглушать оригинал под переводом: light | medium | strong
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
