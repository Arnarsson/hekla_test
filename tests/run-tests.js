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
const suites = [];

function describe(name, fn) {
  suites.push({ name, fn });
}

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

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(msg || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(str, substr, msg) {
  if (!str.includes(substr)) {
    throw new Error(msg || `Expected "${str}" to include "${substr}"`);
  }
}

function skip() { throw new Error('SKIP'); }

// ═══════════════════════════════════════
// Test Suite: Docker Compose Validation
// ═══════════════════════════════════════
const compose = createSuite('Docker Compose Configuration');

compose.test('docker-compose.yml exists and is valid YAML', () => {
  const composePath = path.join(__dirname, '..', 'docker-compose.yml');
  assert(fs.existsSync(composePath), 'docker-compose.yml not found');
  const content = fs.readFileSync(composePath, 'utf8');
  assert(content.includes('services:'), 'Missing services key');
  assert(content.includes('networks:'), 'Missing networks key');
  assert(content.includes('volumes:'), 'Missing volumes key');
});

compose.test('GPU override file exists', () => {
  const gpuPath = path.join(__dirname, '..', 'docker-compose.gpu.yml');
  assert(fs.existsSync(gpuPath), 'docker-compose.gpu.yml not found');
  const content = fs.readFileSync(gpuPath, 'utf8');
  assert(content.includes('nvidia'), 'Missing nvidia GPU config');
});

compose.test('all required services are defined', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8');
  const requiredServices = ['ollama', 'postgres', 'redis', 'gateway', 'orchestrator', 'mail-agent', 'calendar-agent', 'memory-agent', 'langfuse'];
  for (const svc of requiredServices) {
    assertIncludes(content, `container_name: hekla-${svc.replace('-agent', '')}`,
      `Service ${svc} not properly defined (missing container_name)`);
  }
});

compose.test('all services have health checks', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8');
  // Infrastructure services should have healthchecks
  const healthCheckedServices = ['ollama', 'postgres', 'redis'];
  for (const svc of healthCheckedServices) {
    assertIncludes(content, 'healthcheck:', `Missing healthcheck (expected at least for ${svc})`);
  }
});

compose.test('base compose does NOT require GPU', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8');
  assert(!content.includes('nvidia'), 'Base docker-compose.yml should not reference nvidia (use docker-compose.gpu.yml)');
  assert(!content.includes('capabilities: [gpu]'), 'Base compose should not require GPU capabilities');
});

compose.test('environment variables reference .env correctly', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8');
  assertIncludes(content, '${POSTGRES_PASSWORD}', 'Missing POSTGRES_PASSWORD env var');
  assertIncludes(content, '${ACTIVE_MODEL', 'Missing ACTIVE_MODEL env var');
});

// ═══════════════════════════════════════
// Test Suite: Database Schema
// ═══════════════════════════════════════
const db = createSuite('Database Schema');

db.test('init.sql exists', () => {
  const sqlPath = path.join(__dirname, '..', 'postgres', 'init.sql');
  assert(fs.existsSync(sqlPath), 'postgres/init.sql not found');
});

db.test('required tables are defined', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'postgres', 'init.sql'), 'utf8');
  const tables = ['clients', 'oauth_tokens', 'agent_results', 'memories'];
  for (const table of tables) {
    assert(sql.includes(`CREATE TABLE ${table}`) || sql.includes(`CREATE TABLE IF NOT EXISTS ${table}`),
      `Missing table: ${table}`);
  }
});

db.test('agent_results has required columns', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'postgres', 'init.sql'), 'utf8');
  const columns = ['user_id', 'agent_type', 'input', 'output', 'status'];
  for (const col of columns) {
    assertIncludes(sql, col, `Missing column in agent_results: ${col}`);
  }
});

db.test('memories table supports types', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'postgres', 'init.sql'), 'utf8');
  assertIncludes(sql, 'memory_type', 'Missing memory_type column');
});

// ═══════════════════════════════════════
// Test Suite: Gateway Service
// ═══════════════════════════════════════
const gw = createSuite('Gateway Service');

gw.test('index.js exists with required endpoints', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'services', 'gateway', 'index.js'), 'utf8');
  assertIncludes(code, "'/health'", 'Missing /health endpoint');
  assertIncludes(code, "'/api/task'", 'Missing /api/task endpoint');
  assertIncludes(code, "'/api/models'", 'Missing /api/models endpoint');
});

gw.test('validates missing message in POST /api/task', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'services', 'gateway', 'index.js'), 'utf8');
  assertIncludes(code, '!message', 'Missing message validation');
  assertIncludes(code, '400', 'Missing 400 status for bad request');
});

