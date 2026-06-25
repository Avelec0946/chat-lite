const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();

// Load config
const configPath = path.join(__dirname, 'config.json');
let config = {};
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
} catch (e) {
  console.error('Failed to load config.json:', e.message);
  process.exit(1);
}

// Large body for 1M context
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname)));

// CORS for local dev
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// POST /api/chat/completions — proxy to DeepSeek API
app.post('/api/chat/completions', async (req, res) => {
  const {
    messages,
    model,
    apiKey: reqApiKey,
    baseUrl: reqBaseUrl,
    stream = true,
    thinkingEnabled = true
  } = req.body;
  // Client sends baseUrl + apiKey; fallback to env var or server config
  const apiKey = reqApiKey || process.env.API_KEY || config.apiKey;
  const apiBaseUrl = reqBaseUrl || config.apiBaseUrl;

  if (!apiKey) {
    return res.status(400).json({ error: 'API key not configured.' });
  }
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required.' });
  }

  const payload = {
    model: model || config.defaultModel,
    messages,
    stream: true,
    max_tokens: config.maxTokens || 4096,
    temperature: config.temperature ?? 0.7,
    ...config.extraParams
  };

  // Toggle thinking on/off
  if (!thinkingEnabled) {
    payload.thinking = { type: 'disabled' };
  }

  try {
    const response = await fetch(`${apiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    // If error, forward the status and body
    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({
        error: `DeepSeek API error (${response.status})`,
        detail: errorText
      });
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // Stream the response directly
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(decoder.decode(value, { stream: true }));
      }
      res.end();
    } catch (streamErr) {
      // Client disconnected — not an error
      if (streamErr.name === 'AbortError') return;
      console.error('Stream error:', streamErr.message);
      res.end();
    }

  } catch (err) {
    console.error('Proxy error:', err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: `Proxy error: ${err.message}` });
    }
  }
});

// GET /api/config — expose safe config to client
app.get('/api/config', (req, res) => {
  res.json({
    models: config.models || [],
    defaultModel: config.defaultModel || 'deepseek-v4-flash',
    maxTokens: config.maxTokens || 4096
  });
});

// Save conversations to server (跨设备同步)
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

app.post('/api/save', (req, res) => {
  try {
    const { conversations, currentId, key, deletedIds } = req.body;
    const fileKey = (key || 'default').replace(/[^a-zA-Z0-9_-]/g, '');
    const filePath = path.join(DATA_DIR, `conversations_${fileKey}.json`);
    fs.writeFileSync(filePath, JSON.stringify({ conversations, currentId, deletedIds, savedAt: Date.now() }, null, 2));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/load', (req, res) => {
  try {
    const key = (req.query.key || 'default').replace(/[^a-zA-Z0-9_-]/g, '');
    const filePath = path.join(DATA_DIR, `conversations_${key}.json`);
    if (!fs.existsSync(filePath)) {
      return res.json({ conversations: [], currentId: null });
    }
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    res.json({ conversations: data.conversations || [], currentId: data.currentId || null, deletedIds: data.deletedIds || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = config.port || 3000;
const HTTPS_PORT = PORT + 1;  // e.g. 7001 for HTTPS

// HTTP server (keep for backwards compat)
const httpServer = http.createServer(app);
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP  at http://localhost:${PORT}`);
});

// HTTPS server (for PWA install support)
try {
  const certPath = path.join(__dirname, 'certs', 'cert.pem');
  const keyPath = path.join(__dirname, 'certs', 'key.pem');
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    const httpsOpts = {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath)
    };
    const httpsServer = https.createServer(httpsOpts, app);
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`HTTPS at https://localhost:${HTTPS_PORT}`);
      console.log(`PWA ready: https://<ip>:${HTTPS_PORT}`);
    });
  } else {
    console.log('No SSL certs found, HTTPS not available');
  }
} catch(e) {
  console.log('HTTPS start failed:', e.message);
}
