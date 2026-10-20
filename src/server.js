'use strict';

require('dotenv').config();
const path = require('node:path');
const express = require('express');
const { createAuth } = require('./middleware/auth');
const { createBrowserRouter } = require('./routes/browser.routes');
const { BrowserService } = require('./services/browser.service');
const { HttpError } = require('./utils/validation');

function createApp({ apiKey, browserService, policy = {} }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10mb' }));

  // Public: used by Docker / uptime checks. Leaks nothing sensitive.
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: Math.round(process.uptime()), sessions: browserService.sessionCount() });
  });

  app.use('/browser', createAuth(apiKey), createBrowserRouter(browserService, policy));

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.name === 'TimeoutError') {
      return res.status(504).json({ error: 'Browser operation timed out', detail: String(err.message).split('\n')[0] });
    }
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT) || 3000,
    host: env.HOST || '127.0.0.1',
    apiKey: env.API_KEY,
    policy: {
      allowPrivate: env.ALLOW_PRIVATE_HOSTS === 'true',
      allowedDomains: (env.ALLOWED_DOMAINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    },
    browser: {
      headless: env.HEADLESS !== 'false',
      noSandbox: env.NO_SANDBOX === 'true',
      maxSessions: Number(env.MAX_SESSIONS) || 5,
      sessionTtlMs: Number(env.SESSION_TTL_MS) || 300000,
      defaultTimeoutMs: Number(env.DEFAULT_TIMEOUT_MS) || 15000,
      screenshotsDir: path.resolve(env.SCREENSHOTS_DIR || 'screenshots'),
    },
  };
}

if (require.main === module) {
  const cfg = loadConfig();
  if (!cfg.apiKey || cfg.apiKey.length < 16) {
    console.error('API_KEY is missing or shorter than 16 characters. Copy .env.example to .env and set it.');
    process.exit(1);
  }

  const service = new BrowserService({ ...cfg.browser, policy: cfg.policy });
  const app = createApp({ apiKey: cfg.apiKey, browserService: service, policy: cfg.policy });
  const server = app.listen(cfg.port, cfg.host, () => {
    console.log(`Playwright bridge listening on http://${cfg.host}:${cfg.port}`);
    if (cfg.policy.allowPrivate) console.warn('WARNING: ALLOW_PRIVATE_HOSTS=true, SSRF protection is off');
  });

  const shutdown = async () => {
    server.close();
    await service.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createApp, loadConfig };
