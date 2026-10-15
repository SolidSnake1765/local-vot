// Список видео между запусками (настройка «Сохранять список видео между запусками», keepQueue).
// Хранится в папке данных программы (queue.json): у каждого видео — состояние, голос и язык, что сохранять,
// звук, готовые файлы, шаги карточки, копия на Диске и полученный перевод (сами файлы перевода — в кэше
// временной папки, при запуске он не чистится). Недоделанные видео при следующем запуске продолжаются.
import { app } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";

const VERSION = 1;
const queueFile = () => path.join(app.getPath("userData"), "queue.json");

// что из задания сохраняется как есть (остальное — controller, mode, replace — живёт только в этом запуске)
const FIELDS = ["id", "no", "file", "name", "lively", "lang", "diskPath", "duration", "voiceUsed", "langUsed", "outputs",
  "save", "sound", "savedSound", "origOffset", "origLoudness", "steps", "error",
  "mode", "replace"]; // mode/replace — у прерванных: пересборка продолжится пересборкой, а не новым переводом

/**
 * Задание → запись в файл. Идущие и ждущие очереди сохраняются как «в очереди» — при следующем запуске
 * продолжатся. Профиль громкости (тысячи чисел) — отдельным файлом profileFile, в JSON только его путь.
 */
export function serializeJob(job, profileFile) {
  const rec = Object.fromEntries(FIELDS.map((k) => [k, job[k] ?? null]));
  rec.state = ["queued", "running"].includes(job.state) || job.resume ? "queued" : job.state;
  if (job.resume && job.resumeMode) rec.mode = job.resumeMode;
  rec.translation = job.translation ?? null;
  if (job.origProfile && profileFile) {
    if (!existsSync(profileFile)) {
      const { m } = job.origProfile;
      writeFileSync(profileFile, Buffer.from(m.buffer, m.byteOffset, m.byteLength));
    }
    rec.origProfile = { integrated: job.origProfile.integrated, step: job.origProfile.step, file: profileFile };
  }
  return rec;
}

/** Запись → задание (без controller — его заводит main). Пропавшие файлы перевода — перевода нет. */
export function deserializeJob(rec) {
  const job = { ...rec };
  const t = rec.translation;
  if (t && !(t.audio && existsSync(t.audio))) job.translation = null;
  else if (t?.subs && !existsSync(t.subs)) job.translation = { ...t, subs: null };
  job.origProfile = null;
  const p = rec.origProfile;
  if (p?.file && existsSync(p.file)) {
    const buf = readFileSync(p.file);
    job.origProfile = { integrated: p.integrated, step: p.step, m: new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)) };
  }
  // копии нет на Диске, перевода нет — значит, и делать с видео нечего, кроме как начать заново
  if (job.state === "done" && !job.translation && !job.outputs?.length) job.state = "idle";
  return job;
}

/** Сохранённый список: { jobs, order } или null (нет файла, испорчен, другая версия). */
export function loadQueue() {
  try {
    const data = JSON.parse(readFileSync(queueFile(), "utf8"));
    if (data?.version !== VERSION || !Array.isArray(data.jobs)) return null;
    return { jobs: data.jobs.map(deserializeJob), order: Array.isArray(data.order) ? data.order : [] };
  } catch {
    return null;
  }
}

/** Записать список целиком: во временный файл, потом подменить — при сбое посреди записи старый цел. */
export async function saveQueue(records, order) {
  const target = queueFile();
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify({ version: VERSION, jobs: records, order }));
  await rename(tmp, target);
}

export function removeQueueFile() {
  try {
    writeFileSync(queueFile(), JSON.stringify({ version: VERSION, jobs: [], order: [] }));
  } catch { /* нет доступа — не страшно, список и так пуст */ }
}
