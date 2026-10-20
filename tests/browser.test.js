'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../src/server');
const { assertSafeUrl, isPrivateAddress } = require('../src/utils/validation');

const API_KEY = 'test-key-0123456789abcdef';
const SID = '11111111-2222-4333-8444-555555555555';

function fakeService() {
  const calls = [];
  const rec = (name, result) => async (input) => {
    calls.push([name, input]);
    return result;
  };
  return {
    calls,
    sessionCount: () => 0,
    navigate: rec('navigate', { sessionId: SID, url: 'http://example.com/', title: 'Example', status: 200 }),
    click: rec('click', { sessionId: SID }),
    fill: rec('fill', { sessionId: SID }),
    upload: rec('upload', { sessionId: SID }),
    screenshot: rec('screenshot', { sessionId: SID, base64: 'AAAA' }),
    closeSession: async (id) => id === SID,
  };
}

async function start(service, policy = {}) {
  const app = createApp({ apiKey: API_KEY, browserService: service, policy });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const post = (base, path, body, key = API_KEY) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
    body: JSON.stringify(body),
  });

test('GET /health is public', async () => {
  const { server, base } = await start(fakeService());
  const res = await fetch(base + '/health');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'ok');
  server.close();
});

test('rejects requests without a valid API key', async () => {
  const { server, base } = await start(fakeService());
  assert.equal((await post(base, '/browser/navigate', { url: 'http://example.com' }, null)).status, 401);
  assert.equal((await post(base, '/browser/navigate', { url: 'http://example.com' }, 'wrong')).status, 401);
  server.close();
});

test('accepts Bearer authentication', async () => {
  const { server, base } = await start(fakeService(), { allowPrivate: true });
  const res = await fetch(base + '/browser/navigate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ url: 'http://example.com' }),
  });
  assert.equal(res.status, 200);
  server.close();
});

test('navigate forwards validated input to the service', async () => {
  const svc = fakeService();
  const { server, base } = await start(svc, { allowPrivate: true });
  const res = await post(base, '/browser/navigate', { url: 'http://example.com', waitUntil: 'domcontentloaded' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).sessionId, SID);
  assert.equal(svc.calls[0][0], 'navigate');
  assert.equal(svc.calls[0][1].waitUntil, 'domcontentloaded');
  server.close();
});

test('navigate blocks internal targets (SSRF)', async () => {
  const { server, base } = await start(fakeService());
  for (const url of ['http://127.0.0.1/', 'http://localhost:3000/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/', 'http://[::1]/']) {
    assert.equal((await post(base, '/browser/navigate', { url })).status, 403, url);
  }
  assert.equal((await post(base, '/browser/navigate', { url: 'file:///etc/passwd' })).status, 400);
  server.close();
});

test('input validation returns 400', async () => {
  const { server, base } = await start(fakeService());
  assert.equal((await post(base, '/browser/navigate', {})).status, 400);
  assert.equal((await post(base, '/browser/click', { sessionId: 'nope', selector: '#a' })).status, 400);
  assert.equal((await post(base, '/browser/click', { sessionId: SID })).status, 400);
  assert.equal((await post(base, '/browser/fill', { sessionId: SID, selector: '#a' })).status, 400);
  assert.equal((await post(base, '/browser/screenshot', { sessionId: SID, type: 'gif' })).status, 400);
  assert.equal((await post(base, '/browser/upload', { sessionId: SID, selector: 'input', filename: '../x.txt', contentBase64: 'QUJD' })).status, 400);
  server.close();
});

test('fill accepts an empty string (clears a field)', async () => {
  const { server, base } = await start(fakeService());
  assert.equal((await post(base, '/browser/fill', { sessionId: SID, selector: '#a', value: '' })).status, 200);
  server.close();
});

test('DELETE /browser/session/:id', async () => {
  const { server, base } = await start(fakeService());
  const ok = await fetch(`${base}/browser/session/${SID}`, { method: 'DELETE', headers: { 'x-api-key': API_KEY } });
  assert.equal(ok.status, 200);
  const missing = await fetch(`${base}/browser/session/99999999-2222-4333-8444-555555555555`, { method: 'DELETE', headers: { 'x-api-key': API_KEY } });
  assert.equal(missing.status, 404);
  server.close();
});

test('isPrivateAddress / assertSafeUrl', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
  await assert.rejects(assertSafeUrl('http://example.com', { allowPrivate: true, allowedDomains: ['other.com'] }), { status: 403 });
  await assert.doesNotReject(assertSafeUrl('https://sub.example.com', { allowPrivate: true, allowedDomains: ['example.com'] }));
});

/* ---- Optional end-to-end test with real Chromium: npm run test:e2e ---- */
test('e2e: navigate -> fill -> click -> screenshot', { skip: !process.env.RUN_E2E }, async () => {
  const { BrowserService } = require('../src/services/browser.service');
  const page = `<!doctype html><title>start</title>
    <form onsubmit="document.title='sent:'+document.getElementById('n').value;return false">
      <input id="n"><button id="b">Go</button></form>`;
  const site = http.createServer((req, res) => res.end(page));
  await new Promise((r) => site.listen(0, '127.0.0.1', r));

  const policy = { allowPrivate: true };
  const svc = new BrowserService({ policy, noSandbox: process.env.NO_SANDBOX === 'true' });
  const { server, base } = await start(svc, policy);

  try {
    const nav = await (await post(base, '/browser/navigate', { url: `http://127.0.0.1:${site.address().port}/` })).json();
    assert.equal(nav.title, 'start');
    await post(base, '/browser/fill', { sessionId: nav.sessionId, selector: '#n', value: 'hello' });
    const click = await (await post(base, '/browser/click', { sessionId: nav.sessionId, selector: '#b' })).json();
    assert.equal(click.title, 'sent:hello');
    const shot = await (await post(base, '/browser/screenshot', { sessionId: nav.sessionId })).json();
    assert.ok(shot.bytes > 500);
    assert.equal(Buffer.from(shot.base64, 'base64').subarray(1, 4).toString(), 'PNG');
  } finally {
    server.close();
    site.close();
    await svc.close();
  }
});
