// Перевод видео по ссылке через vot.js (неофициальный API Яндекса):
// ожидание готовности, скачивание русской дорожки (mp3) и субтитров (json + srt).
import { writeFileSync } from "node:fs";
import VOTClient from "@vot.js/node";
import { getVideoData } from "@vot.js/node/utils/videoData";

// status: 1 — готово, 2/3 — ждём, 5 — готова только часть (~10 мин), ждём полный перевод, 0 — отказ
const FINISHED = 1;
const TIMEOUT = 30 * 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param url       публичная ссылка на видео (Диск или прямая .mp4)
 * @param duration  длительность, с — обязательна: для ссылок Диска вида /i/... vot.js её
 *                  не знает, шлёт значение по умолчанию, и Яндекс сбоит на повторных запросах
 * @param base      путь без расширения для результатов: <base>.ru.mp3, .ru.srt, .ru.subs.json
 */
export async function translate(url, duration, base, log = console.log) {
  const client = new VOTClient({ requestLang: "en", responseLang: "ru" });
  const videoData = { ...(await getVideoData(url)), duration };

  const started = Date.now();
  const min = () => ((Date.now() - started) / 60000).toFixed(1);
  let res;
  let errors = 0;
  for (;;) {
    try {
      // extraOpts.firstRequest не трогать: Яндекс принимает только true (значение по умолчанию),
      // с false повторные запросы падают с «error_id ... see logs»
      res = await client.translateVideo({ videoData });
      errors = 0;
    } catch (e) {
      // сервер иногда отвечает «error_id ... see logs» — повторяем, а не падаем
      const detail = e.data?.data instanceof ArrayBuffer ? Buffer.from(e.data.data).toString() : e.message;
      if (++errors > 5) throw e;
      log(`[${min()} мин] ошибка Яндекса (${errors}/5): ${detail} — повтор через 20 с`);
      await sleep(20_000);
      continue;
    }
    log(`[${min()} мин] статус ${res.status}${res.translated ? " (есть аудио)" : ""}, осталось ~${res.remainingTime} с ${res.message ?? ""}`);
    if (res.translated && res.status === FINISHED) break;
    if (Date.now() - started > TIMEOUT) throw new Error("Перевод не готов за 30 минут");
    await sleep(30_000); // как в vot-cli; remainingTime у Яндекса всё равно приблизительный
  }

  const audio = Buffer.from(await (await fetch(res.url)).arrayBuffer());
  writeFileSync(`${base}.ru.mp3`, audio);
  const result = { audio: `${base}.ru.mp3`, subs: null, subsCount: 0 };

  // Субтитры: Яндекс отдаёт оригинальные и переведённые (json, таймкоды в мс)
  const subs = await client.getSubtitles({ videoData, requestLang: "en" });
  const ru = subs.subtitles.find((s) => s.translatedLanguage === "ru") ?? subs.subtitles[0];
  if (ru) {
    const raw = await (await fetch(ru.translatedUrl ?? ru.url)).json();
    writeFileSync(`${base}.ru.subs.json`, JSON.stringify(raw, null, 1));
    const ts = (ms) => new Date(ms).toISOString().slice(11, 23).replace(".", ",");
    const lines = raw.subtitles ?? [];
    writeFileSync(`${base}.ru.srt`, lines.map((s, i) =>
      `${i + 1}\n${ts(s.startMs)} --> ${ts(s.startMs + s.durationMs)}\n${s.text}\n`).join("\n"));
    result.subs = `${base}.ru.srt`;
    result.subsCount = lines.length;
  }
  return result;
}