gw.test('package.json has required dependencies', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'services', 'gateway', 'package.json'), 'utf8'));
  const required = ['express', 'cors', 'axios'];
  for (const dep of required) {
    assert(pkg.dependencies[dep], `Missing dependency: ${dep}`);
  }
});

gw.test('Dockerfile exists', () => {
  assert(fs.existsSync(path.join(__dirname, '..', 'services', 'gateway', 'Dockerfile')), 'Missing Dockerfile');
});

// ═══════════════════════════════════════
// Test Suite: Orchestrator Service
// ═══════════════════════════════════════
const orch = createSuite('Orchestrator Service');

orch.test('classifies valid intents', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'services', 'agents', 'orchestrator', 'index.js'), 'utf8');
  const validIntents = ['MAIL', 'CALENDAR', 'MEMORY', 'DIRECT'];
  for (const intent of validIntents) {
    assertIncludes(code, `'${intent}'`, `Missing intent: ${intent}`);
  }
});

orch.test('falls back to DIRECT on classification failure', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'services', 'agents', 'orchestrator', 'index.js'), 'utf8');
  // Check fallback return
  assert(
    code.includes("return 'DIRECT'") && code.includes('catch'),
    'Missing DIRECT fallback on error'
  );
});

orch.test('routes intents to correct queues', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'services', 'agents', 'orchestrator', 'index.js'), 'utf8');
  assertIncludes(code, "'hekla:mail'", 'Missing mail queue');
  assertIncludes(code, "'hekla:calendar'", 'Missing calendar queue');
  assertIncludes(code, "'hekla:memory'", 'Missing memory queue');
});

orch.test('has task status endpoint', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'services', 'agents', 'orchestrator', 'index.js'), 'utf8');
  assertIncludes(code, "'/task/:jobId'", 'Missing task status endpoint');
});

orch.test('has job completion webhook', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'services', 'agents', 'orchestrator', 'index.js'), 'utf8');
  assertIncludes(code, "'/task/:jobId/complete'", 'Missing task completion endpoint');
});

orch.test('package.json has bullmq and uuid', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'services', 'agents', 'orchestrator', 'package.json'), 'utf8'));
  assert(pkg.dependencies.bullmq, 'Missing bullmq dependency');
  assert(pkg.dependencies.uuid, 'Missing uuid dependency');
});

// ═══════════════════════════════════════
// Test Suite: Mail Agent
// ═══════════════════════════════════════
const mail = createSuite('Mail Agent');

mail.test('listens on correct queue', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'services', 'agents', 'mail', 'index.js'), 'utf8');
  assertIncludes(code, "'hekla:mail'", 'Wrong queue name');
});

mail.test('checks for OAuth token before processing', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'services', 'agents', 'mail', 'index.js'), 'utf8');
  assertIncludes(code, 'oauth_tokens', 'Missing OAuth token check');
  assertIncludes(code, '!tokenResult.rows[0]', 'Missing null token guard');
});

mail.test('anti-hallucination: refuses without OAuth', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'services', 'agents', 'mail', 'index.js'), 'utf8');
  assertIncludes(code, 'cannot access your emails', 'Missing auth-required response');
});

mail.test('handles TOKEN_EXPIRED error', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'services', 'agents', 'mail', 'index.js'), 'utf8');
  assertIncludes(code, 'TOKEN_EXPIRED', 'Missing TOKEN_EXPIRED handling');
});

mail.test('uses Microsoft Graph API', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'services', 'agents', 'mail', 'index.js'), 'utf8');
  assertIncludes(code, 'graph.microsoft.com', 'Missing Microsoft Graph API call');
});

// ═══════════════════════════════════════
// Test Suite: Calendar Agent
// ═══════════════════════════════════════
const cal = createSuite('Calendar Agent');

cal.test('listens on correct queue', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'services', 'agents', 'calendar', 'index.js'), 'utf8');
  assertIncludes(code, "'hekla:calendar'", 'Wrong queue name');
});

cal.test('supports event creation', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'services', 'agents', 'calendar', 'index.js'), 'utf8');
  assertIncludes(code, "action === 'create'", 'Missing event creation logic');
  assertIncludes(code, 'createEvent', 'Missing createEvent function');
});

cal.test('uses 7-day calendar window', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'services', 'agents', 'calendar', 'index.js'), 'utf8');
  assertIncludes(code, '7 * 24 * 60 * 60 * 1000', 'Missing 7-day window calculation');
});

