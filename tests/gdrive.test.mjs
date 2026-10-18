// Google Диск (gdrive.js) на подставном Google: загрузка в свою папку с пометкой, повтор при сбое, понятные
// ошибки (нет места, вход устарел), доступ по ссылке и каждый раз новая ссылка, удаление, свободное место.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FILE = fileURLToPath(new URL("../package.json", import.meta.url));
const SIZE = statSync(FILE).size;
let script = []; // ответы «Google» на запросы fetch по порядку
let seen = []; // что программа спросила
let puts = []; // ответы подставного сервера загрузки по порядку
let received = []; // сколько байт он получил за каждую загрузку
const realFetch = globalThis.fetch;
const realTimeout = globalThis.setTimeout;
const server = http.createServer((req, res) => {
  let n = 0;
  req.on("data", (d) => { n += d.length; });
  req.on("end", () => {
    received.push(n);
    const next = puts.shift() ?? { status: 500 };
    res.writeHead(next.status ?? 200, { "Content-Type": "application/json" }).end(next.body ?? "");
  });
});
let base = "";

before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  globalThis.setTimeout = (fn, ms, ...a) => realTimeout(fn, Math.min(ms, 2), ...a); // паузы повторов — мгновенно
  globalThis.fetch = async (url, opts = {}) => {
    seen.push({ url: String(url), method: opts.method ?? "GET", headers: opts.headers ?? {}, body: opts.body ? JSON.parse(opts.body) : null });
    const next = script.shift();
    if (!next) throw new Error(`лишний запрос: ${opts.method ?? "GET"} ${url}`);
    if (next.network) throw new TypeError("fetch failed");
    const headers = next.session ? { location: `${base}/upload/${next.session}` } : {};
    return new Response(next.body === undefined ? "" : JSON.stringify(next.body), { status: next.status ?? 200, headers });
  };
});
after(() => {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realTimeout;
  server.close();
});
beforeEach(() => { script = []; seen = []; puts = []; received = []; });

const g = await import("../src/main/gdrive.js");
const err = (status, reason, message = reason) => ({ status, body: { error: { code: status, message, errors: [{ reason }] } } });

test("загрузка: в папку программы, с пометкой; ход загрузки; итог — gdrive:<id>", async () => {
  script = [{ body: { files: [{ id: "FOLD" }] } }, { session: "s1" }];
  puts = [{ body: '{"id":"F1"}' }];
  const progress = [];
  const ref = await g.upload("tok", FILE, (p) => progress.push(p));
  assert.equal(ref, "gdrive:F1");
  assert.match(decodeURIComponent(seen[0].url), /appProperties has \{ key='localvot' and value='folder' \}/);
  const session = seen[1];
  assert.equal(session.headers.Authorization, "Bearer tok");
  assert.equal(session.headers["X-Upload-Content-Length"], String(SIZE));
  assert.deepEqual([session.body.parents, session.body.appProperties], [["FOLD"], { localvot: "copy" }]);
  assert.deepEqual(received, [SIZE], "файл дошёл целиком");
  assert.deepEqual(progress.at(-1), { phase: "waiting", sent: SIZE, size: SIZE });
});

test("загрузка: папки нет (или её удалили) — создаётся заново", async () => {
  script = [{ body: { files: [] } }, { body: { id: "NEW" } }, { session: "s1" }];
  puts = [{ body: '{"id":"F2"}' }];
  assert.equal(await g.upload("tok", FILE), "gdrive:F2");
  assert.deepEqual(seen[1].body, { name: "Local VOT — копии для перевода", mimeType: "application/vnd.google-apps.folder",
    appProperties: { localvot: "folder" } });
  assert.deepEqual(seen[2].body.parents, ["NEW"]);
});

test("загрузка: сбой посреди (503) — заново, с новой сессией", async () => {
  script = [{ body: { files: [{ id: "FOLD" }] } }, { session: "s1" }, { session: "s2" }];
  puts = [{ status: 503, body: '{"error":{"message":"backend"}}' }, { body: '{"id":"F3"}' }];
  assert.equal(await g.upload("tok", FILE), "gdrive:F3");
  assert.deepEqual(received, [SIZE, SIZE]);
});

test("нет места на Google Диске — сразу понятная ошибка, без повторов", async () => {
  script = [{ body: { files: [{ id: "FOLD" }] } }, err(403, "storageQuotaExceeded", "The user's Drive storage quota has been exceeded.")];
  await assert.rejects(g.upload("tok", FILE), /На Google Диске не хватает места/);
  assert.equal(script.length, 0);
});

test("вход устарел (401) — «войдите заново»; «слишком часто» (429) — повтор", async () => {
  script = [err(401, "authError")];
  await assert.rejects(g.freeSpace("tok"), /Вход в Google устарел/);
  script = [err(429, "rateLimitExceeded"), err(403, "userRateLimitExceeded"), { body: { storageQuota: { limit: "100", usage: "30" } } }];
  assert.equal(await g.freeSpace("tok"), 70);
  script = [{ body: { storageQuota: { usage: "30" } } }];
  assert.equal(await g.freeSpace("tok"), Infinity, "безлимитный тариф");
});

test("доступ по ссылке: всем, только чтение; каждый раз новая ссылка; закрыть уже закрытую — не ошибка", async () => {
  script = [{ body: { id: "anyoneWithLink" } }, { body: { id: "anyoneWithLink" } }];
  const a = await g.publish("tok", "gdrive:F1");
  await new Promise((r) => realTimeout(r, 5));
  const b = await g.publish("tok", "gdrive:F1");
  assert.deepEqual(seen.map((s) => s.body), [{ type: "anyone", role: "reader" }, { type: "anyone", role: "reader" }]);
  assert.match(a, /^https:\/\/drive\.google\.com\/file\/d\/F1\/view\?/);
  assert.notEqual(a, b);
  script = [err(404, "notFound")];
  await g.unpublish("tok", "gdrive:F1");
  assert.equal(seen.at(-1).method, "DELETE");
  assert.match(seen.at(-1).url, /files\/F1\/permissions\/anyoneWithLink$/);
});

test("удаление: насовсем — DELETE, иначе — в Корзину; список своих копий", async () => {
  script = [{}, { body: { id: "F1" } }, { body: { files: [{ id: "A" }, { id: "B" }] } }];
  await g.remove("tok", "gdrive:F1", { permanently: true });
  await g.remove("tok", "gdrive:F1");
  assert.deepEqual(seen.slice(0, 2).map((s) => [s.method, s.body]), [["DELETE", null], ["PATCH", { trashed: true }]]);
  assert.deepEqual(await g.listAppFolder("tok"), ["gdrive:A", "gdrive:B"]);
  assert.match(decodeURIComponent(seen[2].url), /value='copy'/);
});
