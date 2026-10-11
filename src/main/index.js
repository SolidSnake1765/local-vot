// Точка входа. Обычный запуск — программа (main.js). С ключом --thumbs-helper — скрытый помощник,
// который делает миниатюры видео (thumbs-helper.js): Windows делает их, занимая поток целиком,
// и в самой программе это подвешивало бы окно.
if (process.argv.includes("--thumbs-helper")) await import("./thumbs-helper.js");
else await import("./main.js");
