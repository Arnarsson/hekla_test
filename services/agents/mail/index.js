const { Worker } = require('bullmq');
const Redis = require('ioredis');
const axios = require('axios');
const { Pool } = require('pg');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://ollama:11434';
const ACTIVE_MODEL = process.env.ACTIVE_MODEL || 'qwen2.5:14b';
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || 'http://orchestrator:3010';

// Database connection
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Redis connection
const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379');

// Fetch emails from Microsoft Graph
async function fetchEmails(accessToken) {
  try {
    const response = await axios.get(
      'https://graph.microsoft.com/v1.0/me/messages?$top=10&$orderby=receivedDateTime desc',
      {
        headers: { Authorization: `Bearer ${accessToken}` }
      }
    );
    return response.data.value;
  } catch (error) {
    if (error.response?.status === 401) {
      throw new Error('TOKEN_EXPIRED');
    }
    throw error;
  }
}

// Process with LLM
async function processWithLLM(emails, userMessage) {
  const emailSummary = emails.map(e => ({
    from: e.from?.emailAddress?.address,
    subject: e.subject,
    preview: e.bodyPreview?.substring(0, 200),
    received: e.receivedDateTime
  }));

  const response = await axios.post(`${OLLAMA_URL}/api/chat`, {
    model: ACTIVE_MODEL,
    messages: [{
      role: 'system',
      content: `You are a mail assistant. Summarize, triage, and answer questions about the user's inbox.
Here are the recent emails:
${JSON.stringify(emailSummary, null, 2)}`
    }, {
      role: 'user',
      content: userMessage
    }],
    stream: false
  });

  return response.data.message.content;
}

// Save result to database
async function saveResult(jobId, userId, input, output, status) {
  await pool.query(
    `INSERT INTO agent_results (id, user_id, agent_type, input, output, status, completed_at)
     VALUES (gen_random_uuid(), $1, 'mail', $2, $3, $4, NOW())`,
    [userId, JSON.stringify(input), JSON.stringify({ response: output }), status]
  );
}

// Worker processor
const worker = new Worker('hekla:mail', async (job) => {
  const { jobId, userId, message, context } = job.data;
  console.log(`[${new Date().toISOString()}] Mail agent processing job: ${jobId}`);

  try {
    // Get OAuth token from database
    const tokenResult = await pool.query(
      `SELECT access_token FROM oauth_tokens
       WHERE client_id = $1 AND provider = 'microsoft'
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );

    if (!tokenResult.rows[0]) {
      const response = 'I cannot access your emails yet. Please connect your Microsoft account first.';
      await saveResult(jobId, userId, { message }, response, 'completed');
      await notifyOrchestrator(jobId, response);
      return;
    }

    const accessToken = tokenResult.rows[0].access_token;

    // Fetch and process emails
    const emails = await fetchEmails(accessToken);
    const response = await processWithLLM(emails, message);

    await saveResult(jobId, userId, { message }, response, 'completed');
    await notifyOrchestrator(jobId, response);

    console.log(`[${new Date().toISOString()}] Mail agent completed job: ${jobId}`);
  } catch (error) {
    console.error(`Mail agent error: ${error.message}`);

    if (error.message === 'TOKEN_EXPIRED') {
      await notifyOrchestrator(jobId, null, 'TOKEN_EXPIRED: Please re-authorize your Microsoft account.');
    } else {
      await notifyOrchestrator(jobId, null, error.message);
    }
  }
}, {
  connection: redis,
  concurrency: 1, // Serial processing — one job at a time, no parallelism
  lockDuration: 120000, // 2 min lock for LLM inference time
});

async function notifyOrchestrator(jobId, response, error = null) {
  try {
    await axios.post(`${ORCHESTRATOR_URL}/task/${jobId}/complete`, { response, error });
  } catch (e) {
    console.error('Failed to notify orchestrator:', e.message);
  }
}

worker.on('ready', () => {
  console.log('HEKLA Mail Agent ready and listening for jobs');
});

worker.on('failed', (job, err) => {
  console.error(`Job ${job.id} failed:`, err.message);
});
