const express = require('express');
const { Queue } = require('bullmq');
const Redis = require('ioredis');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3010;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://ollama:11434';
const ACTIVE_MODEL = process.env.ACTIVE_MODEL || 'qwen2.5:14b';

// Redis connection
const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379');

// Task queues
const mailQueue = new Queue('hekla:mail', { connection: redis });
const calendarQueue = new Queue('hekla:calendar', { connection: redis });
const memoryQueue = new Queue('hekla:memory', { connection: redis });

// In-memory job status (replace with Redis in production)
const jobStatus = new Map();

// Intent classification using local LLM
async function classifyIntent(message) {
  try {
    const response = await axios.post(`${OLLAMA_URL}/api/chat`, {
      model: ACTIVE_MODEL,
      messages: [{
        role: 'system',
        content: `You are an intent classifier. Classify the user message into exactly one category:
- MAIL: Questions about emails, inbox, messages, sending mail
- CALENDAR: Questions about schedule, meetings, events, availability, blocking time
- MEMORY: Questions about past conversations, remembering things, context
- DIRECT: General questions, greetings, or anything that doesn't fit above

Respond with ONLY the category name, nothing else.`
      }, {
        role: 'user',
        content: message
      }],
      stream: false
    });

    const intent = response.data.message.content.trim().toUpperCase();
    const validIntents = ['MAIL', 'CALENDAR', 'MEMORY', 'DIRECT'];
    return validIntents.includes(intent) ? intent : 'DIRECT';
  } catch (error) {
    console.error('Intent classification failed:', error.message);
    return 'DIRECT';
  }
}

// Direct response using local LLM
async function getDirectResponse(message, context) {
  try {
    const response = await axios.post(`${OLLAMA_URL}/api/chat`, {
      model: ACTIVE_MODEL,
      messages: [{
        role: 'system',
        content: 'You are HEKLA, a helpful AI personal assistant. Be concise and helpful.'
      }, {
        role: 'user',
        content: message
      }],
      stream: false
    });
    return response.data.message.content;
  } catch (error) {
    console.error('Direct response failed:', error.message);
    return 'I apologize, but I am having trouble processing your request right now. Please try again.';
  }
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'orchestrator', model: ACTIVE_MODEL });
});

// Main task endpoint
app.post('/task', async (req, res) => {
  const { userId, message, context } = req.body;
  const jobId = uuidv4();

  console.log(`[${new Date().toISOString()}] Task received: ${message.substring(0, 50)}...`);

  try {
    // Classify intent
    const intent = await classifyIntent(message);
    console.log(`[${jobId}] Intent classified as: ${intent}`);

    // Route based on intent
    if (intent === 'DIRECT') {
      const response = await getDirectResponse(message, context);
      return res.json({
        jobId,
        status: 'direct',
        response,
        intent
      });
    }

    // Queue to appropriate agent
    const jobData = { jobId, userId, message, context, createdAt: new Date().toISOString() };

    switch (intent) {
      case 'MAIL':
        await mailQueue.add('process', jobData);
        break;
      case 'CALENDAR':
        await calendarQueue.add('process', jobData);
        break;
      case 'MEMORY':
        await memoryQueue.add('process', jobData);
        break;
    }

    jobStatus.set(jobId, { status: 'queued', intent, createdAt: new Date() });

    res.json({
      jobId,
      status: 'queued',
      intent
    });
  } catch (error) {
    console.error('Orchestrator error:', error.message);
    res.status(500).json({ error: 'Failed to process task', details: error.message });
  }
});

// Get task status
app.get('/task/:jobId', (req, res) => {
  const status = jobStatus.get(req.params.jobId);
  if (!status) {
    return res.status(404).json({ error: 'Job not found' });
  }
  res.json(status);
});

// Update job status (called by agents)
app.post('/task/:jobId/complete', (req, res) => {
  const { response, error } = req.body;
  const status = jobStatus.get(req.params.jobId);

  if (status) {
    status.status = error ? 'failed' : 'completed';
    status.response = response;
    status.error = error;
    status.completedAt = new Date();
    jobStatus.set(req.params.jobId, status);
  }

  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`HEKLA Orchestrator running on port ${PORT}`);
  console.log(`Using model: ${ACTIVE_MODEL}`);
});
