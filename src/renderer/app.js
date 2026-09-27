// Интерфейс: перетаскивание видео, вход в Яндекс, очередь заданий, настройки.
const api = window.api;
const $ = (id) => document.getElementById(id);

const STATE_LABEL = { queued: "В очереди", running: "Идёт перевод", done: "Готово", error: "Ошибка", cancelled: "Отменено" };
let STEPS = [];
let LANGS = [];
let LIVELY_LANG = "en";
let loggedIn = false;
const langName = (code) => LANGS.find((l) => l.code === code)?.name ?? code;

const fmtTime = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};

function fillLangSelect(select) {
  for (const l of LANGS) {
    const opt = document.createElement("option");
    opt.value = l.code;
    opt.textContent = l.name;
    select.append(opt);
  }
}
const cards = new Map(); // id задания → элементы карточки
// задание стартует сразу после добавления, и первые события могут прийти раньше, чем появится карточка
const early = new Map(); // id → события, ждущие своей карточки

// ---------- вход в Яндекс ----------
async function refreshAccount() {
  const s = await api.authStatus();
  loggedIn = s.loggedIn;
  const text = $("accountText");
  const btn = $("accountBtn");
  btn.hidden = false;
  if (s.loggedIn) {
    text.textContent = "";
    text.append("Яндекс: ");
    const b = document.createElement("b");
    b.textContent = s.name;
    text.append(b);
    if (s.totalBytes) text.append(` · Диск ${(s.usedBytes / 1024 ** 3).toFixed(1)} из ${(s.totalBytes / 1024 ** 3).toFixed(0)} ГБ`);
    btn.textContent = "Выйти";
  } else {
    text.textContent = "Для перевода нужен вход в Яндекс";
    btn.textContent = "Войти через Яндекс";
  }
}

async function startLogin() {
  $("loginModal").hidden = false;
  $("loginWait").hidden = false;
  $("loginCode").hidden = true;
  $("loginError").hidden = true;
  const r = await api.login();
  if (r.ok) {
    $("loginModal").hidden = true;
    await refreshAccount();
  } else if (!/отменён/i.test(r.error)) {
    $("loginWait").hidden = true;
    $("loginError").textContent = r.error;
    $("loginError").hidden = false;
  } else {
    $("loginModal").hidden = true;
  }
}

let codeUrl = "";
api.on("auth:code", ({ userCode, url }) => {
  codeUrl = url;
  $("codeText").textContent = userCode;
  $("loginWait").hidden = true;
  $("loginCode").hidden = false;
});
$("openCodePage").onclick = () => api.openPage(codeUrl);
$("copyCode").onclick = () => navigator.clipboard.writeText($("codeText").textContent);
$("loginCancel").onclick = () => { api.cancelLogin(); $("loginModal").hidden = true; };
$("accountBtn").onclick = async () => {
  if (loggedIn) {
    await api.logout();
    await refreshAccount();
  } else {
    startLogin();
  }
};

// ---------- добавление видео ----------
async function addFiles(paths) {
  if (!paths.length) return;
  if (!loggedIn) {
    startLogin();
    return;
  }
  const added = await api.addJobs(paths);
  for (const job of added) createCard(job);
  updateCount();
}

const dz = $("dropzone");
dz.onclick = async () => addFiles(await api.pickVideos());
// брошенный мимо зоны файл не должен никуда уходить
for (const ev of ["dragover", "drop"]) document.addEventListener(ev, (e) => e.preventDefault());
dz.addEventListener("dragenter", () => dz.classList.add("over"));
dz.addEventListener("dragleave", () => dz.classList.remove("over"));
dz.addEventListener("drop", (e) => {
  dz.classList.remove("over");
  addFiles([...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean));
});

