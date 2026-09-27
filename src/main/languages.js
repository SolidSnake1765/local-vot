// Языки видео, которые понимает переводчик Яндекса (@vot.js/shared availableLangs, кроме русского:
// переводим на русский). «Живые голоса» — только с английского, и не с автоопределением.
export const SOURCE_LANGS = [
  { code: "auto", name: "Автоопределение" },
  { code: "en", name: "Английский" },
  { code: "de", name: "Немецкий" },
  { code: "fr", name: "Французский" },
  { code: "es", name: "Испанский" },
  { code: "it", name: "Итальянский" },
  { code: "ja", name: "Японский" },
  { code: "zh", name: "Китайский" },
  { code: "ko", name: "Корейский" },
  { code: "ar", name: "Арабский" },
];

export const LIVELY_LANG = "en";

// как назвать язык, который определил Яндекс (он может вернуть и не из списка выше)
const DETECTED = {
  en: "английский", de: "немецкий", fr: "французский", es: "испанский", it: "итальянский",
  ja: "японский", zh: "китайский", ko: "корейский", ar: "арабский", ru: "русский", kk: "казахский",
};

export const langName = (code) => SOURCE_LANGS.find((l) => l.code === code)?.name ?? code;
export const detectedName = (code) => DETECTED[code] ?? code;
