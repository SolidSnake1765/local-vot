// Ключ входа (токен) — в папке данных программы, зашифрованный средствами Windows (safeStorage).
// Общий для входа в Яндекс (auth.js) и в Google (gauth.js).
import { app, safeStorage } from "electron";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Хранилище одного токена в файле name. Токен нужен каждому видео и каждому удалению копии — с диска
 * читаем один раз, дальше из памяти.
 */
export function tokenStore(name) {
  const file = () => path.join(app.getPath("userData"), name);
  let cached; // undefined — ещё не читали, null — входа нет
  return {
    save(token) {
      const json = JSON.stringify(token);
      writeFileSync(file(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json));
      cached = token;
    },
    load() {
      if (cached !== undefined) return cached;
      cached = null;
      if (!existsSync(file())) return null;
      const buf = readFileSync(file());
      try {
        cached = JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString());
      } catch { /* файл испорчен — нужен новый вход */ }
      return cached;
    },
    clear() {
      rmSync(file(), { force: true });
      cached = null;
    },
  };
}
