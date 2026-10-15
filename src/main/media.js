// Работа с видео через ffmpeg (своя сборка — scripts/build-ffmpeg.sh; если её нет — системный).
import { spawn as spawnProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ffmpeg — с приоритетом «ниже среднего»: кодирование занимает все ядра, и с обычным приоритетом окно программы
 * (и всё остальное на компьютере) получало долю наравне с десятками ffmpeg — подвисало секунд на 10–15.
 * Свободные ядра ffmpeg так же забирает целиком, просто уступает их окну по первому требованию.
 */
function spawn(cmd, args, opts) {
  const p = spawnProcess(cmd, args, opts);
  if (p.pid) {
    try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* уже завершился */ }
  }
  return p;
}
export const spawnBelowNormal = spawn; // для проверки (tests/media.test.mjs)

// Своя сборка ffmpeg (scripts/build-ffmpeg.sh): при разработке — vendor/ffmpeg в папке проекта, в собранной
// программе — resources/ffmpeg (extraResources в package.json; этот файл там — resources/app.asar/src/main).
// Нет её — системный ffmpeg (7 или новее).
const here = path.dirname(fileURLToPath(import.meta.url));
const FFMPEG = [path.join(here, "..", "..", "vendor", "ffmpeg", "ffmpeg.exe"), path.join(here, "..", "..", "..", "ffmpeg", "ffmpeg.exe")]
  .find((p) => existsSync(p)) ?? "ffmpeg";
// длинный граф фильтров (сотни фраз) не влезает в командную строку Windows — отдаём файлом (синтаксис ffmpeg 7+)
const FILTER_SCRIPT_FLAG = "-/filter_complex";

const RAMP = 0.2; // плавность приглушения оригинала, с

// куда класть временные файлы (граф фильтров, кусок для прослушивания): главный процесс задаёт папку
// программы — у портативной версии она внутри её папки data; без этого — системная временная папка
let tempDir = tmpdir();
export function setTempDir(dir) { tempDir = dir; }
function tempFile(name) {
  mkdirSync(tempDir, { recursive: true });
  return path.join(tempDir, name);
}
/**
 * Убрать временный файл, не дожидаясь и не падая: только что записанный файл Windows (антивирус) иногда
 * держит долю секунды — повторяем; не вышло — папку программы всё равно чистят при выходе.
 */
const dropTemp = (f) => rm(f, { force: true, recursive: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});

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
      else {
        const tail = log.split("\n").map((l) => l.trim()).filter(Boolean).slice(-2).join(" · ");
        reject(new Error(`ffmpeg: ${tail || `завершился с кодом ${code} без сообщения`}`));
      }
    });
  });
}

/**
 * Короткий запуск ffmpeg «посмотреть на файл» (сведения, задержка звука, кадр): обычно доли секунды, но
 * недокачанный или занятый файл (торрент, сетевой диск) может держать его сколько угодно — поэтому
 * останавливается и по отмене, и по времени. Возвращает { out: Buffer (stdout), err: string (stderr), timedOut }.
 */
function briefRun(args, { signal, timeout }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Отменено"));
    const p = spawn(FFMPEG, ["-hide_banner", "-nostdin", ...args], { windowsHide: true });
    const out = [];
    let err = "";
    let timedOut = false;
    const kill = () => p.kill();
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeout);
    signal?.addEventListener("abort", kill, { once: true });
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => { err += d; });
    const finish = (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      if (signal?.aborted) reject(new Error("Отменено"));
      else resolve({ out: Buffer.concat(out), err, code, timedOut });
    };
    p.on("error", () => { err = ""; finish(-1); });
    p.on("close", finish);
  });
}
const NOT_READABLE = "Файл не читается: ffmpeg не смог его открыть за минуту. Возможно, видео ещё не докачано "
  + "или файл занят другой программой";

/**
 * Кадр для миниатюры (JPEG, ширина 320) — когда Windows не умеет сделать миниатюру сама (нет кодека).
 * Берём кадр с 10 % длительности (не дальше 60 с): в самом начале часто чёрная заставка.
 * -ss перед -i — прыжок, а не чтение с начала: быстро даже на десятках гигабайт.
 */
