const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || 'http://orchestrator:3010';

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'gateway' });
});

// Main task endpoint - proxies to orchestrator
app.post('/api/task', async (req, res) => {
  try {
    const { userId, message, context } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    const response = await axios.post(`${ORCHESTRATOR_URL}/task`, {
      userId,
      message,
      context
    });

    res.json(response.data);
  } catch (error) {
    console.error('Gateway error:', error.message);
    res.status(500).json({
      error: 'Failed to process task',
      details: error.response?.data || error.message
    });
  }
});

// Get task status
app.get('/api/task/:jobId', async (req, res) => {
  try {
    const response = await axios.get(`${ORCHESTRATOR_URL}/task/${req.params.jobId}`);
    res.json(response.data);
  } catch (error) {
    console.error('Gateway error:', error.message);
    res.status(500).json({ error: 'Failed to get task status' });
  }
});

// Model management endpoints (Phase 4)
app.get('/api/models', async (req, res) => {
  try {
    const response = await axios.get(`${process.env.OLLAMA_URL}/api/tags`);
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to list models' });
  }
});

app.listen(PORT, () => {
  console.log(`HEKLA Gateway running on port ${PORT}`);
});
