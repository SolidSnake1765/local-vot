// Интерфейс: перетаскивание видео, вход в Яндекс, очередь заданий, настройки.
const api = window.api;
const $ = (id) => document.getElementById(id);

const STATE_LABEL = { queued: "В очереди", running: "Идёт перевод", done: "Готово", error: "Ошибка", cancelled: "Отменено" };
let STEPS = [];
let loggedIn = false;
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
  const card = { id: job.id, node, steps, state: job.state, lively: job.lively, voiceUsed: job.voiceUsed ?? null };

  const toggle = node.querySelector(".job-lively");
  toggle.checked = Boolean(job.lively);
  toggle.onchange = () => {
    card.lively = toggle.checked;
    api.setJobVoice(job.id, card.lively);
    refreshActions(card);
  };
  node.querySelector(".job-cancel").onclick = () => api.cancelJob(job.id);
  node.querySelector(".job-retranslate").onclick = () => api.retranslate(job.id);
  node.querySelector(".job-remove").onclick = async () => {
    if (await api.removeJob(job.id)) {
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
  // пока идёт перевод, голос уже выбран — переключатель заморожен
  card.node.querySelector(".job-lively").disabled = state === "running";
  refreshActions(card);
}

/**
 * Кнопка у готового видео: тот же голос — «Перевести заново» (ещё один запрос, вдруг выйдет лучше);
 * голос переключили после перевода — «Пересоздать» другим голосом.
 */
function refreshActions(card) {
  const finished = ["done", "error", "cancelled"].includes(card.state);
  card.node.querySelector(".job-actions").hidden = !finished;
  if (!finished) return;
  const btn = card.node.querySelector(".job-retranslate");
  const hint = card.node.querySelector(".job-hint");
  const voiceChanged = card.state === "done" && card.voiceUsed !== null && card.lively !== card.voiceUsed;
  if (voiceChanged) {
    btn.textContent = `Пересоздать: ${card.lively ? "живые" : "обычные"} голоса`;
    hint.textContent = "";
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
  const s = await api.getSettings();
  for (const el of document.querySelectorAll("[data-setting]")) {
    const key = el.dataset.setting;
    if (el.type === "checkbox") el.checked = Boolean(s[key]);
    else el.value = s[key];
    el.addEventListener("change", () => {
      const value = el.type === "checkbox" ? el.checked : el.type === "range" ? Number(el.value) : el.value;
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
  const saveVideo = document.querySelector('[data-setting="saveVideo"]').checked;
  document.querySelector('[data-setting="embedSubs"]').disabled = !saveVideo;
}

$("pickFolder").onclick = async () => {
  const dir = await api.pickFolder();
  if (dir) renderFolder((await api.setSettings({ outputDir: dir })).outputDir);
};
$("resetFolder").onclick = async () => renderFolder((await api.setSettings({ outputDir: "" })).outputDir);

// ---------- старт ----------
const info = await api.info();
STEPS = info.steps;
await initSettings();
await refreshAccount();
