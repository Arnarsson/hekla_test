const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || 'http://orchestrator:3010';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

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

// ─── OAuth Token Management (Electron App → Agents) ───

// Store tokens from Electron OAuth flow
app.post('/api/oauth/token', async (req, res) => {
  try {
    const { userId, provider, accessToken, refreshToken, expiresAt, scopes, account } = req.body;

    if (!accessToken || !provider) {
      return res.status(400).json({ error: 'accessToken and provider are required' });
    }

    // Upsert: update if exists for this user+provider, insert otherwise
    const result = await pool.query(`
      INSERT INTO oauth_tokens (client_id, provider, access_token, refresh_token, expires_at, scopes, updated_at)
      VALUES (
        (SELECT id FROM clients WHERE email = $1 LIMIT 1),
        $2, $3, $4, $5, $6, NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        access_token = EXCLUDED.access_token,
        refresh_token = EXCLUDED.refresh_token,
        expires_at = EXCLUDED.expires_at,
        scopes = EXCLUDED.scopes,
        updated_at = NOW()
      RETURNING id
    `, [userId, provider, accessToken, refreshToken, expiresAt, scopes]);

    res.json({ success: true, tokenId: result.rows[0]?.id });
  } catch (error) {
    console.error('OAuth token store error:', error.message);
    res.status(500).json({ error: 'Failed to store token' });
  }
});

// Check OAuth status for a user
app.get('/api/oauth/status', async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) {
      return res.status(400).json({ error: 'userId query param required' });
    }

    const result = await pool.query(`
      SELECT provider, expires_at, scopes, updated_at
      FROM oauth_tokens
      WHERE client_id = (SELECT id FROM clients WHERE email = $1 LIMIT 1)
      ORDER BY updated_at DESC
      LIMIT 1
    `, [userId]);

    if (result.rows[0]) {
      const token = result.rows[0];
      const expired = token.expires_at && new Date(token.expires_at) < new Date();
      res.json({
        connected: !expired,
        provider: token.provider,
        expiresAt: token.expires_at,
        expired,
      });
    } else {
      res.json({ connected: false });
    }
  } catch (error) {
    console.error('OAuth status error:', error.message);
    res.status(500).json({ error: 'Failed to check OAuth status' });
  }
});

// Revoke tokens for a user
app.delete('/api/oauth/token', async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) {
      return res.status(400).json({ error: 'userId query param required' });
    }

    await pool.query(`
      DELETE FROM oauth_tokens
      WHERE client_id = (SELECT id FROM clients WHERE email = $1 LIMIT 1)
    `, [userId]);

    res.json({ success: true });
  } catch (error) {
    console.error('OAuth revoke error:', error.message);
    res.status(500).json({ error: 'Failed to revoke tokens' });
  }
});

app.listen(PORT, () => {
  console.log(`HEKLA Gateway running on port ${PORT}`);
});
