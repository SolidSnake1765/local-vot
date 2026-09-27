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

  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (patch) => ipcRenderer.invoke("settings:set", patch),
  pickVideos: () => ipcRenderer.invoke("dialog:pickVideos"),
  pickFolder: () => ipcRenderer.invoke("dialog:pickFolder"),

  addJobs: (files) => ipcRenderer.invoke("jobs:add", files),
  cancelJob: (id) => ipcRenderer.invoke("jobs:cancel", id),
  setJobVoice: (id, lively) => ipcRenderer.invoke("jobs:setVoice", id, lively),
  retranslate: (id) => ipcRenderer.invoke("jobs:retranslate", id),
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
