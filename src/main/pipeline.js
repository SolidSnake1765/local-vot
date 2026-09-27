// Одно задание перевода: видео → облегчённая копия → Диск → перевод Яндекса →
// убрать файл с Диска → сохранить результат рядом с видео (или в выбранную папку).
import { app } from "electron";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import * as disk from "./yadisk.js";
import { translate } from "./vot.js";
import { makeLight, mux, probe } from "./media.js";

export const STEPS = [
  { id: "light", title: "Облегчённая копия" },
  { id: "upload", title: "Загрузка на Яндекс Диск" },
  { id: "translate", title: "Перевод" },
  { id: "cleanup", title: "Удаление с Диска" },
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
 * @param emit  ({ step, state?: "active"|"done"|"error", progress?: 0..1, detail?: string }) — ход работы
 * @returns список созданных файлов
 */
export async function runJob({ id, file, options, token }, emit, signal) {
  const work = path.join(app.getPath("temp"), "local-vot", id);
  mkdirSync(work, { recursive: true });
  const name = path.parse(file).name;
  const outDir = options.outputDir || path.dirname(file);
  let current = null;
  const step = (stepId, patch = {}) => {
    current = stepId;
    emit({ step: stepId, ...patch });
  };

  try {
    step("light", { state: "active", detail: "Проверяем видео" });
    const { duration } = await probe(file);
    const light = path.join(work, "light.mp4");
    await makeLight(file, light, duration, (p) => step("light", { progress: p, detail: `${Math.round(p * 100)}%` }), signal);
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
    let diskPath;
    try {
      diskPath = await disk.upload(token, light, null, signal);
    } finally {
      clearInterval(timer);
    }
    step("upload", { state: "done", detail: `${mb(statSync(light).size)} МБ за ${fmtSec(Math.round((Date.now() - t0) / 1000))}` });

    let result;
    try {
      step("translate", { state: "active", detail: "Открываем доступ к файлу" });
      const url = await disk.publish(token, diskPath, signal);
      result = await translate(url, duration, path.join(work, "yandex"), (msg) => step("translate", { detail: msg }), signal);
      step("translate", { state: "done", detail: result.subsCount ? `${result.subsCount} строк субтитров` : "" });
    } finally {
      // что бы ни случилось — не оставляем файл висеть по открытой ссылке
      emit({ step: "cleanup", state: "active", detail: "" });
      await disk.unpublish(token, diskPath).catch(() => {});
      await disk.remove(token, diskPath, { permanently: options.deletePermanently })
        .then(() => emit({ step: "cleanup", state: "done", detail: options.deletePermanently ? "Удалено" : "В Корзине Диска" }))
        .catch((e) => emit({ step: "cleanup", state: "error", detail: `Не удалось удалить: ${e.message}` }));
    }

    step("save", { state: "active", detail: "" });
    mkdirSync(outDir, { recursive: true });
    const outputs = [];
    if (options.saveVideo) {
      const out = freePath(path.join(outDir, `${name} [RU].mkv`));
      await mux(file, result.audio, options.embedSubs ? result.subs : null, out, options, duration,
        (p) => step("save", { progress: p, detail: `Собираем видео · ${Math.round(p * 100)}%` }), signal);
      outputs.push(out);
    }
    if (options.saveAudio) {
      const out = freePath(path.join(outDir, `${name}.ru.mp3`));
      copyFileSync(result.audio, out);
      outputs.push(out);
    }
    if (options.saveSubs && result.subs) {
      const out = freePath(path.join(outDir, `${name}.ru.srt`));
      copyFileSync(result.subs, out);
      outputs.push(out);
    }
    step("save", { state: "done", detail: "" });
    return outputs;
  } catch (e) {
    if (current) emit({ step: current, state: "error", detail: e.message });
    throw e;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
