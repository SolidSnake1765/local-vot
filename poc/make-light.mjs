// Проверка идеи: «облегчённое видео» для загрузки на Яндекс Диск.
// Чёрный кадр 256x144 @ 1 fps + исходный звук: Диск видит файл как видео
// (vot.js требует mediatype=video), а весит он как аудио — и картинка никуда не уходит.
//
// node poc/make-light.mjs <видео> [выход.mp4]
import { spawnSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";

const [input, outArg] = process.argv.slice(2);
if (!input) {
  console.error("Использование: node poc/make-light.mjs <видео> [выход.mp4]");
  process.exit(1);
}
const out = outArg ?? path.join("out", `${path.parse(input).name}.light.mp4`);
mkdirSync(path.dirname(out), { recursive: true });

// -shortest с кадром раз в секунду промахивается на десятки секунд — режем точно по длине исходника
const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", input],
  { encoding: "utf8" });
const duration = parseFloat(probe.stdout);
if (!(duration > 0)) {
  console.error("Не удалось узнать длительность видео:", probe.stderr);
  process.exit(1);
}

const args = [
  "-v", "error", "-y", "-t", String(duration),
  "-f", "lavfi", "-i", "color=c=black:s=256x144:r=1",
  "-i", input,
  "-map", "0:v", "-map", "1:a",
  "-c:v", "libx264", "-preset", "veryfast", "-tune", "stillimage", "-crf", "40",
  "-c:a", "aac", "-b:a", "128k",
  "-shortest", "-movflags", "+faststart",
  out,
];
const r = spawnSync("ffmpeg", args, { stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);

const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(1);
console.log(`Готово: ${out} — ${mb(out)} МБ (исходник ${mb(input)} МБ)`);
