// Работа с видео через ffmpeg (встроенный ffmpeg-static; если его нет — системный).
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const audioLine = /Stream #[^\n]*?: Audio: [^\n]*/.exec(info)?.[0] ?? "";
  const layout = /\b(mono|stereo|5\.1|7\.1|(\d+) channels)\b/.exec(audioLine);
  return {
    duration: +m[1] * 3600 + +m[2] * 60 + +m[3],
    audioCodec: /Audio: (\w+)/.exec(audioLine)?.[1] ?? "",
    // качество звука оригинала — чтобы перевод кодировать не хуже (у MKV битрейта часто нет — null)
    audio: {
      codec: /Audio: (\w+)/.exec(audioLine)?.[1] ?? "",
      kbps: Number(/(\d+) kb\/s/.exec(audioLine)?.[1]) || null,
      channels: !layout ? 2 : layout[2] ? Number(layout[2]) : { mono: 1, stereo: 2, "5.1": 6, "7.1": 8 }[layout[1]],
    },
    // AAC моно/стерео можно положить в облегчённую копию как есть, без пережатия
    audioCopyable: /Stream #[^\n]*?: Audio: aac\b[^\n]*\b(mono|stereo)\b/.test(info),
    start: Number(/Duration: [^\n]*?start: (-?\d+(?:\.\d+)?)/.exec(info)?.[1] ?? 0),
  };
}

/**
 * На сколько звук начинается позже начала файла, с. У TS/M2TS это десятки мс, у MKV с задержкой звука —
 * бывает и сотни. Копия звука (makeLight → origOut) эту задержку теряет — при сведении её возвращаем,
 * чтобы оригинал в дорожке перевода стоял там же, где при сборке прямо из видео. Читает только начало файла.
 * @param start — начало файла из probe()
 */
export async function audioOffset(file, start) {
  const out = await new Promise((resolve) => {
    const p = spawn(FFMPEG, ["-hide_banner", "-v", "error", "-copyts", "-i", file, "-map", "0:a:0", "-frames:a", "1",
      "-f", "framecrc", "-"], { windowsHide: true });
    let o = "";
    p.stdout.on("data", (d) => { o += d; });
    p.on("close", () => resolve(o));
    p.on("error", () => resolve(""));
  });
  const tb = /#tb 0: (\d+)\/(\d+)/.exec(out);
  const frame = /^0,\s*-?\d+,\s*(-?\d+),/m.exec(out); // поток, dts, pts, …
  if (!tb || !frame) return 0;
  const offset = (Number(frame[1]) * Number(tb[1])) / Number(tb[2]) - start;
  return Math.abs(offset) < 0.001 ? 0 : offset;
}

/** Аргументы входа «звук оригинала»: копия звука со своей задержкой или само видео. */
const origInput = (src) => (typeof src === "string" ? ["-i", src]
  : [...(src.offset ? ["-itsoffset", src.offset.toFixed(4)] : []), "-i", src.path]);

// ---------- формат итогового видео ----------
// Картинка всегда копируется как есть; звук перевода кодируется тем, что принимает контейнер;
// оригинальный звук копируется, если контейнер его принимает, иначе пережимается.
// min — битрейт, с которого кодек звучит без слышимых потерь; max — выше смысла нет (maxMulti — для 5.1/7.1)
const ENC = {
  // AAC выше 256k на слух не лучше (256k — «прозрачный»), а кодируется в 2–3 раза дольше (замер: 47 мин —
  // 58 с при 256k, 111 с при 288k, 166 с при 320k)
  aac: { enc: "aac", min: 192, max: 256, maxMulti: 640 },
  opus: { enc: "libopus", min: 160, max: 256, maxMulti: 512 },
  mp3: { enc: "libmp3lame", min: 192, max: 320, maxMulti: 320 },
  ac3: { enc: "ac3", min: 192, max: 448, maxMulti: 640 },
  wma: { enc: "wmav2", min: 192, max: 320, maxMulti: 320 },
};
const LOSSLESS = /^(pcm_|flac|alac|truehd|mlp|wavpack|ape|tta)/;

/**
 * Битрейт звука «не хуже оригинала»: как у оригинала, но не ниже min кодека и не выше max;
 * оригинал без сжатия или битрейт неизвестен — max. multi — кодируется сам многоканальный оригинал
 * (дорожка перевода всегда стерео).
 */
export function audioKbps(codec, src = {}, multi = false) {
  const e = ENC[codec];
  const max = multi ? e.maxMulti : e.max;
  if (!src.kbps || LOSSLESS.test(src.codec ?? "")) return max;
  return Math.min(max, Math.max(e.min, src.kbps));
}

/**
 * Аргументы ffmpeg для кодирования звука. spec — поток («:a:0», «:a:1» или «» для единственного).
 * fast — быстрый режим AAC (вдвое быстрее на одном ядре, качество чуть ниже; настройка «Быстрое кодирование»).
 */
