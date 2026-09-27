// Проверка идеи: перевод видео по ссылке через vot.js (неофициальный API Яндекса).
// Ждёт готовности, скачивает русскую дорожку (mp3) и субтитры (json + srt).
//
// node poc/translate.mjs <ссылка на видео> <длительность, с> [папка вывода]
//   Длительность обязательна: для ссылок Диска вида /i/... vot.js её не знает и шлёт
//   значение по умолчанию, из-за чего Яндекс сбоит на повторных запросах.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import VOTClient from "@vot.js/node";
import { getVideoData } from "@vot.js/node/utils/videoData";

const [url, durArg, outDir = "out"] = process.argv.slice(2);
const duration = Number(durArg);
if (!url || !(duration > 0)) {
  console.error("Использование: node poc/translate.mjs <ссылка> <длительность, с> [папка]");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = new VOTClient({ requestLang: "en", responseLang: "ru" });

const videoData = { ...(await getVideoData(url)), duration };
console.log("videoData:", JSON.stringify(videoData));
const base = path.join(outDir, (videoData.title || videoData.videoId || "video").replace(/[\\/:*?"<>|]/g, "_"));

// Яндекс переводит асинхронно: первый запрос ставит в очередь, дальше опрашиваем.
// status: 1 — готово, 2/3 — ждём, 5 — готова только часть (~10 мин), ждём полный перевод.
const FINISHED = 1;
const started = Date.now();
let res;
let errors = 0;
for (let i = 0; ; i++) {
  const min = () => ((Date.now() - started) / 60000).toFixed(1);
  try {
    res = await client.translateVideo({ videoData, extraOpts: { firstRequest: i === 0 } });
    errors = 0;
  } catch (e) {
    // сервер иногда отвечает «error_id ... see logs» — повторяем, а не падаем
    const detail = e.data?.data instanceof ArrayBuffer ? Buffer.from(e.data.data).toString() : e.message;
    if (++errors > 5) throw e;
    console.log(`[${min()} мин] ошибка (${errors}/5): ${detail} — повтор через 20 с`);
    await sleep(20_000);
    continue;
  }
  console.log(`[${min()} мин] status=${res.status} translated=${res.translated} remaining=${res.remainingTime}s ${res.message ?? ""}`);
  if (res.translated && res.status === FINISHED) break;
  if (Date.now() - started > 30 * 60_000) throw new Error("Перевод не готов за 30 минут");
  await sleep(Math.min(Math.max((res.remainingTime ?? 20) * 1000, 10_000), 60_000));
}

const audio = Buffer.from(await (await fetch(res.url)).arrayBuffer());
writeFileSync(`${base}.ru.mp3`, audio);
console.log(`Дорожка: ${base}.ru.mp3 (${(audio.length / 1024 / 1024).toFixed(1)} МБ)`);

// Субтитры: Яндекс отдаёт оригинальные и переведённые (json с таймкодами в мс)
const subs = await client.getSubtitles({ videoData, requestLang: "en" });
const ru = subs.subtitles.find((s) => s.translatedLanguage === "ru") ?? subs.subtitles[0];
if (!ru) {
  console.log("Субтитров нет");
} else {
  const raw = await (await fetch(ru.translatedUrl ?? ru.url)).json();
  writeFileSync(`${base}.ru.subs.json`, JSON.stringify(raw, null, 1));
  const ts = (ms) => new Date(ms).toISOString().slice(11, 23).replace(".", ",");
  const srt = (raw.subtitles ?? []).map((s, i) =>
    `${i + 1}\n${ts(s.startMs)} --> ${ts(s.startMs + s.durationMs)}\n${s.text}\n`).join("\n");
  writeFileSync(`${base}.ru.srt`, srt);
  console.log(`Субтитры: ${base}.ru.srt (${raw.subtitles?.length ?? 0} строк)`);
}
