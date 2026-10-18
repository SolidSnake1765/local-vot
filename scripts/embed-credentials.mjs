// Перед сборкой: кладёт ключи приложений Яндекса и Google в src/main/credentials.json — он попадает в собранную
// программу, но не в git (.gitignore). Ключи берутся из переменных окружения YANDEX_CLIENT_ID /
// YANDEX_CLIENT_SECRET и GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (на GitHub — из секретов репозитория),
// а если их нет — из .env в корне проекта.
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile); // переменные окружения сильнее: loadEnvFile их не трогает

const pair = (prefix) => ({ id: process.env[`${prefix}_CLIENT_ID`], secret: process.env[`${prefix}_CLIENT_SECRET`] });
const keys = { yandex: pair("YANDEX"), google: pair("GOOGLE") };
const missing = Object.entries(keys).filter(([, k]) => !k.id || !k.secret).map(([name]) => name.toUpperCase());
if (missing.length) {
  console.error(`Нет ключей: ${missing.map((p) => `${p}_CLIENT_ID и ${p}_CLIENT_SECRET`).join(", ")} (в .env или в окружении).`);
  process.exit(1);
}
writeFileSync(path.join(root, "src", "main", "credentials.json"), JSON.stringify(keys));
console.log("Ключи Яндекса и Google вшиты в сборку (src/main/credentials.json).");
