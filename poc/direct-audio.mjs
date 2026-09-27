// Эксперимент: перевод без Диска и без туннеля — звук отправляется Яндексу напрямую.
// Схема из форка Acobat12/voice-over-translation-direct: запрос перевода с настоящим адресом
// файла (у нас — локальный, Яндекс до него не дотянется) → Яндекс отвечает статусом 6
// AUDIO_REQUESTED («пришлите звук») → отправляем байты медиафайла кусками → ждём перевод.
//
// node poc/direct-audio.mjs <облегчённое видео .mp4> [папка вывода]
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import VOTClient from "@vot.js/node";

const AUDIO_REQUESTED = 6;
const FINISHED = 1;
const CHUNK = 1024 * 1024;

const [file, outDir = "out"] = process.argv.slice(2);
if (!file) {
  console.error("Использование: node poc/direct-audio.mjs <видео.mp4> [папка]");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const duration = parseFloat(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration",
  "-of", "csv=p=0", file], { encoding: "utf8" }).stdout);

// адрес уникальный: переводы Яндекс кэширует по ссылке, чужие ролики задеть нельзя
const url = `http://127.0.0.1/${randomBytes(12).toString("hex")}/${path.basename(file)}`;
const videoData = { url, videoId: url, host: "custom", duration };
const client = new VOTClient({ requestLang: "en", responseLang: "ru" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)} с] ${m}`);

let res = await client.translateVideo({ videoData, shouldSendFailedAudio: false });
log(`первый ответ: статус ${res.status}, осталось ~${res.remainingTime} с ${res.message ?? ""}`);

if (res.status === AUDIO_REQUESTED) {
  const bytes = readFileSync(file);
  const parts = Math.ceil(bytes.length / CHUNK);
  const fileId = `local_${bytes.length}_${CHUNK}_${Date.now()}`;
  log(`Яндекс просит звук — отправляем ${(bytes.length / 1024 / 1024).toFixed(1)} МБ, ${parts} кусков`);
  const up0 = Date.now();
  for (let i = 0; i < parts; i++) {
    const audioFile = bytes.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, bytes.length));
    const r = await client.provider.requestVtransAudio(url, res.translationId,
      { audioFile, chunkId: i }, { audioPartsLength: parts, fileId, version: 1 });
    if (i === 0 || i === parts - 1 || i % 5 === 0) {
      log(`  кусок ${i + 1}/${parts}: статус ${r.status}, осталось кусков ${r.remainingChunks ?? "?"}`);
    }
  }
  const sec = (Date.now() - up0) / 1000;
  log(`отправлено за ${sec.toFixed(0)} с (${(bytes.length * 8 / 1024 / 1024 / sec).toFixed(1)} Мбит/с)`);
}

for (;;) {
  if (res.translated && res.status === FINISHED) break;
  if (res.status === 0) throw new Error(`Яндекс отказал: ${res.message}`);
  if (Date.now() - t0 > 30 * 60_000) throw new Error("не готово за 30 минут");
  await sleep(15_000);
  try {
    res = await client.translateVideo({ videoData, shouldSendFailedAudio: false });
  } catch (e) {
    log(`ошибка: ${e.message} ${e.data?.message ?? ""}`);
    throw e;
  }
  log(`статус ${res.status}, осталось ~${res.remainingTime} с`);
}

const out = path.join(outDir, `${path.parse(file).name}.direct.ru.mp3`);
const audio = Buffer.from(await (await fetch(res.url)).arrayBuffer());
(await import("node:fs")).writeFileSync(out, audio);
log(`ГОТОВО: ${out} (${(audio.length / 1024 / 1024).toFixed(1)} МБ)`);
