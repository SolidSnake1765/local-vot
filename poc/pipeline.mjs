// Вся цепочка одной командой — прообраз того, что будет делать приложение:
// видео → облегчённая копия → открыть Яндексу доступ к ней → перевод → закрыть доступ →
// сборка видео с переводом.
//
// node poc/pipeline.mjs <видео> [папка вывода] [--via disk|tunnel]
//   disk   — загрузка на Яндекс Диск (нужен вход; API Диска режет скорость до ~127 КБ/с)
//   tunnel — раздача с компьютера через временный туннель Cloudflare (без входа, по умолчанию)
import { spawnSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { translate } from "./vot.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const viaIdx = argv.indexOf("--via");
const via = viaIdx >= 0 ? argv.splice(viaIdx, 2)[1] : "tunnel";
const [video, outDir = "out"] = argv;
if (!video || !["disk", "tunnel"].includes(via)) {
  console.error("Использование: node poc/pipeline.mjs <видео> [папка вывода] [--via disk|tunnel]");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const name = path.parse(video).name;
const base = path.join(outDir, name);
const t0 = Date.now();
const step = (msg) => console.log(`\n[${((Date.now() - t0) / 1000).toFixed(0)} с] ${msg}`);

function node(script, ...args) {
  const r = spawnSync(process.execPath, [path.join(HERE, script), ...args], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${script} завершился с ошибкой`);
}

step("1/5 Облегчённая копия");
const light = `${base}.light.mp4`;
node("make-light.mjs", video, light);
const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video],
  { encoding: "utf8" });
const duration = parseFloat(probe.stdout);
const sizeMb = statSync(light).size / 1024 / 1024;

/** Открывает Яндексу доступ к облегчённой копии; возвращает ссылку и функцию закрытия доступа. */
async function expose() {
  if (via === "tunnel") {
    step("2/5 Туннель: раздаём файл с компьютера");
    const { share } = await import("./tunnel.mjs");
    const s = await share(light);
    console.log(`Ссылка: ${s.url}`);
    return {
      url: s.url,
      async close() {
        s.close();
        console.log(`Туннель закрыт. Яндекс скачал ${(s.sentBytes() / 1024 / 1024).toFixed(1)} из ${sizeMb.toFixed(1)} МБ`);
      },
    };
  }

  step("2/5 Загрузка на Яндекс Диск");
  const { getToken } = await import("./yandex-auth.mjs");
  const disk = await import("./yadisk.mjs");
  const token = await getToken();
  const up0 = Date.now();
  const diskPath = await disk.upload(token, light);
  const upSec = (Date.now() - up0) / 1000;
  console.log(`Загружено: ${diskPath} — ${sizeMb.toFixed(1)} МБ за ${upSec.toFixed(0)} с (${(sizeMb * 8 / upSec).toFixed(1)} Мбит/с)`);
  const close = async () => {
    await disk.unpublish(token, diskPath).catch((e) => console.log(`  снять публикацию не вышло: ${e.message}`));
    await disk.remove(token, diskPath).catch((e) => console.log(`  удалить не вышло: ${e.message}`));
    console.log("Публикация снята, файл в Корзине Диска");
  };
  try {
    const url = await disk.publish(token, diskPath);
    console.log(`Ссылка: ${url}`);
    return { url, close };
  } catch (e) {
    await close();
    throw e;
  }
}

const access = await expose();
let result;
try {
  step("3/5 Перевод (Яндекс)");
  result = await translate(access.url, duration, base);
} finally {
  // что бы ни случилось — не оставляем файл открытым наружу
  step("4/5 Закрываем доступ к файлу");
  await access.close();
}

step("5/5 Сборка видео");
node("mux.mjs", video, result.audio, ...(result.subs ? [result.subs] : []), `${base} [RU].mkv`);
step(`Готово: ${base} [RU].mkv (субтитров: ${result.subsCount})`);