// ---------- карточки заданий ----------
function createCard(job) {
  const node = $("jobTpl").content.firstElementChild.cloneNode(true);
  node.querySelector(".job-name").textContent = job.name;
  node.querySelector(".job-name").title = job.file;
  const steps = {};
  const ol = node.querySelector(".steps");
  for (const s of STEPS) {
    const li = document.createElement("li");
    li.className = "step";
    li.innerHTML = '<span class="mark"></span><div><div class="step-title"></div><div class="step-detail"></div><div class="bar" hidden><i></i></div></div>';
    li.querySelector(".step-title").textContent = s.title;
    ol.append(li);
    steps[s.id] = li;
  }
  const card = { id: job.id, node, steps, state: job.state, lively: job.lively, lang: job.lang,
    voiceUsed: job.voiceUsed ?? null, langUsed: job.langUsed ?? null };

  // живые голоса — только с английского: тумблер и язык подстраивают друг друга
  const toggle = node.querySelector(".job-lively");
  const langSelect = node.querySelector(".job-lang");
  const note = node.querySelector(".job-note");
  const showNote = (text) => { note.textContent = text; note.hidden = !text; };
  fillLangSelect(langSelect);
  toggle.checked = Boolean(job.lively);
  langSelect.value = job.lang;
  toggle.onchange = () => {
    card.lively = toggle.checked;
    api.setJobVoice(job.id, card.lively);
    if (card.lively && card.lang !== LIVELY_LANG) {
      card.lang = LIVELY_LANG;
      langSelect.value = LIVELY_LANG;
      api.setJobLang(job.id, LIVELY_LANG);
      showNote("Язык переключён на английский — живые голоса работают только с ним.");
    } else {
      showNote("");
    }
    refreshActions(card);
  };
  langSelect.onchange = () => {
    card.lang = langSelect.value;
    api.setJobLang(job.id, card.lang);
    if (card.lively && card.lang !== LIVELY_LANG) {
      card.lively = false;
      toggle.checked = false;
      api.setJobVoice(job.id, false);
      showNote("Живые голоса выключены — они работают только с английским.");
    } else {
      showNote("");
    }
    refreshActions(card);
  };
  node.querySelector(".job-cancel").onclick = () => api.cancelJob(job.id);
  node.querySelector(".job-retranslate").onclick = () => api.retranslate(job.id);
  node.querySelector(".job-remux").onclick = () => api.remux(job.id);

  // предпрослушивание: кусок звука с текущими настройками, собирается за доли секунды
  const pos = node.querySelector(".preview-pos");
  const pTime = node.querySelector(".preview-time");
  const pPlay = node.querySelector(".preview-play");
  const pAudio = node.querySelector(".preview-audio");
  const pStatus = node.querySelector(".preview-status");
  pos.oninput = () => { pTime.textContent = fmtTime(Number(pos.value)); };
  pPlay.onclick = async () => {
    pStatus.classList.remove("stale");
    pStatus.textContent = "Готовим звук…";
    pPlay.disabled = true;
    const r = await api.preview(job.id, Number(pos.value));
    pPlay.disabled = false;
    if (!r.ok) {
      pStatus.textContent = r.error;
      return;
    }
    if (card.previewUrl) URL.revokeObjectURL(card.previewUrl);
    card.previewUrl = URL.createObjectURL(new Blob([r.data], { type: "audio/mp4" }));
    pAudio.src = card.previewUrl;
    pAudio.hidden = false;
    pAudio.play();
    pStatus.textContent = `${fmtTime(r.start)}–${fmtTime(r.start + 20)} · ${r.note}`;
  };
  node.querySelector(".job-remove").onclick = async () => {
    if (await api.removeJob(job.id)) {
      if (card.previewUrl) URL.revokeObjectURL(card.previewUrl);
      node.remove();
      cards.delete(job.id);
      $("emptyHint").hidden = cards.size > 0;
      updateCount();
    }
  };

  $("emptyHint").hidden = true;
  $("jobs").prepend(node);
  cards.set(job.id, card);
  setState(card, job.state);
  for (const u of early.get(job.id) ?? []) applyUpdate(card, u);
  early.delete(job.id);
}

function setState(card, state) {
  card.state = state;
  const badge = card.node.querySelector(".badge");
  badge.textContent = STATE_LABEL[state] ?? state;
  badge.className = `badge ${state}`;
  const active = ["queued", "running"].includes(state);
  card.node.querySelector(".job-cancel").hidden = !active;
  // пока идёт перевод, голос и язык уже выбраны — переключатели заморожены
  card.node.querySelector(".job-lively").disabled = state === "running";
  card.node.querySelector(".job-lang").disabled = state === "running";
  if (state === "running") card.node.querySelector(".job-note").hidden = true;
  // пока видео переводится или пересобирается заново, слушать нечего — прячем
  if (active) {
    card.node.querySelector(".preview").hidden = true;
    card.node.querySelector(".preview-audio").pause();
  }
  refreshActions(card);
}

