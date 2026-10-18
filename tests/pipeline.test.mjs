// Конвейер одного видео (pipeline.js) на подставных Диске, Яндексе и ffmpeg: язык речи и живые голоса,
// предел длины, месячный лимит Диска, одновременные копии и сборки.
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const src = (f) => new URL(`../src/main/${f}`, import.meta.url).href;
const root = path.join(os.tmpdir(), `local-vot-test-pipeline-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

const settings = { outputDir: path.join(root, "out"), saveVideo: false, saveAudio: false, saveVoice: true, saveSubs: false, diskJobs: 2 };
// что «делают» Яндекс, Диск и ffmpeg — меняется по тестам
const world = { speech: "en", early: false, duration: 60, uploadLimit: false, lightSec: 0, saveSec: 0 };
const calls = { translate: [], light: 0, upload: 0, active: { light: 0, save: 0 }, peak: { light: 0, save: 0 } };
const wait = (s) => new Promise((r) => setTimeout(r, s * 1000));
const enter = async (kind, sec) => {
  calls.active[kind]++;
  calls.peak[kind] = Math.max(calls.peak[kind], calls.active[kind]);
  try { await wait(sec); } finally { calls.active[kind]--; }
};

mock.module(src("config.js"), { namedExports: { loadSettings: () => ({ ...settings }) } });
mock.module(src("paths.js"), { namedExports: { workRoot: () => path.join(root, "work") } });
mock.module(src("yadisk.js"), { namedExports: {
  upload: async () => {
    calls.upload++;
    if (world.uploadLimit) throw Object.assign(new Error("лимит загрузки"), { code: "UPLOAD_LIMIT" });
    return "app:/copy";
  },
  publish: async () => "https://disk.yandex.ru/i/x", unpublish: async () => {}, freeSpace: async () => 1e12,
} });
mock.module(src("vot.js"), { namedExports: {
  translate: async (url, _d, base, _status, _signal, opts) => {
    calls.translate.push({ lively: Boolean(opts.lively), lang: opts.lang });
    world.lastUrl = url;
    if (world.early && opts.lang !== "auto" && world.speech !== opts.lang) {
      throw Object.assign(new Error("другой язык"), { code: "LANG_MISMATCH", detectedLang: world.speech });
    }
    writeFileSync(`${base}.ru.mp3`, "voice");
    // при явном языке Яндекс заполняет language, только если речь на него не похожа; при auto — всегда
    const detected = opts.lang === "auto" ? world.speech : world.speech === opts.lang ? null : world.speech;
    return { audio: `${base}.ru.mp3`, subs: null, subsCount: 0, lively: Boolean(opts.lively) && world.speech === "en", detectedLang: detected };
  },
} });
mock.module(src("media.js"), { namedExports: {
  probe: async () => ({ duration: world.duration, audioCopyable: true, start: 0, audio: { codec: "aac", kbps: 96, channels: 2 }, audioCodec: "aac" }),
  makeLight: async (_f, light) => { calls.light++; await enter("light", world.lightSec); writeFileSync(light, "x"); },
  loudnessProfile: async () => ({ integrated: -20, step: 0.2, m: new Float32Array(4) }), audioOffset: async () => 0,
  analyzeVoice: async () => ({ loudness: -18, segments: [] }), audioKbps: () => 128, videoPlan: () => ({}), mkvPlan: () => ({}),
  mux: async () => ({}), mixAudio: async () => ({}),
} });
mock.module(src("log.js"), { namedExports: { log: { info() {}, warn() {}, error() {} } } });

const { runJob, reserveDiskTurn } = await import(src("pipeline.js"));

let seq = 0;
async function run(job, opts = {}) {
  const file = path.join(root, `v${++seq}.mp4`);
  writeFileSync(file, "src");
  const full = { id: `job-${seq}`, no: seq, file, lively: false, lang: "auto", ...job };
  const card = [];
  const signal = new AbortController().signal;
  try {
    const r = await runJob(full, { getOptions: () => settings, ...opts, token: "token" in opts ? opts.token : "t" }, (p) => card.push(p), signal);
    return { ok: true, r, job: full, card };
  } catch (e) {
    return { ok: false, error: e.message, job: full, card };
  }
}

beforeEach(() => {
  Object.assign(world, { speech: "en", early: false, duration: 60, uploadLimit: false, lightSec: 0, saveSec: 0 });
  calls.translate.length = 0;
  calls.light = 0;
  calls.upload = 0;
});

test("живые голоса, японская речь → сразу обычные с автоопределением, карточка переключается", async () => {
  world.speech = "ja";
  const t = await run({ lively: true, lang: "en" });
  assert.equal(t.ok, true, t.error);
  assert.deepEqual(calls.translate, [{ lively: true, lang: "en" }, { lively: false, lang: "auto" }]);
  assert.deepEqual([t.job.lively, t.job.lang, t.r.lively, t.r.lang], [false, "auto", false, "auto"]);
  assert.ok(t.card.some((p) => p.lively === false && p.lang === "auto"), "карточка узнаёт о смене до конца");
  assert.match(t.card.findLast((p) => p.step === "translate" && p.state === "done").detail, /японский \(автоопределение\)/);
});

test("живые голоса, язык назван до конца перевода — то же, без ожидания", async () => {
  Object.assign(world, { speech: "ja", early: true });
  const t = await run({ lively: true, lang: "en" });
  assert.equal(t.ok, true, t.error);
  assert.deepEqual(calls.translate, [{ lively: true, lang: "en" }, { lively: false, lang: "auto" }]);
});

test("живые голоса, английская речь — один запрос, голоса остаются живыми", async () => {
  const t = await run({ lively: true, lang: "en" });
  assert.equal(t.ok, true, t.error);
  assert.equal(calls.translate.length, 1);
  assert.equal(t.job.lively, true);
});

test("живые голоса, русская речь — «переводить нечего» без второго запроса", async () => {
  world.speech = "ru";
  const t = await run({ lively: true, lang: "en" });
  assert.match(t.error, /русская речь/);
  assert.equal(calls.translate.length, 1);
});

test("язык выбран вручную, а речь другая — ошибка с подсказкой, язык не меняется", async () => {
  world.speech = "ja";
  const t = await run({ lively: false, lang: "en" });
  assert.match(t.error, /не похожа на английский/);
  assert.equal(t.job.lang, "en");
  world.early = true;
  const t2 = await run({ lively: false, lang: "en" });
  assert.match(t2.error, /не похожа на английский/);
});

test("видео длиннее 4 часов — ошибка до облегчённой копии и загрузки", async () => {
  world.duration = 4 * 3600 + 60;
  const t = await run({});
  assert.match(t.error, /длиннее 4 часов \(4 ч 1 мин\)/);
  assert.deepEqual([calls.light, calls.upload, calls.translate.length], [0, 0, 0]);
});

test("месячный лимит Диска — остальные видео того же входа сразу получают ту же ошибку, без копий", async () => {
  world.uploadLimit = true;
  const first = await run({}, { token: "limit" });
  assert.equal(first.ok, false);
  assert.equal(calls.light, 1);
  const second = await run({}, { token: "limit" });
  assert.equal(second.error, first.error);
  assert.equal(calls.light, 1, "вторая копия не делалась");
  world.uploadLimit = false;
  const other = await run({}, { token: "другой вход" });
  assert.equal(other.ok, true, "другой аккаунт — без блокировки");
});

test("«Копия и сборка» по 2: две копии идут сразу, третья ждёт", async () => {
  world.lightSec = 0.3;
  calls.peak.light = 0;
  const jobs = [1, 2, 3, 4].map(() => {
    const ac = new AbortController();
    return run({}, { lightTurn: reserveDiskTurn(ac.signal, 0) });
  });
  const res = await Promise.all(jobs);
  assert.ok(res.every((r) => r.ok), res.map((r) => r.error).join("; "));
  assert.equal(calls.peak.light, 2);
});

test("по одному: копии строго по одной", async () => {
  settings.diskJobs = 1;
  world.lightSec = 0.2;
  calls.peak.light = 0;
  try {
    const res = await Promise.all([1, 2, 3].map(() => run({}, { lightTurn: reserveDiskTurn(new AbortController().signal, 0) })));
    assert.ok(res.every((r) => r.ok));
    assert.equal(calls.peak.light, 1);
  } finally {
    settings.diskJobs = 2;
  }
});

test("Google Диск: копия туда и ссылка оттуда; без входа в Яндекс живые голоса — обычными, с подсказкой", async () => {
  const google = [];
  const api = {
    upload: async (tok) => { google.push(["upload", tok]); return "gdrive:F"; },
    publish: async (tok, ref) => { google.push(["publish", tok, ref]); return "https://drive.google.com/file/d/F/view?t=1"; },
    unpublish: async (tok, ref) => { google.push(["unpublish", tok, ref]); },
    freeSpace: async () => 1e12,
  };
  // ключ Google живёт час — каждое действие с облаком берёт свежий (здесь: g1, g2, …)
  let fresh = 0;
  const store = { id: "google", where: "на Google Диске", api, getToken: async () => `g${++fresh}` };
  const t = await run({ lively: true, lang: "en" }, { token: null, store });
  assert.equal(t.ok, true, t.error);
  assert.equal(calls.upload, 0, "Яндекс Диск не трогали");
  assert.equal(t.job.diskPath, "gdrive:F");
  assert.equal(world.lastUrl, "https://drive.google.com/file/d/F/view?t=1");
  assert.deepEqual(google.map((c) => c[0]), ["upload", "unpublish", "publish", "unpublish"]);
  assert.ok(google.every((c) => /^g\d+$/.test(c[1])), "везде вход Google");
  assert.equal(google.at(-1)[1], `g${fresh}`, "ссылку закрывает самый свежий ключ, а не взятый в начале");
  assert.equal(new Set(google.map((c) => c[1])).size, google.length, "ключ — заново перед каждым действием");
  assert.deepEqual(calls.translate, [{ lively: false, lang: "en" }], "живые голоса без входа в Яндекс не просим");
  assert.equal(t.job.lively, true, "пометка «живые» остаётся — после входа можно пересоздать");
  assert.match(t.card.findLast((p) => p.step === "translate" && p.state === "done").detail, /войдите в Яндекс/);
  assert.match(t.card.find((p) => p.step === "upload" && p.state === "active").detail, /Google Диске/);
  // со входом в Яндекс — живые голоса и с Google Диском
  const t2 = await run({ lively: true, lang: "en" }, { token: "y", store });
  assert.equal(t2.ok, true, t2.error);
  assert.deepEqual(calls.translate.at(-1), { lively: true, lang: "en" });
});

test.after(() => rmSync(root, { recursive: true, force: true }));
