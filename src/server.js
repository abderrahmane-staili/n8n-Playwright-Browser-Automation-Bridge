
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

app.use(express.json({ limit: '10mb' }));

let context = null;
let page = null;
let requestQueue = Promise.resolve();

// --------------------------------------------------
// REQUEST QUEUE
// --------------------------------------------------

function enqueue(task) {
  const result = requestQueue.then(task, task);
  requestQueue = result.catch(() => {});
  return result;
}

// --------------------------------------------------
// AUTHENTICATION
// --------------------------------------------------

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

// --------------------------------------------------
// ACTION NORMALIZATION
// --------------------------------------------------

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
    scroll_down: 'scroll',
    scroll_up: 'scroll',

    wait: 'wait',
    waitfor: 'waitFor',
    wait_for: 'waitFor',

    extract: 'extract',
    screenshot: 'screenshot',

    pageinfo: 'pageInfo',
    page_info: 'pageInfo',

    inspect_videos: 'inspectVideos',
    inspectvideos: 'inspectVideos',

    find_and_click: 'findAndClick',
    findandclick: 'findAndClick',

    click: 'click',
    select: 'select',
    back: 'back',
    reload: 'reload',

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

  if (type === 'wait') {
    data.ms = data.ms ?? data.time ?? data.milliseconds ?? 1000;
  }

  if (type === 'press') {
    data.key = data.key ?? data.text;
  }

  // ------------------------------------------------
  // V5 SCROLL DIRECTION FIX
  // ------------------------------------------------

  if (type === 'scroll') {
    const directionAliases = {
      up: 'up',
      upward: 'up',
      upwards: 'up',
      top: 'up',
      above: 'up',

      down: 'down',
      downward: 'down',
      downwards: 'down',
      bottom: 'down',
      below: 'down',

      'فوق': 'up',
      'للفوق': 'up',
      'الفوق': 'up',
      'للفوقاني': 'up',

      'تحت': 'down',
      'للتحت': 'down',
      'التحت': 'down'
    };

    let direction = String(
      data.direction ||
      (name === 'scroll_up'
        ? 'up'
        : name === 'scroll_down'
          ? 'down'
          : '')
    ).trim().toLowerCase();

    direction = directionAliases[direction] || direction;

    const amountInput = Number(
      data.amount ?? data.distance ?? 700
    );

    const amount = Math.abs(
      Number.isFinite(amountInput) ? amountInput : 700
    );

    let deltaY;

    // Explicit direction takes priority over deltaY.
    if (direction === 'up') {
      deltaY = -amount;
    } else if (direction === 'down') {
      deltaY = amount;
    } else if (data.deltaY !== undefined) {
      deltaY = Number(data.deltaY);
    } else {
      deltaY = 700;
    }

    if (!Number.isFinite(deltaY)) {
      throw new Error('Invalid scroll deltaY');
    }

    const deltaX = Number(data.deltaX ?? 0);

    if (!Number.isFinite(deltaX)) {
      throw new Error('Invalid scroll deltaX');
    }

    data.deltaY = deltaY;
    data.deltaX = deltaX;
    data.amount = amount;
    data.direction =
      direction || (deltaY < 0 ? 'up' : 'down');
  }

  return { type, ...data };
}

// --------------------------------------------------
// BROWSER MANAGEMENT
// --------------------------------------------------

