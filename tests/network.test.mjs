// Повторы при сбоях Яндекс Диска и скачивания перевода — на подставном fetch (случаи из журналов).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

let script = [];
let calls = 0;
const realFetch = globalThis.fetch;
const realTimeout = globalThis.setTimeout;
before(() => {
  // паузы между повторами — без настоящего ожидания
  globalThis.setTimeout = (fn, ms, ...a) => realTimeout(fn, Math.min(ms, 2), ...a);
  globalThis.fetch = async () => {
    calls++;
    const next = script.shift();
    if (!next) throw new Error("лишний запрос");
    if (next.network) throw new TypeError("fetch failed");
    return new Response(next.body ?? "", { status: next.status ?? 200 });
  };
});
after(() => {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realTimeout;
});
const answers = (list) => { script = [...list]; calls = 0; };
const { freeSpace, publish, upload } = await import("../src/main/yadisk.js");
const { download, nextPoll } = await import("../src/main/vot.js");
const FILE = fileURLToPath(new URL("../package.json", import.meta.url));

test("Диск: 503 с HTML-страницей — повтор, а не сбой разбора", async () => {
  answers([{ status: 503, body: "<html>Bad gateway</html>" }, { body: '{"total_space":10,"used_space":4}' }]);
  assert.equal(await freeSpace("t"), 6);
  assert.equal(calls, 2);
});

test("Диск: 423 у публикации — «другая операция», повтор", async () => {
  answers([{ status: 423, body: '{"message":"Ресурс заблокирован"}' }, { body: "{}" }, { body: '{"public_url":"https://disk.yandex.ru/i/x"}' }]);
  assert.equal(await publish("t", "app:/x"), "https://disk.yandex.ru/i/x");
});

test("Диск: 423 у публикации всё время — честная ошибка, не «лимит загрузки»", async () => {
  answers(Array(4).fill({ status: 423, body: '{"message":"Ресурс заблокирован"}' }));
  const e = await publish("t", "app:/x").catch((err) => err);
  assert.notEqual(e.code, "UPLOAD_LIMIT");
  assert.match(e.message, /заблокирован/);
});

test("Диск: 423 у ссылки на загрузку — месячный лимит", async () => {
  answers([{ status: 423, body: '{"message":"Загрузка недоступна"}' }]);
  const e = await upload("t", FILE, null).catch((err) => err);
  assert.equal(e.code, "UPLOAD_LIMIT");
  assert.equal(calls, 1);
});

test("Диск: публичная ссылка появилась не сразу", async () => {
  answers([{ body: "{}" }, { body: "{}" }, { body: '{"public_url":"https://disk.yandex.ru/i/y"}' }]);
  assert.equal(await publish("t", "app:/y"), "https://disk.yandex.ru/i/y");
});

test("Диск: 401 — без повторов, понятный текст", async () => {
  answers([{ status: 401, body: "{}" }]);
  await assert.rejects(freeSpace("t"), /Вход в Яндекс устарел/);
  assert.equal(calls, 1);
});

test("Диск: обрыв связи при загрузке — 4 попытки с новой ссылкой", async () => {
  answers(Array(4).fill({ body: '{"href":"https://127.0.0.1:9/upload"}' }));
  await assert.rejects(upload("t", FILE, null));
  assert.equal(calls, 4);
});

test("перевод: ошибка сервера и страница вместо MP3 — повтор, потом файл", async () => {
  answers([{ status: 500 }, { body: "<html>oops</html>" }, { body: "x".repeat(5000) }]);
  assert.equal((await download("https://example/voice.mp3")).length, 5000);
});

test("перевод: файл так и не отдали — понятная ошибка после 4 попыток", async () => {
  answers(Array(4).fill({ status: 404 }));
  await assert.rejects(download("https://example/voice.mp3"), /Не удалось скачать готовый перевод: ответ 404/);
  assert.equal(calls, 4);
});

test("опрос Яндекса: к сроку, который он назвал, но не чаще раза в 5 с и не реже раза в 30 с", () => {
  assert.equal(nextPoll(-1), 30_000);
  assert.equal(nextPoll(600), 30_000);
  assert.equal(nextPoll(12), 12_000);
  assert.equal(nextPoll(1), 5_000);
});
