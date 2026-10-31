
const express = require("express");
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(express.json({ limit: "10mb" }));

// ===============================
// CONFIGURATION
// ===============================

const PORT = 3000;
const API_KEY = process.env.API_KEY || "change-this-secret";

const BRAVE_PATH =
  "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe";

const PROFILE_PATH = "C:\\BraveProfiles\\youssef\\profile1";

const SCREENSHOT_DIR = path.join(__dirname, "screenshots");

// ===============================
// BROWSER STATE
// ===============================

let context = null;
let page = null;
let launchPromise = null;
let requestQueue = Promise.resolve();

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

// ===============================
// API KEY AUTHENTICATION
// ===============================

function checkApiKey(req, res, next) {
  const providedKey =
    req.headers["x-api-key"] ||
    (req.headers.authorization || "").replace(/^Bearer\s+/i, "");

  if (providedKey !== API_KEY) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized: Invalid API key"
    });
  }

  next();
}

// ===============================
// NORMALIZE AI AGENT ACTIONS
// ===============================

function normalizeAction(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    throw new Error("Invalid browser action");
  }

  // Standard format:
  // { type: "navigate", url: "https://youtube.com" }

  if (typeof action.type === "string") {
    const normalized = { ...action };

    if (normalized.type === "goto") {
      normalized.type = "navigate";
    }

    if (
      normalized.type === "wait" &&
      normalized.ms === undefined &&
      normalized.milliseconds !== undefined
    ) {
      normalized.ms = normalized.milliseconds;
    }

    return normalized;
  }

  // AI Agent format:
  // { goto: { url: "https://youtube.com" } }

  const actionNames = Object.keys(action);

  if (actionNames.length !== 1) {
    throw new Error("Invalid browser action format");
  }

  let actionName = actionNames[0];
  const actionParams = action[actionName];

  if (actionName === "goto") {
    actionName = "navigate";
  }

  const normalized = {
    type: actionName,
    ...(actionParams && typeof actionParams === "object"
      ? actionParams
      : {})
  };

  if (
    normalized.type === "wait" &&
    normalized.ms === undefined &&
    normalized.milliseconds !== undefined
  ) {
    normalized.ms = normalized.milliseconds;
  }

  return normalized;
}

// ===============================
// GET OR LAUNCH BROWSER
// ===============================

async function getBrowserPage() {
  if (context && page && !page.isClosed()) {
    return page;
  }

  if (launchPromise) {
    return await launchPromise;
  }

  launchPromise = (async () => {
    context = await chromium.launchPersistentContext(PROFILE_PATH, {
      executablePath: BRAVE_PATH,
      headless: false,
      viewport: {
        width: 1366,
        height: 768
      },
      args: [
        "--no-first-run",
        "--no-default-browser-check"
      ]
    });

    // Close restored tabs so only one working tab remains.
    const existingPages = context.pages();

    for (const existingPage of existingPages) {
      await existingPage.close().catch(() => {});
    }

    page = await context.newPage();

    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(30000);

    console.log("Brave started with Profile 1.");

    return page;
  })();

  try {
    return await launchPromise;
  } finally {
    launchPromise = null;
  }
}

// ===============================
// CLOSE BROWSER
// ===============================

async function closeBrowser() {
  if (context) {
    await context.close().catch(() => {});
  }

  context = null;
  page = null;

  console.log("Brave browser closed.");

  return {
    success: true,
    message: "Browser closed"
  };
}

// ===============================
// ACTION HANDLER
// ===============================

