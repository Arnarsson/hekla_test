const { Worker } = require('bullmq');
const Redis = require('ioredis');
const axios = require('axios');
const { Pool } = require('pg');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://ollama:11434';
const ACTIVE_MODEL = process.env.ACTIVE_MODEL || 'qwen2.5:14b';
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || 'http://orchestrator:3010';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379');

// Fetch relevant memories
async function fetchMemories(userId, query) {
  // Simple keyword-based retrieval (upgrade to vector search later)
  const result = await pool.query(
    `SELECT content, memory_type, source, created_at
     FROM memories
     WHERE client_id = $1
     ORDER BY relevance_score DESC, last_accessed DESC
     LIMIT 10`,
    [userId]
  );
  return result.rows;
}

// Store new memory
async function storeMemory(userId, content, memoryType, source) {
  await pool.query(
    `INSERT INTO memories (client_id, content, memory_type, source)
     VALUES ($1, $2, $3, $4)`,
    [userId, content, memoryType, source]
  );
}

// Process with LLM
async function processWithLLM(memories, userMessage) {
  const memoryContext = memories.map(m => `[${m.memory_type}] ${m.content}`).join('\n');

  const response = await axios.post(`${OLLAMA_URL}/api/chat`, {
    model: ACTIVE_MODEL,
    messages: [{
      role: 'system',
      content: `You are a memory assistant. Help the user recall past information and context.
Here are relevant memories:
${memoryContext || 'No memories stored yet.'}

If the user wants to remember something new, respond with:
{"action": "store", "content": "...", "type": "fact|preference|context"}
Otherwise, answer their question about past conversations or stored information.`
    }, {
      role: 'user',
      content: userMessage
    }],
    stream: false
  });

  return response.data.message.content;
}

async function saveResult(jobId, userId, input, output, status) {
  await pool.query(
    `INSERT INTO agent_results (id, user_id, agent_type, input, output, status, completed_at)
     VALUES (gen_random_uuid(), $1, 'memory', $2, $3, $4, NOW())`,
    [userId, JSON.stringify(input), JSON.stringify({ response: output }), status]
  );
}

const worker = new Worker('hekla:memory', async (job) => {
  const { jobId, userId, message } = job.data;
  console.log(`[${new Date().toISOString()}] Memory agent processing job: ${jobId}`);

  try {
    const memories = await fetchMemories(userId, message);
    const response = await processWithLLM(memories, message);

    // Check if LLM wants to store a memory
    try {
      const parsed = JSON.parse(response);
      if (parsed.action === 'store') {
        await storeMemory(userId, parsed.content, parsed.type, 'conversation');
        const finalResponse = `I'll remember that: "${parsed.content}"`;
        await saveResult(jobId, userId, { message }, finalResponse, 'completed');
        await notifyOrchestrator(jobId, finalResponse);
        return;
      }
    } catch {
      // Not JSON, just a text response
    }

    await saveResult(jobId, userId, { message }, response, 'completed');
    await notifyOrchestrator(jobId, response);

    console.log(`[${new Date().toISOString()}] Memory agent completed job: ${jobId}`);
  } catch (error) {
    console.error(`Memory agent error: ${error.message}`);
    await notifyOrchestrator(jobId, null, error.message);
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
  console.log('HEKLA Memory Agent ready and listening for jobs');
});
