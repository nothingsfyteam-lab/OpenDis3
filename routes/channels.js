const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

function auth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

router.use(auth);

router.get('/', (req, res) => {
  const channels = db.prepare(`
    SELECT c.*, cm.user_id as is_member
    FROM channels c
    LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = ?
  `).all(req.session.userId);
  res.json(channels);
});

router.post('/', (req, res) => {
  try {
    const { name, type, server_id } = req.body; // Ensure server_id is unpacked
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const id = uuidv4();
    db.prepare('INSERT INTO channels (id, name, type, owner_id, server_id) VALUES (?, ?, ?, ?, ?)').run(id, name, type || 'text', req.session.userId, server_id);
    db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(id, req.session.userId);
    const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(id);

    // Emit event
    const io = req.app.get('io');
    if (io && server_id) {
      io.emit('new-channel', { serverId: server_id, channel });
    }

    res.json(channel);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/messages', (req, res) => {
  const messages = db.prepare(`
    SELECT m.*, u.username, u.avatar FROM messages m
    JOIN users u ON u.id = m.sender_id
    WHERE m.channel_id = ?
    ORDER BY m.timestamp ASC
    LIMIT 100
  `).all(req.params.id);
  res.json(messages);
});

router.post('/:id/join', (req, res) => {
  try {
    db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(req.params.id, req.session.userId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/leave', (req, res) => {
  db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?').run(req.params.id, req.session.userId);
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND owner_id = ?').get(req.params.id, req.session.userId);
  if (!channel) return res.status(403).json({ error: 'Not authorized' });
  db.prepare('DELETE FROM channels WHERE id = ?').run(req.params.id);

  const io = req.app.get('io');
  if (io && channel.server_id) {
    io.emit('delete-channel', { serverId: channel.server_id, channelId: req.params.id });
  }

  res.json({ ok: true });
});

router.get('/:id/members', (req, res) => {
  const members = db.prepare(`
    SELECT u.id, u.username, u.avatar, u.status FROM channel_members cm
    JOIN users u ON u.id = cm.user_id
    WHERE cm.channel_id = ?
  `).all(req.params.id);
  res.json(members);
});

module.exports = router;
