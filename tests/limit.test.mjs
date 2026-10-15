// Очередь к диску (workPool) и простой ограничитель (limiter).
import { test } from "node:test";
import assert from "node:assert/strict";
import { limiter, workPool } from "../src/main/limit.js";

/** Как в pipeline.js: при n ≥ 2 — до n копий и до n сборок независимо, при 1 — всё по одному, копия раньше. */
const diskPool = (getN) => workPool((kind, busy) => {
  const n = getN();
  return n <= 1 ? !busy.light && !busy.save : (busy[kind] ?? 0) < n;
}, { light: 0, save: 1 });

test("по 2: копия не ждёт сборок, третья сборка ждёт", async () => {
  const pool = diskPool(() => 2);
  const s1 = pool.acquire("save"), s2 = pool.acquire("save"), s3 = pool.acquire("save");
  const l1 = pool.acquire("light");
  assert.deepEqual([s1.granted, s2.granted, s3.granted, l1.granted], [true, true, false, true]);
  const release = await s1;
  release();
  release(); // повторный вызов ничего не ломает
  assert.equal(s3.granted, true);
  for (const t of [s2, s3, l1]) (await t)();
});

test("по одному: всё по очереди, копия раньше сборки, внутри вида — по приоритету", async () => {
  const pool = diskPool(() => 1);
  const a = pool.acquire("save", null, 0);
  const b = pool.acquire("save", null, 1);
  const c = pool.acquire("light", null, 5);
  const d = pool.acquire("light", null, 3);
  assert.deepEqual([a.granted, b.granted, c.granted, d.granted], [true, false, false, false]);
  (await a)();
  assert.equal(d.granted, true, "первой — копия с меньшим приоритетом");
  (await d)();
  assert.equal(c.granted, true);
  (await c)();
  assert.equal(b.granted, true);
  (await b)();
});

test("отмена в ожидании снимает из очереди", async () => {
  const pool = diskPool(() => 1);
  const x = pool.acquire("save");
  const ac = new AbortController();
  const y = pool.acquire("light", ac.signal);
  ac.abort();
  await assert.rejects(y, /Отменено/);
  (await x)();
  const z = pool.acquire("light");
  assert.equal(z.granted, true, "отменённый не держит место");
  (await z)();
});

test("смена настройки на ходу будит ждущих", async () => {
  let n = 1;
  const pool = diskPool(() => n);
  const w = [pool.acquire("save"), pool.acquire("save"), pool.acquire("save")];
  assert.deepEqual(w.map((t) => t.granted), [true, false, false]);
  n = 3;
  pool.wake();
  assert.deepEqual(w.map((t) => t.granted), [true, true, true]);
  for (const t of w) (await t)();
});

test("limiter: не больше n сразу, по приоритету", async () => {
  const lim = limiter(1);
  const first = await lim.acquire();
  const order = [];
  const p1 = lim.acquire(null, 2).then((r) => { order.push("p2"); return r; });
  const p2 = lim.acquire(null, 1).then((r) => { order.push("p1"); return r; });
  assert.equal(lim.busy(), true);
  first();
  (await p2)();
  (await p1)();
  assert.deepEqual(order, ["p1", "p2"]);
});
