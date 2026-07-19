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

// Provider templates for third-party aggregation platforms
const PROVIDER_TEMPLATES = {
  openai: {
    endpointPath: '/v1/chat/completions',
    authType: 'bearer',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    modelsEndpoint: '/v1/models',
    features: { supportsStreaming: true, supportsThinking: false, supportsVision: true, maxTokensField: 'max_tokens' }
  },
  deepseek: {
    endpointPath: '/v1/chat/completions',
    authType: 'bearer',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    modelsEndpoint: '/v1/models',
    features: { supportsStreaming: true, supportsThinking: true, supportsVision: false, maxTokensField: 'max_tokens' }
  },
  azure: {
    endpointPath: '/openai/deployments/{model}/chat/completions',
    authType: 'api-key',
    authHeader: 'api-key',
    authPrefix: '',
    modelsEndpoint: '/v1/models',
    features: { supportsStreaming: true, supportsThinking: false, supportsVision: true, maxTokensField: 'max_tokens' }
  },
  custom: {
    endpointPath: '/v1/chat/completions',
    authType: 'bearer',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    modelsEndpoint: '/v1/models',
    features: { supportsStreaming: true, supportsThinking: false, supportsVision: true, maxTokensField: 'max_tokens' }
  }
};

function resolveTemplate(str, vars) {
  return str.replace(/\{(\w+)\}/g, (m, k) => vars[k] !== undefined ? vars[k] : m);
}

function normalizeBaseUrl(url) {
  return (url || '').replace(/\/+$/, '');
}

function normalizeProvider(provider) {
  // Backwards compat: legacy requests send baseUrl + apiKey directly
  if (!provider || typeof provider !== 'object') {
    provider = {};
  }
  const templateKey = provider.template || 'openai';
  const template = PROVIDER_TEMPLATES[templateKey] || PROVIDER_TEMPLATES.openai;
  const baseUrl = normalizeBaseUrl(provider.baseUrl || config.apiBaseUrl || '');
  const apiKey = provider.apiKey || process.env.API_KEY || config.apiKey;
  return {
    template: templateKey,
    baseUrl,
    endpointPath: provider.endpointPath || template.endpointPath,
    apiKey,
    authType: provider.authType || template.authType,
    authHeader: provider.authHeader || template.authHeader,
    authPrefix: provider.authPrefix !== undefined ? provider.authPrefix : template.authPrefix,
    extraHeaders: provider.extraHeaders || {},
    extraQuery: provider.extraQuery || {},
    features: { ...template.features, ...(provider.features || {}) }
  };
}

function buildUpstreamRequest(provider, body) {
  const p = normalizeProvider(provider);
  if (!p.baseUrl) throw new Error('Provider base URL is required.');
  if (!p.apiKey) throw new Error('API key not configured.');

  const url = new URL(resolveTemplate(p.endpointPath, {
    model: body.model,
    apiVersion: body.apiVersion || p.extraQuery['api-version'] || '2024-06-01'
  }), p.baseUrl);

  Object.entries(p.extraQuery || {}).forEach(([k, v]) => url.searchParams.set(k, v));

  const headers = { 'Content-Type': 'application/json', ...(p.extraHeaders || {}) };
  if (p.authType === 'bearer') {
    headers[p.authHeader] = (p.authPrefix || 'Bearer ') + p.apiKey;
  } else if (p.authType === 'api-key') {
    headers[p.authHeader] = p.apiKey;
  } else if (p.authType === 'header') {
    headers[p.authHeader] = (p.authPrefix || '') + p.apiKey;
  } else if (p.authType === 'query') {
    url.searchParams.set(p.authHeader || 'api_key', p.apiKey);
  }

  const payload = { ...body };
  // Convert thinkingEnabled flag to thinking field
  // Respect user's explicit choice: if they turned off thinking, send disabled flag
  // even for platforms that don't natively support it (aggregators may forward it)
  if (payload.thinkingEnabled === false) {
    payload.thinking = { type: 'disabled' };
  } else {
    delete payload.thinking;
  }
  delete payload.thinkingEnabled;
  delete payload.baseUrl;
  delete payload.apiKey;
  delete payload.provider;
  delete payload.apiVersion;

  // Don't strip thinking field — let upstream API decide
  if (p.features.maxTokensField && p.features.maxTokensField !== 'max_tokens' && payload.max_tokens !== undefined) {
    payload[p.features.maxTokensField] = payload.max_tokens;
    delete payload.max_tokens;
  }

  return { url: url.toString(), headers, payload };
}

// POST /api/chat/completions — proxy to upstream API (supports first-party & third-party platforms)
app.post('/api/chat/completions', async (req, res) => {
  const {
    messages,
    model,
    provider: reqProvider,
    apiKey: reqApiKey,
    baseUrl: reqBaseUrl,
    stream = true,
    thinkingEnabled = true
  } = req.body;

  // Backwards compat: construct provider from legacy fields if needed
  const providerConfig = reqProvider || {
    baseUrl: reqBaseUrl || config.apiBaseUrl,
    apiKey: reqApiKey,
    template: 'openai'
  };

  try {
    const provider = normalizeProvider(providerConfig);

    if (!provider.apiKey) {
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
      ...config.extraParams,
      thinkingEnabled
    };

    // Toggle thinking on/off — respect user's choice even for aggregators
    if (!thinkingEnabled) {
      payload.thinking = { type: 'disabled' };
    }

    const { url, headers, payload: upstreamPayload } = buildUpstreamRequest(provider, payload);

    console.log('Proxy upstream:', url, '(provider:', provider.template, ')');

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(upstreamPayload)
    });

    // If error, forward the status and body
    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({
        error: `Upstream API error (${response.status})`,
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
