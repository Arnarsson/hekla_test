#!/usr/bin/env node
/**
 * HEKLA Offline Test Suite
 * Tests service logic without requiring Docker or external services.
 * Run with: node tests/run-tests.js
 */

const path = require('path');
const fs = require('fs');

// Mini test framework
let totalPassed = 0;
let totalFailed = 0;
let totalSkipped = 0;

function createSuite(suiteName) {
  const tests = [];
  return {
    test(name, fn) { tests.push({ name, fn }); },
    async run() {
      console.log(`\n  ${suiteName}`);
      console.log(`  ${'─'.repeat(suiteName.length)}`);
      for (const { name, fn } of tests) {
        process.stdout.write(`    ○ ${name}... `);
        try {
          await fn();
          console.log('\x1b[32m✓\x1b[0m');
          totalPassed++;
        } catch (e) {
          if (e.message === 'SKIP') {
            console.log('\x1b[33m⊘ skipped\x1b[0m');
            totalSkipped++;
          } else {
            console.log('\x1b[31m✗\x1b[0m');
            console.log(`      \x1b[31m${e.message}\x1b[0m`);
            totalFailed++;
          }
        }
      }
    }
  };
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertIncludes(str, substr, msg) {
  if (!str.includes(substr)) {
    throw new Error(msg || `Expected to include "${substr}"`);
  }
}

function assertNotIncludes(str, substr, msg) {
  if (str.includes(substr)) {
    throw new Error(msg || `Expected NOT to include "${substr}"`);
  }
}

function readFile(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

function fileExists(relativePath) {
  return fs.existsSync(path.join(__dirname, '..', relativePath));
}

// ═══════════════════════════════════════
// Test Suite: Architecture (Mac Mini M4)
// ═══════════════════════════════════════
const arch = createSuite('Architecture (Mac Mini M4)');

arch.test('docker-compose.yml does NOT contain Ollama container', () => {
  const content = readFile('docker-compose.yml');
  assertNotIncludes(content, 'ollama/ollama', 'Ollama should run natively on macOS, not in Docker');
  assertNotIncludes(content, 'nvidia', 'No NVIDIA references — Apple Silicon uses Metal');
});

arch.test('agents connect to Ollama via host.docker.internal', () => {
  const content = readFile('docker-compose.yml');
  assertIncludes(content, 'host.docker.internal:11434', 'Agents must reach host Ollama via Docker bridge');
});

arch.test('no GPU passthrough in base compose', () => {
  const content = readFile('docker-compose.yml');
  assertNotIncludes(content, 'capabilities: [gpu]', 'Mac Mini M4 uses Metal, not Docker GPU passthrough');
  assertNotIncludes(content, 'driver: nvidia', 'No NVIDIA driver on Apple Silicon');
});

arch.test('agents have memory limits for isolation', () => {
  const content = readFile('docker-compose.yml');
  assertIncludes(content, 'memory: 512M', 'Agents should have memory limits for fault isolation');
});

arch.test('all services have restart: unless-stopped', () => {
  const content = readFile('docker-compose.yml');
  const serviceBlocks = content.split(/^\s{2}\w/m).length - 1;
  const restartCount = (content.match(/restart: unless-stopped/g) || []).length;
  assert(restartCount >= 7, `Expected at least 7 restart policies, found ${restartCount}`);
});

arch.test('default model is 32b (optimal for M4 Pro 36GB)', () => {
  const content = readFile('docker-compose.yml');
  assertIncludes(content, 'qwen2.5:32b', 'Default model should be 32b for M4 Pro tier');
});

// ═══════════════════════════════════════
// Test Suite: Serial Processing
// ═══════════════════════════════════════
const serial = createSuite('Serial Processing (No Parallelism)');

serial.test('mail agent has concurrency: 1', () => {
  const code = readFile('services/agents/mail/index.js');
  assertIncludes(code, 'concurrency: 1', 'Mail agent must process one job at a time');
});

serial.test('calendar agent has concurrency: 1', () => {
  const code = readFile('services/agents/calendar/index.js');
  assertIncludes(code, 'concurrency: 1', 'Calendar agent must process one job at a time');
});

serial.test('memory agent has concurrency: 1', () => {
  const code = readFile('services/agents/memory/index.js');
  assertIncludes(code, 'concurrency: 1', 'Memory agent must process one job at a time');
});

serial.test('queues have retry/backoff configured', () => {
  const code = readFile('services/agents/orchestrator/index.js');
  assertIncludes(code, 'attempts:', 'Queues should have retry attempts');
  assertIncludes(code, 'backoff', 'Queues should have backoff strategy');
});

serial.test('workers have extended lock duration for LLM inference', () => {
  const mailCode = readFile('services/agents/mail/index.js');
  assertIncludes(mailCode, 'lockDuration', 'Workers need extended lock for LLM calls');
});

// ═══════════════════════════════════════
// Test Suite: Docker Compose
// ═══════════════════════════════════════
const compose = createSuite('Docker Compose');

compose.test('docker-compose.yml exists and is valid', () => {
  assert(fileExists('docker-compose.yml'), 'docker-compose.yml not found');
  const content = readFile('docker-compose.yml');
  assertIncludes(content, 'services:', 'Missing services key');
  assertIncludes(content, 'networks:', 'Missing networks key');
  assertIncludes(content, 'volumes:', 'Missing volumes key');
});

compose.test('all required services are defined', () => {
  const content = readFile('docker-compose.yml');
  const required = ['hekla-postgres', 'hekla-redis', 'hekla-gateway', 'hekla-orchestrator', 'hekla-mail', 'hekla-calendar', 'hekla-memory', 'hekla-langfuse'];
  for (const name of required) {
    assertIncludes(content, `container_name: ${name}`, `Missing container: ${name}`);
  }
});

compose.test('infrastructure services have health checks', () => {
  const content = readFile('docker-compose.yml');
  assertIncludes(content, 'pg_isready', 'PostgreSQL healthcheck missing');
  assertIncludes(content, 'redis-cli', 'Redis healthcheck missing');
});

compose.test('gateway and orchestrator have health checks', () => {
  const content = readFile('docker-compose.yml');
  // Both should have wget-based health checks
  assert((content.match(/wget.*health/g) || []).length >= 2, 'Gateway and orchestrator need health checks');
});

compose.test('HEKLA branding in compose header', () => {
  const content = readFile('docker-compose.yml');
  assertIncludes(content, 'HEKLA', 'Missing HEKLA branding');
  assertIncludes(content, 'hekla.cc', 'Missing hekla.cc URL');
});

// ═══════════════════════════════════════
// Test Suite: Database Schema
// ═══════════════════════════════════════
const db = createSuite('Database Schema');

db.test('init.sql exists', () => {
  assert(fileExists('postgres/init.sql'), 'postgres/init.sql not found');
});

db.test('required tables are defined', () => {
  const sql = readFile('postgres/init.sql');
  const tables = ['clients', 'oauth_tokens', 'agent_results', 'memories'];
  for (const table of tables) {
    assert(sql.includes(`CREATE TABLE ${table}`) || sql.includes(`CREATE TABLE IF NOT EXISTS ${table}`),
      `Missing table: ${table}`);
  }
});

db.test('agent_results has required columns', () => {
  const sql = readFile('postgres/init.sql');
  for (const col of ['user_id', 'agent_type', 'input', 'output', 'status']) {
    assertIncludes(sql, col, `Missing column: ${col}`);
  }
});

db.test('memories table supports types', () => {
  const sql = readFile('postgres/init.sql');
  assertIncludes(sql, 'memory_type', 'Missing memory_type column');
});

// ═══════════════════════════════════════
// Test Suite: Gateway Service
// ═══════════════════════════════════════
const gw = createSuite('Gateway Service');

gw.test('has required endpoints', () => {
  const code = readFile('services/gateway/index.js');
  assertIncludes(code, "'/health'", 'Missing /health');
  assertIncludes(code, "'/api/task'", 'Missing /api/task');
  assertIncludes(code, "'/api/models'", 'Missing /api/models');
});

gw.test('validates missing message', () => {
  const code = readFile('services/gateway/index.js');
  assertIncludes(code, '!message', 'Missing message validation');
  assertIncludes(code, '400', 'Missing 400 status');
});

gw.test('has required dependencies', () => {
  const pkg = JSON.parse(readFile('services/gateway/package.json'));
  for (const dep of ['express', 'cors', 'axios']) {
    assert(pkg.dependencies[dep], `Missing dep: ${dep}`);
  }
});

gw.test('Dockerfile exists', () => {
  assert(fileExists('services/gateway/Dockerfile'), 'Missing Dockerfile');
});

// ═══════════════════════════════════════
// Test Suite: Orchestrator
// ═══════════════════════════════════════
const orch = createSuite('Orchestrator Service');

orch.test('classifies all intent types', () => {
  const code = readFile('services/agents/orchestrator/index.js');
  for (const intent of ['MAIL', 'CALENDAR', 'MEMORY', 'DIRECT']) {
    assertIncludes(code, `'${intent}'`, `Missing intent: ${intent}`);
  }
});

orch.test('falls back to DIRECT on error', () => {
  const code = readFile('services/agents/orchestrator/index.js');
  assert(code.includes("return 'DIRECT'") && code.includes('catch'), 'Missing DIRECT fallback');
});

orch.test('routes to correct queues', () => {
  const code = readFile('services/agents/orchestrator/index.js');
  assertIncludes(code, "'hekla:mail'", 'Missing mail queue');
  assertIncludes(code, "'hekla:calendar'", 'Missing calendar queue');
  assertIncludes(code, "'hekla:memory'", 'Missing memory queue');
});

orch.test('has task status + completion endpoints', () => {
  const code = readFile('services/agents/orchestrator/index.js');
  assertIncludes(code, "'/task/:jobId'", 'Missing task status');
  assertIncludes(code, "'/task/:jobId/complete'", 'Missing completion webhook');
});

orch.test('has bullmq and uuid dependencies', () => {
  const pkg = JSON.parse(readFile('services/agents/orchestrator/package.json'));
  assert(pkg.dependencies.bullmq, 'Missing bullmq');
  assert(pkg.dependencies.uuid, 'Missing uuid');
});

// ═══════════════════════════════════════
// Test Suite: Agent Isolation & Safety
// ═══════════════════════════════════════
const safety = createSuite('Agent Isolation & Safety');

safety.test('mail agent checks OAuth before processing', () => {
  const code = readFile('services/agents/mail/index.js');
  assertIncludes(code, 'oauth_tokens', 'Must check OAuth');
  assertIncludes(code, '!tokenResult.rows[0]', 'Must guard null token');
  assertIncludes(code, 'cannot access your emails', 'Must refuse without OAuth');
});

safety.test('mail agent handles TOKEN_EXPIRED', () => {
  const code = readFile('services/agents/mail/index.js');
  assertIncludes(code, 'TOKEN_EXPIRED', 'Must handle expired tokens');
});

safety.test('calendar agent checks OAuth', () => {
  const code = readFile('services/agents/calendar/index.js');
  assertIncludes(code, '!tokenResult.rows[0]', 'Must guard null token');
  assertIncludes(code, 'cannot access your calendar', 'Must refuse without OAuth');
});

safety.test('calendar agent supports event creation', () => {
  const code = readFile('services/agents/calendar/index.js');
  assertIncludes(code, "action === 'create'", 'Must support creating events');
});

safety.test('memory agent supports store and recall', () => {
  const code = readFile('services/agents/memory/index.js');
  assertIncludes(code, "action === 'store'", 'Must support storing memories');
  assertIncludes(code, 'relevance_score DESC', 'Must order by relevance');
});

safety.test('all agents use Microsoft Graph API', () => {
  for (const agent of ['mail', 'calendar']) {
    const code = readFile(`services/agents/${agent}/index.js`);
    assertIncludes(code, 'graph.microsoft.com', `${agent} must use MS Graph`);
  }
});

// ═══════════════════════════════════════
// Test Suite: Environment & Config
// ═══════════════════════════════════════
const env = createSuite('Environment & Configuration');

env.test('.env.example has all required vars', () => {
  const content = readFile('.env.example');
  for (const v of ['POSTGRES_PASSWORD', 'ACTIVE_MODEL', 'NEXTAUTH_SECRET', 'OLLAMA_URL']) {
    assertIncludes(content, v, `Missing: ${v}`);
  }
});

env.test('.env.example documents M4 tiers', () => {
  const content = readFile('.env.example');
  assertIncludes(content, 'base', 'Missing base tier');
  assertIncludes(content, 'pro', 'Missing pro tier');
  assertIncludes(content, 'max', 'Missing max tier');
});

env.test('.env.example has host.docker.internal for Ollama', () => {
  const content = readFile('.env.example');
  assertIncludes(content, 'host.docker.internal:11434', 'Ollama URL must use host bridge');
});

env.test('.env.example has subscription/alternative fields', () => {
  const content = readFile('.env.example');
  assertIncludes(content, 'HYBRID_MODE', 'Missing hybrid mode');
  assertIncludes(content, 'OPENROUTER_API_KEY', 'Missing OpenRouter key');
  assertIncludes(content, 'MAIL_FORWARD', 'Missing mail forwarding config');
});

env.test('setup script handles macOS', () => {
  const content = readFile('scripts/setup.sh');
  assertIncludes(content, 'Darwin', 'Must detect macOS');
  assertIncludes(content, 'brew', 'Must use Homebrew');
  assertIncludes(content, 'Metal', 'Must reference Metal GPU');
});

env.test('setup script detects Apple Silicon memory tiers', () => {
  const content = readFile('scripts/setup.sh');
  assertIncludes(content, 'hw.memsize', 'Must detect unified memory');
  assertIncludes(content, 'llama3.3:70b', 'Must recommend 70b for max tier');
  assertIncludes(content, 'qwen2.5:32b', 'Must recommend 32b for pro tier');
});

env.test('QA test script exists', () => {
  assert(fileExists('scripts/qa.js'), 'scripts/qa.js not found');
});

// ═══════════════════════════════════════
// Test Suite: Dockerfiles
// ═══════════════════════════════════════
const docker = createSuite('Dockerfiles');

const svcPaths = [
  'services/gateway',
  'services/agents/orchestrator',
  'services/agents/mail',
  'services/agents/calendar',
  'services/agents/memory'
];

for (const svc of svcPaths) {
  const name = svc.split('/').pop();
  docker.test(`${name} Dockerfile uses Node 20 alpine`, () => {
    const df = readFile(`${svc}/Dockerfile`);
    assertIncludes(df, 'node:20', `${name} should use Node 20`);
    assertIncludes(df, 'alpine', `${name} should use alpine`);
  });
}

// ═══════════════════════════════════════
// Test Suite: Documentation
// ═══════════════════════════════════════
const docs = createSuite('Documentation');

docs.test('README.md references hekla.cc', () => {
  const content = readFile('README.md');
  assertIncludes(content, 'hekla.cc', 'Missing hekla.cc URL');
});

docs.test('README.md documents M4 hardware tiers', () => {
  const content = readFile('README.md');
  assertIncludes(content, 'M4', 'Must reference Mac Mini M4');
  assertIncludes(content, 'Base', 'Must document Base tier');
  assertIncludes(content, 'Pro', 'Must document Pro tier');
  assertIncludes(content, 'Max', 'Must document Max tier');
});

docs.test('README.md explains native Ollama architecture', () => {
  const content = readFile('README.md');
  assertIncludes(content, 'natively', 'Must explain native Ollama');
  assertIncludes(content, 'Metal', 'Must reference Metal GPU');
  assertIncludes(content, 'host.docker.internal', 'Must explain Docker bridge');
});

docs.test('SHIP_RUNBOOK.md exists with Mac Mini steps', () => {
  assert(fileExists('docs/SHIP_RUNBOOK.md'), 'Missing runbook');
  const content = readFile('docs/SHIP_RUNBOOK.md');
  assertIncludes(content, 'Mac Mini', 'Runbook must reference Mac Mini');
  assertIncludes(content, 'brew', 'Runbook must use Homebrew');
});

docs.test('.gitignore exists', () => {
  assert(fileExists('.gitignore'), 'Missing .gitignore');
});

// ═══════════════════════════════════════
// Test Suite: Electron App
// ═══════════════════════════════════════
const electron = createSuite('Electron App');

electron.test('package.json exists with correct name', () => {
  assert(fileExists('electron-app/package.json'), 'Missing electron-app/package.json');
  const pkg = JSON.parse(readFile('electron-app/package.json'));
  assert(pkg.name === 'hekla-desktop', `Expected name hekla-desktop, got ${pkg.name}`);
  assert(pkg.main === 'main.js', 'main should be main.js');
});

electron.test('has MSAL dependency for Microsoft OAuth', () => {
  const pkg = JSON.parse(readFile('electron-app/package.json'));
  assert(pkg.dependencies['@azure/msal-node'], 'Missing @azure/msal-node dependency');
});

electron.test('has electron-store for local config', () => {
  const pkg = JSON.parse(readFile('electron-app/package.json'));
  assert(pkg.dependencies['electron-store'], 'Missing electron-store dependency');
});

electron.test('main process exists with window creation', () => {
  assert(fileExists('electron-app/main.js'), 'Missing main.js');
  const code = readFile('electron-app/main.js');
  assertIncludes(code, 'BrowserWindow', 'Must create BrowserWindow');
  assertIncludes(code, 'contextIsolation: true', 'Must use context isolation');
  assertIncludes(code, 'nodeIntegration: false', 'Must disable nodeIntegration');
});

electron.test('preload.js exposes hekla API bridge', () => {
  assert(fileExists('electron-app/preload.js'), 'Missing preload.js');
  const code = readFile('electron-app/preload.js');
  assertIncludes(code, "exposeInMainWorld('hekla'", 'Must expose hekla API');
  assertIncludes(code, 'startMicrosoftAuth', 'Must expose OAuth');
  assertIncludes(code, 'getServices', 'Must expose service status');
  assertIncludes(code, 'getModels', 'Must expose model listing');
});

electron.test('auth module uses MSAL with auth code flow', () => {
  assert(fileExists('electron-app/src/auth.js'), 'Missing auth.js');
  const code = readFile('electron-app/src/auth.js');
  assertIncludes(code, 'PublicClientApplication', 'Must use MSAL PublicClientApplication');
  assertIncludes(code, 'acquireTokenByCode', 'Must use auth code flow');
  assertIncludes(code, 'Mail.Read', 'Must request Mail.Read scope');
  assertIncludes(code, 'Calendars.ReadWrite', 'Must request Calendar scope');
  assertIncludes(code, 'offline_access', 'Must request offline_access for refresh tokens');
});

electron.test('auth saves tokens to backend gateway', () => {
  const code = readFile('electron-app/src/auth.js');
  assertIncludes(code, '_saveTokensToBackend', 'Must save tokens to backend');
  assertIncludes(code, '/api/oauth/token', 'Must POST to gateway oauth endpoint');
});

electron.test('main routes to setup wizard on first boot', () => {
  const code = readFile('electron-app/main.js');
  assertIncludes(code, 'setupComplete', 'Must check setupComplete flag');
  assertIncludes(code, 'setup.html', 'Must load setup page on first boot');
  assertIncludes(code, 'dashboard.html', 'Must load dashboard when setup done');
});

electron.test('setup wizard page exists with all steps', () => {
  assert(fileExists('electron-app/src/pages/setup.html'), 'Missing setup.html');
  const html = readFile('electron-app/src/pages/setup.html');
  assertIncludes(html, 'step-0', 'Must have welcome step');
  assertIncludes(html, 'step-1', 'Must have system check step');
  assertIncludes(html, 'step-2', 'Must have OAuth step');
  assertIncludes(html, 'step-3', 'Must have completion step');
  assertIncludes(html, 'wizard-step', 'Must have progress indicators');
  assertIncludes(html, 'runSmokeTest', 'Must run smoke tests');
});

electron.test('dashboard page exists with service status', () => {
  assert(fileExists('electron-app/src/pages/dashboard.html'), 'Missing dashboard.html');
  const html = readFile('electron-app/src/pages/dashboard.html');
  assertIncludes(html, 'gw-status', 'Must show gateway status');
  assertIncludes(html, 'ollama-status', 'Must show Ollama status');
  assertIncludes(html, 'model-name', 'Must show active model');
  assertIncludes(html, 'auth-badge', 'Must show auth status');
  assertIncludes(html, 'task-input', 'Must have quick task input');
});

electron.test('settings page exists with config management', () => {
  assert(fileExists('electron-app/src/pages/settings.html'), 'Missing settings.html');
  const html = readFile('electron-app/src/pages/settings.html');
  assertIncludes(html, 'azure-client-id', 'Must have Azure Client ID field');
  assertIncludes(html, 'model-select', 'Must have model selection');
  assertIncludes(html, 'ms-disconnect', 'Must have disconnect button');
  assertIncludes(html, 'device-name', 'Must have device name config');
  assertIncludes(html, 'reset-btn', 'Must have reset setup option');
});

electron.test('shared styles exist', () => {
  assert(fileExists('electron-app/src/styles.css'), 'Missing styles.css');
  const css = readFile('electron-app/src/styles.css');
  assertIncludes(css, 'titlebar', 'Must style titlebar');
  assertIncludes(css, 'wizard-step', 'Must style wizard steps');
  assertIncludes(css, 'status-dot', 'Must style status indicators');
});

electron.test('IPC handlers cover all features', () => {
  const code = readFile('electron-app/main.js');
  const handlers = [
    'navigate', 'store:get', 'store:set',
    'auth:start-microsoft', 'auth:get-status', 'auth:logout',
    'api:health', 'api:models', 'api:services', 'api:task',
    'setup:complete', 'setup:smoke-test',
  ];
  for (const h of handlers) {
    assertIncludes(code, `'${h}'`, `Missing IPC handler: ${h}`);
  }
});

electron.test('smoke test checks Ollama, Gateway, and inference', () => {
  const code = readFile('electron-app/main.js');
  assertIncludes(code, '/api/tags', 'Smoke test must check Ollama');
  assertIncludes(code, '/health', 'Smoke test must check gateway');
  assertIncludes(code, '/api/chat', 'Smoke test must check inference');
});

electron.test('macOS build config targets DMG', () => {
  const pkg = JSON.parse(readFile('electron-app/package.json'));
  assert(pkg.build, 'Missing build config');
  assert(pkg.build.mac, 'Missing mac build config');
  assert(pkg.build.mac.target === 'dmg', 'Mac target should be dmg');
  assertIncludes(pkg.build.appId, 'hekla', 'App ID must include hekla');
});

// ═══════════════════════════════════════
// Run all suites
// ═══════════════════════════════════════
async function run() {
  console.log('\n  HEKLA Offline Test Suite');
  console.log('  ═══════════════════════\n');

  const allSuites = [arch, serial, compose, db, gw, orch, safety, env, docker, docs, electron];

  for (const suite of allSuites) {
    await suite.run();
  }

  console.log('\n  ═══════════════════════');
  console.log(`  \x1b[32m${totalPassed} passed\x1b[0m, \x1b[31m${totalFailed} failed\x1b[0m${totalSkipped ? `, \x1b[33m${totalSkipped} skipped\x1b[0m` : ''}`);
  console.log('');

  process.exit(totalFailed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('Test runner error:', e);
  process.exit(1);
});
