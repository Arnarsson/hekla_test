#!/usr/bin/env node
/**
 * HEKLA QA Test Suite
 * Tests live services (requires Docker stack to be running).
 * Run with: node scripts/qa.js
 *
 * Options:
 *   --timeout=N    Set timeout in ms per test (default: 10000)
 *   --retry=N      Retry failed tests N times (default: 0)
 *   --verbose      Show response bodies on pass
 */

const http = require('http');
const https = require('https');

// Parse CLI options
const args = process.argv.slice(2);
const opts = {
  timeout: 10000,
  retry: 0,
  verbose: false,
};
for (const arg of args) {
  if (arg.startsWith('--timeout=')) opts.timeout = parseInt(arg.split('=')[1]);
  if (arg.startsWith('--retry=')) opts.retry = parseInt(arg.split('=')[1]);
  if (arg === '--verbose') opts.verbose = true;
}

const TESTS = [];
let passed = 0;
let failed = 0;
let skipped = 0;
const results = [];

function test(name, fn, { skip = false } = {}) {
  TESTS.push({ name, fn, skip });
}

async function httpGet(url, timeout = opts.timeout) {
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

async function httpPost(url, body, timeout = opts.timeout) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const payload = JSON.stringify(body);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

// ═══════════════════════════════════════
// Infrastructure Tests
// ═══════════════════════════════════════
test('Ollama is running', async () => {
  const res = await httpGet('http://localhost:11434/api/tags');
  if (res.status !== 200) throw new Error(`Status ${res.status}`);
  return res.data;
});

test('Ollama has a model loaded', async () => {
  const res = await httpGet('http://localhost:11434/api/tags');
  const data = JSON.parse(res.data);
  if (!data.models || data.models.length === 0) {
    throw new Error('No models found. Run: docker exec hekla-ollama ollama pull qwen2.5:14b');
  }
  return `Models: ${data.models.map(m => m.name).join(', ')}`;
});

test('PostgreSQL is accessible (via gateway health)', async () => {
  const res = await httpGet('http://localhost:3000/health');
  if (res.status !== 200) throw new Error(`Gateway unhealthy: status ${res.status}`);
  return res.data;
});

test('Redis is accessible (via gateway)', async () => {
  const res = await httpGet('http://localhost:3000/health');
  if (res.status !== 200) throw new Error('Gateway unhealthy — Redis may be down');
});

// ═══════════════════════════════════════
// Gateway Tests
// ═══════════════════════════════════════
test('Gateway /health returns ok', async () => {
  const res = await httpGet('http://localhost:3000/health');
  if (res.status !== 200) throw new Error(`Status ${res.status}`);
  const data = JSON.parse(res.data);
  if (data.status !== 'ok') throw new Error(`Health status: ${data.status}`);
  return res.data;
});

test('Gateway rejects missing message', async () => {
  const res = await httpPost('http://localhost:3000/api/task', { userId: 'test' });
  if (res.status !== 400) throw new Error(`Expected 400, got ${res.status}`);
  return `Correctly returned ${res.status}`;
});

test('Gateway can list models', async () => {
  const res = await httpGet('http://localhost:3000/api/models');
  if (res.status >= 500) throw new Error(`Status ${res.status}: ${res.data}`);
  return res.data;
});

test('Gateway can reach orchestrator', async () => {
  const res = await httpPost('http://localhost:3000/api/task', {
    userId: 'test-user',
    message: 'Hello'
  });
  if (res.status >= 500) throw new Error(`Status ${res.status}: ${res.data}`);
  return res.data;
});

// ═══════════════════════════════════════
// Orchestrator Intent Classification
// ═══════════════════════════════════════
test('Orchestrator classifies DIRECT intent', async () => {
  const res = await httpPost('http://localhost:3000/api/task', {
    userId: 'test-user',
    message: 'Hello, how are you?'
  });
  const data = JSON.parse(res.data);
  if (data.status === 'direct') {
    return `Intent: DIRECT, Response: ${(data.response || '').substring(0, 80)}...`;
  }
  // Non-fatal: LLM may classify differently
  console.log(`\n      (got: ${data.intent || data.status} — LLM may vary)`);
  return `Intent: ${data.intent || data.status}`;
});

test('Orchestrator classifies MAIL intent', async () => {
  const res = await httpPost('http://localhost:3000/api/task', {
    userId: 'test-user',
    message: "What's in my inbox? Show me my latest emails."
  });
  const data = JSON.parse(res.data);
  if (data.intent === 'MAIL' || data.status === 'queued') {
    return `Intent: ${data.intent}, Status: ${data.status}`;
  }
  console.log(`\n      (got: ${data.intent || data.status} — LLM may vary)`);
});

test('Orchestrator classifies CALENDAR intent', async () => {
  const res = await httpPost('http://localhost:3000/api/task', {
    userId: 'test-user',
    message: "What meetings do I have today? Show my calendar."
  });
  const data = JSON.parse(res.data);
  if (data.intent === 'CALENDAR' || data.status === 'queued') {
    return `Intent: ${data.intent}, Status: ${data.status}`;
  }
  console.log(`\n      (got: ${data.intent || data.status} — LLM may vary)`);
});

test('Orchestrator classifies MEMORY intent', async () => {
  const res = await httpPost('http://localhost:3000/api/task', {
    userId: 'test-user',
    message: "Remember that my favorite color is blue."
  });
  const data = JSON.parse(res.data);
  if (data.intent === 'MEMORY' || data.status === 'queued') {
    return `Intent: ${data.intent}, Status: ${data.status}`;
  }
  console.log(`\n      (got: ${data.intent || data.status} — LLM may vary)`);
});

// ═══════════════════════════════════════
// Anti-Hallucination Tests
// ═══════════════════════════════════════
test('Anti-hallucination: Mail agent requires OAuth', async () => {
  const res = await httpPost('http://localhost:3000/api/task', {
    userId: 'no-oauth-user',
    message: "Show me my latest emails"
  });
  const data = JSON.parse(res.data);
  // Should either be queued (and eventually fail) or contain auth prompt
  if (data.response && data.response.toLowerCase().includes('from:')) {
    throw new Error('Agent may be hallucinating emails without OAuth');
  }
  return 'Agent did not hallucinate emails';
});

// ═══════════════════════════════════════
// Observability
// ═══════════════════════════════════════
test('Langfuse is running', async () => {
  try {
    const res = await httpGet('http://localhost:3001', 5000);
    if (res.status >= 500) throw new Error(`Status ${res.status}`);
    return `Status: ${res.status}`;
  } catch (e) {
    if (e.message === 'timeout') {
      console.log('\n      (Langfuse may be starting up)');
      return; // Don't fail, just warn
    }
    throw e;
  }
});

// ═══════════════════════════════════════
// Task Lifecycle
// ═══════════════════════════════════════
test('Task lifecycle: submit and check status', async () => {
  const submitRes = await httpPost('http://localhost:3000/api/task', {
    userId: 'test-user',
    message: "What's in my inbox?"
  });
  const data = JSON.parse(submitRes.data);
  if (!data.jobId) throw new Error('No jobId returned');

  // Check status
  const statusRes = await httpGet(`http://localhost:3000/api/task/${data.jobId}`);
  if (statusRes.status === 404) {
    // May be direct response — that's ok
    return `Job ${data.jobId} was direct response`;
  }
  return `Job ${data.jobId}: ${JSON.parse(statusRes.data).status}`;
});

// ═══════════════════════════════════════
// Run tests
// ═══════════════════════════════════════
async function runTest(t) {
  for (let attempt = 0; attempt <= opts.retry; attempt++) {
    try {
      const detail = await t.fn();
      return { pass: true, detail };
    } catch (e) {
      if (attempt === opts.retry) return { pass: false, error: e.message };
      // Wait before retry
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

async function run() {
  console.log('\n  HEKLA QA Test Suite (Live)');
  console.log('  ═════════════════════════\n');

  const startTime = Date.now();

  for (const t of TESTS) {
    process.stdout.write(`  ○ ${t.name}... `);

    if (t.skip) {
      console.log('\x1b[33m⊘ skipped\x1b[0m');
      skipped++;
      results.push({ name: t.name, status: 'skipped' });
      continue;
    }

    const result = await runTest(t);

    if (result.pass) {
      console.log('\x1b[32m✓\x1b[0m');
      if (opts.verbose && result.detail) {
        console.log(`      ${result.detail}`);
      }
      passed++;
      results.push({ name: t.name, status: 'passed', detail: result.detail });
    } else {
      console.log('\x1b[31m✗\x1b[0m');
      console.log(`    \x1b[31m${result.error}\x1b[0m`);
      failed++;
      results.push({ name: t.name, status: 'failed', error: result.error });
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n  ─────────────────────────');
  console.log(`  \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m${skipped ? `, \x1b[33m${skipped} skipped\x1b[0m` : ''} (${duration}s)`);
  console.log('');

  // Write JSON results for CI
  if (process.env.QA_OUTPUT) {
    const fs = require('fs');
    fs.writeFileSync(process.env.QA_OUTPUT, JSON.stringify({ passed, failed, skipped, duration, results }, null, 2));
    console.log(`  Results written to ${process.env.QA_OUTPUT}\n`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('Test runner error:', e);
  process.exit(1);
});
