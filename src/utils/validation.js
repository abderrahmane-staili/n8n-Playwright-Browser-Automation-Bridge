'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');
const path = require('node:path');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/* ------------------------------ SSRF protection ------------------------------ */

function isPrivateIPv4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local + cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast + reserved
  );
}

function isPrivateIPv6(ip) {
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  if (v.startsWith('::ffff:')) {
    const tail = v.slice(7);
    return net.isIPv4(tail) ? isPrivateIPv4(tail) : true;
  }
  return /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
}

function isPrivateAddress(ip) {
  return net.isIPv4(ip) ? isPrivateIPv4(ip) : isPrivateIPv6(ip);
}

/**
 * Throws HttpError unless `raw` is an http(s) URL that is allowed by the policy.
 * policy: { allowPrivate?: boolean, allowedDomains?: string[] }
 */
async function assertSafeUrl(raw, policy = {}) {
  const { allowPrivate = false, allowedDomains = [] } = policy;

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, 'Invalid URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new HttpError(400, 'Only http and https URLs are allowed');
  }

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (allowedDomains.length > 0) {
    const ok = allowedDomains.some((d) => host === d || host.endsWith('.' + d));
    if (!ok) throw new HttpError(403, 'Domain is not in the allow-list');
  }
  if (allowPrivate) return url;

  if (host === 'localhost' || /\.(localhost|local|internal)$/.test(host)) {
    throw new HttpError(403, 'Access to internal hosts is not allowed');
  }

  let addresses;
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await dns.lookup(host, { all: true })).map((r) => r.address);
    } catch {
      throw new HttpError(400, 'Host could not be resolved');
    }
  }
  if (addresses.some(isPrivateAddress)) {
    throw new HttpError(403, 'Access to private or internal addresses is not allowed');
  }
  return url;
}

/* ------------------------------ Body validation ------------------------------ */

const WAIT_UNTIL = ['load', 'domcontentloaded', 'networkidle', 'commit'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_UPLOAD_BASE64 = 7_000_000; // ~5 MB of binary data

function requireObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'A JSON object body is required');
  }
  return body;
}

function str(body, key, { required = true, max = 500, allowEmpty = false } = {}) {
  const v = body[key];
  if (v === undefined || v === null) {
    if (required) throw new HttpError(400, `"${key}" is required`);
    return undefined;
  }
  if (typeof v !== 'string' || (!allowEmpty && v.length === 0)) {
    throw new HttpError(400, `"${key}" must be a non-empty string`);
  }
  if (v.length > max) throw new HttpError(400, `"${key}" is too long (max ${max})`);
  return v;
}

function sessionId(body, { required = true } = {}) {
  const v = str(body, 'sessionId', { required, max: 36 });
  if (v !== undefined && !UUID_RE.test(v)) throw new HttpError(400, '"sessionId" is invalid');
  return v;
}

function timeout(body) {
  const v = body.timeoutMs;
  if (v === undefined) return undefined;
  if (!Number.isInteger(v) || v < 500 || v > 60000) {
    throw new HttpError(400, '"timeoutMs" must be an integer between 500 and 60000');
  }
  return v;
}

function oneOf(body, key, list, fallback) {
  const v = body[key];
  if (v === undefined) return fallback;
  if (!list.includes(v)) throw new HttpError(400, `"${key}" must be one of: ${list.join(', ')}`);
  return v;
}

function bool(body, key, fallback = false) {
  const v = body[key];
  if (v === undefined) return fallback;
  if (typeof v !== 'boolean') throw new HttpError(400, `"${key}" must be a boolean`);
  return v;
}

const validators = {
  navigate(raw) {
    const b = requireObject(raw);
    return {
      url: str(b, 'url', { max: 2048 }),
      sessionId: sessionId(b, { required: false }),
      waitUntil: oneOf(b, 'waitUntil', WAIT_UNTIL, 'load'),
      timeoutMs: timeout(b),
    };
  },

  click(raw) {
    const b = requireObject(raw);
    return { sessionId: sessionId(b), selector: str(b, 'selector'), timeoutMs: timeout(b) };
  },

  fill(raw) {
    const b = requireObject(raw);
    return {
      sessionId: sessionId(b),
      selector: str(b, 'selector'),
      value: str(b, 'value', { max: 10000, allowEmpty: true }),
      timeoutMs: timeout(b),
    };
  },

  screenshot(raw) {
    const b = requireObject(raw);
    return {
      sessionId: sessionId(b),
      selector: str(b, 'selector', { required: false }),
      fullPage: bool(b, 'fullPage', false),
      type: oneOf(b, 'type', ['png', 'jpeg'], 'png'),
      response: oneOf(b, 'response', ['base64', 'file'], 'base64'),
      timeoutMs: timeout(b),
    };
  },

  upload(raw) {
    const b = requireObject(raw);
    const filename = str(b, 'filename', { max: 100 });
    if (path.basename(filename) !== filename || !/^[\w. \-]+$/.test(filename)) {
      throw new HttpError(400, '"filename" must be a plain file name');
    }
    const contentBase64 = str(b, 'contentBase64', { max: MAX_UPLOAD_BASE64 });
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(contentBase64)) {
      throw new HttpError(400, '"contentBase64" is not valid base64');
    }
    return {
      sessionId: sessionId(b),
      selector: str(b, 'selector'),
      filename,
      mimeType: str(b, 'mimeType', { required: false, max: 100 }) || 'application/octet-stream',
      contentBase64,
      timeoutMs: timeout(b),
    };
  },
};

module.exports = { HttpError, validators, assertSafeUrl, isPrivateAddress, UUID_RE };
