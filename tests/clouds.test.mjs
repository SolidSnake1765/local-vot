// Список облаков (clouds.js): у каждого облака есть всё, что нужно окну «Облако», очереди и уборке копий, —
// новое облако без какой-то части проверка не пропустит.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const src = (f) => new URL(`../src/main/${f}`, import.meta.url).href;
mock.module("electron", { namedExports: { app: { getPath: () => "", getAppPath: () => "" }, safeStorage: {} } });
const { CLOUDS, cloudById, cloudOf, livelyCloud, publicClouds } = await import(src("clouds.js"));

const STORAGE = ["upload", "publish", "unpublish", "remove", "freeSpace", "listAppFolder"];
const AUTH = ["login", "getToken", "getAccount", "logout"];

test("у каждого облака — описание, способ входа, хранение и вход целиком", () => {
  assert.ok(CLOUDS.length >= 2);
  assert.equal(new Set(CLOUDS.map((c) => c.id)).size, CLOUDS.length, "id не повторяются");
  for (const c of CLOUDS) {
    for (const k of ["id", "title", "who", "where"]) assert.equal(typeof c[k], "string", `${c.id}.${k}`);
    assert.match(c.where, /^на /, `${c.id}.where — «на …»`);
    assert.match(c.to, /^на /, `${c.id}.to — «на …»`);
    assert.ok(["code", "browser"].includes(c.login), `${c.id}.login`);
    assert.ok(Array.isArray(c.points) && c.points.length > 0, `${c.id}.points`);
    for (const f of STORAGE) assert.equal(typeof c.api[f], "function", `${c.id}.api.${f}`);
    for (const f of AUTH) assert.equal(typeof c.auth[f], "function", `${c.id}.auth.${f}`);
    assert.equal(typeof c.owns, "function");
  }
  assert.equal(CLOUDS.filter((c) => c.lively).length, 1, "живые голоса даёт ровно одно облако");
  assert.equal(livelyCloud().id, "yandex");
});

test("копия узнаёт своё облако; неизвестное — первое облако", () => {
  assert.equal(cloudOf("app:/1700000000-light.mp4").id, "yandex");
  assert.equal(cloudOf("gdrive:abc").id, "google");
  assert.equal(CLOUDS.filter((c) => c.owns("gdrive:abc")).length, 1, "копию узнаёт ровно одно облако");
  assert.equal(cloudById("нет такого").id, CLOUDS[0].id);
  assert.equal(cloudById("google").title, "Google Диск");
});

test("окну уходят только описания — без модулей и функций", () => {
  for (const c of publicClouds()) {
    assert.deepEqual(Object.keys(c).sort(), ["id", "lively", "login", "points", "title", "who"]);
    assert.doesNotThrow(() => structuredClone(c));
  }
});
