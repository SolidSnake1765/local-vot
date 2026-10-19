// Перевод (vot.js) на подставном Яндексе: «Слишком много запросов. Попробуйте снова через 5 минут» (status 8) —
// не сбой: Яндекс пускает через 20–80 с (журнал пользователя, 19.10) — повторяем, в счёт ошибок не идёт.
import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// время — подставное: паузы проходят мгновенно, но часы «уходят вперёд» на столько, сколько ждали
let offset = 0;
const realNow = Date.now;
const realTimeout = globalThis.setTimeout;
const realFetch = globalThis.fetch;
const waits = [];
before(() => {
  Date.now = () => realNow() + offset;
  globalThis.setTimeout = (fn, ms = 0, ...a) => { waits.push(ms); offset += ms; return realTimeout(fn, 0, ...a); };
  globalThis.fetch = async () => new Response(Buffer.alloc(4096)); // «скачанная» дорожка
});
after(() => {
  Date.now = realNow;
  globalThis.setTimeout = realTimeout;
  globalThis.fetch = realFetch;
});

let answers = []; // ответы translateVideo по порядку: { busy } — status 8, иначе — готово
let requests = 0;
class FakeClient {
  async translateVideo() {
    requests++;
    const next = answers.shift() ?? {};
    if (next.busy) {
      throw Object.assign(new Error("Unknown response from Yandex"),
        { data: { status: 8, message: "Слишком много запросов.\nПопробуйте снова через 5 минут", isLivelyVoice: true } });
    }
    return { translated: true, status: 1, url: "https://example.invalid/voice.mp3", translationId: `t${requests}` };
  }
  async getSubtitles() { return { subtitles: [] }; }
}
mock.module("@vot.js/node", { defaultExport: FakeClient });
mock.module("@vot.js/node/utils/videoData", { namedExports: { getVideoData: async (url) => ({ url, videoId: "x", host: "custom" }) } });
const { translate } = await import("../src/main/vot.js");

const dir = mkdtempSync(path.join(os.tmpdir(), "local-vot-test-vot-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("«слишком много запросов» подряд 10 раз — повтор каждые 20 с, ошибкой не считается, перевод получен", async () => {
  answers = Array(10).fill({ busy: true }); // раньше 6 отказов подряд роняли видео («переводчик не отвечает»)
  requests = 0;
  waits.length = 0;
  const status = [];
  const r = await translate("https://example.invalid/a.mp4", 60, path.join(dir, "a"), (st) => status.push(st), undefined, { lang: "en" });
  assert.ok(r.audio, "перевод получен");
  assert.equal(requests, 11);
  assert.equal(waits.filter((ms) => ms === 20_000).length, 10, "повтор — через 20 с, не через 5 минут");
  assert.ok(status.some((st) => /Очередь у Яндекса: сейчас много новых переводов сразу/.test(st)), JSON.stringify(status));
  assert.ok(!status.some((st) => /Сбой связи/.test(st)), "это не «сбой связи»");
});

test("«слишком много запросов» больше часа — понятная ошибка", async () => {
  answers = Array(500).fill({ busy: true });
  await assert.rejects(translate("https://example.invalid/b.mp4", 60, path.join(dir, "b"), () => {}, undefined, { lang: "en" }),
    /больше часа не принимает перевод/);
  answers = [];
});
