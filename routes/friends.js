const express = require('express');
const router = express.Router();
const db = require('../db');
const { v4: uuidv4 } = require('uuid');

const auth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

// Get Friends (Accepted)
router.get('/', auth, (req, res) => {
  try {
    const friends = db.prepare(`
      SELECT DISTINCT 
        u.id, 
        u.username, 
        u.status AS user_status, 
        u.avatar, 
        f.status
      FROM friends f
      JOIN users u ON (f.user_id = u.id OR f.friend_id = u.id)
      WHERE (f.user_id = ? OR f.friend_id = ?) 
      AND u.id != ? 
      AND f.status = 'accepted'
    `).all(req.session.userId, req.session.userId, req.session.userId);
    res.json(friends);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get Pending
router.get('/pending', auth, (req, res) => {
  try {
    const pending = db.prepare(`
      SELECT u.id, u.username, u.avatar, f.id AS friendship_id 
      FROM friends f
      JOIN users u ON u.id = f.user_id
      WHERE f.friend_id = ? AND f.status = 'pending'
    `).all(req.session.userId);
    res.json(pending);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get Blocked
router.get('/blocked', auth, (req, res) => {
  try {
    const blocked = db.prepare(`
      SELECT u.id, u.username, u.avatar, f.id AS friendship_id
      FROM friends f
      JOIN users u ON (f.user_id = u.id OR f.friend_id = u.id)
      WHERE (f.user_id = ? OR f.friend_id = ?)
      AND u.id != ?
      AND f.status = 'blocked'
    `).all(req.session.userId, req.session.userId, req.session.userId);
    res.json(blocked);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send Request / Block
router.post('/request', auth, (req, res) => {
  const { username, action } = req.body; // action: 'add' (default) or 'block'
  if (!username) return res.status(400).json({ error: 'Username required' });

  try {
    const target = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.id === req.session.userId) return res.status(400).json({ error: 'Cannot add/block yourself' });

    const existing = db.prepare('SELECT * FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)').get(req.session.userId, target.id, target.id, req.session.userId);

    const statusObj = action === 'block' ? 'blocked' : 'pending';

    if (existing) {
      if (existing.status === 'blocked' && action === 'block') return res.status(400).json({ error: 'Already blocked' });
      // Update to blocked if requested
      if (action === 'block') {
        db.prepare('UPDATE friends SET status = ?, user_id = ?, friend_id = ? WHERE id = ?').run('blocked', req.session.userId, target.id, existing.id);
        return res.json({ success: true, status: 'blocked' });
      }
      return res.status(400).json({ error: 'Friendship already exists' });
    }

    const id = uuidv4();
    db.prepare('INSERT INTO friends (id, user_id, friend_id, status) VALUES (?, ?, ?, ?)').run(id, req.session.userId, target.id, statusObj);
    res.json({ success: true, status: statusObj });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Accept Friend Request
router.post('/accept', auth, (req, res) => {
  const { friendshipId } = req.body;
  if (!friendshipId) return res.status(400).json({ error: 'Friendship ID required' });

  try {
    const result = db.prepare("UPDATE friends SET status = 'accepted' WHERE id = ? AND (user_id = ? OR friend_id = ?)").run(friendshipId, req.session.userId, req.session.userId);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Friendship request not found or unauthorized' });
    }

    // Get the other user ID to notify them?
    const friendship = db.prepare("SELECT user_id, friend_id FROM friends WHERE id = ?").get(friendshipId);
    const otherUserId = friendship.user_id === req.session.userId ? friendship.friend_id : friendship.user_id;

    res.json({ success: true, otherUserId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Decline Friend Request / Remove Friend
router.post('/decline', auth, (req, res) => {
  const { friendshipId } = req.body;
  if (!friendshipId) return res.status(400).json({ error: 'Friendship ID required' });

  try {
    // Allow deleting if you are sender or receiver
    db.prepare("DELETE FROM friends WHERE id = ? AND (friend_id = ? OR user_id = ?)").run(friendshipId, req.session.userId, req.session.userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
