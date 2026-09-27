// Перевод видео по публичной ссылке через vot.js (неофициальный API переводчика Яндекса):
// ожидание готовности, скачивание русской дорожки (mp3) и субтитров (srt).
import { writeFileSync } from "node:fs";
import { YandexVOTProtobuf } from "@vot.js/core/protobuf";
import VOTClient from "@vot.js/node";
import { getVideoData } from "@vot.js/node/utils/videoData";

// vot.js не отдаёт наружу поля ответа Яндекса language и isLivelyVoice, а они нужны:
// language — какой язык Яндекс нашёл в видео (при автоопределении — всегда; при явно указанном
// языке заполняется, только если речь на него не похожа), isLivelyVoice — вышли ли живые голоса.
// Перехватываем расшифровку ответа. Задания идут по одному, так что хватает «последнего ответа».
let lastResponse = {};
const decodeResponse = YandexVOTProtobuf.decodeTranslationResponse;
YandexVOTProtobuf.decodeTranslationResponse = (buf) => (lastResponse = decodeResponse(buf));

// status: 1 — готово, 2/3 — ждём, 5 — готова только часть (~10 мин), ждём полный перевод, 0 — отказ
const FINISHED = 1;
const PART_CONTENT = 5;
const TIMEOUT = 30 * 60_000;
const POLL = 30_000; // как в vot-cli; remainingTime у Яндекса приблизительный

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("Отменено")); }, { once: true });
});

/**
 * @param duration длительность, с — обязательна: для ссылок Диска вида /i/... vot.js её не знает,
 *                 шлёт значение по умолчанию, и Яндекс сбоит на повторных запросах
 * @param base     путь без расширения: <base>.ru.mp3, <base>.ru.srt
 * @param onStatus текст для пользователя о ходе перевода
 * @param lively   «живые голоса» (голоса, похожие на оригинальные; только EN→RU). Нужен токен
 *                 Яндекса — подходит токен входа нашего приложения (проверено: isLivelyVoice=true)
 * @param lang     язык видео: код или "auto"
 * @returns { audio, subs, subsCount, detectedLang, lively } — detectedLang: что нашёл Яндекс (или null),
 *          lively: вышли ли на самом деле живые голоса
 */
export async function translate(url, duration, base, onStatus, signal, { lively = false, token, lang = "en" } = {}) {
  const client = new VOTClient({ requestLang: lang, responseLang: "ru", apiToken: lively ? token : undefined });
  const extraOpts = { useLivelyVoice: Boolean(lively && token) };
  const videoData = { ...(await getVideoData(url)), duration };
  lastResponse = {};

  let res;
  let errors = 0;
  const started = Date.now();
  for (;;) {
    signal?.throwIfAborted();
    try {
      // extraOpts.firstRequest не трогать: Яндекс принимает только true (значение по умолчанию),
      // с false повторные запросы падают с «error_id ... see logs».
      // bypassCache бесполезен: Яндекс всё равно отдаёт кэш по ссылке (проверено) — для свежего
      // перевода нужна новая ссылка, её даёт переопубликация файла на Диске
      res = await client.translateVideo({ videoData, requestLang: lang, extraOpts });
      errors = 0;
    } catch (e) {
      if (e.data?.status === 0 || /couldn't translate/i.test(e.message)) {
        throw new Error(`Яндекс не смог перевести видео: ${e.data?.message ?? e.message}`);
      }
      // сервер иногда отвечает «error_id ... see logs» — повторяем, а не падаем
      if (++errors > 5) throw new Error(`Переводчик Яндекса не отвечает: ${e.message}`);
      onStatus(`Сбой связи с переводчиком, повтор (${errors}/5)…`);
      await sleep(20_000, signal);
      continue;
    }
    if (res.translated && res.status === FINISHED) break;
    const left = res.remainingTime > 0 ? `, осталось ~${Math.ceil(res.remainingTime / 60)} мин` : "";
    onStatus(res.status === PART_CONTENT ? `Готова часть перевода, ждём остальное${left}` : `Яндекс переводит${left}`);
    if (Date.now() - started > TIMEOUT) throw new Error("Перевод не готов за 30 минут — попробуйте позже");
    await sleep(POLL, signal);
  }

  const detectedLang = lastResponse.language || null;
  const result = {
    audio: `${base}.ru.mp3`, subs: null, subsCount: 0,
    detectedLang, lively: Boolean(lastResponse.isLivelyVoice),
  };

  onStatus("Скачиваем перевод");
  const audio = Buffer.from(await (await fetch(res.url, { signal })).arrayBuffer());
  writeFileSync(result.audio, audio);

  // Субтитры: Яндекс отдаёт оригинальные и переведённые (json, таймкоды в мс)
  try {
    const subs = await client.getSubtitles({ videoData, requestLang: lang === "auto" ? (detectedLang ?? "en") : lang });
    const ru = subs.subtitles.find((s) => s.translatedLanguage === "ru") ?? subs.subtitles[0];
    if (ru) {
      const raw = await (await fetch(ru.translatedUrl ?? ru.url, { signal })).json();
      const lines = raw.subtitles ?? [];
      const ts = (ms) => new Date(ms).toISOString().slice(11, 23).replace(".", ",");
      writeFileSync(`${base}.ru.srt`, lines.map((s, i) =>
        `${i + 1}\n${ts(s.startMs)} --> ${ts(s.startMs + s.durationMs)}\n${s.text}\n`).join("\n"));
      result.subs = `${base}.ru.srt`;
      result.subsCount = lines.length;
    }
  } catch {
    // без субтитров перевод всё равно полезен
  }
  return result;
}
