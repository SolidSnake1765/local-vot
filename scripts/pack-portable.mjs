// После electron-builder: портативная версия — zip, внутри которого одна папка «Local VOT»
// (иначе при распаковке «сюда» файлы программы высыпаются россыпью). Данные портативная версия хранит
// в подпапке data рядом с собой (см. src/main/paths.js). Архиватор — tar.exe, встроенный в Windows 10+.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version, build } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const dist = path.join(root, "dist");
const unpacked = path.join(dist, "win-unpacked");
const folderName = build.productName; // «Local VOT»
const folder = path.join(dist, folderName);
const zip = `Local-VOT-${version}-portable.zip`;

if (!existsSync(unpacked)) {
  console.error("Нет dist/win-unpacked — сначала electron-builder.");
  process.exit(1);
}
const tar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
rmSync(folder, { recursive: true, force: true });
rmSync(path.join(dist, zip), { force: true });
renameSync(unpacked, folder); // переименование мгновенное — копировать 450 МБ не нужно
try {
  execFileSync(tar, ["-a", "-c", "-f", zip, folderName], { cwd: dist, stdio: "inherit" });
} finally {
  renameSync(folder, unpacked);
}
console.log(`Портативная версия: dist/${zip}`);
