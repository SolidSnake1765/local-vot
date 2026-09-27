// Раздача файла Яндексу напрямую с компьютера пользователя — без Диска и без входа в аккаунт.
// Локальный HTTP-сервер отдаёт один файл по случайному адресу, временный туннель Cloudflare
// (cloudflared, без регистрации) даёт ему публичную ссылку https://<слова>.trycloudflare.com/....
// vot.js принимает любые прямые ссылки на .mp4.
import { spawn } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CLOUDFLARED = path.join(ROOT, "tools", "cloudflared.exe");

/** Сервер отдаёт только этот файл и только по секретному пути; поддерживает Range. */
function serveFile(file, log) {
  const secret = randomBytes(12).toString("hex");
  const urlPath = `/${secret}/video.mp4`;
  const size = statSync(file).size;
  let sent = 0;

  const server = createServer((req, res) => {
    if (req.url !== urlPath || !["GET", "HEAD"].includes(req.method)) {
      res.writeHead(404).end();
      return;
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    let start = 0;
    let end = size - 1;
    if (range) {
      start = range[1] ? Number(range[1]) : size - Number(range[2]);
      end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : end;
    }
    const headers = {
      "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Length": end - start + 1,
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
    };
    res.writeHead(range ? 206 : 200, headers);
    log(`  ← ${req.method} ${range ? `байты ${start}-${end}` : "весь файл"} (${req.headers["user-agent"] ?? "?"})`);
    if (req.method === "HEAD") return res.end();
    const stream = createReadStream(file, { start, end });
    stream.on("data", (chunk) => { sent += chunk.length; });
    stream.pipe(res);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, urlPath, sent: () => sent }));
  });
}

/** Запускает cloudflared и ждёт публичный адрес туннеля. */
export function startTunnel(port, log = console.log) {
  if (!existsSync(CLOUDFLARED)) throw new Error(`Нет ${CLOUDFLARED}`);
  // http2 вместо QUIC: UDP хуже проходит через VPN-клиенты в режиме TUN
  const proc = spawn(CLOUDFLARED, ["tunnel", "--no-autoupdate", "--protocol", "http2",
    "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "ignore", "pipe"] });

  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      proc.kill();
      // cloudflared сам диагностирует сеть: вытаскиваем его вывод, иначе причина не видна
      const reason = /TLS handshake with edge error|QUIC connection failed|blocked or unreachable/.test(buf)
        ? "серверы Cloudflare (порт 7844) недоступны из этой сети — вероятно, блокировка провайдера"
        : "причина в журнале ниже";
      reject(new Error(`Туннель не поднялся за 60 с: ${reason}\n${buf.split("\n").filter((l) => / ERR |FAIL/.test(l)).slice(-6).join("\n")}`));
    }, 60_000);
    let ready = false;
    proc.stderr.on("data", (d) => {
      if (ready) return;
      buf += d;
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(buf);
      // адрес печатается раньше, чем туннель готов, — ждём регистрации соединения
      if (m && /Registered tunnel connection/.test(buf)) {
        ready = true;
        clearTimeout(timer);
        log(`  туннель: ${m[0]}`);
        resolve({ proc, publicUrl: m[0] });
      }
    });
    proc.on("exit", (code) => { clearTimeout(timer); reject(new Error(`cloudflared завершился (${code}):\n${buf.slice(-2000)}`)); });
  });
}

/** Открывает файл наружу; возвращает ссылку и функцию закрытия. */
export async function share(file, log = console.log) {
  const srv = await serveFile(file, log);
  let tunnel;
  try {
    tunnel = await startTunnel(srv.port, log);
  } catch (e) {
    srv.server.close();
    throw e;
  }
  return {
    url: `${tunnel.publicUrl}${srv.urlPath}`,
    sentBytes: srv.sent,
    close() {
      tunnel.proc.kill();
      srv.server.closeAllConnections();
      srv.server.close();
    },
  };
}
