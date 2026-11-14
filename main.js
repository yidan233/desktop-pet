/* main.js —— Electron 主进程:一个覆盖工作区的透明、置顶、鼠标穿透窗口 + 托盘 + 右键菜单。 */
const { app, BrowserWindow, Tray, Menu, screen, ipcMain, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const PETS_DIR = path.join(__dirname, 'assets', 'pets');
const SCALES = [['小', 0.8], ['中', 1], ['大', 1.35]];
let win = null, tray = null, kinds = {}, prefs = { scale: 1, pets: [] };
const prefsFile = () => path.join(app.getPath('userData'), 'prefs.json');

if (!app.requestSingleInstanceLock()) { app.quit(); }

function scanPets() {
  const out = {};
  if (!fs.existsSync(PETS_DIR)) return out;
  for (const dir of fs.readdirSync(PETS_DIR)) {
    const f = path.join(PETS_DIR, dir, 'pet.json');
    if (!fs.existsSync(f)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(f, 'utf8'));
      m.id = m.id || dir; m.baseUrl = '../assets/pets/' + dir + '/';
      out[m.id] = m;
    } catch (e) { console.error('pet.json 解析失败', dir, e); }
  }
  return out;
}
function loadPrefs() {
  try { prefs = Object.assign(prefs, JSON.parse(fs.readFileSync(prefsFile(), 'utf8'))); } catch (_) {}
}
function savePrefs(p) {
  prefs = Object.assign(prefs, p);
  try { fs.mkdirSync(path.dirname(prefsFile()), { recursive: true }); fs.writeFileSync(prefsFile(), JSON.stringify(prefs)); } catch (_) {}
}

// Windows:在桌面放一个指向 exe 的快捷方式(程序本体和素材仍留在解压目录)
function desktopShortcut(silent) {
  if (process.platform !== 'win32' || !app.isPackaged) return false;
  try {
    const lnk = path.join(app.getPath('desktop'), '没有特色.lnk');
    const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;   // portable 版要指向原文件,而不是临时解压目录
    if (silent && fs.existsSync(lnk)) return true;
    return shell.writeShortcutLink(lnk, fs.existsSync(lnk) ? 'replace' : 'create', {
      target: exe, cwd: path.dirname(exe), description: '没有特色', icon: exe, iconIndex: 0
    });
  } catch (e) { console.error('创建桌面快捷方式失败', e); return false; }
}

function workArea() { return screen.getPrimaryDisplay().workArea; }

function createWindow() {
  const wa = workArea();
  win = new BrowserWindow({
    x: wa.x, y: wa.y, width: wa.width, height: wa.height,
    transparent: true, frame: false, hasShadow: false, resizable: false, movable: false,
    skipTaskbar: true, focusable: false, alwaysOnTop: true, show: false, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.showInactive());
  if (process.env.PET_SELFTEST) require('./test/selftest.js')(win, { send });
  win.on('closed', () => { win = null; });
}

function fitWindow() {
  if (!win) return;
  const wa = workArea();
  win.setBounds({ x: wa.x, y: wa.y, width: wa.width, height: wa.height });
}

function send(action) { if (win) win.webContents.send('action', action); }

function commonItems() {
  const addItems = Object.values(kinds).map(k => ({ label: k.name, click: () => send({ action: 'add', kind: k.id }) }));
  return [
    { label: '全员合影', click: () => send({ action: 'photo' }) },
    { label: '大家聚一聚', click: () => send({ action: 'gather' }) },
    { label: '召回全部桌宠', click: () => send({ action: 'restore' }) },
    { label: '添加桌宠', submenu: addItems },
    { label: '大小', submenu: SCALES.map(([name, s]) => ({ label: name, type: 'radio', checked: Math.abs((prefs.scale || 1) - s) < 0.01, click: () => { prefs.scale = s; send({ action: 'scale', scale: s }); } })) },
    { type: 'separator' },
    ...(process.platform === 'win32' && app.isPackaged ? [{ label: '在桌面创建快捷方式', click: () => desktopShortcut(false) }] : []),
    { label: '开机自启', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked }) },
    { label: '退出', click: () => app.quit() }
  ];
}

function popup(menu) {
  if (!win) return;
  win.setFocusable(true);
  menu.popup({ window: win, callback: () => { if (win) win.setFocusable(false); } });
}

function createTray() {
  const first = Object.values(kinds)[0];
  let img = nativeImage.createEmpty();
  if (first) {
    const file = path.join(PETS_DIR, first.id, first.frames.peace || Object.values(first.frames)[0]);
    img = nativeImage.createFromPath(file).resize({ width: 24, height: 24 });
  }
  tray = new Tray(img);
  tray.setToolTip('没有特色');
  const build = () => Menu.buildFromTemplate([
    { label: win && win.isVisible() ? '隐藏桌宠' : '显示桌宠', click: () => { if (!win) return; win.isVisible() ? win.hide() : win.showInactive(); } },
    { type: 'separator' }, ...commonItems()
  ]);
  tray.on('click', () => tray.popUpContextMenu(build()));
  tray.on('right-click', () => tray.popUpContextMenu(build()));
}

app.whenReady().then(() => {
  if (app.dock) app.dock.hide();
  kinds = scanPets(); loadPrefs();
  createWindow(); createTray();
  if (!prefs.shortcutMade && desktopShortcut(true)) savePrefs({ shortcutMade: true });
  screen.on('display-metrics-changed', fitWindow);
  screen.on('display-added', fitWindow);
  screen.on('display-removed', fitWindow);
});

app.on('second-instance', () => { if (win && !win.isVisible()) win.showInactive(); send({ action: 'restore-if-empty' }); });
app.on('window-all-closed', () => app.quit());

ipcMain.handle('init', () => ({ kinds, prefs, platform: process.platform }));
ipcMain.on('set-ignore', (_e, v) => { if (win) v ? win.setIgnoreMouseEvents(true, { forward: true }) : win.setIgnoreMouseEvents(false); });
ipcMain.on('save-prefs', (_e, p) => savePrefs(p));
ipcMain.on('show-menu', (_e, info) => {
  const items = [
    { label: info.name, enabled: false }, { type: 'separator' },
    { label: info.sleeping ? '叫醒' : '睡觉', click: () => send({ action: 'sleep', petId: info.petId }) },
    { label: '打招呼', click: () => send({ action: 'greet', petId: info.petId }) }
  ];
  if (info.hasSignature) items.push({ label: '招牌动作', click: () => send({ action: 'signature', petId: info.petId }) });
  if (info.special) items.push({ label: info.special, click: () => send({ action: 'special', petId: info.petId }) });
  items.push({ label: '移除这只', click: () => send({ action: 'remove', petId: info.petId }) }, { type: 'separator' }, ...commonItems());
  popup(Menu.buildFromTemplate(items));
});
