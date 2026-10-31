const express = require('express');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY || 'change-this-secret';

const BRAVE_PATH = process.env.BRAVE_PATH ||
  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';

const PROFILE_DIR = process.env.PROFILE_DIR ||
  'C:\\BraveProfiles\\youssef\\profile1';

const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');

app.use(express.json({ limit: '10mb' }));

let context = null;
let page = null;
let requestQueue = Promise.resolve();

function enqueue(task) {
  const result = requestQueue.then(task, task);
  requestQueue = result.catch(() => {});
  return result;
}

function authenticate(req, res, next) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const suppliedKey = req.headers['x-api-key'] || bearer;

  if (!suppliedKey || suppliedKey !== API_KEY) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: invalid or missing API key'
    });
  }

  next();
}

function normalizeAction(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid browser action: action must be an object');
  }

  let actionName;
  let data;

  if (typeof input.action === 'string') {
    actionName = input.action;
    data = { ...input };
    delete data.action;
  } else if (typeof input.type === 'string') {
    actionName = input.type;
    data = { ...input };
    delete data.type;
  } else {
    const keys = Object.keys(input);

    if (keys.length !== 1) {
      throw new Error(
        'Invalid browser action format: use { action: "...", ... } or { type: "...", ... }'
      );
    }

    actionName = keys[0];
    const value = input[actionName];

    data = value && typeof value === 'object' && !Array.isArray(value)
      ? { ...value }
      : {};

    if (value !== undefined && (value === null || typeof value !== 'object')) {
      data.value = value;
    }
  }

  const aliases = {
    open: 'navigate',
    open_url: 'navigate',
    goto: 'navigate',
    navigate: 'navigate',
    type: 'fill',
    input: 'fill',
    waitfor: 'waitFor',
    wait_for: 'waitFor',
    pageinfo: 'pageInfo',
    page_info: 'pageInfo',
    close: 'closeBrowser',
    close_browser: 'closeBrowser',
    closebrowser: 'closeBrowser',
    screenshot: 'screenshot',
    extract: 'extract',
    press: 'press',
    click: 'click',
    fill: 'fill',
    select: 'select',
    wait: 'wait',
    back: 'back',
    reload: 'reload'
  };

  const normalizedName = aliases[String(actionName).toLowerCase()];

  if (!normalizedName) {
    throw new Error(`Unsupported action: ${actionName}`);
  }

  if (normalizedName === 'fill') {
    data.value = data.value ?? data.text ?? data.content ?? '';
  }

  if (normalizedName === 'wait') {
    data.ms = data.ms ?? data.time ?? data.milliseconds ?? 1000;
  }

  if (normalizedName === 'navigate') {
    data.url = data.url ?? data.href;
  }

  if (normalizedName === 'press') {
    data.key = data.key ?? data.text;
  }

  return { type: normalizedName, ...data };
}

async function getBrowserPage() {
  if (!context) {
    if (!fs.existsSync(BRAVE_PATH)) {
      throw new Error(`Brave executable not found: ${BRAVE_PATH}`);
    }

    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      executablePath: BRAVE_PATH,
      headless: false,
      viewport: null,
      args: [
        '--start-maximized',
        '--no-first-run',
        '--no-default-browser-check'
      ]
    });

    context.on('close', () => {
      context = null;
      page = null;
    });
  }

  const pages = context.pages();

  page = pages.length
    ? pages[0]
    : await context.newPage();

  return page;
}

async function closeBrowser() {
  if (context) {
    const currentContext = context;

    context = null;
    page = null;

    await currentContext.close();
  }

  return { closed: true };
}

