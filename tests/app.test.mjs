// Настоящая программа (Electron) в отдельной папке данных (LOCAL_VOT_DATA_DIR): восстановление списка видео,
// продолжение недоделанного, сохранение при закрытии, «выключить компьютер после очереди» без выключения.
// Входа в Яндекс в этой папке нет — запущенные видео ожидаемо заканчиваются ошибкой «Войдите в Яндекс».
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ELECTRON = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const FFMPEG = path.join(ROOT, "vendor", "ffmpeg", "ffmpeg.exe");
const skip = (!existsSync(ELECTRON) || !existsSync(FFMPEG)) && "нет Electron или vendor/ffmpeg";
const base = path.join(os.tmpdir(), `local-vot-test-app-${process.pid}`);
rmSync(base, { recursive: true, force: true });
mkdirSync(base, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const id = (n) => `00000000-0000-4000-8000-00000000000${n}`;

// маленькое видео и звук для заготовленного списка
const video = path.join(base, "clip.mp4"), voice = path.join(base, "voice.m4a");
if (!skip) {
  await new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-t", "8", "-i", "color=c=gray:s=160x90:r=5",
      "-c:v", "libx264", "-preset", "ultrafast", video], { windowsHide: true });
    p.on("close", (c) => (c ? reject(new Error("видео не сделалось")) : resolve()));
  });
  copyFileSync(video, voice); // как «перевод» сойдёт любой файл: прослушивание в проверке не запускается
}

