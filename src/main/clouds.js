// Облака, через которые видео передаётся переводчику Яндекса (тот берёт видео только по ссылке).
// Новое облако = модуль хранения (как yadisk.js / gdrive.js: upload, publish, unpublish, remove, freeSpace,
// listAppFolder), модуль входа (как auth.js / gauth.js: login, getToken, getAccount, logout) и запись здесь —
// окно «Облако», шапка, очередь и уборка копий берут всё отсюда.
import * as yandexAuth from "./auth.js";
import * as googleAuth from "./gauth.js";
import * as yadisk from "./yadisk.js";
import * as gdrive from "./gdrive.js";

/**
 * id — значение настройки storage; who — «Войти через …», «нет входа в …»; where — «на … не хватает места»;
 * to — «Загрузка на …» (шаг видео);
 * login — как идёт вход: code (код на странице сервиса) или browser (страница входа в браузере);
 * lively — этот вход даёт живые голоса (они есть только у Яндекса — нужен его вход при любом облаке);
 * throttledBps — если сервис может резать скорость загрузки, примерная скорость для оценки времени;
 * points — описание в окне «Облако»; owns(ref) — копия (job.diskPath) лежит в этом облаке.
 */
export const CLOUDS = [
  {
    id: "yandex", title: "Яндекс Диск", who: "Яндекс", where: "на Яндекс Диске", to: "на Яндекс Диск", login: "code", lively: true,
    throttledBps: 130_000, // ограничение Диска ~127 КБ/с, если оно сработает (см. yadisk.js)
    points: [
      "Нужен аккаунт Яндекса.",
      "Бесплатный Диск принимает не больше 10 ГБ загрузок за 30 дней — примерно 120 двухчасовых видео.",
      "Копии лежат в папке «Приложения → Local VOT».",
    ],
    api: yadisk, auth: yandexAuth,
    owns: (ref) => String(ref).startsWith("app:/"),
  },
  {
    id: "google", title: "Google Диск", who: "Google", where: "на Google Диске", to: "на Google Диск", login: "browser", lively: false,
    points: [
      "Нужен аккаунт Google. Месячного лимита загрузки нет, бесплатно — 15 ГБ места.",
      "Копии лежат в папке «Local VOT — копии для перевода».",
    ],
    api: gdrive, auth: googleAuth,
    owns: (ref) => String(ref).startsWith(gdrive.PREFIX),
  },
];

/** Облако по id (неизвестное — первое, Яндекс Диск). */
export const cloudById = (id) => CLOUDS.find((c) => c.id === id) ?? CLOUDS[0];
/** В каком облаке лежит копия (job.diskPath). */
export const cloudOf = (ref) => CLOUDS.find((c) => c.owns(ref)) ?? CLOUDS[0];
/** Чей вход даёт живые голоса. */
export const livelyCloud = () => CLOUDS.find((c) => c.lively);

/** Что окну нужно знать об облаках (без модулей). */
export const publicClouds = () => CLOUDS.map(({ id, title, who, login, lively, points }) => ({ id, title, who, login, lively, points }));
