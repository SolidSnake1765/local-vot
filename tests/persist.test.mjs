// Список видео между запусками (persist.js): запись и чтение, пропавшие файлы, прерванные видео.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = path.join(os.tmpdir(), `local-vot-test-persist-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
mock.module("electron", { namedExports: { app: { getPath: () => dir } } });
const { deserializeJob, loadQueue, removeQueueFile, saveQueue, serializeJob } = await import("../src/main/persist.js");

const file = (name, body = "x") => { const p = path.join(dir, name); writeFileSync(p, body); return p; };

test("готовое видео: туда и обратно — всё на месте, профиль громкости отдельным файлом", async () => {
  const audio = file("voice.ru.mp3"), subs = file("subs.ru.srt");
  const m = Float32Array.from([-20, -18.5, -70, -21]);
  const job = { id: "a", no: 1, file: "D:/v.mp4", name: "v.mp4", state: "done", lively: false, lang: "auto", diskPath: "app:/1",
    duration: 120, voiceUsed: false, langUsed: "auto", outputs: ["D:/v [RU].mp4"], save: null, sound: { voiceGain: 1 },
    savedSound: { voiceGain: 1 }, origOffset: 0.12, origLoudness: -19, steps: { save: { state: "done", detail: "ок" } }, error: "",
    mode: "translate", replace: false, controller: new AbortController(),
    translation: { audio, subs, subsCount: 3, lively: false, lang: "auto", analysis: { loudness: -18, segments: [[1, 2]] } },
    origProfile: { integrated: -19, step: 0.2, m } };
  const profile = path.join(dir, "a-profile.f32");
  await saveQueue([serializeJob(job, profile)], ["a"]);
  assert.ok(existsSync(profile));
  const back = loadQueue();
  assert.deepEqual(back.order, ["a"]);
  const j = back.jobs[0];
  for (const k of ["id", "file", "state", "lively", "lang", "diskPath", "duration", "outputs", "origOffset", "steps", "sound", "savedSound"]) {
    assert.deepEqual(j[k], job[k], k);
  }
  assert.deepEqual(j.translation, job.translation);
  assert.deepEqual([...j.origProfile.m], [...m]);
  assert.equal(j.controller, undefined, "служебное этого запуска не сохраняется");
});

test("идущие и ждущие сохраняются «в очереди»; прерванная пересборка остаётся пересборкой", () => {
  const base = { id: "b", file: "v", name: "v", outputs: [] };
  assert.equal(serializeJob({ ...base, state: "running" }).state, "queued");
  assert.equal(serializeJob({ ...base, state: "queued" }).state, "queued");
  // при выходе идущее отменяется, и его mode сбрасывается — запомненное до отмены важнее
  const rec = serializeJob({ ...base, state: "cancelled", resume: true, mode: "translate", resumeMode: "remux" });
  assert.deepEqual([rec.state, rec.mode], ["queued", "remux"]);
  assert.equal(serializeJob({ ...base, state: "error", error: "сбой" }).error, "сбой");
});

test("пропавшие файлы перевода — перевода нет; пропавшие субтитры — без субтитров", () => {
  const audio = file("v2.mp3");
  const gone = deserializeJob({ id: "c", state: "error", translation: { audio: path.join(dir, "нет.mp3") }, outputs: [] });
  assert.equal(gone.translation, null);
  const noSubs = deserializeJob({ id: "d", state: "done", translation: { audio, subs: path.join(dir, "нет.srt") }, outputs: ["x"] });
  assert.equal(noSubs.translation.subs, null);
  // «готово», но ни перевода, ни файлов — делать с ним нечего, кроме как начать заново
  assert.equal(deserializeJob({ id: "e", state: "done", translation: null, outputs: [] }).state, "idle");
});

test("испорченный или чужой файл списка — пустой список, без сбоя", () => {
  writeFileSync(path.join(dir, "queue.json"), "{не json");
  assert.equal(loadQueue(), null);
  writeFileSync(path.join(dir, "queue.json"), JSON.stringify({ version: 99, jobs: [] }));
  assert.equal(loadQueue(), null);
  removeQueueFile();
  assert.deepEqual(loadQueue(), { jobs: [], order: [] });
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
