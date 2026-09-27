// Работа с видео через ffmpeg (встроенный ffmpeg-static; если его нет — системный).
import { spawn } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegStatic from "ffmpeg-static";

// в собранном приложении бинарник лежит вне архива app.asar
const bundled = ffmpegStatic?.replace("app.asar", "app.asar.unpacked");
const FFMPEG = bundled && existsSync(bundled) ? bundled : "ffmpeg";
// длинный граф фильтров (сотни фраз) не влезает в командную строку Windows — отдаём файлом;
// встроенный ffmpeg 6.1 понимает -filter_complex_script, системный 7+ — «-/filter_complex»
const FILTER_SCRIPT_FLAG = FFMPEG === "ffmpeg" ? "-/filter_complex" : "-filter_complex_script";

const RAMP = 0.2; // плавность приглушения оригинала, с

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
 * Громкость звука по EBU R128 (integrated loudness, LUFS). Тишина в расчёт не входит (гейтинг),
 * поэтому у дорожки перевода меряется громкость самой речи. null — если измерить не вышло.
 */
export async function measureLoudness(file, signal) {
  const log = await new Promise((resolve) => {
    const p = spawn(FFMPEG, ["-hide_banner", "-nostdin", "-i", file, "-map", "0:a:0", "-af", "ebur128=framelog=quiet", "-f", "null", "-"],
      { windowsHide: true });
    let e = "";
    const onAbort = () => p.kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    p.stderr.on("data", (d) => { e = (e + d).slice(-8000); });
    p.on("error", () => resolve(""));
    p.on("close", () => { signal?.removeEventListener("abort", onAbort); resolve(e); });
  });
  signal?.throwIfAborted();
  const m = [...log.matchAll(/I:\s+(-?\d+(?:\.\d+)?) LUFS/g)].at(-1);
  const lufs = m ? Number(m[1]) : NaN;
  return Number.isFinite(lufs) && lufs > -60 ? lufs : null; // -70 — это тишина
}

/**
 * Где в дорожке перевода звучит речь: [[начало, конец], ...] в секундах.
 * Ищем тишину (silencedetect) и берём промежутки между ней.
 */
export async function speechSegments(voice, signal) {
  const log = await new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ["-hide_banner", "-nostdin", "-i", voice, "-af", "silencedetect=noise=-35dB:d=0.35", "-f", "null", "-"],
      { windowsHide: true });
    let e = "";
    const onAbort = () => p.kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    p.stderr.on("data", (d) => { e += d; });
    p.on("error", reject);
    p.on("close", () => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) reject(new Error("Отменено"));
      else resolve(e);
    });
  });
  const total = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(log);
  const end = total ? +total[1] * 3600 + +total[2] * 60 + +total[3] : Infinity;
  const segments = [];
  let speechStart = 0;
  for (const m of log.matchAll(/silence_(start|end): (-?\d+(?:\.\d+)?)/g)) {
    const t = Math.max(0, Number(m[2]));
    if (m[1] === "start") {
      if (t - speechStart > 0.1) segments.push([speechStart, t]);
      speechStart = null;
    } else {
      speechStart = t;
    }
  }
  if (speechStart !== null && end - speechStart > 0.1) segments.push([speechStart, end]);
  // склеиваем фразы, между которыми меньше пары рамп: иначе оригинал «дышит» между словами
  const merged = [];
  for (const s of segments) {
    const last = merged.at(-1);
    if (last && s[0] - last[1] < RAMP * 3) last[1] = s[1];
    else merged.push([...s]);
  }
  return merged;
}

/**
 * Громкость оригинала во времени: 1 в паузах перевода, level во время речи перевода,
 * с плавными переходами RAMP до и после фразы. Выражение для фильтра volume (eval=frame).
 */
