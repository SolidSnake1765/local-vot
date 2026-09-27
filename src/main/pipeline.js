// Одно задание перевода: видео → облегчённая копия → Диск → перевод Яндекса →
// убрать файл с Диска → сохранить результат рядом с видео (или в выбранную папку).
import { app } from "electron";
import { copyFileSync, existsSync, mkdirSync, rmSync, statfsSync, statSync } from "node:fs";
import path from "node:path";
import * as disk from "./yadisk.js";
import { translate } from "./vot.js";
import { analyzeVoice, makeLight, measureLoudness, mixAudio, mux, probe } from "./media.js";
import { detectedName, langName, LIVELY_LANG } from "./languages.js";

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
const DISK_BYTES_PER_SEC = 130_000; // замерено: API Диска принимает ~127 КБ/с независимо от канала

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
  const work = path.join(app.getPath("temp"), "local-vot", `${job.id}-${Date.now()}`);
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
        await uploadCopy(job, work, token, step, signal);
      }
      ({ result, lively, lang } = await translateOnce(job, work, token, step, emit, signal));
      job.translation = await keepTranslation(job, result, lively, lang, signal);
      result = job.translation;
    }

    step("save", { state: "active", detail: "Проверяем место на диске" });
    // настройки сохранения и звука — на момент сохранения, а не старта: пока видео грузилось
    // и переводилось, их могли поменять
    const options = getOptions();
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
    const mixOpts = { ...options, origLoudness: job.origLoudness ?? null, voiceAnalysis: result.analysis };
    try {
      if (options.saveVideo) {
        pending = freePath(path.join(outDir, `${name} [${tag}].mkv`));
        const out = pending;
        const { autoGainDb } = await withSaveProgress(out, "Собираем видео", srcSize, step, (onP) =>
          mux(file, result.audio, options.embedSubs ? result.subs : null, out, mixOpts, job.duration, onP, signal));
        saveNote = describeMix(options, autoGainDb);
        outputs.push(pending);
      }
      if (options.saveAudio) {
        // готовая звуковая дорожка: оригинал + перевод, как в видео, — для внешней дорожки в плеере
        pending = freePath(path.join(outDir, `${name} [${tag}].m4a`));
        const out = pending;
        const { autoGainDb } = await withSaveProgress(out, "Собираем звуковую дорожку", job.duration * 24_000, step, (onP) =>
          mixAudio(file, result.audio, out, mixOpts, job.duration, onP, signal));
        saveNote = describeMix(options, autoGainDb);
        outputs.push(pending);
      }
      if (options.saveVoice) {
        pending = freePath(path.join(outDir, `${name} [${tag}, голос].mp3`));
        copyFileSync(result.audio, pending);
        outputs.push(pending);
      }
      if (options.saveSubs && result.subs) {
        pending = freePath(path.join(outDir, `${name} [RU].srt`));
        copyFileSync(result.subs, pending);
        outputs.push(pending);
      }
      pending = null;
    } catch (e) {
      if (pending) rmSync(pending, { force: true });
      throw diskFullError(e) ?? e;
    }
    step("save", { state: "done", detail: saveNote });
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
  return path.join(app.getPath("temp"), "local-vot", "cache", jobId);
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
async function uploadCopy(job, work, token, step, signal) {
  step("light", { state: "active", detail: "Проверяем видео" });
  const { duration } = await probe(job.file);
  job.duration = duration;
  // облегчённая копия ≈ звук 128 кбит/с + чёрный кадр: ~20 КБ на секунду видео
  ensureSpace(work, duration * 20_000 + 50 * MB, "для временной облегчённой копии");
  const light = path.join(work, "light.mp4");
  try {
    await makeLight(job.file, light, duration, (p) => step("light", { progress: p, detail: `${Math.round(p * 100)}%` }), signal);
  } catch (e) {
    throw diskFullError(e) ?? e;
  }
  // громкость оригинала меряем по облегчённой копии: в ней тот же звук, а читать её — секунды,
  // в отличие от многогигабайтного исходника; нужна для автоподстройки громкости перевода
  step("light", { detail: "Измеряем громкость" });
  job.origLoudness = await measureLoudness(light, signal);
  step("light", { state: "done", detail: job.origLoudness !== null ? `Громкость оригинала ${job.origLoudness.toFixed(1)} LUFS` : "" });

  step("upload", { state: "active", detail: "Проверяем место на Яндекс Диске" });
  const lightSize = statSync(light).size;
  const diskFree = await disk.freeSpace(token, signal).catch(() => Infinity);
  if (diskFree < lightSize + 10 * MB) {
    throw new Error(`На Яндекс Диске не хватает места: нужно ~${size(lightSize)}, свободно ${size(diskFree)}. `
      + "Освободите место на Диске (и очистите его Корзину) и нажмите «Попробовать снова».");
  }
  // Диск принимает файл со скоростью ~127 КБ/с. Сколько байт ушло из программы — не показатель:
  // сеть и VPN-клиент забирают в буфер десятки мегабайт сразу, а потом отправляют медленно.
  // Поэтому ход загрузки показываем по таймеру, по оценке этой скорости.
  const expectedSec = lightSize / DISK_BYTES_PER_SEC;
  const t0 = Date.now();
  const tick = () => {
    const elapsed = (Date.now() - t0) / 1000;
    const left = Math.max(0, Math.ceil(expectedSec - elapsed));
    step("upload", {
      progress: Math.min(0.99, elapsed / expectedSec),
      detail: `${size(lightSize)} · ` + (left > 0 ? `осталось ~${fmtSec(left)}` : "почти готово"),
    });
  };
  tick();
  const timer = setInterval(tick, 1000);
  try {
    job.diskPath = await disk.upload(token, light, null, signal);
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
  const onStatus = (msg) => step("translate", { detail: msg });
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
      // живые голоса доступны не всегда — не теряем перевод, пробуем обычными
      onStatus("Живые голоса не получились, переводим обычными");
      result = await translate(url, job.duration, base, onStatus, signal, { lang });
    }
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
