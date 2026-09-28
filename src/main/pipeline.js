// Одно задание перевода: видео → облегчённая копия → Диск → перевод Яндекса →
// убрать файл с Диска → сохранить результат рядом с видео (или в выбранную папку).
import { copyFileSync, existsSync, mkdirSync, rmSync, statfsSync, statSync } from "node:fs";
import path from "node:path";
import * as disk from "./yadisk.js";
import { translate } from "./vot.js";
import { analyzeVoice, audioKbps, audioOffset, makeLight, measureLoudness, mixAudio, mkvPlan, mux, probe, videoPlan } from "./media.js";
import { detectedName, langName, LIVELY_LANG } from "./languages.js";
import { workRoot } from "./paths.js";
import { log } from "./log.js";

export const STEPS = [
  { id: "light", title: "Облегчённая копия" },
  { id: "upload", title: "Загрузка на Яндекс Диск" },
  { id: "translate", title: "Перевод" },
  { id: "cleanup", title: "Закрытие ссылки" },
  { id: "save", title: "Сохранение результата" },
];

/** «имя [RU].mkv» → «имя [RU] (2).mkv», если такой файл уже есть. */
function freePath(p) {
  if (!existsSync(p)) return p;
  const { dir, name, ext } = path.parse(p);
  for (let i = 2; ; i++) {
    const candidate = path.join(dir, `${name} (${i})${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
}

const fmtSec = (s) => (s < 60 ? `${s} с` : `${Math.floor(s / 60)} мин ${String(s % 60).padStart(2, "0")} с`);
const DISK_BYTES_PER_SEC = 130_000; // если сработает ограничение Диска: ~127 КБ/с (замерено)

/**
 * Копия на Диске живёт дольше одного перевода: job.diskPath сохраняется, чтобы «Перевести заново»
 * и смена голоса не грузили файл повторно. Убирает её main.js (при удалении из списка и выходе).
 *
 * Полученный перевод (дорожка и субтитры) тоже хранится — в job.translation, в папке кэша, —
 * чтобы «Пересобрать видео» (mode = "remux") собирало видео заново без запроса к Яндексу.
 *
 * @param job   { id, file, lively, lang, diskPath?, duration?, translation? } — дополняется здесь
 * @param emit  ({ step, state?: "active"|"done"|"error", progress?: 0..1, detail?: string }) — ход работы
 * @returns { outputs: string[], lively: boolean, lang: string } — созданные файлы, голос и язык перевода
 */
export async function runJob(job, { getOptions, token, mode = "translate" }, emit, signal) {
  const { file } = job;
  const work = path.join(workRoot(), `${job.id}-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  const name = path.parse(file).name;
  let current = null;
  const step = (stepId, patch = {}) => {
    current = stepId;
    emit({ step: stepId, ...patch });
  };

  try {
    let result, lively, lang;
    if (mode === "remux") {
      if (!job.translation || !existsSync(job.translation.audio)) {
        throw new Error("Готового перевода нет — нажмите «Перевести заново».");
      }
      ({ lively, lang } = job.translation);
      result = job.translation;
      emit({ step: "light", state: "done", detail: "" });
      emit({ step: "upload", state: "done", detail: "Не нужна" });
      emit({ step: "translate", state: "done", detail: "Берём уже полученный перевод — без запроса к Яндексу" });
      emit({ step: "cleanup", state: "done", detail: "" });
    } else {
      if (job.diskPath) {
        emit({ step: "light", state: "done", detail: "" });
        emit({ step: "upload", state: "done", detail: "Файл уже на Диске" });
      } else {
        await uploadCopy(job, work, token, step, signal, getOptions().fastAudio);
      }
      ({ result, lively, lang } = await translateOnce(job, work, token, step, emit, signal));
      job.translation = await keepTranslation(job, result, lively, lang, signal);
      result = job.translation;
    }

    step("save", { state: "active", detail: "Проверяем место на диске" });
    // настройки сохранения и звука — на момент сохранения, а не старта: пока видео грузилось
    // и переводилось, их могли поменять
    const options = getOptions();
    // перевод уже получен и лежит в кэше — ошибка ничего не теряет: отметить нужное и «Пересобрать видео»
    if (!options.saveVideo && !options.saveAudio && !options.saveVoice && !(options.saveSubs && result.subs)) {
      throw new Error(options.saveSubs
        ? "Отмечены только субтитры, а Яндекс их не прислал — сохранять нечего. Перевод получен: отметьте в «Что сохранить» видео или дорожку и нажмите «Пересобрать видео»."
        : "В «Что сохранить» ничего не отмечено. Перевод получен: отметьте нужное и нажмите «Пересобрать видео» — Яндекс заново не понадобится.");
    }
    const outDir = options.outputDir || path.dirname(file);
    mkdirSync(outDir, { recursive: true });
    const srcSize = statSync(file).size;
    // видео копируется без перекодирования — итог весит примерно как исходник
    ensureSpace(outDir, (options.saveVideo ? srcSize * 1.02 : 0) + 100 * MB,
      options.saveVideo ? "для видео с переводом" : "для файлов перевода");

    const outputs = [];
    const tag = lively ? "RU живые" : "RU";
    let pending = null; // файл, который пишется прямо сейчас, — при сбое или отмене удаляем
    let saveNote = "";
    const notes = []; // в каком формате сохранили и почему — в подпись шага
    // звук оригинала (кодек, битрейт, каналы): дорожку с переводом кодируем не хуже него
    const src = await probe(file);
    const mixOpts = { ...options, origLoudness: job.origLoudness ?? null, voiceAnalysis: result.analysis, origInfo: src.audio };
    try {
      // звуковую дорожку — первой: видео потом берёт её готовой, без второго кодирования того же звука
      let premixed = null;
      let voiceCodec = null; // чем закодирована дорожка с переводом — для подписи шага
      if (options.saveAudio) {
        // готовая звуковая дорожка: оригинал + перевод, как в видео, — для внешней дорожки в плеере;
        // звук оригинала — из копии, сделанной вместе с облегчённой (не читаем заново гигабайты видео)
        pending = freePath(path.join(outDir, `${name} [${tag}].m4a`));
        const out = pending;
        const { autoGainDb } = await withSaveProgress(out, "Собираем звуковую дорожку", job.duration * 24_000, step, (onP) =>
          mixAudio(origAudio(job), result.audio, out, mixOpts, job.duration, onP, signal));
        saveNote = describeMix(options, autoGainDb);
        voiceCodec = "aac";
        outputs.push(pending);
        premixed = pending;
        pending = null;
      }
      if (options.saveVideo) {
        // формат исходника (если можно), иначе MKV; не собралось в формате исходника — пробуем MKV
        const srcExt = path.extname(file).slice(1).toLowerCase();
        let plan = videoPlan(srcExt, src.audioCodec, options.videoFormat !== "mkv");
        log.info(`видео #${job.no}`, `сохранение видео: .${plan.ext}, перевод ${plan.voice} ${audioKbps(plan.voice, src.audio)} кбит/с, `
          + `оригинал ${plan.origCodec === "copy" ? "без пережатия" : plan.origCodec}${plan.reason ? `, MKV: ${plan.reason}` : ""}`
          + `${premixed ? ", звук из готовой .m4a" : ""}${options.fastAudio ? ", быстрое кодирование" : ""}`);
        const build = (p) => {
          pending = freePath(path.join(outDir, `${name} [${tag}].${p.ext}`));
          const out = pending;
          return withSaveProgress(out, "Собираем видео", srcSize, step, (onP) =>
            mux(file, result.audio, options.embedSubs ? result.subs : null, out, { ...mixOpts, premixed }, job.duration, onP,
              signal, p));
        };
        let built;
        try {
          built = await build(plan);
        } catch (e) {
          if (signal?.aborted || plan.ext === "mkv" || diskFullError(e)) throw e;
          log.warn(`видео #${job.no}`, `.${plan.ext} не собрался — повтор в MKV`, e);
          rmSync(pending, { force: true });
          plan = mkvPlan(`${srcExt.toUpperCase()} не принял картинку или звук этого видео`);
          built = await build(plan);
        }
        saveNote = describeMix(options, built.autoGainDb);
        voiceCodec = plan.voice;
        outputs.push(pending);
        if (plan.reason) notes.push(`сохранено в MKV: ${plan.reason}`);
        // контейнер без встроенных субтитров — кладём их рядом с тем же именем: плееры подхватывают сами
        if (options.embedSubs && result.subs && !plan.subs) {
          pending = freePath(pending.replace(/\.[^.\\/]+$/, ".srt"));
          copyFileSync(result.subs, pending);
          outputs.push(pending);
          notes.push(`субтитры — файлом рядом: ${plan.ext.toUpperCase()} не умеет встроенные`);
        }
      }
      if (voiceCodec) {
        notes.unshift(`звук ${voiceCodec.toUpperCase()} ${audioKbps(voiceCodec, src.audio)} кбит/с`
          + (options.fastAudio && voiceCodec === "aac" ? ", быстрое кодирование" : ""));
      }
      if (options.saveVoice) {
        pending = freePath(path.join(outDir, `${name} [${tag}, голос].mp3`));
        copyFileSync(result.audio, pending);
        outputs.push(pending);
      }
      // субтитры уже легли рядом с видео — второй такой же файл не нужен
      if (options.saveSubs && result.subs && !outputs.some((p) => p.toLowerCase().endsWith(".srt"))) {
        pending = freePath(path.join(outDir, `${name} [RU].srt`));
        copyFileSync(result.subs, pending);
        outputs.push(pending);
      }
      pending = null;
    } catch (e) {
      if (pending) rmSync(pending, { force: true });
      throw diskFullError(e) ?? e;
    }
    step("save", { state: "done", detail: [saveNote, ...notes].filter(Boolean).join(" · ") });
    return { outputs, lively, lang };
  } catch (e) {
    if (current) emit({ step: current, state: "error", detail: e.message });
    throw e;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Папка, где хранится последний полученный перевод видео (для пересборки без Яндекса). */
export function translationCacheDir(jobId) {
  return path.join(workRoot(), "cache", jobId);
}

/** Звук оригинала без изменений — делается вместе с облегчённой копией; живёт, пока видео в списке. */
export function origAudioPath(jobId) {
  return path.join(workRoot(), "cache", `${jobId}-orig.mka`);
}

/** Откуда брать звук оригинала: из сохранённой копии (с её задержкой), если она есть, иначе из самого видео. */
export function origAudio(job) {
  const p = origAudioPath(job.id);
  return existsSync(p) ? { path: p, offset: job.origOffset ?? 0 } : job.file;
}

/**
 * Переносит дорожку и субтитры из временной папки в кэш задания (прежний перевод заменяется)
 * и один раз разбирает дорожку — громкость и места речи — для сборки и предпрослушивания.
 */
async function keepTranslation(job, result, lively, lang, signal) {
  const dir = translationCacheDir(job.id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const audio = path.join(dir, "voice.ru.mp3");
  copyFileSync(result.audio, audio);
  let subs = null;
  if (result.subs) {
    subs = path.join(dir, "subs.ru.srt");
    copyFileSync(result.subs, subs);
  }
  const analysis = await analyzeVoice(audio, signal);
  return { audio, subs, subsCount: result.subsCount, lively, lang, analysis };
}

/**
 * Запись файла с прогрессом: проценты — по времени ffmpeg (run получает onProgress),
 * записанный объём и скорость — по размеру файла. expectedBytes — ориентир итогового размера.
 */
async function withSaveProgress(out, label, expectedBytes, step, run) {
  const t0 = Date.now();
  let p = 0;
  let lastBytes = 0;
  let lastT = t0;
  let speed = 0;
  const tick = () => {
    const now = Date.now();
    let bytes = lastBytes;
    try { bytes = statSync(out).size; } catch { /* файл ещё не создан */ }
    const inst = (bytes - lastBytes) / Math.max(0.001, (now - lastT) / 1000);
    speed = speed ? speed * 0.7 + inst * 0.3 : inst; // сглаживаем, чтобы цифра не прыгала
    lastBytes = bytes;
    lastT = now;
    const elapsed = (now - t0) / 1000;
    const eta = p > 0.02 ? Math.ceil((elapsed * (1 - p)) / p) : null;
    step("save", {
      progress: p,
      detail: [`${label} · ${Math.round(p * 100)}%`, `${size(bytes)} из ~${size(expectedBytes)}`,
        `${(speed / MB).toFixed(speed < 10 * MB ? 1 : 0)} МБ/с`, eta !== null ? `осталось ~${fmtSec(eta)}` : ""].filter(Boolean).join(" · "),
    });
  };
  const timer = setInterval(tick, 1000);
  try {
    step("save", { progress: 0, detail: `${label} · готовим звук` });
    return await run((x) => { p = x; });
  } finally {
    clearInterval(timer);
  }
}

/** Как сведён звук — одной строкой для карточки (и для предпрослушивания). */
export function describeMix(options, autoGainDb) {
  const orig = Number(options.originalVolume);
  const parts = [options.mixMode === "constant"
    ? `Оригинал ${orig}% постоянно`
    : orig >= 100 ? "Оригинал не приглушён" : `Оригинал ${orig}% под переводом`];
  parts.push(`перевод ${Math.round(options.voiceGain * 100)}%`);
  if (autoGainDb !== null && autoGainDb !== undefined) {
    parts.push(`подстроен под оригинал: ${autoGainDb > 0 ? "+" : ""}${autoGainDb.toFixed(1)} дБ`);
  }
  return parts.join(" · ");
}

const MB = 1024 * 1024;
const GB = 1024 * MB;
const size = (b) => (b >= GB ? `${(b / GB).toFixed(1)} ГБ` : `${Math.round(b / MB)} МБ`);

function freeBytes(dir) {
  try {
    const s = statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return Infinity; // не узнали — не мешаем, при нехватке сработает diskFullError
  }
}

/** Заранее проверяет место, чтобы не упасть посреди многогигабайтной записи. */
function ensureSpace(dir, needed, what) {
  const free = freeBytes(dir);
  if (free >= needed) return;
  throw new Error(`Не хватает места на диске ${path.parse(path.resolve(dir)).root}: ${what} нужно ~${size(needed)}, `
    + `свободно ${size(free)}. Выберите другую папку в настройках «Куда» или освободите место.`);
}

/** Ошибка «кончилось место» посреди записи → понятное сообщение (иначе null). */
function diskFullError(e) {
  if (!/ENOSPC|No space left|not enough space|недостаточно места/i.test(`${e.code ?? ""} ${e.message}`)) return null;
  return new Error("На диске закончилось место во время сохранения. Недособранный файл удалён. "
    + "Выберите папку на другом диске в настройках «Куда» или освободите место и нажмите «Перевести заново».");
}

/** Облегчённая копия и загрузка её на Диск; заполняет job.diskPath и job.duration. */
async function uploadCopy(job, work, token, step, signal, fastAudio = false) {
  step("light", { state: "active", detail: "Проверяем видео" });
  const { duration, audioCopyable, start, audio } = await probe(job.file);
  job.duration = duration;
  log.info(`видео #${job.no}`, `исходник: ${Math.round(duration)} с, ${size(statSync(job.file).size)}, `
    + `звук ${audio.codec} ${audio.kbps ?? "?"} кбит/с ${audio.channels} кан.${audioCopyable ? " (в копию без пережатия)" : ""}`);
  // облегчённая копия ≈ звук + чёрный кадр: ~20–40 КБ на секунду видео; копия звука оригинала — столько же
  ensureSpace(work, duration * 80_000 + 50 * MB, "для временной облегчённой копии");
  const light = path.join(work, "light.mp4");
  const origOut = origAudioPath(job.id);
  mkdirSync(path.dirname(origOut), { recursive: true });
  try {
    await makeLight(job.file, light, duration, (p) => step("light", { progress: p, detail: `${Math.round(p * 100)}%` }), signal,
      { copyAudio: audioCopyable, origOut, audio, fast: fastAudio });
  } catch (e) {
    rmSync(origOut, { force: true });
    throw diskFullError(e) ?? e;
  }
  // громкость оригинала меряем по облегчённой копии: в ней тот же звук, а читать её — секунды,
  // в отличие от многогигабайтного исходника; нужна для автоподстройки громкости перевода
  step("light", { detail: "Измеряем громкость" });
  job.origLoudness = await measureLoudness(light, signal);
  job.origOffset = await audioOffset(job.file, start);
  step("light", { state: "done", detail: job.origLoudness !== null ? `Громкость оригинала ${job.origLoudness.toFixed(1)} LUFS` : "" });

  step("upload", { state: "active", detail: "Проверяем место на Яндекс Диске" });
  const lightSize = statSync(light).size;
  const diskFree = await disk.freeSpace(token, signal).catch(() => Infinity);
  if (diskFree < lightSize + 10 * MB) {
    throw new Error(`На Яндекс Диске не хватает места: нужно ~${size(lightSize)}, свободно ${size(diskFree)}. `
      + "Освободите место на Диске (и очистите его Корзину) и нажмите «Попробовать снова».");
  }
  // Обычно загрузка идёт на полной скорости (см. UPLOAD_LINK_HEADERS в yadisk.js) — показываем
  // отправленные байты и скорость. Если Яндекс всё же ограничит скорость (~127 КБ/с), байты уйдут
  // в буфер сети за секунды, а сервер будет принимать файл минутами — тогда фаза «ожидания»
  // с оценкой по этой скорости.
  const t0 = Date.now();
  let timer = null;
  const waiting = () => {
    const elapsed = (Date.now() - t0) / 1000;
    const expectedSec = lightSize / DISK_BYTES_PER_SEC;
    const left = Math.max(0, Math.ceil(expectedSec - elapsed));
    step("upload", {
      progress: Math.min(0.99, Math.max(0.95, elapsed / expectedSec)),
      detail: `Диск принимает файл · ` + (left > 0 ? `осталось ~${fmtSec(left)}` : "почти готово"),
    });
  };
  step("upload", { progress: 0, detail: `0 из ${size(lightSize)}` });
  try {
    job.diskPath = await disk.upload(token, light, ({ phase, sent }) => {
      if (phase === "sending") {
        const sec = Math.max(0.001, (Date.now() - t0) / 1000);
        step("upload", { progress: 0.95 * sent / lightSize, detail: `${size(sent)} из ${size(lightSize)} · ${(sent / MB / sec).toFixed(1)} МБ/с` });
      } else if (!timer) {
        timer = setInterval(waiting, 1000);
      }
    }, signal);
  } finally {
    clearInterval(timer);
  }
  step("upload", { state: "done", detail: `${size(lightSize)} за ${fmtSec(Math.round((Date.now() - t0) / 1000))}` });
}

/**
 * Один запрос перевода. Каждый раз — новая публичная ссылка: Яндекс кэширует перевод по ссылке
 * (bypassCache не помогает), а после переопубликации Диск выдаёт новую, и перевод делается заново.
 */
async function translateOnce(job, work, token, step, emit, signal) {
  let lastStatus = "";
  const onStatus = (msg) => {
    if (msg !== lastStatus) log.info(`видео #${job.no}`, `Яндекс: ${msg}`);
    lastStatus = msg;
    step("translate", { detail: msg });
  };
  const base = path.join(work, "yandex");
  let lively = Boolean(job.lively);
  // живые голоса — только с английского (и не с автоопределением), интерфейс держит это же правило
  const lang = lively ? LIVELY_LANG : (job.lang || "auto");
  let result;
  try {
    step("translate", { state: "active", detail: "Открываем доступ к файлу" });
    await disk.unpublish(token, job.diskPath).catch(() => {}); // вдруг осталась открытой с прошлого раза
    let url;
    try {
      url = await disk.publish(token, job.diskPath, signal);
    } catch (e) {
      if (/\(404\)|не найден/i.test(e.message)) {
        job.diskPath = null; // копию удалили с Диска вручную — в следующий раз загрузим заново
        throw new Error("Копия пропала с Диска — нажмите «Перевести заново», файл загрузится ещё раз");
      }
      throw e;
    }
    try {
      result = await translate(url, job.duration, base, onStatus, signal, { lively, token, lang });
    } catch (e) {
      if (!lively || signal.aborted) throw e;
      log.warn(`видео #${job.no}`, "живые голоса не получились — обычными", e);
      // живые голоса доступны не всегда — не теряем перевод, пробуем обычными
      onStatus("Живые голоса не получились, переводим обычными");
      result = await translate(url, job.duration, base, onStatus, signal, { lang });
    }
    log.info(`видео #${job.no}`, `перевод получен: живые голоса ${result.lively ? "да" : "нет"}, `
      + `найденный язык ${result.detectedLang || "совпал с указанным"}, субтитров ${result.subsCount ?? 0}`);
    checkLanguage(lang, lively, result.detectedLang);
    lively = result.lively;
    const langText = lang === "auto"
      ? `${result.detectedLang ? detectedName(result.detectedLang) : "язык не определён"} (автоопределение)`
      : langName(lang).toLowerCase();
    step("translate", {
      state: "done",
      detail: [lively ? "Живые голоса" : "Обычные голоса", langText,
        result.subsCount ? `${result.subsCount} строк субтитров` : ""].filter(Boolean).join(" · "),
    });
  } finally {
    // что бы ни случилось — не оставляем файл висеть по открытой ссылке
    if (job.diskPath) {
      emit({ step: "cleanup", state: "active", detail: "" });
      await disk.unpublish(token, job.diskPath)
        .then(() => emit({ step: "cleanup", state: "done", detail: "Ссылка закрыта · копия на Диске до выхода из приложения" }))
        .catch((e) => emit({ step: "cleanup", state: "error", detail: `Не удалось закрыть ссылку: ${e.message}` }));
    }
  }
  return { result, lively, lang };
}

/**
 * Яндекс не отказывает, если язык указан неверно, — «переводит» чужую речь, получается мусор.
 * Но в ответе остаётся след: при верном языке поле language пустое, при неверном — там язык,
 * который Яндекс нашёл сам (проверено на русской речи с пометкой «английский»: вернул it,
 * то есть само определение неточное, но несовпадение видно надёжно).
 */
function checkLanguage(lang, lively, detected) {
  if (lang === "auto") {
    if (detected === "ru") throw new Error("В видео русская речь — переводить на русский нечего.");
    return;
  }
  if (!detected || detected === lang) return;
  if (lively) {
    throw new Error("Английская речь не найдена. Живые голоса работают только с английским — "
      + "выключите их, выберите язык видео или «Автоопределение» и нажмите «Перевести заново».");
  }
  throw new Error(`Речь в видео не похожа на ${langName(lang).toLowerCase()}. `
    + "Выберите другой язык или «Автоопределение» и нажмите «Перевести заново».");
}