function duckExpression(segments, level) {
  if (!segments.length) return "1";
  const r = RAMP.toFixed(2);
  const env = segments.map(([a, b]) => {
    const from = (a - RAMP).toFixed(2);
    const to = (b + RAMP).toFixed(2);
    return `clip((t-${from})/${r},0,1)*clip((${to}-t)/${r},0,1)`;
  }).join("+");
  return `1-${(1 - level).toFixed(3)}*min(1,${env})`;
}

// автоподстройка перевода под оригинал — в разумных пределах, чтобы не раздуть шум или тишину
const AUTO_GAIN_MIN_DB = -20;
const AUTO_GAIN_MAX_DB = 12;
// перевод чуть громче оригинала — иначе при оригинале на 100 % речь тонет
const AUTO_TARGET_OFFSET_DB = 3;

/**
 * Итоговое видео: картинка без перекодирования + дорожка «оригинал с переводом поверх»
 * + исходная дорожка + субтитры.
 *
 * mixMode "duck"     — оригинал на originalVolume %, только пока звучит перевод; в паузах 100 %;
 *         "constant" — оригинал всё время на originalVolume %.
 * autoLevel + origLoudness (LUFS оригинала) — перевод подгоняется по громкости к оригиналу,
 * voiceGain применяется поверх.
 * @returns { autoGainDb } — на сколько подстроен перевод (null — без подстройки)
 */
export async function mux(video, voice, subs, out, opts = {}, duration, onProgress, signal) {
  const { voiceGain = 1, originalVolume = 30, mixMode = "duck", autoLevel = true, origLoudness = null } = opts;
  const level = Math.min(100, Math.max(0, Number(originalVolume) || 0)) / 100;

  let autoGainDb = null;
  if (autoLevel && origLoudness !== null) {
    const voiceLoudness = await measureLoudness(voice, signal);
    if (voiceLoudness !== null) {
      autoGainDb = Math.min(AUTO_GAIN_MAX_DB, Math.max(AUTO_GAIN_MIN_DB, origLoudness + AUTO_TARGET_OFFSET_DB - voiceLoudness));
    }
  }
  const voiceVolume = voiceGain * 10 ** ((autoGainDb ?? 0) / 20);

  let origChain;
  if (level >= 1) origChain = "[0:a:0]aresample=48000[duck]";
  else if (mixMode === "constant") origChain = `[0:a:0]aresample=48000,volume=${level.toFixed(3)}[duck]`;
  else origChain = `[0:a:0]aresample=48000,volume='${duckExpression(await speechSegments(voice, signal), level)}':eval=frame[duck]`;

  const filter = [
    `[1:a]aresample=48000,volume=${voiceVolume.toFixed(4)}[voice]`,
    origChain,
    "[duck][voice]amix=inputs=2:duration=first:normalize=0[mix]",
  ].join(";\n");
  const script = path.join(tmpdir(), `local-vot-filter-${process.pid}-${Date.now()}.txt`);
  writeFileSync(script, filter);
  const withSubs = Boolean(subs);
  try {
    await ffmpeg([
      "-v", "error", "-stats",
      "-i", video, "-i", voice, ...(withSubs ? ["-i", subs] : []),
      FILTER_SCRIPT_FLAG, script,
      "-map", "0:v:0", "-map", "[mix]", "-map", "0:a:0", ...(withSubs ? ["-map", "2:s"] : []),
      "-c:v", "copy", "-c:a:0", "aac", "-b:a:0", "192k", "-c:a:1", "copy", ...(withSubs ? ["-c:s", "srt"] : []),
      "-metadata:s:a:0", "language=rus", "-metadata:s:a:0", "title=Перевод",
      "-metadata:s:a:1", "title=Оригинал",
      ...(withSubs ? ["-metadata:s:s:0", "language=rus", "-metadata:s:s:0", "title=Русские"] : []),
      "-disposition:a:0", "default", "-disposition:a:1", "0",
      out,
    ], { duration, onProgress, signal });
  } finally {
    rmSync(script, { force: true });
  }
  return { autoGainDb };
}