function audioArgs(spec, codec, src, { multi = false, fast = false } = {}) {
  return [`-c${spec}`, ENC[codec].enc, `-b${spec}`, `${audioKbps(codec, src, multi)}k`,
    ...(fast && codec === "aac" ? [`-aac_coder${spec}`, "fast"] : [])];
}
const MP4_AUDIO = ["aac", "mp3", "ac3", "eac3", "alac", "flac", "opus"];
const MP4 = { voice: "aac", keep: MP4_AUDIO, subs: "mov_text" };
const TS = { format: "mpegts", voice: "aac", keep: ["aac", "mp3", "mp2", "ac3", "eac3", "dts", "opus"], subs: null };
const PS = { format: "vob", voice: "ac3", keep: ["mp2", "mp3", "ac3", "dts", "pcm_dvd"], subs: null };
/**
 * Расширение → как собрать. keep: какой оригинальный звук копировать без пережатия (null — любой);
 * subs: кодек встроенных субтитров (null — контейнер их не держит, субтитры пойдут файлом рядом).
 * reason: контейнер не годится совсем — сохраняем в MKV.
 */
const CONTAINERS = {
  mkv: { format: "matroska", voice: "aac", keep: null, subs: "srt" },
  mp4: { format: "mp4", ...MP4 },
  m4v: { format: "mp4", ...MP4 },
  mov: { format: "mov", ...MP4, keep: [...MP4_AUDIO, "pcm_s16le", "pcm_s24le"] },
  "3gp": { format: "3gp", ...MP4, keep: ["aac", "amr_nb", "amr_wb"] },
  webm: { format: "webm", voice: "opus", keep: ["opus", "vorbis"], subs: "webvtt" },
  ogv: { format: "ogg", voice: "opus", keep: ["opus", "vorbis", "flac"], subs: null },
  avi: { format: "avi", voice: "mp3", keep: null, subs: null },
  wmv: { format: "asf", voice: "wma", keep: ["wmav1", "wmav2", "wmapro", "mp3"], subs: null },
  ts: TS, m2ts: TS, mts: TS,
  mpg: PS, mpeg: PS, vob: PS,
  flv: { reason: "FLV не умеет хранить две звуковые дорожки" },
};

/**
 * План сборки видео: в формате исходника (если можно) или в MKV.
 * @returns { ext, format, voice, origCodec, subs, reason? } — reason: почему пришлось взять MKV
 */
export function videoPlan(sourceExt, audioCodec, preferSource = true) {
  const ext = sourceExt.toLowerCase();
  const c = preferSource ? CONTAINERS[ext] : null;
  const mkv = (reason) => ({ ext: "mkv", ...CONTAINERS.mkv, origCodec: "copy", reason });
  if (!c) return mkv(preferSource ? `формат ${ext.toUpperCase()} не поддерживается для сохранения` : "");
  if (c.reason) return mkv(c.reason);
  const origCodec = !c.keep || c.keep.includes(audioCodec) ? "copy" : c.voice;
  return { ext, ...c, origCodec, reason: "" };
}

/** Тот же план, но в MKV — если сборка в формате исходника не удалась. */
export const mkvPlan = (reason) => ({ ext: "mkv", ...CONTAINERS.mkv, origCodec: "copy", reason });

/**
 * Облегчённая копия для загрузки: чёрный кадр 256x144 @ 1 fps + исходный звук.
 * Диск видит её как видео (vot.js требует mediatype=video), весит она как аудио, картинка никуда не уходит.
 * -t по длительности исходника: -shortest с 1 fps промахивается на десятки секунд.
 *
 * Звук AAC моно/стерео кладём как есть (copyAudio): пережатие 40-мин звука — ~40 с на одном ядре,
 * а качество для переводчика только лучше. Заодно за то же чтение исходника сохраняем его звук
 * без изменений (origOut) — сборка дорожки и прослушивание потом не читают гигабайты видео.
 * Если пережимать всё же надо — с битрейтом не хуже оригинала (audio — сведения о нём из probe).
 */
