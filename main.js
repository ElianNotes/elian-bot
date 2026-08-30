// main.js — the Electron shell. Open = the scheduler runs; closed = nothing fires.

const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require("electron");
const path = require("node:path");
const engine = require("./engine");
const { validateCron, nextFire } = require("./cron");

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
const changed = () => { if (win && !win.isDestroyed()) win.webContents.send("changed"); };

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: "#141415",
    title: "ElianBot",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

// Auto-ping: a macOS notification for every finished run.
function pingFinished(job, status, code) {
  if (!Notification.isSupported()) return;
  new Notification({
    title: `ElianBot — ${job.name}`,
    body: status === "success" ? "Run finished: success" : `Run FAILED (exit ${code})`,
    silent: status === "success"
  }).show();
}

// @notify mention → a loud notification with the job's own words.
function notifyMention(job, text) {
  if (!Notification.isSupported()) return;
  new Notification({ title: `ElianBot — ${job.name}`, body: text }).show();
}

app.whenReady().then(async () => {
  await engine.boot(changed, pingFinished, notifyMention);
  createWindow();
});

app.on("second-instance", () => { if (win) { win.show(); win.focus(); } });
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => engine.shutdown());

ipcMain.handle("state", () => ({ root: engine.dataRoot(), jobs: engine.snapshot() }));
ipcMain.handle("messages", () => engine.getMessages());
ipcMain.handle("upcoming", (_e, days) => engine.upcoming(days));
ipcMain.handle("read-log", (_e, file) => engine.readLog(file));
ipcMain.handle("create", (_e, data) => engine.create(data));
ipcMain.handle("update", (_e, id, data) => engine.update(id, data));
ipcMain.handle("run", (_e, id, input) => engine.runNow(id, input));
ipcMain.handle("toggle", (_e, id) => engine.toggle(id));
ipcMain.handle("remove", (_e, id) => engine.remove(id));
ipcMain.handle("reveal", (_e, file) => shell.showItemInFolder(file));
ipcMain.handle("set-secret", (_e, id, value) => engine.setSecret(id, value));
ipcMain.handle("cron-info", (_e, expr) => {
  const v = validateCron(String(expr || ""));
  if (!v.ok) return { ok: false, reason: v.reason };
  const next = [];
  let t = new Date();
  for (let i = 0; i < 3; i++) { t = nextFire(String(expr), t); next.push(t.toISOString()); }
  return { ok: true, next };
});
ipcMain.handle("change-root", async () => {
  const r = await dialog.showOpenDialog(win, {
    title: "Choose the ElianBot data folder",
    buttonLabel: "Use this folder",
    properties: ["openDirectory", "createDirectory"]
  });
  if (r.canceled) return null;
  const res = await engine.relocate(r.filePaths[0]);
  changed();
  return res.root;
});
ipcMain.handle("pick-script", async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ["openFile"],
    filters: [{ name: "Shell script", extensions: ["sh"] }]
  });
  return r.canceled ? null : r.filePaths[0];
});
