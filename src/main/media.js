// Работа с видео через ffmpeg (встроенный ffmpeg-static; если его нет — системный).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import ffmpegStatic from "ffmpeg-static";

// в собранном приложении бинарник лежит вне архива app.asar
const bundled = ffmpegStatic?.replace("app.asar", "app.asar.unpacked");
const FFMPEG = bundled && existsSync(bundled) ? bundled : "ffmpeg";

// насколько «прижимать» оригинал, пока звучит перевод (sidechaincompress ratio)
const DUCK_RATIO = { light: 4, medium: 10, strong: 20 };

function ffmpeg(args, { duration, onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, ["-hide_banner", "-nostdin", "-y", ...args], { windowsHide: true });
    let log = "";
    const onAbort = () => proc.kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    proc.stderr.on("data", (d) => {
      const s = d.toString();
      log = (log + s).slice(-4000);
      const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s);
      if (m && duration && onProgress) onProgress(Math.min(1, (+m[1] * 3600 + +m[2] * 60 + +m[3]) / duration));
    });
    proc.on("error", (e) => reject(new Error(`Не удалось запустить ffmpeg: ${e.message}`)));
    proc.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) reject(new Error("Отменено"));
      else if (code === 0) resolve();
      else reject(new Error(`ffmpeg: ${log.split("\n").map((l) => l.trim()).filter(Boolean).slice(-2).join(" · ")}`));
    });
  });
}

/** Длительность видео в секундах; заодно проверяет, что в файле есть звук. */
export async function probe(file) {
  // ffmpeg без выходного файла завершается с ошибкой, но сведения о файле печатает
  const info = await new Promise((resolve) => {
    const p = spawn(FFMPEG, ["-hide_banner", "-i", file], { windowsHide: true });
    let e = "";
    p.stderr.on("data", (d) => { e += d; });
    p.on("close", () => resolve(e));
    p.on("error", () => resolve(""));
  });
  const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(info);
  if (!m) throw new Error("Не удалось прочитать файл — он повреждён или это не видео");
  if (!/Stream #.*Audio:/.test(info)) throw new Error("В видео нет звуковой дорожки — переводить нечего");
  return { duration: +m[1] * 3600 + +m[2] * 60 + +m[3] };
}

/**
 * Облегчённая копия для загрузки: чёрный кадр 256x144 @ 1 fps + исходный звук.
 * Диск видит её как видео (vot.js требует mediatype=video), весит она как аудио, картинка никуда не уходит.
 * -t по длительности исходника: -shortest с 1 fps промахивается на десятки секунд.
 */
export function makeLight(input, out, duration, onProgress, signal) {
  return ffmpeg([
    "-v", "error", "-stats", "-t", String(duration),
    "-f", "lavfi", "-i", "color=c=black:s=256x144:r=1",
    "-i", input,
    "-map", "0:v", "-map", "1:a:0",
    "-c:v", "libx264", "-preset", "veryfast", "-tune", "stillimage", "-crf", "40",
    "-c:a", "aac", "-b:a", "128k",
    "-shortest", "-movflags", "+faststart",
    out,
  ], { duration, onProgress, signal });
}

/**
 * Итоговое видео: картинка без перекодирования + дорожка «оригинал с переводом поверх»
 * (оригинал притихает, пока звучит перевод) + исходная дорожка + субтитры.
 */
export function mux(video, voice, subs, out, { voiceGain = 1, duck = "medium" } = {}, duration, onProgress, signal) {
  const ratio = DUCK_RATIO[duck] ?? DUCK_RATIO.medium;
  const filter = [
    `[1:a]aresample=48000,volume=${voiceGain},asplit=2[vk][vm]`,
    "[0:a:0]aresample=48000[orig]",
    `[orig][vk]sidechaincompress=threshold=0.015:ratio=${ratio}:attack=30:release=500:makeup=1[duck]`,
    "[duck][vm]amix=inputs=2:duration=first:normalize=0[mix]",
  ].join(";");
  const withSubs = Boolean(subs);
  return ffmpeg([
    "-v", "error", "-stats",
    "-i", video, "-i", voice, ...(withSubs ? ["-i", subs] : []),
    "-filter_complex", filter,
    "-map", "0:v:0", "-map", "[mix]", "-map", "0:a:0", ...(withSubs ? ["-map", "2:s"] : []),
    "-c:v", "copy", "-c:a:0", "aac", "-b:a:0", "192k", "-c:a:1", "copy", ...(withSubs ? ["-c:s", "srt"] : []),
    "-metadata:s:a:0", "language=rus", "-metadata:s:a:0", "title=Перевод",
    "-metadata:s:a:1", "title=Оригинал",
    ...(withSubs ? ["-metadata:s:s:0", "language=rus", "-metadata:s:s:0", "title=Русские"] : []),
    "-disposition:a:0", "default", "-disposition:a:1", "0",
    out,
  ], { duration, onProgress, signal });
}