export async function grabFrame(file, duration = 0) {
  const at = Math.min(60, Math.max(0, duration * 0.1));
  const { out, err, code, timedOut } = await briefRun(["-v", "error", "-ss", at.toFixed(2), "-i", file, "-frames:v", "1",
    "-vf", "scale=320:-2", "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "4", "pipe:1"], { timeout: 30_000 });
  if (code !== 0 || !out.length) throw new Error(`ffmpeg: кадр не получен ${timedOut ? "(за 30 с)" : err.slice(-500).trim()}`);
  return out;
}

/** Длительность видео в секундах; заодно проверяет, что в файле есть звук. */
export async function probe(file, signal, timeout = 60_000) {
  // ffmpeg без выходного файла завершается с ошибкой, но сведения о файле печатает
  const { err: info, timedOut } = await briefRun(["-i", file], { signal, timeout });
  if (timedOut) throw new Error(NOT_READABLE);
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
 * бывает и сотни. Копия звука (makeLight → origOut) эту задержку теряет — при сведении и в облегчённой копии
 * её возвращаем явно, до сэмпла (shift), чтобы оригинал стоял там же, где в видео. Читает только начало файла.
 * @param start — начало файла из probe()
 */
export async function audioOffset(file, start, signal, timeout = 60_000) {
  const { out: raw, timedOut } = await briefRun(["-v", "error", "-copyts", "-i", file, "-map", "0:a:0", "-frames:a", "1",
    "-f", "framecrc", "-"], { signal, timeout });
  // первый кадр звука не читается минуту — с файлом что-то не так (недокачан), копия его всё равно не прочтёт
  if (timedOut) throw new Error(NOT_READABLE);
  const out = raw.toString();
  const tb = /#tb 0: (\d+)\/(\d+)/.exec(out);
  const frame = /^0,\s*-?\d+,\s*(-?\d+),/m.exec(out); // поток, dts, pts, …
  if (!tb || !frame) return 0;
  const offset = (Number(frame[1]) * Number(tb[1])) / Number(tb[2]) - start;
  return Math.abs(offset) < 0.001 ? 0 : offset;
}

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
 * Звук в копии — только для Яндекса (распознать речь, услышать голоса для живых), поэтому он сжат:
 * AAC 96 кбит/с стерео (64 — моно), быстрый режим кодировщика. Копия в 2,5 раза легче, чем со звуком
 * как есть (2 ч видео со звуком 256 кбит/с — ~85 МБ вместо ~210), а это месячный лимит загрузки Диска
 * (на бесплатном — 10 ГБ) и время загрузки; сжатие — ~10 с на 20 мин звука. Звук уже не толще этого
 * (AAC моно/стерео, copyAudio) — кладём как есть. Итог от этого не страдает: за то же чтение исходника
 * сохраняем его звук без изменений (origOut) — из него собираются дорожка и видео, по нему меряется
 * громкость, его слушает прослушивание, и гигабайты видео потом не читаются заново.
 */
export const LIGHT_KBPS = { 1: 64, 2: 96 };
const BLACK = ["-f", "lavfi", "-i", "color=c=black:s=256x144:r=1"];
const BLACK_CODEC = ["-c:v", "libx264", "-preset", "veryfast", "-tune", "stillimage", "-crf", "40"];
/**
 * Сжатие делается на всех ядрах (encodeAac) из копии звука origOut, уже после чтения исходника: так чтение
 * многогигабайтного видео не ждёт кодировщик на одном ядре. origOffset — на сколько звук начинается позже
 * начала видео (audioOffset): копия звука эту задержку теряет, в облегчённой копии она возвращается.
 */
export async function makeLight(input, out, duration, onProgress, signal,
  { copyAudio = false, origOut = null, audio = {}, origOffset = 0 } = {}) {
  const channels = audio.channels === 1 ? 1 : 2;
  const keep = copyAudio && audio.kbps && audio.kbps <= LIGHT_KBPS[channels] + 32;
  if (keep || !origOut) {
    await ffmpeg([
      "-v", "error", "-stats", "-t", String(duration), ...BLACK,
      "-i", input,
      "-map", "0:v", "-map", "1:a:0", ...BLACK_CODEC,
      ...(keep ? ["-c:a", "copy"]
        : ["-c:a", "aac", "-b:a", `${LIGHT_KBPS[channels]}k`, "-ac", String(channels), "-aac_coder", "fast"]),
      "-shortest", "-movflags", "+faststart",
      out,
      ...(origOut ? ["-map", "1:a:0", "-c", "copy", origOut] : []),
    ], { duration, onProgress, signal });
    return;
  }
  const tag = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const picture = tempFile(`light-${tag}.mp4`);
  const sound = tempFile(`light-${tag}.m4a`);
  try {
    // одно чтение исходника: чёрная картинка и звук оригинала как есть (это почти всё время копии)
    await ffmpeg([
      "-v", "error", "-stats", "-t", String(duration), ...BLACK,
      "-i", input,
      "-map", "0:v", ...BLACK_CODEC, "-an", picture,
      "-map", "1:a:0", "-c", "copy", origOut,
    ], { duration, onProgress: (p) => onProgress?.(p * 0.9), signal });
    await encodeAac(["-i", origOut],
      `[0:a:0]asetpts=N/SR/TB,aresample=${RATE},aformat=channel_layouts=${channels === 1 ? "mono" : "stereo"}${shift(origOffset)}[mix]`,
      sound, { kbps: LIGHT_KBPS[channels], fast: true, duration, onProgress: (p) => onProgress?.(0.9 + p * 0.1), signal });
    await ffmpeg(["-v", "error", "-i", picture, "-i", sound, "-map", "0:v", "-map", "1:a", "-c", "copy", "-movflags", "+faststart", out],
      { signal });
  } finally {
    dropTemp(picture);
    dropTemp(sound);
  }
}

const RATE = 48000; // звук дорожек и копий — 48 кГц: так кадры AAC (1024 сэмпла) у кусков encodeAac совпадают
/** Задержка звука на offset с (отрицательная — обрезать начало) — точно до сэмпла, после aresample=RATE. */
const shift = (offset) => (!offset ? ""
  : offset > 0 ? `,adelay=${Math.round(offset * RATE)}S:all=1`
    : `,atrim=start_sample=${Math.round(-offset * RATE)},asetpts=N/SR/TB`);

// ---------- AAC на всех ядрах ----------
// Кодировщик AAC в ffmpeg работает на одном ядре: 2 ч звука 256 кбит/с — ~2,5 мин, и ускорить его самого
// нечем (ffmpeg 8 вместо 6.1 — на 5–10 %). Поэтому звук режется на куски, куски кодируются одновременно
// отдельными ffmpeg и склеиваются по пакетам. Проверено на 21-мин дорожке (8 кусков): 26 → 8 с, длина и
// положение до сэмпла как у обычного кодирования, средний SNR тот же (38,1 дБ).
// - Каждый кусок считает граф фильтров с самого начала и вырезает свой отрезок (atrim по сэмплам): перемотка
//   входа (-ss) точна лишь до миллисекунды — куски разъезжались бы на несколько сэмплов. Начало графа
//   считается быстро (декодирование и фильтры — ~3 с на 20 мин), дольше всего — само кодирование.
// - Отрезок кодируется с запасом CHUNK_PAD кадров с обеих сторон: кодировщику нужно «разогнаться» —
//   с запасом 16 кадров кадры у стыков выходили заметно хуже обычных, с 64 (~1,4 с) — не отличить.
// - Из каждого куска берутся только пакеты своего отрезка. Пакет j куска, начатого с сэмпла a, декодируется
//   в сэмплы [a + (j−1)·1024, a + j·1024): первый пакет — «разгон» кодировщика (1024 сэмпла задержки).
//   Склейка начинается с «разгона» первого куска, как у обычного кодирования, — в m4a он помечается задержкой.
const FRAME = 1024;
const CHUNK_PAD = 64;
const PARALLEL_MIN_SEC = 180; // короче — одним процессом: выигрыш меньше, чем запуск десятка ffmpeg
const CORES = Math.max(1, os.availableParallelism?.() ?? os.cpus().length);
let encoding = 0; // сколько encodeAac идёт кусками прямо сейчас

/**
 * Отрезки по кадрам: [from, to) — свои, последний открыт до конца. Последующие куски сначала проходят граф
 * до своего начала, поэтому они короче: время каждого ≈ r·начало + длина (r — сколько стоит проход графа
 * против кодирования, ~0,1: подобрано на 2-ч дорожке — 16 кусков кончают за 28–34 с, всё — 36 с вместо 167) —
 * подбираем общую длительность T так, чтобы хватило n кусков. Больше 16 кусков не быстрее (22 — 40 с).
 */
function chunkPlan(totalFrames, n, r = 0.1) {
  const fits = (T) => {
    const chunks = [];
    let from = 0;
    while (from < totalFrames) {
      const len = Math.floor(T - r * from);
      if (len < CHUNK_PAD * 4 || chunks.length === n) return null;
      chunks.push([from, Math.min(totalFrames, from + len)]);
      from += len;
    }
    return chunks;
  };
  let lo = 1, hi = totalFrames;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (fits(mid)) hi = mid; else lo = mid + 1;
  }
  const chunks = fits(lo) ?? [[0, totalFrames]];
  chunks.at(-1)[1] = Infinity;
  return chunks;
}

/** Пакеты ADTS из файла (у каждого заголовок со своей длиной). */
function adtsPackets(buf) {
  const packets = [];
  for (let o = 0; o + 7 <= buf.length;) {
    if (buf[o] !== 0xff || (buf[o + 1] & 0xf0) !== 0xf0) throw new Error("ffmpeg: повреждён кусок звука (ADTS)");
    const len = ((buf[o + 3] & 3) << 11) | (buf[o + 4] << 3) | (buf[o + 5] >> 5);
    packets.push(buf.subarray(o, o + len));
    o += len;
  }
  return packets;
}

/**
 * Звук из графа фильтров (выход [mix], RATE Гц) → AAC в m4a, на всех ядрах. inputs — аргументы входов ffmpeg;
 * after — аргументы вывода (метаданные). Короткий звук или мало ядер — одним процессом, как обычно.
 */
async function encodeAac(inputs, graph, out, { kbps, fast = false, duration, onProgress, signal, after = [] }) {
  const codec = ["-c:a", "aac", "-b:a", `${kbps}k`, ...(fast ? ["-aac_coder", "fast"] : [])];
  if (!graph.endsWith("[mix]")) throw new Error("encodeAac: граф должен кончаться выходом [mix]");
  // ядра делятся между видео, которые кодируются одновременно («Копия и сборка» — до 8): иначе 8 видео
  // запустили бы по 16 ffmpeg — 128 процессов, памяти много, а быстрее не станет
  const n = Math.min(16, Math.floor((CORES - 1) / (encoding + 1)));
  if (!(duration >= PARALLEL_MIN_SEC) || n < 2) {
    await withFilterScript(graph, (script) => ffmpeg(["-v", "error", "-stats", ...inputs, FILTER_SCRIPT_FLAG, script,
      "-map", "[mix]", ...codec, "-movflags", "+faststart", ...after, out], { duration, onProgress, signal }));
    return;
  }
  const chunks = chunkPlan(Math.ceil((duration * RATE) / FRAME), n);
  // один кусок не вышел — остальные останавливаем
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const tag = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const files = chunks.map((_, i) => tempFile(`aac-${tag}-${i}.aac`));
  const joined = tempFile(`aac-${tag}.aac`);
  const done = chunks.map(() => 0);
  let shown = 0; // ход — не назад: ffmpeg кусков отчитываются вразнобой
  const report = () => {
    shown = Math.max(shown, done.reduce((a, b) => a + b, 0) / chunks.length);
    onProgress?.(shown);
  };
  encoding++;
  try {
    await Promise.all(chunks.map(async ([from, to], i) => {
      const a = Math.max(0, from - CHUNK_PAD); // с какого кадра кусок кодирует (с запасом)
      const b = to === Infinity ? null : to + CHUNK_PAD;
      const trim = `atrim=start_sample=${a * FRAME}${b === null ? "" : `:end_sample=${b * FRAME}`},asetpts=N/SR/TB`;
      const len = ((b ?? Math.ceil((duration * RATE) / FRAME)) - a) * FRAME / RATE;
      try {
        await withFilterScript(`${graph.slice(0, -"[mix]".length)},${trim}[mix]`, (script) => ffmpeg([
          "-v", "error", "-stats", ...inputs, FILTER_SCRIPT_FLAG, script, "-map", "[mix]", ...codec, "-f", "adts", files[i],
        ], { duration: len, onProgress: (p) => { done[i] = p; report(); }, signal: stop.signal }));
      } catch (e) {
        stop.abort();
        throw e;
      }
    }));
    const parts = chunks.map(([from, to], i) => {
      const a = Math.max(0, from - CHUNK_PAD);
      const packets = adtsPackets(readFileSync(files[i]));
      // пакет j — сэмплы [a + (j−1)·1024, …): свои — с кадра from; у первого куска — и «разгон» (j = 0)
      return packets.slice(i === 0 ? 0 : from - a + 1, to === Infinity ? packets.length : to - a + 1);
    });
    writeFileSync(joined, Buffer.concat(parts.flat()));
    // «разгон» в начале склейки — задержка кодировщика: сдвигаем на него, и m4a помечает его, как при обычном
    // кодировании (проверено: число сэмплов и положение совпадают)
    await ffmpeg(["-v", "error", "-itsoffset", (-FRAME / RATE).toFixed(6), "-i", joined, "-map", "0:a", "-c", "copy",
      "-movflags", "+faststart", ...after, out], { signal });
  } catch (e) {
    throw signal?.aborted ? new Error("Отменено") : e;
  } finally {
    encoding--;
    signal?.removeEventListener("abort", onAbort);
    for (const f of [...files, joined]) dropTemp(f);
  }
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
 * Громкость звука во времени (EBU R128): общая громкость (integrated, LUFS) и мгновенная громкость
 * (окно 400 мс) каждые PROFILE_STEP секунд — по ней потом считается, насколько громок оригинал именно
 * там, где звучит перевод (loudnessDuring). Один проход ffmpeg, как и для общей громкости.
 * @returns { integrated, step, m: Float32Array } или null — если измерить не вышло
 */
const PROFILE_STEP = 0.2; // = 2 значения ebur128 (он пишет каждые 0,1 с)
export async function loudnessProfile(file, signal) {
  const values = [];
  let integrated = NaN;
  await new Promise((resolve) => {
    const p = spawn(FFMPEG, ["-hide_banner", "-nostdin", "-nostats", "-i", file, "-map", "0:a:0",
      "-af", "ebur128=framelog=info", "-f", "null", "-"], { windowsHide: true });
    const onAbort = () => p.kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    // строк — по десять на секунду звука: разбираем по мере поступления, не копя весь вывод
    let rest = "";
    let n = 0; // ebur128 пишет значение каждые 0,1 с, берём каждое второе: i-е — на (i + 1) · 0,2 с
    p.stderr.on("data", (d) => {
      const lines = (rest + d).split("\n");
      rest = lines.pop();
      for (const line of lines) {
        const m = /\bt:\s*([\d.]+)\s+TARGET:\S+\s+LUFS\s+M:\s*(-?[\d.]+|-inf)/.exec(line);
        if (m) {
          if (++n % 2 === 0) values.push(m[2] === "-inf" ? -120 : Number(m[2]));
          continue;
        }
        const i = /^\s*I:\s+(-?\d+(?:\.\d+)?) LUFS/.exec(line);
        if (i) integrated = Number(i[1]); // итог печатается в конце; последнее значение и есть общее
      }
    });
    p.on("error", () => resolve());
    p.on("close", () => { signal?.removeEventListener("abort", onAbort); resolve(); });
  });
  signal?.throwIfAborted();
  if (!Number.isFinite(integrated) || integrated <= -60) return null; // -70 — это тишина
  return { integrated, step: PROFILE_STEP, m: Float32Array.from(values) };
}

/**
 * Громкость звука (LUFS) только в указанные промежутки времени — по профилю loudnessProfile, с тем же
 * гейтингом, что у EBU R128: тишина (ниже -70) и куски на 10 LU тише среднего в расчёт не входят.
 * null — в эти промежутки звука нет совсем.
 */
export function loudnessDuring(profile, segments) {
  if (!profile?.m?.length || !segments?.length) return null;
  const { m, step } = profile;
  const picked = [];
  let s = 0;
  for (let i = 0; i < m.length && s < segments.length; i++) {
    const t = (i + 1) * step - 0.2; // середина окна 400 мс, которым мерилось значение
    while (s < segments.length && segments[s][1] < t) s++;
    if (s < segments.length && t >= segments[s][0] && m[i] > -70) picked.push(m[i]);
  }
  if (!picked.length) return null;
  const mean = (arr) => 10 * Math.log10(arr.reduce((a, v) => a + 10 ** (v / 10), 0) / arr.length);
  const gate = mean(picked) - 10;
  const loud = picked.filter((v) => v > gate);
  return loud.length ? mean(loud) : null;
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
// потолок итоговой дорожки: -1 dBFS. Оригинал + перевод, сложенные вместе, на громком видео выходят
// за 0 dBFS — без ограничителя это хрип; ограничитель срабатывает только на таких пиках
const LIMIT = 0.891;

/**
 * Разбор дорожки перевода: громкость речи и где она звучит. Делается один раз после перевода —
 * сборка и предпрослушивание берут готовое (на 40-мин видео это экономит секунды на каждом прослушивании).
 */
export async function analyzeVoice(voice, signal) {
  const [loudness, segments] = await Promise.all([measureLoudness(voice, signal), speechSegments(voice, signal)]);
  return { loudness, segments };
}

/**
 * Насколько громок оригинал для подстройки перевода (LUFS): там, где звучит перевод (по профилю
 * громкости), — то, с чем перевод на самом деле звучит вместе. Общая громкость видео сбивается громкой
 * музыкой, взрывами или долгой тишиной, а речь обычно тише них. Профиля нет — общая громкость.
 */
function origReference(opts, analysis) {
  const during = loudnessDuring(opts.origProfile, analysis.segments);
  return during ?? opts.origLoudness ?? null;
}

/**
 * Граф фильтров сведения: [0] — звук оригинала, [1] — перевод → [mix].
 *
 * mixMode "duck"     — оригинал на originalVolume %, только пока звучит перевод; в паузах 100 %;
 *         "constant" — оригинал всё время на originalVolume %.
 * autoLevel + origProfile / origLoudness (громкость оригинала) — перевод подгоняется по громкости
 * к оригиналу там, где звучит (origReference), voiceGain применяется поверх.
 * В конце — ограничитель пиков (LIMIT): сумма двух звуков не должна хрипеть.
 * offset — с какой секунды вырезан кусок (для предпрослушивания): фразы сдвигаются к началу куска;
 * громкость для подстройки при этом считается по всему видео — кусок звучит так же, как в файле.
 * duration — длина итога, с (длина видео); null — по длине входов.
 * origDelay — на сколько звук оригинала начинается позже начала видео (копия звука эту задержку теряет).
 * Метки времени входов сбрасываются (asetpts): amix всё равно складывает звуки сэмпл к сэмплу, не глядя на них, —
 * задержка ставится явно, до сэмпла, а итог начинается с нуля (это нужно и кускам encodeAac).
 */
function mixFilter(opts, analysis, offset = 0, duration = null, origDelay = 0) {
  const { voiceGain = 1, originalVolume = 30, mixMode = "duck", autoLevel = true } = opts;
  const level = Math.min(100, Math.max(0, Number(originalVolume) || 0)) / 100;

  let autoGainDb = null;
  const origRef = autoLevel ? origReference(opts, analysis) : null;
  if (origRef !== null && analysis.loudness !== null) {
    autoGainDb = Math.min(AUTO_GAIN_MAX_DB, Math.max(AUTO_GAIN_MIN_DB, origRef + AUTO_TARGET_OFFSET_DB - analysis.loudness));
  }
  const voiceVolume = voiceGain * 10 ** ((autoGainDb ?? 0) / 20);

  // оба звука — в стерео до смешивания: перевод Яндекса моно, и без этого amix сводит к моно
  // всю итоговую дорожку, теряя стерео оригинала
  const orig = `[0:a:0]asetpts=N/SR/TB,aresample=${RATE},aformat=channel_layouts=stereo${shift(origDelay)}`;
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
    `[1:a]asetpts=N/SR/TB,aresample=${RATE},aformat=channel_layouts=stereo,volume=${voiceVolume.toFixed(4)}[voice]`,
    origChain,
    // длина — по видео: amix с duration=first у некоторых звуков (FLAC — частый в MKV) обрывает конец
    // на ~1,5 с, поэтому сводим по самому длинному входу и обрезаем точно по длине видео.
    // Ограничитель: level=0 — сам громкость не поднимает; упреждение (attack) 1 мс — на столько он задерживает
    // звук, это не слышно. Компенсацию задержки (latency=1) не включаем: она сбивает метки времени, и у видео,
    // где звук начинается позже картинки, перевод разъезжался бы с оригиналом
    `[duck][voice]amix=inputs=2:duration=longest:normalize=0${duration ? `,atrim=end=${duration.toFixed(3)}` : ""},`
      + `alimiter=limit=${LIMIT}:attack=1:release=80:level=0[mix]`,
  ].join(";\n");
  return { filter, autoGainDb };
}

/** ffmpeg с графом фильтров из файла (длинный граф не влезает в командную строку Windows). */
async function withFilterScript(filter, run) {
  const script = tempFile(`filter-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
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
  const { filter, autoGainDb } = mixFilter(opts, analysis, 0, duration, opts.origOffset ?? 0);
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
  const src = typeof orig === "string" ? { path: orig, offset: 0 } : orig;
  const { filter, autoGainDb } = mixFilter(opts, analysis, 0, duration, src.offset);
  await encodeAac(["-i", src.path, "-i", voice], filter, out, {
    kbps: audioKbps("aac", opts.origInfo ?? {}), fast: opts.fastAudio, duration, onProgress, signal,
    after: ["-metadata:s:a:0", "language=rus", "-metadata:s:a:0", "title=Перевод"],
  });
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
  const out = tempFile(`preview-${process.pid}-${Date.now()}.m4a`);
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