async function getBrowserPage() {
  if (!context) {
    if (!fs.existsSync(BRAVE_PATH)) {
      throw new Error(`Brave not found: ${BRAVE_PATH}`);
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

    context.on('page', newPage => {
      page = newPage;
    });

    context.on('close', () => {
      context = null;
      page = null;
    });
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

  const currentContext = context;

  context = null;
  page = null;

  await currentContext.close();

  return { closed: true };
}

// --------------------------------------------------
// YOUTUBE VIDEO INSPECTION
// --------------------------------------------------

async function inspectVideos(currentPage) {
  return currentPage.evaluate(() => {
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

    return videos.slice(0, 40);
  });
}

// --------------------------------------------------
// ACTION EXECUTION
// --------------------------------------------------

async function runAction(rawAction, index) {
  const action = normalizeAction(rawAction);

  if (action.type === 'closeBrowser') {
    return closeBrowser();
  }

  const currentPage = await getBrowserPage();

  const selector = action.selector;
  const timeout = Number(action.timeout || 15000);

  switch (action.type) {

    // ----------------------------------------------
    // NAVIGATE
    // ----------------------------------------------

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

    // ----------------------------------------------
    // CLICK
    // ----------------------------------------------

    case 'click': {
      // Coordinate click
      if (
        action.x !== undefined &&
        action.y !== undefined &&
        Number.isFinite(Number(action.x)) &&
        Number.isFinite(Number(action.y))
      ) {
        await currentPage.mouse.click(
          Number(action.x),
          Number(action.y),
          {
            button: action.button || 'left',
            clickCount: Number(action.clickCount || 1)
          }
        );

        return {
          clickedCoordinates: {
            x: Number(action.x),
            y: Number(action.y)
          }
        };
      }

      // Text-based click
      if (action.text) {
        const locator = currentPage.getByText(
          String(action.text),
          { exact: Boolean(action.exact) }
        ).first();

        await locator.click({ timeout });

        return { clickedText: action.text };
      }

      // Selector-based click
      if (selector) {
        await currentPage.locator(selector).first().click({
          timeout
        });

        return { clickedSelector: selector };
      }

      throw new Error(
        'click requires x/y coordinates, text, or selector'
      );
    }

    // ----------------------------------------------
    // FIND AND CLICK YOUTUBE VIDEO
    // ----------------------------------------------

    case 'findAndClick': {
      const query = String(
        action.query || action.text || action.title || ''
      ).trim();

      if (!query) {
        throw new Error('findAndClick requires query or title');
      }

      const videoLinks = currentPage.locator(
        'a#video-title, a[href*="/watch?v="]'
      );

      const count = await videoLinks.count();

      for (let i = 0; i < Math.min(count, 100); i++) {
        const item = videoLinks.nth(i);

        const title = (
          await item.getAttribute('title') ||
          await item.innerText().catch(() => '')
        ).trim();

        if (
          title &&
          title.toLowerCase().includes(query.toLowerCase())
        ) {
          await item.click({ timeout });

          return {
            clicked: true,
            title,
            url: currentPage.url()
          };
        }
      }

      throw new Error(
        `No visible video title matched: ${query}. Inspect videos first.`
      );
    }

    // ----------------------------------------------
    // INSPECT VIDEOS
    // ----------------------------------------------

    case 'inspectVideos': {
      const videos = await inspectVideos(currentPage);

      return {
        pageUrl: currentPage.url(),
        pageTitle: await currentPage.title(),
        count: videos.length,
        videos
      };
    }

    // ----------------------------------------------
    // FILL INPUT
    // ----------------------------------------------

    case 'fill': {
      if (!selector) {
        throw new Error('fill requires selector');
      }

      await currentPage.locator(selector).first().fill(
        String(action.value),
        { timeout }
      );

      return { filled: selector };
    }

    // ----------------------------------------------
    // PRESS KEY
    // ----------------------------------------------

    case 'press': {
      if (!action.key) {
        throw new Error('press requires key');
      }

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

    // ----------------------------------------------
    // SCROLL - V5
    // ----------------------------------------------

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
    // SELECT OPTION
    // ----------------------------------------------

    case 'select': {
      if (!selector) {
        throw new Error('select requires selector');
      }

      const value = action.value ?? action.option;

      if (value === undefined) {
        throw new Error('select requires value or option');
      }

      await currentPage.locator(selector).first().selectOption(
        String(value),
        { timeout }
      );

      return { selected: value };
    }

    // ----------------------------------------------
    // WAIT
    // ----------------------------------------------

    case 'wait': {
      const ms = Math.max(
        0,
        Math.min(Number(action.ms) || 0, 120000)
      );

      await currentPage.waitForTimeout(ms);

      return { waited: ms };
    }

    // ----------------------------------------------
    // WAIT FOR ELEMENT OR LOAD STATE
    // ----------------------------------------------

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

    // ----------------------------------------------
    // EXTRACT DATA
    // ----------------------------------------------

    case 'extract': {
      if (action.mode === 'videos') {
        const videos = await inspectVideos(currentPage);

        return {
          count: videos.length,
          videos
        };
      }

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

    // ----------------------------------------------
    // SCREENSHOT
    // ----------------------------------------------

    case 'screenshot': {
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

      const filename =
        `screenshot-${Date.now()}-${index + 1}.png`;

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

    // ----------------------------------------------
    // PAGE INFO
    // ----------------------------------------------

    case 'pageInfo': {
      return {
        url: currentPage.url(),
        title: await currentPage.title()
      };
    }

    // ----------------------------------------------
    // BACK
    // ----------------------------------------------

    case 'back': {
      await currentPage.goBack({
        waitUntil: action.waitUntil || 'domcontentloaded',
        timeout
      });

      return { url: currentPage.url() };
    }

    // ----------------------------------------------
    // RELOAD
    // ----------------------------------------------

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

// --------------------------------------------------
// HEALTH
// --------------------------------------------------

app.get('/health', (req, res) => {
  res.json({
    success: true,
    version: 'V5',
    browser: 'Brave',
    browserOpen: Boolean(context),
    headless: false,
    currentUrl:
      page && !page.isClosed()
        ? page.url()
        : null
  });
});

// --------------------------------------------------
// EXECUTE ACTIONS
// --------------------------------------------------

app.post('/execute', authenticate, async (req, res) => {
  try {
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
        error: 'Provide a non-empty actions array'
      });
    }

    const results = await enqueue(async () => {
      const output = [];

      for (let i = 0; i < actions.length; i++) {
        try {
          const result = await runAction(actions[i], i);

          output.push({
            index: i,
            success: true,
            result
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
      version: 'V5',
      results
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      version: 'V5',
      error: error.message,
      failedIndex: error.failedIndex ?? null,
      results: error.actionResults || []
    });
  }
});

// --------------------------------------------------
// CLOSE ENDPOINT
// --------------------------------------------------

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

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running: http://localhost:${PORT}`);
  console.log('Version: V5');
  console.log('Browser: Brave | Visible: ON');
  console.log('Browser remains open between tasks.');
  console.log(`Profile: ${PROFILE_DIR}`);
});

// --------------------------------------------------
// SHUTDOWN
// --------------------------------------------------

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
