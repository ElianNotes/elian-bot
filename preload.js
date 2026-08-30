const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("elianBot", {
  state: () => ipcRenderer.invoke("state"),
  messages: () => ipcRenderer.invoke("messages"),
  upcoming: (days) => ipcRenderer.invoke("upcoming", days),
  readLog: (file) => ipcRenderer.invoke("read-log", file),
  create: (data) => ipcRenderer.invoke("create", data),
  update: (id, data) => ipcRenderer.invoke("update", id, data),
  run: (id, input) => ipcRenderer.invoke("run", id, input),
  toggle: (id) => ipcRenderer.invoke("toggle", id),
  remove: (id) => ipcRenderer.invoke("remove", id),
  reveal: (file) => ipcRenderer.invoke("reveal", file),
  pickScript: () => ipcRenderer.invoke("pick-script"),
  changeRoot: () => ipcRenderer.invoke("change-root"),
  setSecret: (id, value) => ipcRenderer.invoke("set-secret", id, value),
  cronInfo: (expr) => ipcRenderer.invoke("cron-info", expr),
  onChanged: (fn) => ipcRenderer.on("changed", fn)
});
