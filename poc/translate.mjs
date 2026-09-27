// Перевод по готовой ссылке (без загрузки на Диск).
// node poc/translate.mjs <ссылка на видео> <длительность, с> [папка вывода]
import { mkdirSync } from "node:fs";
import path from "node:path";
import { translate } from "./vot.mjs";

const [url, durArg, outDir = "out"] = process.argv.slice(2);
const duration = Number(durArg);
if (!url || !(duration > 0)) {
  console.error("Использование: node poc/translate.mjs <ссылка> <длительность, с> [папка]");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const id = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "video";
const r = await translate(url, duration, path.join(outDir, id));
console.log(`Дорожка: ${r.audio}\nСубтитры: ${r.subs ?? "нет"} (${r.subsCount} строк)`);
