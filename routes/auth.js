const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

router.post('/register', (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    const existing = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE').get(username, email);
    if (existing) {
      return res.status(409).json({ error: 'Username or email already taken' });
    }
    const hash = bcrypt.hashSync(password, 10);
    const id = uuidv4();
    db.prepare('INSERT INTO users (id, username, email, password_hash) VALUES (?, ?, ?, ?)').run(id, username, email, hash);
    req.session.userId = id;
    res.json({ id, username, email, avatar: '', status: 'online' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/login', (req, res) => {
  try {
    const { username, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    db.prepare('UPDATE users SET status = ? WHERE id = ?').run('online', user.id);
    req.session.userId = user.id;
    res.json({ id: user.id, username: user.username, email: user.email, avatar: user.avatar, status: 'online' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/logout', (req, res) => {
  if (req.session.userId) {
    db.prepare('UPDATE users SET status = ? WHERE id = ?').run('offline', req.session.userId);
  }
  req.session.destroy();
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const user = db.prepare('SELECT id, username, email, avatar, status FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return res.status(401).json({ error: 'User not found' });
  res.json(user);
});

module.exports = router;
