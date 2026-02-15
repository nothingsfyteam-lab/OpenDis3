const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

function auth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

router.use(auth);

// Send channel message
router.post('/channel/:channelId', (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'Content required' });
  const id = uuidv4();
  db.prepare('INSERT INTO messages (id, channel_id, sender_id, content) VALUES (?, ?, ?, ?)').run(id, req.params.channelId, req.session.userId, content);
  const msg = db.prepare('SELECT m.*, u.username, u.avatar FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?').get(id);
  res.json(msg);
});

// Get DMs with a user
router.get('/dm/:userId', (req, res) => {
  const messages = db.prepare(`
    SELECT dm.*, u.username, u.avatar FROM direct_messages dm
    JOIN users u ON u.id = dm.sender_id
    WHERE (dm.sender_id = ? AND dm.receiver_id = ?) OR (dm.sender_id = ? AND dm.receiver_id = ?)
    ORDER BY dm.timestamp ASC
    LIMIT 100
  `).all(req.session.userId, req.params.userId, req.params.userId, req.session.userId);
  res.json(messages);
});

// Send DM
router.post('/dm/:userId', (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'Content required' });
  const id = uuidv4();
  db.prepare('INSERT INTO direct_messages (id, sender_id, receiver_id, content) VALUES (?, ?, ?, ?)').run(id, req.session.userId, req.params.userId, content);
  const msg = db.prepare('SELECT dm.*, u.username, u.avatar FROM direct_messages dm JOIN users u ON u.id = dm.sender_id WHERE dm.id = ?').get(id);
  res.json(msg);
});

module.exports = router;
