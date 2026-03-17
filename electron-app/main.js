const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { AuthManager } = require('./src/auth');
const Store = require('electron-store');

const store = new Store({
  defaults: {
    setupComplete: false,
    userId: null,
    deviceName: 'hekla-device',
    gatewayUrl: 'http://localhost:3000',
    ollamaUrl: 'http://localhost:11434',
  }
});

let mainWindow;
let authManager;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0a0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  // Decide which page to show
  const startPage = store.get('setupComplete')
    ? 'src/pages/dashboard.html'
    : 'src/pages/setup.html';

  mainWindow.loadFile(path.join(__dirname, startPage));

  // Open external links in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(() => {
  authManager = new AuthManager(store);
  createWindow();
  registerIpcHandlers();
});

app.on('window-all-closed', () => {
  app.quit();
});

// ─── IPC Handlers ────────────────────────

function registerIpcHandlers() {
  // Navigation
  ipcMain.handle('navigate', (_, page) => {
    mainWindow.loadFile(path.join(__dirname, 'src', 'pages', `${page}.html`));
  });

  // Store
  ipcMain.handle('store:get', (_, key) => store.get(key));
  ipcMain.handle('store:set', (_, key, value) => store.set(key, value));

  // OAuth
  ipcMain.handle('auth:start-microsoft', () => authManager.startMicrosoftAuth());
  ipcMain.handle('auth:get-status', () => authManager.getStatus());
  ipcMain.handle('auth:logout', () => authManager.logout());

  // Gateway API
  ipcMain.handle('api:health', async () => {
    const url = store.get('gatewayUrl');
    try {
      const res = await fetch(`${url}/health`);
      return await res.json();
    } catch {
      return { status: 'unreachable' };
    }
  });

  ipcMain.handle('api:models', async () => {
    const url = store.get('ollamaUrl');
    try {
      const res = await fetch(`${url}/api/tags`);
      return await res.json();
    } catch {
      return { models: [] };
    }
  });

  ipcMain.handle('api:services', async () => {
    const gw = store.get('gatewayUrl');
    const ollama = store.get('ollamaUrl');

    const check = async (name, url) => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
        return { name, status: res.ok ? 'running' : 'error', code: res.status };
      } catch {
        return { name, status: 'down' };
      }
    };

    return Promise.all([
      check('Gateway', `${gw}/health`),
      check('Ollama', `${ollama}/api/tags`),
      check('Langfuse', 'http://localhost:3001'),
    ]);
  });

  ipcMain.handle('api:task', async (_, message) => {
    const url = store.get('gatewayUrl');
    const userId = store.get('userId');
    try {
      const res = await fetch(`${url}/api/task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, message }),
      });
      return await res.json();
    } catch (e) {
      return { error: e.message };
    }
  });

  // Setup completion
  ipcMain.handle('setup:complete', (_, userId) => {
    store.set('setupComplete', true);
    store.set('userId', userId);
    mainWindow.loadFile(path.join(__dirname, 'src', 'pages', 'dashboard.html'));
  });

  // Smoke test (for setup wizard)
  ipcMain.handle('setup:smoke-test', async () => {
    const gw = store.get('gatewayUrl');
    const ollama = store.get('ollamaUrl');
    const results = [];

    // Test Ollama
    try {
      const res = await fetch(`${ollama}/api/tags`, { signal: AbortSignal.timeout(5000) });
      const data = await res.json();
      results.push({ name: 'Ollama', pass: true, detail: `${data.models?.length || 0} model(s)` });
    } catch {
      results.push({ name: 'Ollama', pass: false, detail: 'Not running — start with: ollama serve' });
    }

    // Test Gateway
    try {
      const res = await fetch(`${gw}/health`, { signal: AbortSignal.timeout(5000) });
      results.push({ name: 'Gateway', pass: res.ok });
    } catch {
      results.push({ name: 'Gateway', pass: false, detail: 'Not running — start with: docker compose up -d' });
    }

    // Test inference
    try {
      const res = await fetch(`${ollama}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen2.5:32b',
          messages: [{ role: 'user', content: 'Say OK' }],
          stream: false,
        }),
        signal: AbortSignal.timeout(30000),
      });
      const data = await res.json();
      results.push({ name: 'Inference', pass: !!data.message?.content, detail: 'Model responding' });
    } catch {
      results.push({ name: 'Inference', pass: false, detail: 'Model not loaded or too slow' });
    }

    return results;
  });
}
