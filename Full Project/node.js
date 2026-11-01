
const express = require('express');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const app = express();

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY || 'change-this-secret';

const BRAVE_PATH =
  process.env.BRAVE_PATH ||
  String.raw`C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe`;

const PROFILE_DIR =
  process.env.PROFILE_DIR ||
  String.raw`C:\BraveProfiles\youssef\profile1`;

const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');

const MAX_EVENTS = 40;
const DEFAULT_TIMEOUT = 15000;

app.use(express.json({ limit: '15mb' }));

let context = null;
let page = null;
let requestQueue = Promise.resolve();

let browserEvents = [];
let dialogEvents = [];

// ==================================================
// QUEUE
// ==================================================

function enqueue(task) {
  const result = requestQueue.then(task, task);
  requestQueue = result.catch(() => {});
  return result;
}

// ==================================================
// AUTH
// ==================================================

function authenticate(req, res, next) {
  const bearer = (req.headers.authorization || '')
    .replace(/^Bearer\s+/i, '');

  const key = req.headers['x-api-key'] || bearer;

  if (!key || key !== API_KEY) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized'
    });
  }

  next();
}

// ==================================================
// EVENT LOGGER
// ==================================================

function addEvent(type, details = {}) {
  browserEvents.push({
    type,
    timestamp: new Date().toISOString(),
    ...details
  });

  if (browserEvents.length > MAX_EVENTS) {
    browserEvents = browserEvents.slice(-MAX_EVENTS);
  }
}

function attachPageListeners(targetPage) {
  targetPage.on('console', message => {
    if (message.type() === 'error') {
      addEvent('console_error', {
        message: message.text()
      });
    }
  });

  targetPage.on('pageerror', error => {
    addEvent('page_error', {
      message: error.message
    });
  });

  targetPage.on('requestfailed', request => {
    addEvent('request_failed', {
      url: request.url(),
      method: request.method(),
      error: request.failure()?.errorText || 'Unknown'
    });
  });

  targetPage.on('crash', () => {
    addEvent('page_crashed');
  });

  targetPage.on('framenavigated', frame => {
    if (frame === targetPage.mainFrame()) {
      addEvent('navigation', {
        url: frame.url()
      });
    }
  });

  targetPage.on('dialog', async dialog => {
    const item = {
      type: dialog.type(),
      message: dialog.message()
    };

    dialogEvents.push(item);

    if (dialogEvents.length > 20) {
      dialogEvents.shift();
    }

    addEvent('dialog', item);

    // Do not leave the browser blocked by a native dialog.
    // Dismiss by default; the Agent can inspect the returned event.
    try {
      await dialog.dismiss();
    } catch (_) {}
  });
}

// ==================================================
// BROWSER MANAGEMENT
// ==================================================

async function getBrowserPage() {
  if (!context) {
    if (!fs.existsSync(BRAVE_PATH)) {
      throw new Error(`Brave not found: ${BRAVE_PATH}`);
    }

    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

    context = await chromium.launchPersistentContext(
      PROFILE_DIR,
      {
        executablePath: BRAVE_PATH,
        headless: false,
        viewport: null,
        acceptDownloads: true,
        args: [
          '--start-maximized',
          '--no-first-run',
          '--no-default-browser-check'
        ]
      }
    );

    context.on('page', newPage => {
      page = newPage;
      attachPageListeners(newPage);
      addEvent('new_page', {
        url: newPage.url()
      });
    });

    context.on('close', () => {
      context = null;
      page = null;
      addEvent('browser_closed');
    });

    for (const existingPage of context.pages()) {
      attachPageListeners(existingPage);
    }
  }

  if (page && !page.isClosed()) {
    return page;
  }

  const pages = context.pages();

  page = pages.length
    ? pages[pages.length - 1]
    : await context.newPage();

  return page;
}

async function closeBrowser() {
  if (!context) {
    return {
      closed: true,
      alreadyClosed: true
    };
  }

  const oldContext = context;

  context = null;
  page = null;

  await oldContext.close();

  return { closed: true };
}

// ==================================================
// HUMAN INTERVENTION DETECTION
// ==================================================

