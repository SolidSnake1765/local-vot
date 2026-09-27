// Одно задание перевода: видео → облегчённая копия → Диск → перевод Яндекса →
// убрать файл с Диска → сохранить результат рядом с видео (или в выбранную папку).
import { app } from "electron";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import * as disk from "./yadisk.js";
import { translate } from "./vot.js";
import { makeLight, mux, probe } from "./media.js";
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

const mb = (b) => (b / 1024 / 1024).toFixed(1);
const fmtSec = (s) => (s < 60 ? `${s} с` : `${Math.floor(s / 60)} мин ${String(s % 60).padStart(2, "0")} с`);
const DISK_BYTES_PER_SEC = 130_000; // замерено: API Диска принимает ~127 КБ/с независимо от канала

/**
 * Копия на Диске живёт дольше одного перевода: job.diskPath сохраняется, чтобы «Перевести заново»
 * и смена голоса не грузили файл повторно. Убирает её main.js (при удалении из списка и выходе).
 *
 * @param job   { id, file, lively, diskPath?, duration? } — diskPath/duration заполняются здесь
 * @param emit  ({ step, state?: "active"|"done"|"error", progress?: 0..1, detail?: string }) — ход работы
 * @returns { outputs: string[], lively: boolean } — созданные файлы и каким голосом вышел перевод
 */
export async function runJob(job, { options, token }, emit, signal) {
  const { file } = job;
  const work = path.join(app.getPath("temp"), "local-vot", `${job.id}-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  const name = path.parse(file).name;
  const outDir = options.outputDir || path.dirname(file);
  let current = null;
  const step = (stepId, patch = {}) => {
    current = stepId;
    emit({ step: stepId, ...patch });
  };

  try {
    if (job.diskPath) {
      emit({ step: "light", state: "done", detail: "" });
      emit({ step: "upload", state: "done", detail: "Файл уже на Диске" });
    } else {
      await uploadCopy(job, work, token, step, signal);
    }

    const { result, lively, lang } = await translateOnce(job, work, token, step, emit, signal);

    step("save", { state: "active", detail: "" });
    mkdirSync(outDir, { recursive: true });
    const outputs = [];
    const tag = lively ? "RU живые" : "RU";
    if (options.saveVideo) {
      const out = freePath(path.join(outDir, `${name} [${tag}].mkv`));
      await mux(file, result.audio, options.embedSubs ? result.subs : null, out, options, job.duration,
        (p) => step("save", { progress: p, detail: `Собираем видео · ${Math.round(p * 100)}%` }), signal);
      outputs.push(out);
    }
    if (options.saveAudio) {
      const out = freePath(path.join(outDir, `${name} [${tag}].mp3`));
      copyFileSync(result.audio, out);
      outputs.push(out);
    }
    if (options.saveSubs && result.subs) {
      const out = freePath(path.join(outDir, `${name} [RU].srt`));
      copyFileSync(result.subs, out);
      outputs.push(out);
    }
    step("save", { state: "done", detail: "" });
    return { outputs, lively, lang };
  } catch (e) {
    if (current) emit({ step: current, state: "error", detail: e.message });
    throw e;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Облегчённая копия и загрузка её на Диск; заполняет job.diskPath и job.duration. */
async function uploadCopy(job, work, token, step, signal) {
  step("light", { state: "active", detail: "Проверяем видео" });
  const { duration } = await probe(job.file);
  job.duration = duration;
  const light = path.join(work, "light.mp4");
  await makeLight(job.file, light, duration, (p) => step("light", { progress: p, detail: `${Math.round(p * 100)}%` }), signal);
  step("light", { state: "done", detail: "" });

  step("upload", { state: "active", detail: "Готовим загрузку" });
    // Диск принимает файл со скоростью ~127 КБ/с. Сколько байт ушло из программы — не показатель:
    // сеть и VPN-клиент забирают в буфер десятки мегабайт сразу, а потом отправляют медленно.
    // Поэтому ход загрузки показываем по таймеру, по оценке этой скорости.
    const size = statSync(light).size;
    const expectedSec = size / DISK_BYTES_PER_SEC;
    const t0 = Date.now();
    const tick = () => {
      const elapsed = (Date.now() - t0) / 1000;
      const left = Math.max(0, Math.ceil(expectedSec - elapsed));
      step("upload", {
        progress: Math.min(0.99, elapsed / expectedSec),
        detail: `${mb(size)} МБ · ` + (left > 0 ? `осталось ~${fmtSec(left)}` : "почти готово"),
      });
    };
    tick();
    const timer = setInterval(tick, 1000);
  try {
    job.diskPath = await disk.upload(token, light, null, signal);
  } finally {
    clearInterval(timer);
  }
  step("upload", { state: "done", detail: `${mb(size)} МБ за ${fmtSec(Math.round((Date.now() - t0) / 1000))}` });
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
