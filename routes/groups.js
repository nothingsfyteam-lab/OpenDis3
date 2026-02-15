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
  const groups = db.prepare(`
    SELECT g.* FROM groups_table g
    JOIN group_members gm ON gm.group_id = g.id
    WHERE gm.user_id = ?
  `).all(req.session.userId);
  res.json(groups);
});

router.post('/', (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const id = uuidv4();
    db.prepare('INSERT INTO groups_table (id, name, owner_id) VALUES (?, ?, ?)').run(id, name, req.session.userId);
    db.prepare('INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)').run(id, req.session.userId, 'owner');
    const group = db.prepare('SELECT * FROM groups_table WHERE id = ?').get(id);
    res.json(group);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/messages', (req, res) => {
  const messages = db.prepare(`
    SELECT gm.*, u.username, u.avatar FROM group_messages gm
    JOIN users u ON u.id = gm.sender_id
    WHERE gm.group_id = ?
    ORDER BY gm.timestamp ASC
    LIMIT 100
  `).all(req.params.id);
  res.json(messages);
});

router.post('/:id/messages', (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'Content required' });
  const id = uuidv4();
  db.prepare('INSERT INTO group_messages (id, group_id, sender_id, content) VALUES (?, ?, ?, ?)').run(id, req.params.id, req.session.userId, content);
  const msg = db.prepare('SELECT gm.*, u.username, u.avatar FROM group_messages gm JOIN users u ON u.id = gm.sender_id WHERE gm.id = ?').get(id);
  res.json(msg);
});

router.post('/:id/members', (req, res) => {
  try {
    const { username } = req.body;
    const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)').run(req.params.id, user.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/members', (req, res) => {
  const members = db.prepare(`
    SELECT u.id, u.username, u.avatar, u.status, gm.role FROM group_members gm
    JOIN users u ON u.id = gm.user_id
    WHERE gm.group_id = ?
  `).all(req.params.id);
  res.json(members);
});

router.delete('/:id', (req, res) => {
  const group = db.prepare('SELECT * FROM groups_table WHERE id = ? AND owner_id = ?').get(req.params.id, req.session.userId);
  if (!group) return res.status(403).json({ error: 'Not authorized' });
  db.prepare('DELETE FROM groups_table WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
