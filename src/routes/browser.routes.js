'use strict';

const express = require('express');
const { validators, assertSafeUrl, HttpError, UUID_RE } = require('../utils/validation');

// Express 4 does not catch rejected promises on its own.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

function createBrowserRouter(service, policy = {}) {
  const router = express.Router();

  router.post(
    '/navigate',
    wrap(async (req, res) => {
      const input = validators.navigate(req.body);
      await assertSafeUrl(input.url, policy);
      res.json(await service.navigate(input));
    }),
  );

  router.post('/click', wrap(async (req, res) => res.json(await service.click(validators.click(req.body)))));
  router.post('/fill', wrap(async (req, res) => res.json(await service.fill(validators.fill(req.body)))));
  router.post('/upload', wrap(async (req, res) => res.json(await service.upload(validators.upload(req.body)))));
  router.post(
    '/screenshot',
    wrap(async (req, res) => res.json(await service.screenshot(validators.screenshot(req.body)))),
  );

  router.delete(
    '/session/:id',
    wrap(async (req, res) => {
      if (!UUID_RE.test(req.params.id)) throw new HttpError(400, 'Invalid session id');
      const closed = await service.closeSession(req.params.id);
      if (!closed) throw new HttpError(404, 'Session not found or expired');
      res.json({ closed: true });
    }),
  );

  router.get('/screenshots/:name', (req, res, next) => {
    if (!/^[\w.-]+\.(png|jpe?g)$/i.test(req.params.name)) {
      return next(new HttpError(400, 'Invalid file name'));
    }
    res.sendFile(req.params.name, { root: service.screenshotsDir, dotfiles: 'deny' }, (err) => {
      if (err && !res.headersSent) next(new HttpError(404, 'Screenshot not found'));
    });
  });

  return router;
}

module.exports = { createBrowserRouter };