/** Показать блок прослушивания: ползунок по длине видео, по умолчанию — с первой фразы перевода. */
function setupPreview(card, info) {
  const box = card.node.querySelector(".preview");
  if (!info) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const pos = box.querySelector(".preview-pos");
  const maxStart = Math.max(0, Math.floor(info.duration - info.length));
  pos.max = String(maxStart);
  if (!card.previewPlaced) {
    pos.value = String(Math.min(maxStart, Math.floor(info.start)));
    card.previewPlaced = true;
  }
  box.querySelector(".preview-time").textContent = fmtTime(Number(pos.value));
}

/** Настройки звука поменялись — прослушанный кусок уже не соответствует им. */
function markPreviewsStale() {
  for (const card of cards.values()) {
    if (!card.previewUrl) continue;
    const st = card.node.querySelector(".preview-status");
    st.textContent = "Настройки звука изменились — нажмите «▶ 20 секунд», чтобы послушать заново";
    st.classList.add("stale");
  }
}

/**
 * Кнопка у готового видео: те же голос и язык — «Перевести заново» (ещё один запрос, вдруг выйдет
 * лучше); голос или язык поменяли после перевода — «Пересоздать» с новыми.
 */
function refreshActions(card) {
  const finished = ["done", "error", "cancelled"].includes(card.state);
  card.node.querySelector(".job-actions").hidden = !finished;
  if (!finished) return;
  card.node.querySelector(".job-remux-row").hidden = !card.hasTranslation;
  const btn = card.node.querySelector(".job-retranslate");
  const hint = card.node.querySelector(".job-hint");
  const done = card.state === "done" && card.voiceUsed !== null;
  const voiceChanged = done && card.lively !== card.voiceUsed;
  const langChanged = done && card.langUsed !== null && card.lang !== card.langUsed;
  if (voiceChanged || langChanged) {
    const parts = [`${card.lively ? "живые" : "обычные"} голоса`];
    if (langChanged) parts.push(langName(card.lang).toLowerCase());
    btn.textContent = `Пересоздать: ${parts.join(" · ")}`;
    hint.textContent = "Новый перевод с выбранными голосом и языком, прежний файл останется";
  } else {
    btn.textContent = card.state === "done" ? "Перевести заново" : "Попробовать снова";
    hint.textContent = card.state === "done" ? "Новый запрос к Яндексу — иногда второй перевод выходит лучше" : "";
  }
}

/** Повторный запуск: шаги снова «не начаты», прежние результаты остаются в списке. */
function resetSteps(card) {
  for (const li of Object.values(card.steps)) {
    li.classList.remove("active", "done", "error");
    li.querySelector(".step-detail").textContent = "";
    li.querySelector(".bar").hidden = true;
  }
  card.node.querySelector(".job-error").hidden = true;
}

function updateStep(card, { step, state, progress, detail }) {
  const li = card.steps[step];
  if (!li) return;
  if (state) {
    li.classList.remove("active", "done", "error");
    li.classList.add(state);
  }
  if (detail !== undefined) li.querySelector(".step-detail").textContent = detail;
  const bar = li.querySelector(".bar");
  if (progress !== undefined && li.classList.contains("active")) {
    bar.hidden = false;
    bar.firstElementChild.style.width = `${Math.round(progress * 100)}%`;
  }
  if (state && state !== "active") bar.hidden = true;
}

function showOutputs(card, outputs) {
  const box = card.node.querySelector(".outputs");
  box.hidden = !outputs.length;
  for (const p of outputs) {
    const row = document.createElement("div");
    row.className = "output";
    const name = document.createElement("span");
    name.textContent = p.split(/[\\/]/).pop();
    name.title = p;
    const btn = document.createElement("button");
    btn.className = "btn btn-small btn-ghost";
    btn.textContent = "Показать в папке";
    btn.onclick = () => api.showItem(p);
    row.append(name, btn);
    box.append(row);
  }
}

