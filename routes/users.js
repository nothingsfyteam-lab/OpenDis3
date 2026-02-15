const express = require('express');
const router = express.Router();
const db = require('../db');

const auth = (req, res, next) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    next();
};

router.put('/me', auth, (req, res) => {
    const { bio, avatar } = req.body;
    try {
        if (bio !== undefined) db.prepare('UPDATE users SET bio = ? WHERE id = ?').run(bio, req.session.userId);
        if (avatar !== undefined) db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatar, req.session.userId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/:id', auth, (req, res) => {
    const user = db.prepare('SELECT id, username, avatar, bio, status FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
});

module.exports = router;
