const { Worker } = require('bullmq');
const Redis = require('ioredis');
const axios = require('axios');
const { Pool } = require('pg');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://ollama:11434';
const ACTIVE_MODEL = process.env.ACTIVE_MODEL || 'qwen2.5:14b';
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || 'http://orchestrator:3010';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379');

// Fetch calendar events from Microsoft Graph
async function fetchCalendarEvents(accessToken) {
  const now = new Date();
  const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  try {
    const response = await axios.get(
      `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${now.toISOString()}&endDateTime=${weekFromNow.toISOString()}&$orderby=start/dateTime`,
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

// Create calendar event
async function createEvent(accessToken, eventData) {
  const response = await axios.post(
    'https://graph.microsoft.com/v1.0/me/events',
    eventData,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return response.data;
}

// Process with LLM
async function processWithLLM(events, userMessage) {
  const eventSummary = events.map(e => ({
    subject: e.subject,
    start: e.start?.dateTime,
    end: e.end?.dateTime,
    location: e.location?.displayName
  }));

  const response = await axios.post(`${OLLAMA_URL}/api/chat`, {
    model: ACTIVE_MODEL,
    messages: [{
      role: 'system',
      content: `You are a calendar assistant. Help the user understand their schedule, find free time, and answer scheduling questions.
Here are the upcoming events for the next 7 days:
${JSON.stringify(eventSummary, null, 2)}

If the user wants to create an event or block time, respond with JSON in this format:
{"action": "create", "subject": "...", "start": "ISO date", "end": "ISO date"}
Otherwise, just provide a helpful text response.`
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
     VALUES (gen_random_uuid(), $1, 'calendar', $2, $3, $4, NOW())`,
    [userId, JSON.stringify(input), JSON.stringify({ response: output }), status]
  );
}

const worker = new Worker('hekla:calendar', async (job) => {
  const { jobId, userId, message } = job.data;
  console.log(`[${new Date().toISOString()}] Calendar agent processing job: ${jobId}`);

  try {
    const tokenResult = await pool.query(
      `SELECT access_token FROM oauth_tokens
       WHERE client_id = $1 AND provider = 'microsoft'
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );

    if (!tokenResult.rows[0]) {
      const response = 'I cannot access your calendar yet. Please connect your Microsoft account first.';
      await saveResult(jobId, userId, { message }, response, 'completed');
      await notifyOrchestrator(jobId, response);
      return;
    }

    const accessToken = tokenResult.rows[0].access_token;
    const events = await fetchCalendarEvents(accessToken);
    const response = await processWithLLM(events, message);

    // Check if LLM wants to create an event
    try {
      const parsed = JSON.parse(response);
      if (parsed.action === 'create') {
        await createEvent(accessToken, {
          subject: parsed.subject,
          start: { dateTime: parsed.start, timeZone: 'UTC' },
          end: { dateTime: parsed.end, timeZone: 'UTC' }
        });
        const finalResponse = `I've created the event: "${parsed.subject}"`;
        await saveResult(jobId, userId, { message }, finalResponse, 'completed');
        await notifyOrchestrator(jobId, finalResponse);
        return;
      }
    } catch {
      // Not JSON, just a text response
    }

    await saveResult(jobId, userId, { message }, response, 'completed');
    await notifyOrchestrator(jobId, response);

    console.log(`[${new Date().toISOString()}] Calendar agent completed job: ${jobId}`);
  } catch (error) {
    console.error(`Calendar agent error: ${error.message}`);
    await notifyOrchestrator(jobId, null, error.message);
  }
}, { connection: redis });

async function notifyOrchestrator(jobId, response, error = null) {
  try {
    await axios.post(`${ORCHESTRATOR_URL}/task/${jobId}/complete`, { response, error });
  } catch (e) {
    console.error('Failed to notify orchestrator:', e.message);
  }
}

worker.on('ready', () => {
  console.log('HEKLA Calendar Agent ready and listening for jobs');
});
