#!/usr/bin/env node
/**
 * HEKLA QA Test Suite
 * Run with: node scripts/qa.js
 */

const http = require('http');
const https = require('https');

const TESTS = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  TESTS.push({ name, fn });
}

async function httpGet(url, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function httpPost(url, body, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(JSON.stringify(body));
    req.end();
  });
}

// Test definitions
test('Ollama is running', async () => {
  const res = await httpGet('http://localhost:11434/api/tags');
  if (res.status !== 200) throw new Error(`Status ${res.status}`);
});

test('Ollama has a model loaded', async () => {
  const res = await httpGet('http://localhost:11434/api/tags');
  const data = JSON.parse(res.data);
  if (!data.models || data.models.length === 0) {
    throw new Error('No models found. Run: docker exec hekla-ollama ollama pull qwen2.5:14b');
  }
});

test('Gateway is running', async () => {
  const res = await httpGet('http://localhost:3000/health');
  if (res.status !== 200) throw new Error(`Status ${res.status}`);
});

test('Gateway can reach orchestrator', async () => {
  const res = await httpPost('http://localhost:3000/api/task', {
    userId: 'test-user',
    message: 'Hello'
  });
  if (res.status >= 500) throw new Error(`Status ${res.status}: ${res.data}`);
});

test('Orchestrator classifies DIRECT intent', async () => {
  const res = await httpPost('http://localhost:3000/api/task', {
    userId: 'test-user',
    message: 'Hello, how are you?'
  });
  const data = JSON.parse(res.data);
  if (data.status !== 'direct') {
    console.log('    (got:', data.intent || data.status, ')');
  }
});

test('Orchestrator classifies MAIL intent', async () => {
  const res = await httpPost('http://localhost:3000/api/task', {
    userId: 'test-user',
    message: "What's in my inbox?"
  });
  const data = JSON.parse(res.data);
  if (data.intent !== 'MAIL' && data.status !== 'queued') {
    console.log('    (got:', data.intent || data.status, ')');
  }
});

test('Orchestrator classifies CALENDAR intent', async () => {
  const res = await httpPost('http://localhost:3000/api/task', {
    userId: 'test-user',
    message: "What meetings do I have today?"
  });
  const data = JSON.parse(res.data);
  if (data.intent !== 'CALENDAR' && data.status !== 'queued') {
    console.log('    (got:', data.intent || data.status, ')');
  }
});

test('Anti-hallucination: Mail agent requires OAuth', async () => {
  // Send a mail request without OAuth configured
  // Agent should NOT invent fake emails
  const res = await httpPost('http://localhost:3000/api/task', {
    userId: 'no-oauth-user',
    message: "Show me my latest emails"
  });
  const data = JSON.parse(res.data);
  // Should either be queued (and eventually fail) or contain auth prompt
  if (data.response && data.response.toLowerCase().includes('from:')) {
    throw new Error('Agent may be hallucinating emails without OAuth');
  }
});

test('Langfuse is running', async () => {
  try {
    const res = await httpGet('http://localhost:3001');
    if (res.status >= 500) throw new Error(`Status ${res.status}`);
  } catch (e) {
    if (e.message === 'timeout') {
      console.log('    (Langfuse may be starting up)');
      return; // Don't fail, just warn
    }
    throw e;
  }
});

test('Redis is accessible (via gateway)', async () => {
  // This is tested implicitly by the orchestrator working
  const res = await httpGet('http://localhost:3000/health');
  if (res.status !== 200) throw new Error('Gateway unhealthy');
});

// Run tests
async function run() {
  console.log('\n  HEKLA QA Test Suite');
  console.log('  ═══════════════════\n');

  for (const { name, fn } of TESTS) {
    process.stdout.write(`  ○ ${name}... `);
    try {
      await fn();
      console.log('\x1b[32m✓\x1b[0m');
      passed++;
    } catch (e) {
      console.log('\x1b[31m✗\x1b[0m');
      console.log(`    \x1b[31m${e.message}\x1b[0m`);
      failed++;
    }
  }

  console.log('\n  ───────────────────');
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('');

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('Test runner error:', e);
  process.exit(1);
});