function detectHumanIntervention(info) {
  const text = [
    info.url || '',
    info.title || '',
    info.text || ''
  ].join(' ').toLowerCase();

  const patterns = [
    {
      type: 'captcha',
      words: [
        'captcha',
        'recaptcha',
        'hcaptcha',
        'verify you are human',
        'prove you are human',
        'robot check',
        'unusual traffic'
      ],
      message:
        'A CAPTCHA or bot verification is required. Please complete it manually in Brave.'
    },
    {
      type: 'two_factor',
      words: [
        'two-factor',
        'two factor',
        'verification code',
        'one-time password',
        'one time password',
        'authenticator code',
        'enter code',
        'otp'
      ],
      message:
        'A verification code is required. Please complete the verification manually.'
    },
    {
      type: 'login',
      words: [
        'sign in',
        'log in',
        'login',
        'password',
        'forgot password'
      ],
      message:
        'The website appears to require login. Please sign in manually in Brave. Do not send your password in chat.'
    },
    {
      type: 'access_denied',
      words: [
        'access denied',
        'access forbidden',
        'account suspended',
        'account locked',
        'temporarily blocked'
      ],
      message:
        'The website has restricted access. Human review may be required.'
    }
  ];

  for (const pattern of patterns) {
    if (pattern.words.some(word => text.includes(word))) {
      return {
        required: true,
        type: pattern.type,
        message: pattern.message
      };
    }
  }

  return {
    required: false,
    type: null,
    message: null
  };
}

// ==================================================
// PAGE INSPECTION
// ==================================================

async function inspectPage(currentPage) {
  const data = await currentPage.evaluate(() => {
    const clean = value =>
      String(value || '').replace(/\s+/g, ' ').trim();

    const links = Array.from(
      document.querySelectorAll('a[href]')
    )
      .map(a => ({
        text: clean(a.innerText || a.textContent),
        href: a.href,
        visible: !!(
          a.offsetWidth ||
          a.offsetHeight ||
          a.getClientRects().length
        )
      }))
      .filter(x => x.text || x.href)
      .slice(0, 150);

    const buttons = Array.from(
      document.querySelectorAll(
        'button, input[type="button"], input[type="submit"], [role="button"]'
      )
    )
      .map(el => ({
        text: clean(
          el.innerText ||
          el.textContent ||
          el.getAttribute('aria-label') ||
          el.value
        ),
        disabled: !!el.disabled,
        visible: !!(
          el.offsetWidth ||
          el.offsetHeight ||
          el.getClientRects().length
        )
      }))
      .slice(0, 100);

    const inputs = Array.from(
      document.querySelectorAll('input, textarea, select')
    )
      .map(el => ({
        tag: el.tagName.toLowerCase(),
        type: el.type || null,
        name: el.name || null,
        placeholder: el.placeholder || null,
        ariaLabel: el.getAttribute('aria-label'),
        required: !!el.required,
        visible: !!(
          el.offsetWidth ||
          el.offsetHeight ||
          el.getClientRects().length
        )
      }))
      .slice(0, 80);

    const headings = Array.from(
      document.querySelectorAll('h1, h2, h3')
    )
      .map(el => clean(el.innerText))
      .filter(Boolean)
      .slice(0, 50);

    const bodyText = clean(
      document.body?.innerText || ''
    ).slice(0, 12000);

    return {
      title: document.title,
      url: location.href,
      headings,
      links,
      buttons,
      inputs,
      text: bodyText
    };
  });

  return {
    ...data,
    humanIntervention: detectHumanIntervention(data)
  };
}

// ==================================================
// PAGE STATE
// ==================================================

async function getPageState() {
  if (!context) {
    return {
      browserOpen: false,
      tabs: []
    };
  }

  const tabs = [];

  for (let i = 0; i < context.pages().length; i++) {
    const tab = context.pages()[i];

    tabs.push({
      index: i,
      active: tab === page,
      closed: tab.isClosed(),
      url: tab.isClosed() ? null : tab.url(),
      title: tab.isClosed() ? null : await tab.title().catch(() => null)
    });
  }

  let current = null;

  if (page && !page.isClosed()) {
    current = {
      url: page.url(),
      title: await page.title().catch(() => null)
    };
  }

  return {
    browserOpen: true,
    current,
    tabs
  };
}

