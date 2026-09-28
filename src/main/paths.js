// Где программа хранит свои данные.
// Портативная версия (распакована из архива) — всё рядом с собой, в папке data: настройки, вход в Яндекс,
// временные файлы и кэш переводов; в системе следов не остаётся. Установленная — как принято в Windows:
// настройки в %APPDATA%\Local VOT, временные файлы в %TEMP%\local-vot (деинсталлятор убирает и то и другое).
import { app } from "electron";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const exeDir = path.dirname(process.execPath);
const dataDir = path.join(exeDir, "data");
// установщик кладёт рядом с программой деинсталлятор; нет его — программу распаковали из архива
let portable = app.isPackaged && !existsSync(path.join(exeDir, `Uninstall ${app.getName()}.exe`));

// запуск из исходников (npm start) — отдельно от установленной версии: своя папка настроек и входа
// в Яндекс и свои временные файлы; иначе удаление установленной стирало бы данные разработки,
// а запуск одной версии чистил бы временные файлы другой
const DEV_NAME = "Local VOT (разработка)";

/**
 * Вызывать до app.whenReady(): портативная версия — данные в папке data рядом с программой;
 * запуск из исходников — в %APPDATA%\Local VOT (разработка).
 */
export function setupDataPaths() {
  if (!app.isPackaged) {
    app.setPath("userData", path.join(app.getPath("appData"), DEV_NAME));
    return;
  }
  if (!portable) return;
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch {
    portable = false; // папка только для чтения (например, Program Files) — данные в обычных местах
    return;
  }
  // профиль: настройки, токен входа, размер окна и служебные папки Chromium (кэш, дампы сбоев)
  const profile = path.join(dataDir, "profile");
  app.setPath("userData", profile);
  app.setPath("sessionData", profile);
  app.setPath("crashDumps", path.join(profile, "Crashpad"));
  app.setPath("logs", path.join(profile, "logs"));
}

/** Портативная ли версия (данные в папке data рядом с программой). */
export const isPortable = () => portable;

/** Папка для временных файлов и кэша переводов (очищается при запуске и выходе). */
export function workRoot() {
  if (portable) return path.join(dataDir, "temp");
  return path.join(app.getPath("temp"), app.isPackaged ? "local-vot" : "local-vot-dev");
}
