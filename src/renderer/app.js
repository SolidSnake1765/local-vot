// Интерфейс: перетаскивание видео, вход в Яндекс, очередь заданий, настройки.
const api = window.api;
// ошибки интерфейса — в журнал программы (иначе их никто не увидит)
window.addEventListener("error", (e) => api.logError(`${e.message} (${e.filename?.split("/").pop()}:${e.lineno})${e.error?.stack ? "\n" + e.error.stack : ""}`));
window.addEventListener("unhandledrejection", (e) => api.logError(`необработанная ошибка: ${e.reason?.stack ?? e.reason}`));
const $ = (id) => document.getElementById(id);

const STATE_LABEL = { idle: "Ожидает запуска", queued: "В очереди", running: "Идёт перевод", done: "Готово", error: "Ошибка", cancelled: "Отменено" };
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
    if (s.totalBytes) {
      text.append(` · Диск ${(s.usedBytes / 1024 ** 3).toFixed(1)} из ${(s.totalBytes / 1024 ** 3).toFixed(0)} ГБ`);
      const meter = document.createElement("span");
      meter.className = "disk-meter";
      meter.title = `Занято ${Math.round((s.usedBytes / s.totalBytes) * 100)}%`;
      const fill = document.createElement("i");
      fill.style.width = `${Math.min(100, (s.usedBytes / s.totalBytes) * 100)}%`;
      meter.append(fill);
      text.append(meter);
    }
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
  const { added, note, error } = await api.addJobs(paths);
  for (const job of added) createCard(job);
  updateCount();
  showAddNote(error || note, Boolean(error));
  // новые видео встают в конец списка — показываем их, чтобы не искать
  const fresh = added.map((j) => cards.get(j.id)?.node).filter(Boolean);
  fresh[0]?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  for (const node of fresh) {
    node.classList.add("fresh");
    setTimeout(() => node.classList.remove("fresh"), 1800);
  }
}

// итог добавления («пропущено: уже переведены…», «не подходит: …») — на время вместо подсказки
const ADD_HINT = $("addNote").textContent;
let addNoteTimer = null;
function showAddNote(text, isError = false) {
  clearTimeout(addNoteTimer);
  $("addNote").textContent = text || ADD_HINT;
  $("addNote").classList.toggle("added", Boolean(text) && !isError);
  $("addNote").classList.toggle("add-error", isError);
  if (text) addNoteTimer = setTimeout(() => showAddNote(""), isError ? 30_000 : 12_000);
}

const dz = $("dropzone");
dz.onclick = async () => addFiles(await api.pickVideos());
$("pickVideoFolder").onclick = async () => addFiles(await api.pickVideoFolder());
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
  node.dataset.id = job.id;
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
  node.querySelector(".job-start").onclick = () => api.startJob(job.id);
  node.querySelector(".job-retranslate").onclick = () => api.retranslate(job.id);
  node.querySelector(".job-remux").onclick = () => api.remux(job.id);

  // предпрослушивание: кусок звука с настройками этого видео, собирается за доли секунды
  const pos = node.querySelector(".preview-pos");
  const pTime = node.querySelector(".preview-time");
  const pPlay = node.querySelector(".preview-play");
  const pAudio = node.querySelector(".preview-audio");
  const pStatus = node.querySelector(".preview-status");
  pos.oninput = () => { pTime.textContent = fmtTime(Number(pos.value)); };
  let previewReq = 0; // ответ на устаревший запрос (ползунок уже сдвинули ещё раз) не проигрываем
  const playPreview = async () => {
    const req = ++previewReq;
    pStatus.textContent = "Готовим звук…";
    pPlay.disabled = true;
    const r = await api.preview(job.id, Number(pos.value));
    if (req !== previewReq) return;
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
  pPlay.onclick = playPreview;

  // звук этого видео: меняете ползунок — через полсекунды кусок сам звучит заново с того же места
  const snd = {
    orig: node.querySelector(".snd-orig"), origVal: node.querySelector(".snd-orig-val"),
    voice: node.querySelector(".snd-voice"), voiceVal: node.querySelector(".snd-voice-val"),
    auto: node.querySelector(".snd-auto"), modes: [...node.querySelectorAll(".snd-mode")],
  };
  let replayTimer = null;
  const changeSound = (patch) => {
    card.sound = { ...card.sound, ...patch };
    api.setJobSound(job.id, patch);
    renderSound(card);
    clearTimeout(replayTimer);
    replayTimer = setTimeout(playPreview, 450);
  };
  snd.orig.oninput = () => { snd.origVal.textContent = `${snd.orig.value} %`; };
  snd.orig.onchange = () => changeSound({ originalVolume: Number(snd.orig.value) });
  snd.voice.oninput = () => { snd.voiceVal.textContent = `${Math.round(snd.voice.value * 100)} %`; };
  snd.voice.onchange = () => changeSound({ voiceGain: Number(snd.voice.value) });
  snd.auto.onchange = () => changeSound({ autoLevel: snd.auto.checked });
  for (const b of snd.modes) {
    b.onclick = () => { if (card.sound?.mixMode !== b.dataset.mode) changeSound({ mixMode: b.dataset.mode }); };
  }
  node.querySelector(".snd-save").onclick = () => api.remux(job.id);
  const remove = async () => {
    if (await api.removeJob(job.id)) dropCard(card);
  };
  node.querySelector(".job-remove").onclick = remove;
  node.querySelector(".job-drop").onclick = remove;
  setupDrag(card);

  $("emptyHint").hidden = true;
  $("jobs").append(node);
  cards.set(job.id, card);
  setState(card, job.state);
  for (const u of early.get(job.id) ?? []) applyUpdate(card, u);
  early.delete(job.id);
}