// ==================================================
// SCREENSHOT
// ==================================================

async function captureScreenshot(currentPage) {
  try {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

    const filename = `diagnostic-${Date.now()}.jpg`;
    const filepath = path.join(SCREENSHOT_DIR, filename);

    const buffer = await currentPage.screenshot({
      type: 'jpeg',
      quality: 55,
      fullPage: false,
      timeout: 10000
    });

    fs.writeFileSync(filepath, buffer);

    return {
      filename,
      path: filepath,
      mimeType: 'image/jpeg',
      base64: buffer.toString('base64')
    };
  } catch (error) {
    return {
      error: error.message
    };
  }
}

// ==================================================
// ERROR DIAGNOSTICS
// ==================================================

async function buildDiagnostics(error, action) {
  let currentPage = page;

  if (!currentPage || currentPage.isClosed()) {
    return {
      error: error.message,
      action,
      browserOpen: Boolean(context),
      humanIntervention: {
        required: false
      },
      recentEvents: browserEvents.slice(-15)
    };
  }

  const state = await currentPage.evaluate(() => ({
    url: location.href,
    title: document.title,
    text: (document.body?.innerText || '')
      .replace(/\s+/g, ' ')
      .slice(0, 6000)
  })).catch(() => ({
    url: currentPage.url(),
    title: null,
    text: ''
  }));

  const human = detectHumanIntervention(state);

  const screenshot = await captureScreenshot(currentPage);

  return {
    error: error.message,
    failedAction: action,
    page: state,
    humanIntervention: human,
    screenshot,
    recentEvents: browserEvents.slice(-15),
    dialogEvents: dialogEvents.slice(-10),
    suggestedNextStep: human.required
      ? human.message
      : 'Inspect the page state and choose a safe alternative action.'
  };
}

// ==================================================
// ACTION NORMALIZATION
// ==================================================

function normalizeAction(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid browser action');
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
      throw new Error('Invalid browser action format');
    }

    actionName = keys[0];
    const value = input[actionName];

    data =
      value && typeof value === 'object' && !Array.isArray(value)
        ? { ...value }
        : { value };
  }

  const name = String(actionName).toLowerCase();

  const aliases = {
    open: 'navigate',
    open_url: 'navigate',
    goto: 'navigate',
    navigate: 'navigate',

    type: 'fill',
    input: 'fill',
    fill: 'fill',

    keypress: 'press',
    keyboard: 'press',
    press: 'press',

    scroll: 'scroll',
    scroll_up: 'scroll',
    scroll_down: 'scroll',

    inspect: 'inspectPage',
    inspect_page: 'inspectPage',
    inspectpage: 'inspectPage',

    page_state: 'getPageState',
    getpagestate: 'getPageState',

    evaluate: 'evaluate',
    execute_js: 'evaluate',

    hover: 'hover',
    check: 'check',
    uncheck: 'uncheck',

    wait: 'wait',
    waitfor: 'waitFor',
    wait_for: 'waitFor',

    extract: 'extract',
    screenshot: 'screenshot',

    click: 'click',
    select: 'select',
    upload: 'upload',
    download: 'download',

    new_tab: 'newTab',
    switch_tab: 'switchTab',
    close_tab: 'closeTab',

    back: 'back',
    forward: 'forward',
    reload: 'reload',

    inspect_videos: 'inspectVideos',
    inspectvideos: 'inspectVideos',

    find_and_click: 'findAndClick',
    findandclick: 'findAndClick',

    close: 'closeBrowser',
    closebrowser: 'closeBrowser',
    close_browser: 'closeBrowser'
  };

  const type = aliases[name];

  if (!type) {
    throw new Error(`Unsupported action: ${actionName}`);
  }

  if (type === 'fill') {
    data.value = data.value ?? data.text ?? data.content ?? '';
  }

  if (type === 'navigate') {
    data.url = data.url ?? data.href;
  }

  if (type === 'press') {
    data.key = data.key ?? data.text;
  }

  if (type === 'wait') {
    data.ms = data.ms ?? data.time ?? data.milliseconds ?? 1000;
  }

  if (type === 'scroll') {
    const amount = Math.abs(
      Number(data.amount ?? data.distance ?? 700)
    );

    const direction = String(
      data.direction ||
      (name === 'scroll_up'
        ? 'up'
        : name === 'scroll_down'
          ? 'down'
          : '')
    ).toLowerCase();

    if (direction === 'up') {
      data.deltaY = -amount;
    } else if (direction === 'down') {
      data.deltaY = amount;
    } else {
      data.deltaY = Number(data.deltaY ?? 700);
    }

    data.deltaX = Number(data.deltaX ?? 0);
  }

  return { type, ...data };
}

