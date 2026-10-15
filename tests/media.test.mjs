// Звук и облегчённая копия на настоящем ffmpeg (vendor/ffmpeg): тестовый звук — тишина с короткими
// «щелчками» в известные моменты. Проверяем, что после сведения и сжатия (в том числе кусками на всех ядрах)
// каждый щелчок на своём месте, лишних звуков нет (неудачный стык кусков слышен в тишине), задержка звука
// оригинала ставится точно, а облегчённая копия держит звук там же, где он в видео.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const media = await import("../src/main/media.js");
const FFMPEG = new URL("../vendor/ffmpeg/ffmpeg.exe", import.meta.url);
const skip = !existsSync(FFMPEG) && "нет vendor/ffmpeg/ffmpeg.exe (scripts/build-ffmpeg.sh)";
const dir = path.join(os.tmpdir(), `local-vot-test-media-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
media.setTempDir(path.join(dir, "tmp"));

const DURATION = 200; // больше 180 с — сжатие идёт кусками на всех ядрах
const ORIG_AT = Array.from({ length: 28 }, (_, i) => 3 + i * 7); // 3, 10, 17 … 192
const VOICE_AT = ORIG_AT.map((t) => t + 3.5);

/** WAV 16 бит: тишина и тон 1 кГц по 0,3 с в моменты at (короче 0,1 с анализ перевода фразой не считает). */
function wav(file, rate, channels, at) {
  const n = DURATION * rate;
  const data = Buffer.alloc(n * channels * 2);
  for (const t of at) {
    const s0 = Math.round(t * rate);
    for (let i = 0; i < rate * 0.3; i++) {
      const v = Math.round(Math.sin((2 * Math.PI * 1000 * i) / rate) * 16000);
      for (let c = 0; c < channels; c++) data.writeInt16LE(v, ((s0 + i) * channels + c) * 2);
    }
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  writeFileSync(file, Buffer.concat([h, data]));
  return file;
}

const ff = (args) => new Promise((resolve, reject) => {
  const p = spawn(FFMPEG.pathname.replace(/^\/(\w:)/, "$1").replaceAll("%20", " "), ["-hide_banner", "-nostdin", "-y", ...args], { windowsHide: true });
  let err = "";
  p.stderr.on("data", (d) => { err += d; });
  p.on("close", (code) => (code ? reject(new Error(err.slice(-500))) : resolve(err)));
});

/** Где начинается звук (конец каждой тишины), с — по звуку файла с учётом его меток времени. */
async function sounds(file, stream = "0:a:0") {
  const log = await ff(["-i", file, "-map", stream, "-af", "silencedetect=noise=-45dB:d=0.5", "-f", "null", "-"]);
  // конец файла silencedetect тоже отмечает концом тишины — это не звук
  return [...log.matchAll(/silence_end: (-?[\d.]+)/g)].map((m) => Number(m[1])).filter((t) => t < DURATION - 0.1);
}

/** Каждый ожидаемый момент найден (±tol с) и лишнего ничего нет. */
function assertAt(found, expected, tol = 0.006, what = "") {
  const missing = expected.filter((t) => !found.some((f) => Math.abs(f - t) <= tol));
  const extra = found.filter((f) => !expected.some((t) => Math.abs(f - t) <= tol));
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, `${what}: найдено ${found.map((x) => x.toFixed(3)).join(", ")}`);
}

const orig = wav(path.join(dir, "orig.wav"), 48000, 2, ORIG_AT);
const voice = wav(path.join(dir, "voice.wav"), 24000, 1, VOICE_AT);
const opts = (extra) => ({ voiceGain: 1, originalVolume: 100, mixMode: "duck", autoLevel: false,
  origInfo: { codec: "aac", kbps: 256, channels: 2 }, ...extra });

test("дорожка с переводом кусками на всех ядрах: всё на месте, стыков не слышно", { skip }, async () => {
  const analysis = await media.analyzeVoice(voice);
  assert.equal(analysis.segments.length, VOICE_AT.length, "фразы перевода найдены");
  const out = path.join(dir, "mix.m4a");
  let last = 0;
  await media.mixAudio({ path: orig, offset: 0 }, voice, out, opts({ voiceAnalysis: analysis }), DURATION, (p) => {
    assert.ok(p >= last, "ход работы не идёт назад");
    last = p;
  });
  // ограничитель громкости задерживает звук на 1 мс — так и задумано
  assertAt(await sounds(out), [...ORIG_AT, ...VOICE_AT].map((t) => t + 0.001), 0.006, "сведение");
  const info = await media.probe(out);
  assert.ok(Math.abs(info.duration - DURATION) < 0.05, `длина ${info.duration}`);
});

test("задержка звука оригинала ставится точно, перевод остаётся на месте", { skip }, async () => {
  const analysis = await media.analyzeVoice(voice);
  const out = path.join(dir, "mix-delay.m4a");
  await media.mixAudio({ path: orig, offset: 0.12 }, voice, out, opts({ voiceAnalysis: analysis }), DURATION);
  assertAt(await sounds(out), [...ORIG_AT.map((t) => t + 0.12), ...VOICE_AT].map((t) => t + 0.001), 0.006, "с задержкой");
});

test("облегчённая копия (звук сжимается отдельно): звук там же, где в видео, копия звука — без изменений", { skip }, async () => {
  // видео: картинка с 0, звук AAC 256 кбит/с на 0,12 с позже — как у MKV с задержкой звука
  const video = path.join(dir, "video.mkv");
  await ff(["-f", "lavfi", "-t", String(DURATION), "-i", "color=c=gray:s=320x180:r=10", "-itsoffset", "0.12", "-i", orig,
    "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-b:a", "256k", video]);
  const info = await media.probe(video);
  const offset = await media.audioOffset(video, info.start);
  assert.ok(Math.abs(offset - 0.12) < 0.03, `задержка ${offset}`);
  const light = path.join(dir, "light.mp4"), origOut = path.join(dir, "orig-copy.mka");
  await media.makeLight(video, light, info.duration, null, null, { copyAudio: info.audioCopyable, origOut, audio: info.audio, origOffset: offset });
  const lightInfo = await media.probe(light);
  // пережат, а не скопирован как есть (256 кбит/с); точной цифры нет — тишина сжимается почти в ноль
  assert.ok(lightInfo.audio.kbps < 150, `звук для Яндекса сжат: ${lightInfo.audio.kbps} кбит/с`);
  const inVideo = await sounds(video);
  assertAt(await sounds(light), inVideo, 0.006, "облегчённая копия");
  // копия звука оригинала — тот же звук, только без задержки (её возвращают сведение и копия)
  assertAt(await sounds(origOut), inVideo.map((t) => t - offset), 0.006, "копия звука");
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
