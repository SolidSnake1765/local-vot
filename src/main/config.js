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
  saveVideo: true,          // видео с дорожкой перевода
  videoFormat: "source",    // source — в формате исходника, если он позволяет (иначе .mkv); mkv — всегда .mkv
  embedSubs: true,          // вшить русские субтитры в видео
  saveAudio: false,         // звуковая дорожка отдельно: оригинал + перевод, как в видео (.m4a)
  saveVoice: false,         // только голос перевода, как его отдал Яндекс (.mp3)
  saveSubs: false,          // субтитры отдельно (.srt)
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
