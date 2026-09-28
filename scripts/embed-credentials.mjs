// Перед сборкой: кладёт ключи приложения Яндекса в src/main/credentials.json — он попадает в собранную
// программу, но не в git (.gitignore). Ключи берутся из переменных окружения YANDEX_CLIENT_ID /
// YANDEX_CLIENT_SECRET (на GitHub — из секретов репозитория), а если их нет — из .env в корне проекта.
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env");
if (!process.env.YANDEX_CLIENT_ID && existsSync(envFile)) process.loadEnvFile(envFile);

const { YANDEX_CLIENT_ID: id, YANDEX_CLIENT_SECRET: secret } = process.env;
if (!id || !secret) {
  console.error("Нет ключей Яндекса: задайте YANDEX_CLIENT_ID и YANDEX_CLIENT_SECRET (в .env или в окружении).");
  process.exit(1);
}
writeFileSync(path.join(root, "src", "main", "credentials.json"), JSON.stringify({ id, secret }));
console.log("Ключи Яндекса вшиты в сборку (src/main/credentials.json).");
