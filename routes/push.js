// Push notifications for the signed-in user: register this device, remove it, send a test.
const express = require('express');
const push = require('../lib/push');

const router = express.Router();

router.get('/key', (req, res) => res.json({ key: push.publicKey(), on: push.hasDevices(req.session.userId) }));

router.post('/subscribe', (req, res) => {
  if (!push.subscribe(req.session.userId, req.body?.subscription, req.get('user-agent'))) {
    return res.status(400).json({ error: 'Could not turn on notifications on this device.' });
  }
  res.json({ ok: true });
});

router.post('/unsubscribe', (req, res) => {
  if (req.body?.endpoint) push.unsubscribe(req.body.endpoint);
  res.json({ ok: true });
});

router.post('/test', async (req, res) => {
  const sent = await push.sendToUser(req.session.userId, {
    title: 'Notifications are on', body: 'You will get reminders and updates on this device.', url: '/notifications', tag: 'test' });
  res.json(sent ? { ok: true, sent } : { error: 'No device has notifications turned on yet.' });
});

module.exports = router;
