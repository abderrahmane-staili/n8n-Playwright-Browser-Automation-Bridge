
const express = require("express");
const { chromium } = require("playwright");
const crypto = require("crypto");

const app = express();

app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  throw new Error("API_KEY is required");
}

// Authentication
app.use((req, res, next) => {
  const key = req.headers["x-api-key"];

  if (
    typeof key !== "string" ||
    key.length !== API_KEY.length ||
    !crypto.timingSafeEqual(
      Buffer.from(key),
      Buffer.from(API_KEY)
    )
  ) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized"
    });
  }

  next();
});

let browser;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox"]
    });
  }

  return browser;
}

// Health check
app.get("/health", async (req, res) => {
  try {
    const b = await getBrowser();

    res.json({
      success: true,
      status: "running",
      browser: b.isConnected() ? "connected" : "disconnected"
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Execute browser actions
app.post("/execute", async (req, res) => {
  const { actions } = req.body;

  if (!Array.isArray(actions) || actions.length === 0 || actions.length > 15) {
    return res.status(400).json({
      success: false,
      error: "Provide between 1 and 15 actions"
    });
  }

  let context;

  try {
    const b = await getBrowser();

    context = await b.newContext({
      viewport: {
        width: 1366,
        height: 768
      }
    });

    const page = await context.newPage();

    page.setDefaultTimeout(15000);

    const results = [];

    for (const action of actions) {
      let result;

      switch (action.type) {
        case "navigate": {
          const url = new URL(action.url);

          if (!["http:", "https:"].includes(url.protocol)) {
            throw new Error("Only HTTP and HTTPS URLs are allowed");
          }

          await page.goto(url.href, {
            waitUntil: "domcontentloaded",
            timeout: 30000
          });

          result = {
            url: page.url(),
            title: await page.title()
          };
          break;
        }

        case "click": {
          if (!action.selector) {
            throw new Error("Selector is required");
          }

          await page.locator(action.selector).first().click();

          result = {
            clicked: action.selector
          };
          break;
        }

        case "fill": {
          if (!action.selector) {
            throw new Error("Selector is required");
          }

          await page.locator(action.selector).first().fill(
            String(action.value ?? "")
          );

          result = {
            filled: action.selector
          };
          break;
        }

        case "select": {
          await page.locator(action.selector).first().selectOption(
            String(action.value)
          );

          result = {
            selected: action.value
          };
          break;
        }

        case "wait": {
          const duration = Math.min(
            Math.max(Number(action.ms) || 1000, 0),
            10000
          );

          await page.waitForTimeout(duration);

          result = {
            waited: duration
          };
          break;
        }

        case "waitFor": {
          await page.locator(action.selector).first().waitFor({
            state: "visible"
          });

          result = {
            visible: action.selector
          };
          break;
        }

        case "extract": {
          const selector = action.selector || "body";

          const text = await page.locator(selector).first().innerText();

          result = {
            text: text.slice(0, 12000)
          };
          break;
        }

        case "screenshot": {
          const screenshot = await page.screenshot({
            type: "png",
            fullPage: false
          });

          result = {
            screenshot: screenshot.toString("base64"),
            format: "png"
          };
          break;
        }

        default:
          throw new Error(`Unsupported action: ${action.type}`);
      }

      results.push({
        action: action.type,
        success: true,
        result
      });
    }

    res.json({
      success: true,
      currentUrl: page.url(),
      title: await page.title(),
      results
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });

  } finally {
    if (context) {
      await context.close();
    }
  }
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Playwright Bridge running on port ${PORT}`);
});

// Graceful shutdown
async function shutdown() {
  if (browser) {
    await browser.close();
  }

  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
