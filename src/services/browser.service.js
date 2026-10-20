'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const { HttpError, assertSafeUrl } = require('../utils/validation');

const firstLine = (msg = '') => String(msg).split('\n')[0];

/**
 * Manages one shared Chromium instance and many short-lived, isolated sessions
 * (one BrowserContext + Page each). A session lets a workflow chain
 * navigate -> fill -> click -> screenshot across several HTTP calls.
 */
class BrowserService {
  constructor(opts = {}) {
    this.headless = opts.headless !== false;
    this.noSandbox = Boolean(opts.noSandbox);
    this.maxSessions = opts.maxSessions || 5;
    this.sessionTtlMs = opts.sessionTtlMs || 5 * 60 * 1000;
    this.defaultTimeoutMs = opts.defaultTimeoutMs || 15000;
    this.screenshotsDir = path.resolve(opts.screenshotsDir || 'screenshots');
    this.policy = opts.policy || {};

    this.browser = null;
    this.launching = null;
    this.pending = 0;
    this.sessions = new Map();

    this.sweeper = setInterval(() => this.sweep(), 30000);
    this.sweeper.unref();
  }

  sessionCount() {
    return this.sessions.size;
  }

  async getBrowser() {
    if (this.browser && this.browser.isConnected()) return this.browser;
    if (!this.launching) {
      this.launching = chromium
        .launch({ headless: this.headless, args: this.noSandbox ? ['--no-sandbox'] : [] })
        .then((b) => {
          this.browser = b;
          b.on('disconnected', () => {
            this.browser = null;
            this.sessions.clear();
          });
          return b;
        })
        .finally(() => {
          this.launching = null;
        });
    }
    return this.launching;
  }

  async createSession() {
    if (this.sessions.size + this.pending >= this.maxSessions) {
      throw new HttpError(429, 'Too many active sessions, close one or wait for it to expire');
    }
    this.pending += 1;
    try {
      const browser = await this.getBrowser();
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        acceptDownloads: false,
        serviceWorkers: 'block',
      });

      // Re-check every request (redirects, sub-resources, XHR) against the SSRF policy.
      await context.route('**/*', async (route) => {
        const req = route.request();
        const url = req.url();
        if (/^(data|blob|about):/i.test(url)) return route.continue();
        try {
          await assertSafeUrl(url, {
            allowPrivate: this.policy.allowPrivate,
            allowedDomains: req.isNavigationRequest() ? this.policy.allowedDomains : [],
          });
          await route.continue();
        } catch {
          await route.abort('blockedbyclient').catch(() => {});
        }
      });

      const page = await context.newPage();
      const id = crypto.randomUUID();
      this.sessions.set(id, { id, context, page, lastUsed: Date.now(), queue: Promise.resolve() });
      return id;
    } finally {
      this.pending -= 1;
    }
  }

  /** Runs fn(session) serialised per session so parallel calls cannot interleave. */
  withSession(id, fn) {
    const s = this.sessions.get(id);
    if (!s) throw new HttpError(404, 'Session not found or expired');
    const run = s.queue.then(() => {
      s.lastUsed = Date.now();
      return fn(s);
    });
    s.queue = run.catch(() => {});
    return run;
  }

  async closeSession(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    this.sessions.delete(id);
    await s.context.close().catch(() => {});
    return true;
  }

  async sweep() {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.lastUsed > this.sessionTtlMs) await this.closeSession(id);
    }
  }

  async close() {
    clearInterval(this.sweeper);
    for (const id of [...this.sessions.keys()]) await this.closeSession(id);
    if (this.browser) await this.browser.close().catch(() => {});
    this.browser = null;
  }

  /* ------------------------------- Actions ------------------------------- */

  async navigate({ url, sessionId, waitUntil = 'load', timeoutMs }) {
    let id = sessionId;
    let created = false;
    if (!id) {
      id = await this.createSession();
      created = true;
    }
    try {
      return await this.withSession(id, async ({ page }) => {
        let response;
        try {
          response = await page.goto(url, { waitUntil, timeout: timeoutMs || this.defaultTimeoutMs });
        } catch (err) {
          if (err.name === 'TimeoutError') throw err;
          throw new HttpError(502, `Navigation failed: ${firstLine(err.message)}`);
        }
        return {
          sessionId: id,
          url: page.url(),
          title: await page.title(),
          status: response ? response.status() : null,
        };
      });
    } catch (err) {
      if (created) await this.closeSession(id);
      throw err;
    }
  }

  click({ sessionId, selector, timeoutMs }) {
    return this.withSession(sessionId, async ({ page }) => {
      await page.click(selector, { timeout: timeoutMs || this.defaultTimeoutMs });
      return { sessionId, url: page.url(), title: await page.title() };
    });
  }

  fill({ sessionId, selector, value, timeoutMs }) {
    return this.withSession(sessionId, async ({ page }) => {
      await page.fill(selector, value, { timeout: timeoutMs || this.defaultTimeoutMs });
      return { sessionId, filled: selector };
    });
  }

  upload({ sessionId, selector, filename, mimeType, contentBase64, timeoutMs }) {
    return this.withSession(sessionId, async ({ page }) => {
      const buffer = Buffer.from(contentBase64, 'base64');
      await page.setInputFiles(
        selector,
        { name: filename, mimeType, buffer },
        { timeout: timeoutMs || this.defaultTimeoutMs },
      );
      return { sessionId, uploaded: filename, bytes: buffer.length };
    });
  }

  screenshot({ sessionId, selector, fullPage, type = 'png', response = 'base64', timeoutMs }) {
    return this.withSession(sessionId, async ({ page }) => {
      const timeout = timeoutMs || this.defaultTimeoutMs;
      const buf = selector
        ? await page.locator(selector).first().screenshot({ type, timeout })
        : await page.screenshot({ type, fullPage, timeout });
      const mimeType = type === 'jpeg' ? 'image/jpeg' : 'image/png';

      if (response === 'file') {
        await fs.mkdir(this.screenshotsDir, { recursive: true });
        const file = `${Date.now()}-${sessionId.slice(0, 8)}.${type === 'jpeg' ? 'jpg' : 'png'}`;
        await fs.writeFile(path.join(this.screenshotsDir, file), buf);
        return { sessionId, file, downloadPath: `/browser/screenshots/${file}`, mimeType, bytes: buf.length };
      }
      return { sessionId, mimeType, bytes: buf.length, base64: buf.toString('base64') };
    });
  }
}

module.exports = { BrowserService };
