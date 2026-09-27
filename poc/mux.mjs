// Проверка идеи: сборка итогового видео — перевод поверх оригинала.
// Оригинал автоматически приглушается, пока звучит перевод (sidechaincompress),
// в паузах перевода звучит как есть. Видео не перекодируется.
//
// node poc/mux.mjs <видео> <перевод.mp3> [субтитры.srt] [выход.mkv]
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const [video, voice, subs, outArg] = process.argv.slice(2);
if (!video || !voice) {
  console.error("Использование: node poc/mux.mjs <видео> <перевод.mp3> [субтитры.srt] [выход.mkv]");
  process.exit(1);
}
const out = outArg ?? path.join("out", `${path.parse(video).name} [RU].mkv`);
const hasSubs = subs && existsSync(subs);

const VOICE_GAIN = 1.0;   // громкость перевода
const filter = [
  `[1:a]aresample=48000,volume=${VOICE_GAIN},asplit=2[vk][vm]`,
  // оригинал «прижимается», когда в переводе есть речь
  `[0:a]aresample=48000[orig]`,
  `[orig][vk]sidechaincompress=threshold=0.015:ratio=10:attack=30:release=500:makeup=1[duck]`,
  `[duck][vm]amix=inputs=2:duration=first:normalize=0[mix]`,
].join(";");

const args = [
  "-v", "error", "-y",
  "-i", video, "-i", voice, ...(hasSubs ? ["-i", subs] : []),
  "-filter_complex", filter,
  "-map", "0:v", "-map", "[mix]", "-map", "0:a", ...(hasSubs ? ["-map", "2:s"] : []),
  "-c:v", "copy", "-c:a:0", "aac", "-b:a:0", "192k", "-c:a:1", "copy", ...(hasSubs ? ["-c:s", "srt"] : []),
  "-metadata:s:a:0", "language=rus", "-metadata:s:a:0", "title=Перевод",
  "-metadata:s:a:1", "language=eng", "-metadata:s:a:1", "title=Оригинал",
  ...(hasSubs ? ["-metadata:s:s:0", "language=rus", "-metadata:s:s:0", "title=Русские"] : []),
  "-disposition:a:0", "default", "-disposition:a:1", "0",
  out,
];
const r = spawnSync("ffmpeg", args, { stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(`Готово: ${out}`);
