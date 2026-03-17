#!/usr/bin/env node
// HEKLA Electron App Launch Test
// Verifies the app starts, creates a window, and loads the setup page.
// Usage: xvfb-run node scripts/test-electron-launch.js

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const TIMEOUT_MS = 30000;
const electronAppDir = path.resolve(__dirname, '..', 'electron-app');
const electronBin = path.join(electronAppDir, 'node_modules', '.bin', 'electron');

console.log('HEKLA Electron Launch Test');
console.log('═════════════════════════');
console.log('');

let passed = 0;
let failed = 0;

function ok(msg) {
  passed++;
  console.log(`  \u25cb ${msg}... \x1b[32m\u2713\x1b[0m`);
}

function fail(msg, detail) {
  failed++;
  console.log(`  \u25cb ${msg}... \x1b[31m\u2717\x1b[0m`);
  if (detail) console.log(`    ${detail}`);
}

// Build the test main script — it runs inside Electron and writes results to a temp file
const resultsFile = path.join(electronAppDir, '_launch_test_results.json');

const testMainScript = `
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

const results = {};
const resultsFile = ${JSON.stringify(resultsFile)};

app.whenReady().then(async () => {
  results['app-ready'] = true;

  try {
    const Store = require('electron-store');
    const store = new Store({ defaults: { setupComplete: false } });
    results['store-ok'] = true;
  } catch (e) {
    results['store-fail'] = e.message.split('\\n')[0];
  }

  try {
    const { AuthManager } = require('./src/auth');
    results['auth-module-ok'] = true;
  } catch (e) {
    results['auth-module-fail'] = e.message.split('\\n')[0];
  }

  try {
    const win = new BrowserWindow({
      width: 960, height: 680, show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true, nodeIntegration: false,
      }
    });
    results['window-created'] = true;

    await win.loadFile(path.join(__dirname, 'src/pages/setup.html'));
    results['page-loaded'] = 'src/pages/setup.html';

    const title = win.getTitle();
    results['title'] = title;

    const bodyText = await win.webContents.executeJavaScript('document.body.innerText.substring(0, 200)');
    results['body-preview'] = bodyText.replace(/\\n/g, ' ').substring(0, 100);

    results['done'] = true;
  } catch (e) {
    results['window-fail'] = e.message.split('\\n')[0];
    results['done'] = true;
  }

  fs.writeFileSync(resultsFile, JSON.stringify(results));
  setTimeout(() => app.quit(), 500);
});

app.on('window-all-closed', () => app.quit());
`;

const tempScript = path.join(electronAppDir, '_launch_test_main.js');
fs.writeFileSync(tempScript, testMainScript);

// Clean up any old results
try { fs.unlinkSync(resultsFile); } catch {}

const child = spawn(electronBin, ['--no-sandbox', tempScript], {
  cwd: electronAppDir,
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stderr = '';

child.stderr.on('data', (data) => {
  stderr += data.toString();
});

child.on('error', (err) => {
  fail('Electron binary launches', err.message);
  cleanup();
  printResults();
});

const timeout = setTimeout(() => {
  fail('App launches within timeout', `Killed after ${TIMEOUT_MS / 1000}s`);
  child.kill('SIGKILL');
  cleanup();
  printResults();
}, TIMEOUT_MS);

child.on('close', (code) => {
  clearTimeout(timeout);

  // Read results from temp file
  let results = {};
  try {
    results = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  } catch {
    // Results file not written — app crashed before finishing
  }

  // Evaluate results
  if (results['app-ready']) {
    ok('Electron app.whenReady() fires');
  } else {
    fail('Electron app.whenReady() fires', 'App did not become ready');
  }

  if (results['store-ok']) {
    ok('electron-store initializes');
  } else {
    fail('electron-store initializes', results['store-fail'] || 'Unknown error');
  }

  if (results['auth-module-ok']) {
    ok('AuthManager module loads (MSAL)');
  } else {
    fail('AuthManager module loads (MSAL)', results['auth-module-fail'] || 'Unknown error');
  }

  if (results['window-created']) {
    ok('BrowserWindow created');
  } else {
    fail('BrowserWindow created', results['window-fail'] || 'Unknown error');
  }

  if (results['page-loaded']) {
    ok(`Setup page loads (${results['page-loaded']})`);
  } else {
    fail('Setup page loads', results['window-fail'] || 'Page did not load');
  }

  if (results['title']) {
    ok(`Window has title: "${results['title']}"`);
  }

  if (results['body-preview']) {
    const hasContent = results['body-preview'].trim().length > 10;
    if (hasContent) {
      ok('Page renders with content');
    } else {
      fail('Page renders with content', 'Body appears empty');
    }
  }

  if (results['done']) {
    if (code === 0) {
      ok('App exits cleanly (code 0)');
    } else {
      fail('App exits cleanly', `Exit code: ${code}`);
    }
  }

  // Check for critical errors in stderr
  const criticalErrors = stderr.split('\n').filter(l =>
    l.includes('Error:') && !l.includes('GPU') && !l.includes('sandbox') &&
    !l.includes('dbus') && !l.includes('libGL') && !l.includes('DISPLAY') &&
    !l.includes('bus.cc')
  );
  if (criticalErrors.length === 0) {
    ok('No critical errors in stderr');
  } else {
    fail('No critical errors in stderr', criticalErrors[0]);
  }

  cleanup();
  printResults();
});

function cleanup() {
  try { fs.unlinkSync(tempScript); } catch {}
  try { fs.unlinkSync(resultsFile); } catch {}
}

function printResults() {
  console.log('');
  console.log('\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
  const summary = [];
  if (passed) summary.push(`\x1b[32m${passed} passed\x1b[0m`);
  if (failed) summary.push(`\x1b[31m${failed} failed\x1b[0m`);
  console.log(`  ${summary.join(', ')}`);
  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}