async function runAction(action) {
  const currentPage = await getBrowserPage();

  switch (action.type) {

    // NAVIGATE / GOTO
    case "navigate": {
      if (!action.url) {
        throw new Error("Navigate requires a URL");
      }

      const url = new URL(action.url);

      if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error("Only HTTP and HTTPS URLs are allowed");
      }

      await currentPage.goto(url.toString(), {
        waitUntil: "domcontentloaded",
        timeout: 30000
      });

      return {
        success: true,
        url: currentPage.url(),
        title: await currentPage.title()
      };
    }

    // CLICK
    case "click": {
      if (!action.selector) {
        throw new Error("Click requires a selector");
      }

      await currentPage.locator(action.selector).first().click();

      return {
        success: true,
        action: "click",
        selector: action.selector
      };
    }

    // FILL INPUT
    case "fill": {
      if (!action.selector) {
        throw new Error("Fill requires a selector");
      }

      await currentPage.locator(action.selector).first().fill(
        String(action.value ?? "")
      );

      return {
        success: true,
        action: "fill",
        selector: action.selector
      };
    }

    // SELECT OPTION
    case "select": {
      if (!action.selector) {
        throw new Error("Select requires a selector");
      }

      await currentPage.locator(action.selector).first().selectOption(
        String(action.value)
      );

      return {
        success: true,
        action: "select"
      };
    }

    // WAIT
    case "wait": {
      const ms = Math.min(
        Math.max(Number(action.ms) || 1000, 0),
        30000
      );

      await currentPage.waitForTimeout(ms);

      return {
        success: true,
        waited: ms
      };
    }

    // WAIT FOR ELEMENT
    case "waitFor": {
      if (!action.selector) {
        throw new Error("waitFor requires a selector");
      }

      await currentPage.locator(action.selector).first().waitFor({
        state: action.state || "visible",
        timeout: action.timeout || 15000
      });

      return {
        success: true,
        action: "waitFor",
        selector: action.selector
      };
    }

    // EXTRACT TEXT
    case "extract": {
      const selector = action.selector || "body";

      const text = await currentPage
        .locator(selector)
        .first()
        .innerText()
        .catch(() => "");

      const maxLength = Math.min(
        Number(action.maxLength) || 5000,
        10000
      );

      return {
        success: true,
        text: text.slice(0, maxLength)
      };
    }

    // PAGE INFORMATION
    case "pageInfo": {
      const title = await currentPage.title();

      const text = await currentPage
        .locator("body")
        .innerText()
        .catch(() => "");

      return {
        success: true,
        url: currentPage.url(),
        title,
        text: text.slice(0, 5000)
      };
    }

    // SCREENSHOT
    case "screenshot": {
      const filename =
        "screenshot-" + Date.now() + ".png";

      const screenshotPath = path.join(
        SCREENSHOT_DIR,
        filename
      );

      await currentPage.screenshot({
        path: screenshotPath,
        fullPage: Boolean(action.fullPage)
      });

      return {
        success: true,
        screenshot: filename,
        path: screenshotPath
      };
    }

    // BACK
    case "back": {
      await currentPage.goBack({
        waitUntil: "domcontentloaded",
        timeout: 30000
      }).catch(() => {});

      return {
        success: true,
        url: currentPage.url()
      };
    }

    // RELOAD
    case "reload": {
      await currentPage.reload({
        waitUntil: "domcontentloaded",
        timeout: 30000
      });

      return {
        success: true,
        url: currentPage.url()
      };
    }

    // CLOSE BROWSER
    case "closeBrowser": {
      await closeBrowser();

      return {
        success: true,
        message: "Browser closed"
      };
    }

    default:
      throw new Error(`Unsupported action: ${action.type}`);
  }
}

// ===============================
// SERIALIZE REQUESTS
// ===============================

function enqueue(task) {
  const result = requestQueue.then(task);

  requestQueue = result.catch(() => {});

  return result;
}

// ===============================
// HEALTH CHECK
// ===============================

app.get("/health", (req, res) => {
  res.json({
    success: true,
    service: "Brave Browser Automation",
    browser: "Brave",
    profile: "Profile 1",
    port: PORT,
    browserOpen: Boolean(context)
  });
});

// ===============================
// EXECUTE ACTIONS
// ===============================

app.post("/execute", checkApiKey, async (req, res) => {
  try {
    const actions = req.body.actions;

    if (!Array.isArray(actions) || actions.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Request must contain a non-empty actions array"
      });
    }

    const results = await enqueue(async () => {
      const actionResults = [];

      for (let i = 0; i < actions.length; i++) {
        const normalizedAction = normalizeAction(actions[i]);

        try {
          const result = await runAction(normalizedAction);

          actionResults.push({
            index: i,
            action: normalizedAction.type,
            ...result
          });
        } catch (error) {
          actionResults.push({
            index: i,
            action: normalizedAction.type,
            success: false,
            error: error.message
          });

          // Stop after a failed action.
          break;
        }
      }

      return actionResults;
    });

    const success = results.every(item => item.success !== false);

    res.status(success ? 200 : 500).json({
      success,
      totalActions: actions.length,
      completedActions: results.length,
      results
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ===============================
// CLOSE ENDPOINT
// ===============================

app.post("/close", checkApiKey, async (req, res) => {
  try {
    const result = await enqueue(async () => {
      return await closeBrowser();
    });

    res.json(result);

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ===============================
// SERVER
// ===============================

app.listen(PORT, "0.0.0.0", () => {
  console.log("--------------------------------");
  console.log("Brave Browser Automation Server");
  console.log("--------------------------------");
  console.log(`Port: ${PORT}`);
  console.log("Profile: Profile 1");
  console.log("Browser: Brave");
  console.log("Server ready.");
});
