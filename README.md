# n8n Playwright Browser Automation Bridge

REST API built with Node.js, Express.js, and Playwright to connect **n8n** workflows with **browser automation**:
navigation, form filling, clicks, screenshots, and file uploads, all driven by plain HTTP Request nodes.

```
n8n (HTTP Request node)  ->  Express API  ->  Playwright / Chromium  ->  any public website
```

## Features

- `POST /browser/navigate`, `/click`, `/fill`, `/screenshot`, `/upload`
- Stateful **sessions**, so one workflow can chain several steps on the same page
- Screenshots returned as base64 (easy for n8n) or saved to disk and downloaded later
- API-key authentication, strict input validation
- **SSRF protection**: blocks localhost, private networks and cloud-metadata addresses, including via redirects
- Docker image, health check, graceful shutdown, automated tests

## Quick start

Requirements: Node.js 18+.

```bash
git clone https://github.com/<your-username>/n8n-playwright-browser-automation-bridge.git
cd n8n-playwright-browser-automation-bridge

npm install
npx playwright install chromium

cp .env.example .env        # then edit API_KEY (Windows PowerShell: copy .env.example .env)
npm run dev
```

Generate a strong key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Try it:

```bash
curl http://localhost:3000/health

curl -X POST http://localhost:3000/browser/navigate \
  -H "x-api-key: YOUR_KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
# -> {"sessionId":"...","url":"https://example.com/","title":"Example Domain","status":200}
```

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `API_KEY` | required | Secret for the `x-api-key` header (min. 16 chars) |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Listen address (Docker sets `HOST=0.0.0.0`) |
| `HEADLESS` | `true` | Set `false` to watch the browser while developing |
| `NO_SANDBOX` | `false` | Needed for Chromium inside Docker |
| `MAX_SESSIONS` | `5` | Concurrent sessions |
| `SESSION_TTL_MS` | `300000` | Idle time before a session is closed |
| `DEFAULT_TIMEOUT_MS` | `15000` | Default action timeout |
| `SCREENSHOTS_DIR` | `screenshots` | Where `response: "file"` screenshots go |
| `ALLOWED_DOMAINS` | empty | Comma-separated allow-list for navigation |
| `ALLOW_PRIVATE_HOSTS` | `false` | Disables the SSRF guard. **Development only** |

## API reference

All `/browser/*` endpoints need the `x-api-key` header (or `Authorization: Bearer <key>`). Bodies are JSON.

| Method & path | Body | Returns |
| --- | --- | --- |
| `GET /health` | none | `{status, uptime, sessions}` (public) |
| `POST /browser/navigate` | `url`, optional `sessionId`, `waitUntil` (`load` \| `domcontentloaded` \| `networkidle` \| `commit`), `timeoutMs` | `{sessionId, url, title, status}` |
| `POST /browser/click` | `sessionId`, `selector`, optional `timeoutMs` | `{sessionId, url, title}` |
| `POST /browser/fill` | `sessionId`, `selector`, `value` | `{sessionId, filled}` |
| `POST /browser/screenshot` | `sessionId`, optional `selector`, `fullPage`, `type` (`png` \| `jpeg`), `response` (`base64` \| `file`) | `{base64, mimeType, bytes}` or `{file, downloadPath}` |
| `POST /browser/upload` | `sessionId`, `selector` (a file input), `filename`, `contentBase64`, optional `mimeType` | `{uploaded, bytes}` |
| `GET /browser/screenshots/:name` | none | the image file |
| `DELETE /browser/session/:id` | none | `{closed: true}` |

Errors are always `{"error": "..."}` with the right status: `400` validation, `401` auth, `403` blocked target,
`404` unknown session, `429` too many sessions, `502` navigation failed, `504` timeout.

Selectors are standard [Playwright selectors](https://playwright.dev/docs/locators), for example `#email`,
`input[name=q]`, `text=Sign in`.

## Using it from n8n

1. Add an **HTTP Request** node: method `POST`, URL `http://localhost:3000/browser/navigate`
   (if n8n runs in Docker, use `http://host.docker.internal:3000`).
2. Add the `x-api-key` header. Best practice: create a **Header Auth** credential in n8n instead of typing the key.
3. Send JSON, for example `{"url": "https://example.com"}`.
4. Reuse the returned `sessionId` in the next nodes: `{{ $('Navigate').first().json.sessionId }}`.
5. Finish with `DELETE /browser/session/:id`.

A complete workflow (navigate, fill, screenshot, convert to file, close) is in
[`examples/n8n-http-request.json`](examples/n8n-http-request.json). Import it from *Workflows -> Import from file*.
It reads the key from the `PLAYWRIGHT_BRIDGE_API_KEY` environment variable; if your n8n blocks env access,
swap those headers for a Header Auth credential. No credentials are stored in the file.

## Docker

```bash
docker build -t playwright-bridge .
docker run --rm -p 3000:3000 -e API_KEY=$(openssl rand -hex 32) playwright-bridge
```

The base image tag in the `Dockerfile` must match the `playwright` version in `package.json`
(currently `1.49.1`). Bump both together. The container runs Chromium with `--no-sandbox` as a non-root user;
if you need the sandbox, run with a [seccomp profile](https://playwright.dev/docs/docker) and set `NO_SANDBOX=false`.

## Security notes

Do not expose this API directly to the internet without TLS (use a reverse proxy) and a strong `API_KEY`.
Anyone holding the key can make your server browse the public web. Read [`docs/architecture.md`](docs/architecture.md)
for the full security model and known limitations. Never commit `.env`, n8n credentials, or logins for websites.

## Tests

```bash
npm test            # fast unit + API tests, no browser needed
npm run test:e2e    # also runs a real Chromium flow against a local test page
```

## Project structure

```
src/
  server.js                    Express app, config, error handling
  routes/browser.routes.js     HTTP endpoints
  services/browser.service.js  Playwright sessions and actions
  middleware/auth.js           API key authentication
  utils/validation.js          Input validation and SSRF guard
tests/browser.test.js          node:test suite
examples/n8n-http-request.json Importable n8n workflow
docs/architecture.md           Diagrams and security model
```

## Roadmap

- [ ] `select`, `press`, `waitForSelector`, and `evaluate`-free text extraction endpoints
- [ ] Multi-step `/browser/run` endpoint to execute a whole script in one request
- [ ] Rate limiting and per-key quotas
- [ ] GitHub Actions CI

## License

MIT