async function runAction(rawAction, index) {
  const action = normalizeAction(rawAction);

  if (action.type === 'closeBrowser') {
    return closeBrowser();
  }

  const currentPage = await getBrowserPage();
  const selector = action.selector;
  const timeout = Number(action.timeout || 15000);

  switch (action.type) {

    case 'navigate': {
      if (typeof action.url !== 'string' || !action.url.trim()) {
        throw new Error('navigate action requires a url');
      }

      const parsed = new URL(action.url);

      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Only http and https URLs are allowed');
      }

      await currentPage.goto(parsed.href, {
        waitUntil: action.waitUntil || 'domcontentloaded',
        timeout
      });

      return {
        url: currentPage.url(),
        title: await currentPage.title()
      };
    }

    case 'click': {
      if (!selector) {
        throw new Error('click action requires selector');
      }

      await currentPage.locator(selector).first().click({ timeout });

      return { clicked: selector };
    }

    case 'fill': {
      if (!selector) {
        throw new Error('fill/type action requires selector');
      }

      await currentPage.locator(selector).first().fill(
        String(action.value),
        { timeout }
      );

      return { filled: selector };
    }

    case 'press': {
      if (!action.key) {
        throw new Error('press action requires key');
      }

      if (selector) {
        await currentPage.locator(selector).first().press(
          String(action.key),
          { timeout }
        );
      } else {
        await currentPage.keyboard.press(String(action.key));
      }

      return {
        pressed: action.key,
        selector: selector || null
      };
    }

    case 'select': {
      if (!selector) {
        throw new Error('select action requires selector');
      }

      const value = action.value ?? action.option;

      if (value === undefined) {
        throw new Error('select action requires value or option');
      }

      await currentPage.locator(selector).first().selectOption(
        String(value),
        { timeout }
      );

      return {
        selected: value,
        selector
      };
    }

    case 'wait': {
      const ms = Math.max(
        0,
        Math.min(Number(action.ms) || 0, 120000)
      );

      await currentPage.waitForTimeout(ms);

      return { waited: ms };
    }

    case 'waitFor': {
      if (selector) {
        await currentPage.locator(selector).first().waitFor({
          state: action.state || 'visible',
          timeout
        });

        return {
          selector,
          state: action.state || 'visible'
        };
      }

      await currentPage.waitForLoadState(
        action.state || 'domcontentloaded',
        { timeout }
      );

      return {
        state: action.state || 'domcontentloaded'
      };
    }

    case 'extract': {
      const target = currentPage.locator(selector || 'body').first();
      const attribute = String(action.attribute || 'innerText');

      let value;

      if (attribute === 'innerText') {
        value = await target.innerText({ timeout });
      } else if (attribute === 'textContent') {
        value = await target.textContent({ timeout });
      } else if (attribute === 'value') {
        value = await target.inputValue({ timeout });
      } else {
        value = await target.getAttribute(attribute, { timeout });
      }

      return {
        selector: selector || 'body',
        attribute,
        value
      };
    }

    case 'pageInfo':
      return {
        url: currentPage.url(),
        title: await currentPage.title()
      };

    case 'screenshot': {
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

      const filename = `screenshot-${Date.now()}-${index + 1}.png`;
      const filepath = path.join(SCREENSHOT_DIR, filename);

      await currentPage.screenshot({
        path: filepath,
        fullPage: Boolean(action.fullPage)
      });

      return {
        screenshot: filepath,
        filename
      };
    }

    case 'back':
      await currentPage.goBack({
        waitUntil: action.waitUntil || 'domcontentloaded',
        timeout
      });

      return { url: currentPage.url() };

    case 'reload':
      await currentPage.reload({
        waitUntil: action.waitUntil || 'domcontentloaded',
        timeout
      });

      return {
        url: currentPage.url(),
        title: await currentPage.title()
      };

    default:
      throw new Error(
        `Unsupported action after normalization: ${action.type}`
      );
  }
}

app.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'online',
    browserOpen: Boolean(context),
    browser: 'Brave',
    headless: false
  });
});

app.post('/execute', authenticate, async (req, res) => {
  try {
    const actions = Array.isArray(req.body.actions)
      ? req.body.actions
      : (req.body.action || req.body.type ? [req.body] : null);

    if (!actions || actions.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Request body must contain a non-empty actions array'
      });
    }

    const results = await enqueue(async () => {
      const output = [];

      for (let i = 0; i < actions.length; i++) {
        try {
          output.push({
            index: i,
            success: true,
            result: await runAction(actions[i], i)
          });
        } catch (error) {
          output.push({
            index: i,
            success: false,
            error: error.message
          });

          throw Object.assign(
            new Error(error.message),
            {
              actionResults: output,
              failedIndex: i
            }
          );
        }
      }

      return output;
    });

    res.json({
      success: true,
      results
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      failedIndex: error.failedIndex ?? null,
      results: error.actionResults || []
    });
  }
});

app.post('/close', authenticate, async (req, res) => {
  try {
    const result = await enqueue(closeBrowser);

    res.json({
      success: true,
      result
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Browser automation server running on http://localhost:${PORT}`);
  console.log('Browser: Brave | Visible window: ON (headless:false)');
  console.log(`Brave executable: ${BRAVE_PATH}`);
  console.log(`Brave profile: ${PROFILE_DIR}`);
});

async function shutdown() {
  try {
    await closeBrowser();
  } catch (error) {
    console.error('Error while closing Brave:', error.message);
  }

  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
