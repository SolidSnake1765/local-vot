// Мост между интерфейсом и главным процессом: интерфейс не имеет доступа к Node.js,
// только к этим функциям.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

const EVENTS = ["auth:code", "job:update"];

contextBridge.exposeInMainWorld("api", {
  info: () => ipcRenderer.invoke("app:info"),

  authStatus: () => ipcRenderer.invoke("auth:status"),
  login: () => ipcRenderer.invoke("auth:login"),
  cancelLogin: () => ipcRenderer.invoke("auth:cancel"),
  logout: () => ipcRenderer.invoke("auth:logout"),
  openPage: (url) => ipcRenderer.invoke("auth:openPage", url),
  openRepo: () => ipcRenderer.invoke("app:openRepo"),
  openLogs: () => ipcRenderer.invoke("app:openLogs"),
  logError: (message) => ipcRenderer.invoke("log:renderer", message),

  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (patch) => ipcRenderer.invoke("settings:set", patch),
  pickVideos: () => ipcRenderer.invoke("dialog:pickVideos"),
  pickVideoFolder: () => ipcRenderer.invoke("dialog:pickVideoFolder"),
  pickFolder: () => ipcRenderer.invoke("dialog:pickFolder"),

  addJobs: (files) => ipcRenderer.invoke("jobs:add", files),
  cancelJob: (id) => ipcRenderer.invoke("jobs:cancel", id),
  startJob: (id) => ipcRenderer.invoke("jobs:start", id),
  startAll: () => ipcRenderer.invoke("jobs:startAll"),
  reorderJobs: (ids) => ipcRenderer.invoke("jobs:reorder", ids),
  setJobVoice: (id, lively) => ipcRenderer.invoke("jobs:setVoice", id, lively),
  setJobLang: (id, lang) => ipcRenderer.invoke("jobs:setLang", id, lang),
  retranslate: (id) => ipcRenderer.invoke("jobs:retranslate", id),
  remux: (id) => ipcRenderer.invoke("jobs:remux", id),
  setJobSound: (id, patch) => ipcRenderer.invoke("jobs:setSound", id, patch),
  preview: (id, start) => ipcRenderer.invoke("jobs:preview", id, start),
  removeJob: (id) => ipcRenderer.invoke("jobs:remove", id),
  showItem: (p) => ipcRenderer.invoke("shell:showItem", p),

  // путь к файлу, брошенному в окно (с Electron 32 File.path больше нет)
  pathForFile: (file) => webUtils.getPathForFile(file),

  on(channel, callback) {
    if (!EVENTS.includes(channel)) return () => {};
    const handler = (_e, data) => callback(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