function setState(card, state) {
  card.state = state;
  card.node.dataset.state = state;
  const badge = card.node.querySelector(".badge");
  badge.textContent = STATE_LABEL[state] ?? state;
  badge.className = `badge ${state}`;
  const active = ["queued", "running"].includes(state);
  card.node.querySelector(".job-cancel").hidden = !active;
  card.node.querySelector(".job-start").hidden = state !== "idle";
  card.node.querySelector(".job-drop").hidden = state !== "idle";
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
  card.sound = info.sound;
  card.savedSound = info.savedSound;
  renderSound(card);
}

const sameSound = (a, b) => a.mixMode === b.mixMode && a.originalVolume === b.originalVolume
  && Math.abs(a.voiceGain - b.voiceGain) < 0.001 && a.autoLevel === b.autoLevel;

/** Ползунки звука — по настройкам видео; «Звук изменён», если он отличается от сохранённого в файлах. */
function renderSound(card) {
  const s = card.sound;
  if (!s) return;
  const q = (sel) => card.node.querySelector(sel);
  q(".snd-orig").value = String(s.originalVolume);
  q(".snd-orig-val").textContent = `${s.originalVolume} %`;
  q(".snd-voice").value = String(s.voiceGain);
  q(".snd-voice-val").textContent = `${Math.round(s.voiceGain * 100)} %`;
  q(".snd-auto").checked = Boolean(s.autoLevel);
  for (const b of card.node.querySelectorAll(".snd-mode")) {
    b.classList.toggle("on", b.dataset.mode === s.mixMode);
    b.setAttribute("aria-pressed", String(b.dataset.mode === s.mixMode));
  }
  q(".snd-orig").title = s.mixMode === "constant" ? "Громкость оригинала всё время" : "Громкость оригинала, пока звучит перевод";
  q(".sound-dirty").hidden = !card.savedSound || sameSound(s, card.savedSound);
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
    hint.textContent = card.state === "done"
      ? "Новый запрос к Яндексу — иногда второй перевод выходит лучше. Прежняя версия уйдёт в Корзину"
      : "";
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

/** Все файлы видео (главный процесс присылает полный список: прежняя версия могла уйти в Корзину). */
function showOutputs(card, outputs) {
  const box = card.node.querySelector(".outputs");
  box.replaceChildren();
  box.hidden = !outputs.length;
  for (const p of outputs) {
    const row = document.createElement("div");
    row.className = "output";
    const fileName = p.split(/[\\/]/).pop();
    const ext = document.createElement("span");
    ext.className = "ext";
    ext.textContent = (fileName.match(/\.([^.]+)$/)?.[1] ?? "").toUpperCase();
    const name = document.createElement("span");
    name.className = "file";
    name.textContent = fileName;
    name.title = p;
    const btn = document.createElement("button");
    btn.className = "btn btn-small btn-ghost";
    btn.textContent = "Показать в папке";
    btn.onclick = () => api.showItem(p);
    row.append(ext, name, btn);
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
  if (u.note !== undefined) {
    const el = card.node.querySelector(".job-note");
    el.textContent = u.note;
    el.hidden = !u.note;
  }
  if (u.error) {
    const el = card.node.querySelector(".job-error");
    el.textContent = u.error;
    el.hidden = false;
  }
  updateCount();
}

/** Шапка очереди: сколько видео и в каком они состоянии, полоса готовности, какие кнопки нужны. */
function updateCount() {
  const list = [...cards.values()];
  const count = (...states) => list.filter((c) => states.includes(c.state)).length;
  const total = list.length;
  const done = count("done");
  const parts = [
    ["run", count("running"), "в работе"],
    ["wait", count("queued"), "в очереди"],
    ["idle", count("idle"), "ждут запуска"],
    ["err", count("error"), "с ошибкой"],
    ["off", count("cancelled"), "отменено"],
  ].filter(([, n]) => n > 0);
  const stats = $("queueStats");
  stats.hidden = total === 0;
  stats.replaceChildren();
  const main = document.createElement("span");
  main.className = "qs-main";
  main.innerHTML = `<b></b> из <b></b> готово`;
  main.children[0].textContent = done;
  main.children[1].textContent = total;
  stats.append(main);
  for (const [kind, n, label] of parts) {
    const chip = document.createElement("span");
    chip.className = `qs-chip ${kind}`;
    chip.textContent = `${n} ${label}`;
    stats.append(chip);
  }
  // полоса: готово (зелёный) · в работе (переливается) · с ошибкой (красный); остальное — ещё впереди
  const bar = $("queueProgress");
  bar.hidden = total === 0;
  const width = (n) => `${total ? (n / total) * 100 : 0}%`;
  bar.querySelector(".qp-seg.done").style.width = width(done);
  bar.querySelector(".qp-seg.run").style.width = width(count("running"));
  bar.querySelector(".qp-seg.err").style.width = width(count("error"));
  $("queuePct").textContent = `${total ? Math.round((done / total) * 100) : 0}%`;

  const idle = count("idle");
  $("startAll").hidden = idle === 0;
  $("startAll").textContent = idle > 1 ? `▶ Запустить все (${idle})` : "▶ Запустить";
  $("cancelAll").hidden = count("queued", "running") === 0;
  $("clearList").hidden = !list.some((c) => c.state !== "running");
}
$("startAll").onclick = () => api.startAll();
$("clearList").onclick = async () => {
  const info = await api.clearInfo();
  if (!info.all) return;
  const buttons = [{ label: `Убрать все (${info.all})`, value: "all", kind: "danger" }];
  if (info.done && info.done < info.all) buttons.push({ label: `Только готовые (${info.done})`, value: "done", kind: "primary" });
  buttons.push({ label: "Отмена", value: null, kind: "ghost" });
  const mode = await askUser({
    title: "Очистить список?",
    text: (info.running ? "Видео, которые переводятся прямо сейчас, останутся. " : "")
      + "Файлы на компьютере не удаляются. Копии этих видео на Яндекс Диске и полученные переводы удалятся — "
      + "«Пересобрать видео» для них будет недоступно.",
    buttons,
  });
  if (!mode) return;
  for (const id of await api.clearJobs(mode)) {
    const card = cards.get(id);
    if (card) dropCard(card);
  }
};
$("cancelAll").onclick = async () => {
  const list = [...cards.values()];
  const runningNow = list.filter((c) => c.state === "running").length;
  const waiting = list.filter((c) => c.state === "queued").length;
  const ok = await askUser({
    title: "Отменить все переводы?",
    text: [runningNow ? `Переводятся сейчас: ${runningNow}.` : "", waiting ? `В очереди: ${waiting}.` : "",
      "Видео останутся в списке — их можно будет запустить снова. Уже сохранённые файлы не пострадают."]
      .filter(Boolean).join(" "),
    buttons: [{ label: "Отменить все", value: true, kind: "danger" }, { label: "Не отменять", value: null, kind: "ghost" }],
  });
  if (ok) api.cancelAll();
};
$("testNotification").onclick = async () => {
  const shown = await api.testNotification();
  if (!shown) showAddNote("Windows не показала уведомление — подробности в журнале («Папка логов»)", true);
};

/**
 * Вопрос с вариантами ответа в оформлении программы (вместо системного окна Windows).
 * buttons: [{ label, value, kind: "danger" | "primary" | "ghost" }]; Esc и клик мимо — null.
 */
function askUser({ title, text, buttons }) {
  const modal = $("askModal");
  $("askTitle").textContent = title;
  $("askText").textContent = text;
  const box = $("askBtns");
  box.replaceChildren();
  return new Promise((resolve) => {
    const finish = (value) => {
      modal.hidden = true;
      document.removeEventListener("keydown", onKey);
      modal.onclick = null;
      resolve(value);
    };
    const onKey = (e) => { if (e.key === "Escape") finish(null); };
    for (const b of buttons) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `btn ${b.kind === "ghost" ? "btn-ghost" : b.kind === "danger" ? "btn-danger" : ""}`;
      btn.textContent = b.label;
      btn.onclick = () => finish(b.value);
      box.append(btn);
    }
    modal.onclick = (e) => { if (e.target === modal) finish(null); };
    document.addEventListener("keydown", onKey);
    modal.hidden = false;
    box.lastElementChild?.focus(); // по умолчанию — безопасный вариант (последний: «Отмена»)
  });
}

/** Карточку — из списка (видео уже убрано в главном процессе). */
function dropCard(card) {
  if (card.previewUrl) URL.revokeObjectURL(card.previewUrl);
  card.node.remove();
  cards.delete(card.id);
  $("emptyHint").hidden = cards.size > 0;
  updateCount();
}

// ---------- порядок очереди: карточки перетаскиваются за ручку слева от названия ----------
let dragged = null;
function setupDrag(card) {
  const { node } = card;
  const handle = node.querySelector(".drag-handle");
  // тянется только за ручку: иначе мешало бы выделять текст и двигать ползунки
  handle.addEventListener("pointerdown", () => { node.draggable = true; });
  node.addEventListener("pointerup", () => { node.draggable = false; });
  node.addEventListener("dragstart", (e) => {
    dragged = node;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", card.id);
    requestAnimationFrame(() => node.classList.add("dragging"));
  });
  node.addEventListener("dragend", () => {
    node.draggable = false;
    node.classList.remove("dragging");
    dragged = null;
    api.reorderJobs([...$("jobs").querySelectorAll(".job")].map((el) => el.dataset.id));
  });
}
// карточка встаёт перед той, над верхней половиной которой курсор, иначе — после
$("jobs").addEventListener("dragover", (e) => {
  if (!dragged) return;
  e.preventDefault();
  const over = e.target.closest(".job");
  if (!over || over === dragged) return;
  const box = over.getBoundingClientRect();
  over[e.clientY < box.top + box.height / 2 ? "before" : "after"](dragged);
});

// ---------- настройки ----------
function renderFolder(dir) {
  $("outputDir").textContent = dir || "Рядом с исходным видео";
  $("resetFolder").hidden = !dir;
}

async function initSettings() {
  fillLangSelect($("settingsLang"));
  for (const n of [1, 2, 3, 4, 5, 6, 8]) {
    const opt = document.createElement("option");
    opt.value = String(n);
    opt.textContent = n === 1 ? "1 видео — по очереди" : `${n} видео`;
    $("parallelJobs").append(opt);
  }
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
    : "В паузах перевода оригинал звучит в полную громкость.");
  const saveVideo = document.querySelector('[data-setting="saveVideo"]').checked;
  document.querySelector('[data-setting="embedSubs"]').disabled = !saveVideo;
  $("videoFormat").disabled = !saveVideo;
  $("videoFormatNote").textContent = $("videoFormat").value === "mkv"
    ? "MKV принимает любое видео, звук и субтитры."
    : "MP4 останется MP4, AVI — AVI и т. д. Если формат не справится (например, FLV), сохраним в MKV и напишем почему. В AVI, WMV, TS, MPG, OGV субтитры не встраиваются — лягут файлом рядом.";
  $("saveNone").hidden = ["saveVideo", "saveAudio", "saveVoice", "saveSubs"]
    .some((k) => document.querySelector(`[data-setting="${k}"]`).checked);

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
$("appVersion").textContent = `v${info.version}${info.portable ? " · портативная" : ""}`;
$("repoBtn").hidden = !info.repoUrl;
$("repoBtn").onclick = () => api.openRepo();
$("openLogs").onclick = () => api.openLogs();
$("dzFormats").textContent = info.videoExt.map((e) => e.toUpperCase()).join(", ");
await initSettings();
await refreshAccount();