// ==================================================
// ACTION EXECUTOR
// ==================================================

async function runAction(rawAction, index) {
  const action = normalizeAction(rawAction);

  if (action.type === 'closeBrowser') {
    return closeBrowser();
  }

  if (action.type === 'getPageState') {
    return getPageState();
  }

  const currentPage = await getBrowserPage();
  const selector = action.selector;
  const timeout = Number(action.timeout || DEFAULT_TIMEOUT);

  switch (action.type) {

    case 'navigate': {
      if (!action.url) {
        throw new Error('navigate requires url');
      }

      const url = new URL(action.url);

      if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('Only HTTP and HTTPS URLs are allowed');
      }

      await currentPage.goto(url.href, {
        waitUntil: action.waitUntil || 'domcontentloaded',
        timeout
      });

      return {
        url: currentPage.url(),
        title: await currentPage.title()
      };
    }

    case 'click': {
      if (action.x !== undefined && action.y !== undefined) {
        await currentPage.mouse.click(
          Number(action.x),
          Number(action.y),
          {
            button: action.button || 'left',
            clickCount: Number(action.clickCount || 1)
          }
        );

        return { clickedCoordinates: true };
      }

      if (action.text) {
        await currentPage.getByText(
          String(action.text),
          { exact: Boolean(action.exact) }
        ).first().click({ timeout });

        return { clickedText: action.text };
      }

      if (!selector) {
        throw new Error('click requires selector, text, or coordinates');
      }

      await currentPage.locator(selector).first().click({
        timeout,
        force: Boolean(action.force)
      });

      return { clickedSelector: selector };
    }

    case 'hover': {
      if (!selector) throw new Error('hover requires selector');

      await currentPage.locator(selector).first().hover({ timeout });

      return { hovered: selector };
    }

    case 'fill': {
      if (!selector) throw new Error('fill requires selector');

      await currentPage.locator(selector).first().fill(
        String(action.value),
        { timeout }
      );

      return { filled: selector };
    }

    case 'press': {
      if (!action.key) throw new Error('press requires key');

      if (selector) {
        await currentPage.locator(selector).first().press(
          String(action.key),
          { timeout }
        );
      } else {
        await currentPage.keyboard.press(String(action.key));
      }

      return { pressed: action.key };
    }

    case 'check': {
      if (!selector) throw new Error('check requires selector');

      await currentPage.locator(selector).first().check({ timeout });

      return { checked: selector };
    }

    case 'uncheck': {
      if (!selector) throw new Error('uncheck requires selector');

      await currentPage.locator(selector).first().uncheck({ timeout });

      return { unchecked: selector };
    }

    case 'scroll': {
      const deltaY = Number(action.deltaY);
      const deltaX = Number(action.deltaX);

      if (!Number.isFinite(deltaY) || !Number.isFinite(deltaX)) {
        throw new Error('Invalid scroll values');
      }

      if (selector) {
        await currentPage.locator(selector).evaluate(
          (element, data) => {
            element.scrollBy(data.deltaX, data.deltaY);
          },
          { deltaX, deltaY }
        );
      } else {
        const viewport = currentPage.viewportSize();

        const x = Number(
          action.x ?? (viewport ? viewport.width / 2 : 800)
        );

        const y = Number(
          action.y ?? (viewport ? viewport.height / 2 : 600)
        );

        await currentPage.mouse.move(x, y);
        await currentPage.mouse.wheel(deltaX, deltaY);
      }

      return {
        scrolled: true,
        direction: deltaY < 0 ? 'up' : 'down',
        deltaX,
        deltaY
      };
    }

    // ----------------------------------------------
    // EVALUATE JAVASCRIPT
    // ----------------------------------------------

    case 'evaluate': {
      if (typeof action.script !== 'string') {
        throw new Error('evaluate requires a JavaScript script string');
      }

      const result = await Promise.race([
        currentPage.evaluate(action.script),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('Evaluate timeout')),
            Math.min(timeout, 15000)
          )
        )
      ]);

      return {
        evaluated: true,
        result
      };
    }

    // ----------------------------------------------
    // INSPECT PAGE
    // ----------------------------------------------

    case 'inspectPage': {
      return inspectPage(currentPage);
    }

    // ----------------------------------------------
    // INSPECT YOUTUBE VIDEOS
    // ----------------------------------------------

    case 'inspectVideos': {
      const result = await currentPage.evaluate(() => {
        const anchors = Array.from(
          document.querySelectorAll(
            'a#video-title, a[href*="/watch?v="]'
          )
        );

        const seen = new Set();
        const videos = [];

        for (const anchor of anchors) {
          const title =
            anchor.getAttribute('title') ||
            anchor.innerText ||
            anchor.textContent ||
            '';

          const href = anchor.href;

          if (!title.trim() || !href || !href.includes('/watch')) {
            continue;
          }

          if (seen.has(href)) continue;

          seen.add(href);

          videos.push({
            title: title.trim(),
            url: href
          });
        }

        return videos.slice(0, 50);
      });

      return {
        count: result.length,
        videos: result
      };
    }

    case 'findAndClick': {
      const query = String(
        action.query || action.text || action.title || ''
      ).trim();

      if (!query) {
        throw new Error('findAndClick requires query');
      }

      const links = currentPage.locator(
        'a#video-title, a[href*="/watch?v="]'
      );

      const count = await links.count();

      for (let i = 0; i < Math.min(count, 100); i++) {
        const item = links.nth(i);

        const title = (
          await item.getAttribute('title') ||
          await item.innerText().catch(() => '')
        ).trim();

        if (title.toLowerCase().includes(query.toLowerCase())) {
          await item.click({ timeout });

          return {
            clicked: true,
            title,
            url: currentPage.url()
          };
        }
      }

      throw new Error(`No matching video found: ${query}`);
    }

    case 'select': {
      if (!selector) throw new Error('select requires selector');

      const value = action.value ?? action.option;

      if (value === undefined) {
        throw new Error('select requires value');
      }

      await currentPage.locator(selector).first().selectOption(
        String(value),
        { timeout }
      );

      return { selected: value };
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

      return { state: action.state || 'domcontentloaded' };
    }

    case 'extract': {
      const target = currentPage
        .locator(selector || 'body')
        .first();

      const attribute = action.attribute || 'innerText';

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

    case 'screenshot': {
      const screenshot = await captureScreenshot(currentPage);

      if (action.includeBase64 === false) {
        delete screenshot.base64;
      }

      return screenshot;
    }

    case 'upload': {
      if (!selector || !action.filePath) {
        throw new Error('upload requires selector and filePath');
      }

      await currentPage.locator(selector).setInputFiles(
        action.filePath,
        { timeout }
      );

      return { uploaded: true };
    }

    case 'download': {
      if (!action.url) {
        throw new Error('download requires url');
      }

      const url = new URL(action.url);

      if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('Only HTTP and HTTPS URLs are allowed');
      }

      const response = await currentPage.request.get(url.href, {
        timeout
      });

      if (!response.ok()) {
        throw new Error(`Download failed: HTTP ${response.status()}`);
      }

      const filename = path.basename(
        url.pathname || `download-${Date.now()}`
      );

      const filepath = path.join(__dirname, 'downloads', filename);

      fs.mkdirSync(path.dirname(filepath), { recursive: true });

      fs.writeFileSync(filepath, await response.body());

      return {
        downloaded: true,
        filename,
        path: filepath
      };
    }

    case 'newTab': {
      const newPage = await context.newPage();
      page = newPage;

      if (action.url) {
        await newPage.goto(action.url, {
          waitUntil: 'domcontentloaded',
          timeout
        });
      }

      return {
        newTab: true,
        url: newPage.url()
      };
    }

    case 'switchTab': {
      const tabs = context.pages();
      const tabIndex = Number(action.index);

      if (!Number.isInteger(tabIndex) || !tabs[tabIndex]) {
        throw new Error('Invalid tab index');
      }

      page = tabs[tabIndex];
      await page.bringToFront();

      return {
        switched: true,
        index: tabIndex,
        url: page.url()
      };
    }

    case 'closeTab': {
      const tabs = context.pages();
      const tabIndex = Number(action.index ?? tabs.indexOf(currentPage));

      if (!tabs[tabIndex]) {
        throw new Error('Invalid tab index');
      }

      if (tabs.length <= 1) {
        throw new Error('Cannot close the last browser tab');
      }

      await tabs[tabIndex].close();

      page = context.pages().slice(-1)[0] || null;

      return { closedTab: tabIndex };
    }

    case 'back': {
      await currentPage.goBack({
        waitUntil: action.waitUntil || 'domcontentloaded',
        timeout
      });

      return { url: currentPage.url() };
    }

    case 'forward': {
      await currentPage.goForward({
        waitUntil: action.waitUntil || 'domcontentloaded',
        timeout
      });

      return { url: currentPage.url() };
    }

    case 'reload': {
      await currentPage.reload({
        waitUntil: action.waitUntil || 'domcontentloaded',
        timeout
      });

      return {
        url: currentPage.url(),
        title: await currentPage.title()
      };
    }

    default:
      throw new Error(`Unsupported action: ${action.type}`);
  }
}

