'use strict';

const crypto = require('node:crypto');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();

/**
 * API-key authentication. Accepts `x-api-key: <key>` or `Authorization: Bearer <key>`.
 * Both sides are hashed first so timingSafeEqual always compares equal-length buffers.
 */
function createAuth(apiKey) {
  if (!apiKey) throw new Error('createAuth requires an API key');
  const expected = sha256(apiKey);

  return function auth(req, res, next) {
    const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const provided = req.get('x-api-key') || bearer;
    if (provided && crypto.timingSafeEqual(expected, sha256(provided))) return next();
    res.status(401).json({ error: 'Invalid or missing API key' });
  };
}

module.exports = { createAuth };
