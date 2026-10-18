// Перевод видео по публичной ссылке через vot.js (неофициальный API переводчика Яндекса):
// ожидание готовности, скачивание русской дорожки (mp3) и субтитров (srt).
import { writeFileSync } from "node:fs";
import { YandexVOTProtobuf } from "@vot.js/core/protobuf";
import VOTClient from "@vot.js/node";
import { getVideoData } from "@vot.js/node/utils/videoData";

// vot.js не отдаёт наружу поля ответа Яндекса language и isLivelyVoice, а они нужны:
// language — какой язык Яндекс нашёл в видео (при автоопределении — всегда; при явно указанном
// языке заполняется, только если речь на него не похожа), isLivelyVoice — вышли ли живые голоса.
// Перехватываем расшифровку ответа. Видео переводятся параллельно, поэтому ответы храним по номеру
// перевода (translationId): vot.js возвращает его же в результате — по нему находим свой ответ,
// а не чужой «последний».
const responses = new Map();
const decodeResponse = YandexVOTProtobuf.decodeTranslationResponse;
YandexVOTProtobuf.decodeTranslationResponse = (buf) => {
  const response = decodeResponse(buf);
  if (response?.translationId) {
    responses.set(response.translationId, response);
    if (responses.size > 100) responses.delete(responses.keys().next().value); // брошенные — не копим
  }
  return response;
};

// status: 1 — готово, 2/3 — ждём, 5 — готова только часть (~10 мин), ждём полный перевод, 0 — отказ
const FINISHED = 1;
const PART_CONTENT = 5;
const TIMEOUT = 60 * 60_000; // самое долгое ожидание в журналах пользователя — 21 мин (27-мин видео)
const POLL = 30_000; // как в vot-cli; remainingTime у Яндекса приблизительный
const POLL_MIN = 5_000;
const SUBS_RETRY = [0, 5_000, 10_000, 15_000]; // паузы перед запросами субтитров (см. ниже)

/**
 * Когда спросить Яндекс снова: раз в 30 с, но если он сам говорит, что осталось меньше, — к этому сроку
 * (не чаще раза в 5 с): иначе готовый перевод в среднем лежал бы у Яндекса лишние ~15 с.
 */
export const nextPoll = (remainingSec) => (remainingSec > 0 ? Math.min(POLL, Math.max(POLL_MIN, remainingSec * 1000)) : POLL);

// слушатель отмены снимается и по окончании паузы: опросов за час — больше сотни, и иначе они копились бы на сигнале
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const onAbort = () => { clearTimeout(t); reject(new Error("Отменено")); };
  const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
});

/**
 * Скачать готовую дорожку: перевод уже сделан, и сбой связи на скачивании не должен его терять — повторяем.
 * Ответ проверяем: страница ошибки вместо MP3 дальше дала бы непонятный сбой разбора звука.
 */
export async function download(url, signal) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`ответ ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1024) throw new Error(`слишком маленький файл (${buf.length} байт)`);
      return buf;
    } catch (e) {
      if (signal?.aborted) throw new Error("Отменено");
      if (attempt >= 4) throw new Error(`Не удалось скачать готовый перевод: ${e.message}`);
      await sleep(5_000 * attempt, signal);
    }
  }
}

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
  // vot.js сводит ссылку Google Диска к drive.google.com/file/d/<id> — а у каждого перевода своя ссылка
  // (gdrive.publish): по одинаковой Яндекс отдал бы прежний перевод из своего кэша
  if (videoData.host === "googledrive") videoData.url = url;

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
    // Яндекс может назвать язык речи ещё до конца перевода (промежуточные ответы тоже проходят через
    // decodeTranslationResponse). Язык указан явно, а речь другая — дальше ждать незачем: перевод выйдет
    // бессмыслицей, а pipeline либо переключится на автоопределение (живые голоса), либо скажет об ошибке
    const early = responses.get(res.translationId)?.language;
    if (lang !== "auto" && early && early !== lang) {
      responses.delete(res.translationId);
      throw Object.assign(new Error(`Яндекс нашёл в видео другой язык: ${early}`), { code: "LANG_MISMATCH", detectedLang: early });
    }
    const left = res.remainingTime > 0 ? `, осталось ~${Math.ceil(res.remainingTime / 60)} мин` : "";
    onStatus(res.status === PART_CONTENT ? `Готова часть перевода, ждём остальное${left}` : `Яндекс переводит${left}`);
    if (Date.now() - started > TIMEOUT) throw new Error("Перевод не готов за час — попробуйте позже");
    await sleep(nextPoll(res.remainingTime), signal);
  }

  const own = responses.get(res.translationId) ?? {};
  responses.delete(res.translationId);
  const detectedLang = own.language || null;
  const result = {
    audio: `${base}.ru.mp3`, subs: null, subsCount: 0,
    detectedLang, lively: Boolean(own.isLivelyVoice),
  };

  onStatus("Скачиваем перевод");
  writeFileSync(result.audio, await download(res.url, signal));

  // Субтитры: Яндекс отдаёт оригинальные и переведённые (json, таймкоды в мс). Берём только русские:
  // раньше без русских брались первые попавшиеся — в видео ложились английские с подписью «Русские»
  // Субтитры у Яндекса бывают готовы на секунды позже звука: сразу после перевода список иногда пуст, а чуть
  // позже — полный (проверено 18.10 на трёх ссылках одного видео: пустой выпадал то на одной, то на другой)
  try {
    let url = null;
    for (const pause of SUBS_RETRY) {
      if (pause) await sleep(pause, signal);
      const subs = await client.getSubtitles({ videoData, requestLang: lang === "auto" ? (detectedLang ?? "en") : lang })
        .catch(() => ({ subtitles: [] })); // сбой запроса — как «ещё не готовы»
      const pick = subs.subtitles.find((s) => s.translatedLanguage === "ru" && s.translatedUrl);
      url = pick?.translatedUrl ?? subs.subtitles.find((s) => s.language === "ru")?.url;
      if (url) break;
    }
    if (url) {
      const raw = await (await fetch(url, { signal })).json();
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