/** Запустить программу с подготовленной папкой данных; вернуть { evaluate, close, exited, log }. */
async function launch(dir, port, env = {}) {
  const app = spawn(ELECTRON, [".", `--remote-debugging-port=${port}`],
    { cwd: ROOT, env: { ...process.env, LOCAL_VOT_DATA_DIR: dir, ...env }, stdio: "ignore" });
  const state = { exited: false };
  app.on("exit", () => { state.exited = true; });
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(500);
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((p) => p.type === "page"); } catch { /* ещё не готово */ }
  }
  assert.ok(page, "окно программы не появилось");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let seq = 0;
  const evaluate = (expression) => new Promise((resolve) => {
    const n = ++seq;
    const on = (e) => { const m = JSON.parse(e.data); if (m.id === n) { ws.removeEventListener("message", on); resolve(m.result?.result?.value); } };
    ws.addEventListener("message", on);
    ws.send(JSON.stringify({ id: n, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  const waitExit = async (ms) => { for (let i = 0; i < ms / 250 && !state.exited; i++) await sleep(250); return state.exited; };
  // ждать, пока выражение в окне не станет истинным (сервер сборки бывает в разы медленнее — не «на глаз»)
  const waitFor = async (expression, ms = 30_000) => {
    for (let i = 0; i < ms / 250; i++) {
      if (await evaluate(expression)) return true;
      await sleep(250);
    }
    return false;
  };
  return {
    evaluate, state, waitExit, waitFor,
    // как крестик окна: Windows шлёт окну «закрыть»
    close: async () => { ws.close(); spawn("taskkill", ["/PID", String(app.pid)], { stdio: "ignore" }); return waitExit(30_000); },
    kill: () => { try { ws.close(); } catch { /* уже закрыт */ } app.kill(); },
    log: () => readdirSync(path.join(dir, "profile", "logs")).map((f) => readFileSync(path.join(dir, "profile", "logs", f), "utf8")).join(""),
  };
}

const cardsJs = `[...document.querySelectorAll(".job")].map((n) => ({ id: n.dataset.id, state: n.dataset.state,
  steps: [...n.querySelectorAll(".step")].map((s) => s.className.replace("step", "").trim() + ":" + s.querySelector(".step-detail").textContent),
  error: n.querySelector(".job-error").hidden ? "" : n.querySelector(".job-error").textContent,
  outputs: n.querySelectorAll(".output").length, preview: !n.querySelector(".preview").hidden }))`;

test("список видео между запусками: восстановление, продолжение, сохранение при закрытии", { skip, timeout: 120_000 }, async () => {
  const dir = path.join(base, "restore");
  const profile = path.join(dir, "profile"), cache = path.join(dir, "temp", "cache");
  mkdirSync(path.join(cache, id(1)), { recursive: true });
  mkdirSync(profile, { recursive: true });
  copyFileSync(voice, path.join(cache, id(1), "voice.ru.mp3"));
  mkdirSync(path.join(dir, "temp", "work-old"), { recursive: true });
  writeFileSync(path.join(cache, "deadbeef-orig.mka"), "мусор прошлого запуска");
  const steps = { light: { state: "done", detail: "Громкость оригинала -19.3 LUFS" }, translate: { state: "done", detail: "Обычные голоса" },
    save: { state: "done", detail: "Оригинал 30% под переводом" } };
  const job = { file: video, name: "clip.mp4", lively: false, lang: "auto", diskPath: null, duration: 8, outputs: [], save: null,
    sound: null, savedSound: null, origOffset: 0, origLoudness: -19, steps: null, error: "", mode: "translate", replace: false, translation: null };
  const jobs = [
    { ...job, id: id(1), no: 1, state: "done", voiceUsed: false, langUsed: "auto", steps, outputs: [video],
      translation: { audio: path.join(cache, id(1), "voice.ru.mp3"), subs: null, subsCount: 0, lively: false, lang: "auto",
        analysis: { loudness: -18, segments: [[1, 2]] } } },
    { ...job, id: id(2), no: 2, state: "error", error: "Речь в видео не похожа на английский.",
      steps: { translate: { state: "error", detail: "Речь в видео не похожа на английский." } } },
    { ...job, id: id(3), no: 3, state: "idle" },
    { ...job, id: id(4), no: 4, state: "queued" },
  ];
  writeFileSync(path.join(profile, "queue.json"), JSON.stringify({ version: 1, jobs, order: [id(3), id(1), id(4), id(2)] }));
  writeFileSync(path.join(profile, "settings.json"), JSON.stringify({ keepQueue: true }));

  const app = await launch(dir, 9351);
  try {
    // список на месте и недоделанное уже отработало (без входа — ошибкой)
    await app.waitFor(`document.querySelectorAll(".job").length === 4
      && document.querySelector('.job[data-id="${id(4)}"]')?.dataset.state === "error"`);
    const cards = await app.evaluate(cardsJs);
    assert.deepEqual(cards.map((c) => c.id), [id(3), id(1), id(4), id(2)], "порядок");
    const [idle, done, resumed, failed] = cards;
    assert.equal(idle.state, "idle");
    assert.equal(done.state, "done");
    assert.deepEqual([done.outputs, done.preview], [1, true], "готовое — с файлом и прослушиванием");
    assert.match(done.steps.join(" | "), /done:Громкость оригинала -19\.3 LUFS/);
    assert.equal(resumed.state, "error", "недоделанное продолжилось (без входа — ошибка)");
    assert.match(resumed.error, /Войдите в Яндекс/);
    assert.equal(failed.error, "Речь в видео не похожа на английский.");
    assert.ok(!existsSync(path.join(dir, "temp", "work-old")) && !existsSync(path.join(cache, "deadbeef-orig.mka")), "мусор убран");
    assert.ok(existsSync(path.join(cache, id(1), "voice.ru.mp3")), "кэш готового на месте");
    assert.ok(await app.close(), "программа закрылась");
  } finally {
    app.kill();
  }
  const after = JSON.parse(readFileSync(path.join(profile, "queue.json"), "utf8"));
  assert.deepEqual(after.order, [id(3), id(1), id(4), id(2)]);
  assert.deepEqual(after.jobs.map((j) => j.state), ["idle", "done", "error", "error"]);
  assert.ok(existsSync(path.join(cache, id(1), "voice.ru.mp3")), "кэш пережил выход");
  assert.match(app.log(), /список сохраняется/);
});

test("выключить компьютер после очереди: отсчёт, отмена и выключение (без настоящего)", { skip, timeout: 120_000 }, async () => {
  for (const cancel of [true, false]) {
    const dir = path.join(base, cancel ? "sd-cancel" : "sd-wait");
    mkdirSync(path.join(dir, "profile"), { recursive: true });
    const job = { id: id(9), no: 1, file: video, name: "clip.mp4", state: "idle", lively: false, lang: "auto", outputs: [] };
    writeFileSync(path.join(dir, "profile", "queue.json"), JSON.stringify({ version: 1, jobs: [job], order: [job.id] }));
    writeFileSync(path.join(dir, "profile", "settings.json"), JSON.stringify({ keepQueue: true }));
    const app = await launch(dir, cancel ? 9352 : 9353, { LOCAL_VOT_DRY_SHUTDOWN: "1", LOCAL_VOT_SHUTDOWN_SECONDS: "3" });
    try {
      await app.waitFor(`Boolean(document.querySelector(".job-start")) && !document.querySelector(".job-start").hidden`);
      await app.evaluate(`document.getElementById("shutdownAfter").click()`);
      await app.evaluate(`document.querySelector(".job-start").click()`);
      await app.waitFor(`!document.getElementById("askModal").hidden`);
      const title = await app.evaluate(`document.getElementById("askModal").hidden ? "" : document.getElementById("askTitle").textContent`);
      assert.equal(title, "Выключение компьютера");
      assert.equal(await app.evaluate(`document.getElementById("shutdownAfter").checked`), false, "галочка — один раз");
      if (cancel) {
        await app.evaluate(`[...document.querySelectorAll("#askBtns button")].find((b) => b.textContent === "Не выключать").click()`);
        assert.equal(await app.waitExit(6000), false, "после отмены программа работает");
        assert.ok(await app.close());
        assert.match(app.log(), /\[выключение\] отменено/);
      } else {
        assert.ok(await app.waitExit(20_000), "программа закрылась сама");
        const log = app.log();
        assert.match(log, /выключаем компьютер/);
        assert.match(log, /проверка: компьютер не выключается/);
        assert.equal(log.match(/закрытие программы/g).length, 1, "уборка — один раз");
      }
    } finally {
      app.kill();
    }
  }
});

test("облако: Google Диск без входов — кнопка в шапке, окно облака, подсказки, понятная ошибка, смена облака", { skip, timeout: 120_000 }, async () => {
  const dir = path.join(base, "google");
  mkdirSync(path.join(dir, "profile"), { recursive: true });
  const job = { id: id(7), no: 1, file: video, name: "clip.mp4", state: "queued", lively: true, lang: "en", outputs: [] };
  writeFileSync(path.join(dir, "profile", "queue.json"), JSON.stringify({ version: 1, jobs: [job], order: [job.id] }));
  writeFileSync(path.join(dir, "profile", "settings.json"), JSON.stringify({ keepQueue: true, storage: "google", livelyVoice: true }));
  const app = await launch(dir, 9354);
  const ui = () => app.evaluate(`(() => {
    const acc = (k) => {
      const opt = document.querySelector('.cloud-opt[data-cloud="' + k + '"]');
      return { selected: opt.classList.contains("selected"), text: opt.querySelector('[data-acc="text"]').textContent,
        btn: opt.querySelector('[data-acc="btn"]').textContent };
    };
    return { name: document.querySelector(".cloud-name").textContent, sub: document.getElementById("cloudSub").textContent,
      need: document.getElementById("cloudBtn").classList.contains("need"), open: !document.getElementById("cloudModal").hidden,
      yandex: acc("yandex"), google: acc("google"), voiceNote: !document.getElementById("cloudVoiceNote").hidden,
      voiceTag: document.getElementById("voiceTag").hidden ? null : document.querySelector("#voiceTag .vt-long").textContent, error: document.querySelector(".job-error").textContent };
  })()`);
  try {
    await app.waitFor(`document.querySelector('.job[data-id="${id(7)}"]')?.dataset.state === "error"`);
    let u = await ui();
    assert.deepEqual([u.name, u.sub, u.need, u.open], ["Облако", "Нужен вход в облако", true, false]);
    assert.match(u.error, /Войдите в Google \(кнопка «Облако» вверху\)/);
    assert.equal(u.voiceTag, "Живые голоса не работают — нет входа в Яндекс", "метка в шапке");
    // окно облака: выбран Google Диск, у обоих — «войти», у Яндекса — «только для живых голосов»
    await app.evaluate(`document.getElementById("cloudBtn").click()`);
    u = await ui();
    assert.ok(u.open);
    assert.deepEqual(u.google, { selected: true, text: "Вход не выполнен", btn: "Войти через Google" });
    assert.deepEqual(u.yandex, { selected: false, text: "Вход не выполнен — нужен только для живых голосов", btn: "Войти через Яндекс" });
    assert.ok(u.voiceNote);
    // выбрали Яндекс Диск щелчком по карточке — шапка и подсказки следом; Esc закрывает окно
    await app.evaluate(`document.querySelector('.cloud-opt[data-cloud="yandex"] ul').click()`);
    u = await ui();
    assert.deepEqual([u.name, u.sub, u.yandex.selected, u.google.selected, u.voiceNote],
      ["Облако", "Нужен вход в облако", true, false, false]);
    assert.equal(u.voiceTag, "Живые голоса не работают — нет входа в Яндекс", "метка — при любом облаке, пока нет входа в Яндекс");
    assert.equal(u.yandex.text, "Вход не выполнен");
    await app.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
    assert.equal((await ui()).open, false);
    assert.ok(await app.close(), "программа закрылась");
  } finally {
    app.kill();
  }
  assert.equal(JSON.parse(readFileSync(path.join(dir, "profile", "settings.json"), "utf8")).storage, "yandex", "выбор сохранился");
});

test.after(async () => {
  await sleep(500);
  rmSync(base, { recursive: true, force: true, maxRetries: 5 });
});