// ==================================================
// HEALTH
// ==================================================

app.get('/health', (req, res) => {
  res.json({
    success: true,
    version: 'V6',
    browser: 'Brave',
    browserOpen: Boolean(context),
    headless: false,
    currentUrl:
      page && !page.isClosed()
        ? page.url()
        : null
  });
});

// ==================================================
// EXECUTE
// ==================================================

app.post('/execute', authenticate, async (req, res) => {
  const actions = Array.isArray(req.body.actions)
    ? req.body.actions
    : (
        req.body.action || req.body.type
          ? [req.body]
          : null
      );

  if (!actions || actions.length === 0) {
    return res.status(400).json({
      success: false,
      version: 'V6',
      error: 'Provide a non-empty actions array'
    });
  }

  try {
    const output = await enqueue(async () => {
      const results = [];

      for (let i = 0; i < actions.length; i++) {
        try {
          const result = await runAction(actions[i], i);

          results.push({
            index: i,
            success: true,
            result
          });

        } catch (error) {
          addEvent('action_error', {
            action: actions[i],
            message: error.message
          });

          const diagnostics = await buildDiagnostics(
            error,
            actions[i]
          );

          results.push({
            index: i,
            success: false,
            error: error.message,
            diagnostics
          });

          // Stop the sequence and return the error to the Agent.
          return {
            success: false,
            failedIndex: i,
            results
          };
        }
      }

      return {
        success: true,
        results
      };
    });

    return res.status(output.success ? 200 : 500).json({
      ...output,
      version: 'V6'
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      version: 'V6',
      error: error.message
    });
  }
});

// ==================================================
// MANUAL PAGE INSPECTION
// ==================================================

app.get('/inspect', authenticate, async (req, res) => {
  try {
    const result = await enqueue(async () => {
      const currentPage = await getBrowserPage();
      return inspectPage(currentPage);
    });

    res.json({
      success: true,
      version: 'V6',
      result
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================================================
// BROWSER CLOSE
// ==================================================

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

// ==================================================
// START
// ==================================================

app.listen(PORT, '0.0.0.0', () => {
  console.log('====================================');
  console.log('Browser Automation Bridge V6');
  console.log(`Server: http://localhost:${PORT}`);
  console.log('Browser: Brave');
  console.log('Visible mode: ON');
  console.log('Persistent session: ON');
  console.log('Page inspection: ON');
  console.log('Error diagnostics: ON');
  console.log('Human intervention detection: ON');
  console.log(`Profile: ${PROFILE_DIR}`);
  console.log('==================BMO==================');
});

// ==================================================
// SHUTDOWN
// ==================================================

async function shutdown() {
  try {
    await closeBrowser();
  } catch (error) {
    console.error(error.message);
  }

  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