api.on("job:update", (u) => {
  const card = cards.get(u.id);
  if (!card) {
    early.set(u.id, [...(early.get(u.id) ?? []), u]);
    return;
  }
  applyUpdate(card, u);
});

function applyUpdate(card, u) {
  if (u.reset) resetSteps(card);
  if (u.voiceUsed !== undefined) card.voiceUsed = u.voiceUsed;
  if (u.langUsed !== undefined) card.langUsed = u.langUsed;
  if (u.hasTranslation !== undefined) card.hasTranslation = u.hasTranslation;
  if (u.preview !== undefined && !["queued", "running"].includes(u.state)) setupPreview(card, u.preview);
  if (u.state && !u.step) setState(card, u.state);
  if (u.step) updateStep(card, u);
  if (u.outputs) showOutputs(card, u.outputs);
  if (u.error) {
    const el = card.node.querySelector(".job-error");
    el.textContent = u.error;
    el.hidden = false;
  }
  updateCount();
}

function updateCount() {
  const n = cards.size;
  $("jobsCount").textContent = n ? `${n} видео` : "";
}

// ---------- настройки ----------
function renderFolder(dir) {
  $("outputDir").textContent = dir || "Рядом с исходным видео";
  $("resetFolder").hidden = !dir;
}

async function initSettings() {
  fillLangSelect($("settingsLang"));
  for (let v = 0; v <= 100; v += 10) {
    const opt = document.createElement("option");
    opt.value = String(v);
    opt.textContent = v === 0 ? "0% — выключить" : v === 100 ? "100% — как в оригинале" : `${v}%`;
    $("originalVolume").append(opt);
  }
  const s = await api.getSettings();
  for (const el of document.querySelectorAll("[data-setting]")) {
    const key = el.dataset.setting;
    if (el.type === "checkbox") el.checked = Boolean(s[key]);
    else el.value = String(s[key]);
    el.addEventListener("change", () => {
      const numeric = el.type === "range" || el.dataset.type === "number";
      const value = el.type === "checkbox" ? el.checked : numeric ? Number(el.value) : el.value;
      api.setSettings({ [key]: value });
      syncDependent();
      if (["mixMode", "originalVolume", "voiceGain", "autoLevel"].includes(key)) markPreviewsStale();
    });
    if (el.type === "range") el.addEventListener("input", syncDependent);
  }
  renderFolder(s.outputDir);
  syncDependent();
}

function syncDependent() {
  const gain = document.querySelector('[data-setting="voiceGain"]').value;
  $("voiceGainVal").textContent = `${Math.round(gain * 100)}%`;
  const constant = $("mixMode").value === "constant";
  $("originalVolumeLabel").textContent = constant ? "Громкость оригинала — всё время" : "Громкость оригинала — пока звучит перевод";
  $("mixNote").textContent = (constant
    ? "Оригинал и перевод звучат на заданных уровнях всё время."
    : "В паузах перевода оригинал звучит в полную громкость.")
    + " Чтобы применить к готовому видео, нажмите в карточке «Пересобрать видео».";
  const saveVideo = document.querySelector('[data-setting="saveVideo"]').checked;
  document.querySelector('[data-setting="embedSubs"]').disabled = !saveVideo;

  // с живыми голосами язык всегда английский: показываем его, а сохранённый выбор
  // (для видео без живых голосов) возвращаем, когда их выключат
  const lively = document.querySelector('[data-setting="livelyVoice"]').checked;
  const langSel = $("settingsLang");
  if (lively && !langSel.disabled) {
    langSel.dataset.saved = langSel.value;
    langSel.value = LIVELY_LANG;
    langSel.disabled = true;
  } else if (!lively && langSel.disabled) {
    langSel.value = langSel.dataset.saved ?? "auto";
    langSel.disabled = false;
  }
}

$("pickFolder").onclick = async () => {
  const dir = await api.pickFolder();
  if (dir) renderFolder((await api.setSettings({ outputDir: dir })).outputDir);
};
$("resetFolder").onclick = async () => renderFolder((await api.setSettings({ outputDir: "" })).outputDir);

// ---------- старт ----------
const info = await api.info();
STEPS = info.steps;
LANGS = info.languages;
LIVELY_LANG = info.livelyLang;
await initSettings();
await refreshAccount();