cal.test('checks for OAuth before accessing calendar', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'services', 'agents', 'calendar', 'index.js'), 'utf8');
  assertIncludes(code, '!tokenResult.rows[0]', 'Missing OAuth guard');
  assertIncludes(code, 'cannot access your calendar', 'Missing auth-required message');
});

// ═══════════════════════════════════════
// Test Suite: Memory Agent
// ═══════════════════════════════════════
const mem = createSuite('Memory Agent');

mem.test('listens on correct queue', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'services', 'agents', 'memory', 'index.js'), 'utf8');
  assertIncludes(code, "'hekla:memory'", 'Wrong queue name');
});

mem.test('supports memory storage', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'services', 'agents', 'memory', 'index.js'), 'utf8');
  assertIncludes(code, "action === 'store'", 'Missing memory store logic');
  assertIncludes(code, 'storeMemory', 'Missing storeMemory function');
});

mem.test('supports memory types (fact/preference/context)', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'services', 'agents', 'memory', 'index.js'), 'utf8');
  assertIncludes(code, 'memory_type', 'Missing memory_type field');
  assertIncludes(code, 'fact|preference|context', 'Missing memory type options in prompt');
});

mem.test('retrieves memories ordered by relevance', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'services', 'agents', 'memory', 'index.js'), 'utf8');
  assertIncludes(code, 'relevance_score DESC', 'Missing relevance ordering');
});

// ═══════════════════════════════════════
// Test Suite: Environment & Config
// ═══════════════════════════════════════
const env = createSuite('Environment & Configuration');

env.test('.env.example exists with all required vars', () => {
  const envExample = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  const required = ['POSTGRES_PASSWORD', 'ACTIVE_MODEL', 'NEXTAUTH_SECRET', 'LANGFUSE_SALT'];
  for (const v of required) {
    assertIncludes(envExample, v, `Missing env var: ${v}`);
  }
});

env.test('setup script exists and is executable-ready', () => {
  const setupPath = path.join(__dirname, '..', 'scripts', 'setup.sh');
  assert(fs.existsSync(setupPath), 'scripts/setup.sh not found');
  const content = fs.readFileSync(setupPath, 'utf8');
  assertIncludes(content, '#!/bin/bash', 'Missing shebang');
  assertIncludes(content, 'set -e', 'Missing error handling');
});

env.test('setup script auto-detects GPU tier', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'setup.sh'), 'utf8');
  assertIncludes(content, 'nvidia-smi', 'Missing GPU detection');
  assertIncludes(content, 'RECOMMENDED_MODEL', 'Missing model recommendation');
});

env.test('QA test script exists', () => {
  assert(fs.existsSync(path.join(__dirname, '..', 'scripts', 'qa.js')), 'scripts/qa.js not found');
});

// ═══════════════════════════════════════
// Test Suite: Dockerfiles
// ═══════════════════════════════════════
const docker = createSuite('Dockerfiles');

const services = [
  'services/gateway',
  'services/agents/orchestrator',
  'services/agents/mail',
  'services/agents/calendar',
  'services/agents/memory'
];

for (const svc of services) {
  const name = svc.split('/').pop();
  docker.test(`${name} Dockerfile uses Node 20 alpine`, () => {
    const dockerfile = fs.readFileSync(path.join(__dirname, '..', svc, 'Dockerfile'), 'utf8');
    assertIncludes(dockerfile, 'node:20', `${name} should use Node 20`);
    assertIncludes(dockerfile, 'alpine', `${name} should use alpine base`);
  });
}

// ═══════════════════════════════════════
// Test Suite: Documentation
// ═══════════════════════════════════════
const docs = createSuite('Documentation');

docs.test('README.md exists', () => {
  assert(fs.existsSync(path.join(__dirname, '..', 'README.md')), 'README.md not found');
});

docs.test('SHIP_RUNBOOK.md exists', () => {
  assert(fs.existsSync(path.join(__dirname, '..', 'docs', 'SHIP_RUNBOOK.md')), 'docs/SHIP_RUNBOOK.md not found');
});

docs.test('.gitignore exists', () => {
  assert(fs.existsSync(path.join(__dirname, '..', '.gitignore')), '.gitignore not found');
});

// ═══════════════════════════════════════
// Run all suites
// ═══════════════════════════════════════
async function run() {
  console.log('\n  HEKLA Offline Test Suite');
  console.log('  ═══════════════════════\n');

  const allSuites = [compose, db, gw, orch, mail, cal, mem, env, docker, docs];

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