export function makeLight(input, out, duration, onProgress, signal,
  { copyAudio = false, origOut = null, audio = {}, fast = false } = {}) {
  return ffmpeg([
    "-v", "error", "-stats", "-t", String(duration),
    "-f", "lavfi", "-i", "color=c=black:s=256x144:r=1",
    "-i", input,
    "-map", "0:v", "-map", "1:a:0",
    "-c:v", "libx264", "-preset", "veryfast", "-tune", "stillimage", "-crf", "40",
    ...(copyAudio ? ["-c:a", "copy"] : audioArgs(":a", "aac", audio, { multi: audio.channels > 2, fast })),
    "-shortest", "-movflags", "+faststart",
    out,
    ...(origOut ? ["-map", "1:a:0", "-c", "copy", origOut] : []),
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
  const env = ([a, b]) => `clip((t-${(a - RAMP).toFixed(2)})/${r},0,1)*clip((${(b + RAMP).toFixed(2)}-t)/${r},0,1)`;
  // Фразы идут по порядку и не перекрываются вместе с переходами (speechSegments оставляет между ними
  // ≥ 3·RAMP), поэтому в каждый момент звучит не больше одной — ищем её делением пополам: ~10 проверок
  // на кадр вместо сотен слагаемых (на 40-мин видео сборка дорожки быстрее в разы, звук тот же).
  const pick = (lo, hi) => {
    if (hi - lo === 1) return env(segments[lo]);
    const mid = (lo + hi) >> 1;
    const border = ((segments[mid - 1][1] + segments[mid][0]) / 2).toFixed(2);
    return `if(lt(t,${border}),${pick(lo, mid)},${pick(mid, hi)})`;
  };
  return `1-${(1 - level).toFixed(3)}*${pick(0, segments.length)}`;
}

// автоподстройка перевода под оригинал — в разумных пределах, чтобы не раздуть шум или тишину
const AUTO_GAIN_MIN_DB = -20;
const AUTO_GAIN_MAX_DB = 12;
// перевод чуть громче оригинала — иначе при оригинале на 100 % речь тонет
const AUTO_TARGET_OFFSET_DB = 3;

/**
 * Разбор дорожки перевода: громкость речи и где она звучит. Делается один раз после перевода —
 * сборка и предпрослушивание берут готовое (на 40-мин видео это экономит секунды на каждом прослушивании).
 */
export async function analyzeVoice(voice, signal) {
  const [loudness, segments] = await Promise.all([measureLoudness(voice, signal), speechSegments(voice, signal)]);
  return { loudness, segments };
}

/**
 * Граф фильтров сведения: [0] — звук оригинала, [1] — перевод → [mix].
 *
 * mixMode "duck"     — оригинал на originalVolume %, только пока звучит перевод; в паузах 100 %;
 *         "constant" — оригинал всё время на originalVolume %.
 * autoLevel + origLoudness (LUFS оригинала) — перевод подгоняется по громкости к оригиналу,
 * voiceGain применяется поверх.
 * offset — с какой секунды вырезан кусок (для предпрослушивания): фразы сдвигаются к началу куска.
 */
function mixFilter(opts, analysis, offset = 0) {
  const { voiceGain = 1, originalVolume = 30, mixMode = "duck", autoLevel = true, origLoudness = null } = opts;
  const level = Math.min(100, Math.max(0, Number(originalVolume) || 0)) / 100;

  let autoGainDb = null;
  if (autoLevel && origLoudness !== null && analysis.loudness !== null) {
    autoGainDb = Math.min(AUTO_GAIN_MAX_DB, Math.max(AUTO_GAIN_MIN_DB, origLoudness + AUTO_TARGET_OFFSET_DB - analysis.loudness));
  }
  const voiceVolume = voiceGain * 10 ** ((autoGainDb ?? 0) / 20);

  // оба звука — в стерео до смешивания: перевод Яндекса моно, и без этого amix сводит к моно
  // всю итоговую дорожку, теряя стерео оригинала
  const orig = "[0:a:0]aresample=48000,aformat=channel_layouts=stereo";
  let origChain;
  if (level >= 1) {
    origChain = `${orig}[duck]`;
  } else if (mixMode === "constant") {
    origChain = `${orig},volume=${level.toFixed(3)}[duck]`;
  } else {
    const segments = analysis.segments
      .map(([a, b]) => [a - offset, b - offset])
      .filter(([, b]) => b > -RAMP);
    origChain = `${orig},volume='${duckExpression(segments, level)}':eval=frame[duck]`;
  }

  const filter = [
    `[1:a]aresample=48000,aformat=channel_layouts=stereo,volume=${voiceVolume.toFixed(4)}[voice]`,
    origChain,
    "[duck][voice]amix=inputs=2:duration=first:normalize=0[mix]",
  ].join(";\n");
  return { filter, autoGainDb };
}

/** ffmpeg с графом фильтров из файла (длинный граф не влезает в командную строку Windows). */
async function withFilterScript(filter, run) {
  const script = path.join(tmpdir(), `local-vot-filter-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(script, filter);
  try {
    return await run(script);
  } finally {
    rmSync(script, { force: true });
  }
}

/**
 * Итоговое видео: картинка без перекодирования + дорожка «оригинал с переводом поверх»
 * + исходная дорожка + субтитры. opts — см. mixFilter, плюс voiceAnalysis (из analyzeVoice).
 * plan — формат итога (videoPlan / mkvPlan); если контейнер не держит субтитры, subs сюда не передают.
 * @returns { autoGainDb } — на сколько подстроен перевод (null — без подстройки)
 */
export async function mux(video, voice, subs, out, opts = {}, duration, onProgress, signal, plan = mkvPlan("")) {
  const analysis = opts.voiceAnalysis ?? await analyzeVoice(voice, signal);
  const { filter, autoGainDb } = mixFilter(opts, analysis);
  const withSubs = Boolean(subs && plan.subs);
  // opts.origInfo — сведения о звуке оригинала (probe().audio): перевод кодируем не хуже него
  const src = opts.origInfo ?? {};
  const orig = plan.origCodec === "copy" ? ["-c:a:1", "copy"]
    : audioArgs(":a:1", plan.origCodec, src, { multi: src.channels > 2, fast: opts.fastAudio });
  // та же дорожка уже собрана в .m4a (opts.premixed) — берём её готовой, без второго кодирования
  const premixed = opts.premixed && plan.voice === "aac" ? opts.premixed : null;
  const mix = premixed
    ? { input: ["-i", premixed], map: "1:a:0", codec: ["-c:a:0", "copy"] }
    : { input: ["-i", voice], map: "[mix]", codec: audioArgs(":a:0", plan.voice, src, { fast: opts.fastAudio }) };
  const run = (script) => ffmpeg([
    "-v", "error", "-stats",
    "-i", video, ...mix.input, ...(withSubs ? ["-i", subs] : []),
    ...(script ? [FILTER_SCRIPT_FLAG, script] : []),
    "-map", "0:v:0", "-map", mix.map, "-map", "0:a:0", ...(withSubs ? ["-map", "2:s"] : []),
    "-c:v", "copy", ...mix.codec, ...orig, ...(withSubs ? ["-c:s", plan.subs] : []),
    "-f", plan.format,
    "-metadata:s:a:0", "language=rus", "-metadata:s:a:0", "title=Перевод",
    "-metadata:s:a:1", "title=Оригинал",
    ...(withSubs ? ["-metadata:s:s:0", "language=rus", "-metadata:s:s:0", "title=Русские"] : []),
    "-disposition:a:0", "default", "-disposition:a:1", "0",
    out,
  ], { duration, onProgress, signal });
  await (premixed ? run(null) : withFilterScript(filter, run));
  return { autoGainDb };
}

/**
 * Звуковая дорожка отдельно: оригинал + перевод с теми же настройками, что у видео, без картинки.
 * Для плееров, которые подключают внешнюю дорожку, — вместо копии многогигабайтного видео.
 * @returns { autoGainDb }
 */
export async function mixAudio(orig, voice, out, opts = {}, duration, onProgress, signal) {
  const analysis = opts.voiceAnalysis ?? await analyzeVoice(voice, signal);
  const { filter, autoGainDb } = mixFilter(opts, analysis);
  await withFilterScript(filter, (script) => ffmpeg([
    "-v", "error", "-stats",
    ...origInput(orig), "-i", voice,
    FILTER_SCRIPT_FLAG, script,
    "-map", "[mix]", "-vn", ...audioArgs(":a", "aac", opts.origInfo ?? {}, { fast: opts.fastAudio }), "-movflags", "+faststart",
    "-metadata:s:a:0", "language=rus", "-metadata:s:a:0", "title=Перевод",
    out,
  ], { duration, onProgress, signal }));
  return { autoGainDb };
}

/**
 * Предпрослушивание: только звук куска [start, start+length) с теми же настройками, что у сборки.
 * Исходник не копируется — ffmpeg прыгает к нужному месту (быстро даже на десятках гигабайт).
 * @returns { data: Buffer (m4a/AAC), autoGainDb }
 */
export async function renderPreview(orig, voice, start, length, opts = {}, signal) {
  const analysis = opts.voiceAnalysis ?? await analyzeVoice(voice, signal);
  const { filter, autoGainDb } = mixFilter(opts, analysis, start);
  const out = path.join(tmpdir(), `local-vot-preview-${process.pid}-${Date.now()}.m4a`);
  const cut = (from) => ["-ss", Math.max(0, from).toFixed(3), "-t", String(length)];
  // копия звука начинается раньше видео на свою задержку — берём кусок с поправкой на неё
  const origArgs = typeof orig === "string" ? [...cut(start), "-i", orig] : [...cut(start - orig.offset), "-i", orig.path];
  try {
    await withFilterScript(filter, (script) => ffmpeg([
      "-v", "error",
      ...origArgs, ...cut(start), "-i", voice,
      FILTER_SCRIPT_FLAG, script,
      "-map", "[mix]", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
      out,
    ], { signal }));
    return { data: readFileSync(out), autoGainDb };
  } finally {
    rmSync(out, { force: true });
  }
}
