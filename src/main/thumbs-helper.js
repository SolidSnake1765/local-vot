// Скрытый помощник для миниатюр — отдельный процесс программы без окон (запускает thumbs.js).
// Получает сообщения { id, file }, отвечает { id, url } (url — data:-адрес PNG или null) по каналу
// IPC Node (обычный ввод у Electron на Windows не читается). nativeImage.createThumbnailFromPath
// занимает поток, пока Windows читает видео (на жёстком диске — до секунд на файл); здесь это никому
// не мешает. Канал закрылся (программа вышла или закрыла помощника) — выходим и мы.
import { app, nativeImage } from "electron";
import path from "node:path";

// свои служебные папки Chromium — отдельно от профиля программы, которая работает в то же время;
// папку передаёт программа (её временная папка: убирается при выходе)
const dir = process.argv.find((a) => a.startsWith("--thumbs-dir="))?.slice("--thumbs-dir=".length);
if (dir) {
  app.setPath("userData", dir);
  app.setPath("sessionData", dir);
  app.setPath("crashDumps", path.join(dir, "Crashpad"));
}
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {}); // окон нет и не будет

if (!process.send) app.quit(); // запустили не из программы — делать нечего
process.on("disconnect", () => app.quit());

// сообщения могут прийти раньше, чем Electron готов, — ждём его в цепочке
let chain = app.whenReady();
process.on("message", (req) => {
  if (!req || typeof req.file !== "string") return;
  // по одной: Windows всё равно делает их по очереди, а так ответы приходят по мере готовности
  chain = chain.then(async () => {
    let url = null;
    try {
      const img = await nativeImage.createThumbnailFromPath(path.normalize(req.file), { width: 320, height: 180 });
      if (!img.isEmpty()) url = img.toDataURL();
    } catch { /* Windows не смогла — программа возьмёт кадр через ffmpeg */ }
    if (process.connected) process.send({ id: req.id, url });
  });
});
