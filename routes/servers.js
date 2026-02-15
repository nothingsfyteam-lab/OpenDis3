const express = require('express');
const router = express.Router();
const db = require('../db');
const { v4: uuidv4 } = require('uuid');

// Middleware
const auth = (req, res, next) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    next();
};

// Create Server
router.post('/', auth, (req, res) => {
    const { name, icon } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });

    const serverId = uuidv4();

    try {
        const txn = db.transaction(() => {
            db.prepare('INSERT INTO servers (id, name, owner_id, icon) VALUES (?, ?, ?, ?)').run(serverId, name, req.session.userId, icon || '');
            db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(serverId, req.session.userId);

            // Default channels
            const c1 = uuidv4();
            const c2 = uuidv4();
            db.prepare('INSERT INTO channels (id, name, type, owner_id, server_id) VALUES (?, ?, ?, ?, ?)').run(c1, 'general', 'text', req.session.userId, serverId);
            db.prepare('INSERT INTO channels (id, name, type, owner_id, server_id) VALUES (?, ?, ?, ?, ?)').run(c2, 'Voice Chat', 'voice', req.session.userId, serverId);
        });
        txn();
        res.json({ id: serverId, name });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// List my servers
router.get('/', auth, (req, res) => {
    try {
        const servers = db.prepare(`
        SELECT s.* FROM servers s
        JOIN server_members sm ON s.id = sm.server_id
        WHERE sm.user_id = ?
    `).all(req.session.userId);
        res.json(servers);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get channels for a server
router.get('/:id/channels', auth, (req, res) => {
    try {
        // Verify membership
        const member = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(req.params.id, req.session.userId);
        if (!member) return res.status(403).json({ error: 'Not a member' });

        const channels = db.prepare('SELECT * FROM channels WHERE server_id = ?').all(req.params.id);
        res.json(channels);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Join Server via Invite Code
router.post('/invite/:code', auth, (req, res) => {
    try {
        // For now, invite code = server ID. In future, use a real invite table.
        const serverId = req.params.code;
        const server = db.prepare('SELECT id FROM servers WHERE id = ?').get(serverId);
        if (!server) return res.status(404).json({ error: 'Invalid invite code' });

        db.prepare('INSERT OR IGNORE INTO server_members (server_id, user_id) VALUES (?, ?)').run(serverId, req.session.userId);
        res.json({ success: true, serverId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Create Instant Invite
router.post('/:id/invite', auth, (req, res) => {
    // Return server ID as the code for simplicity
    res.json({ code: req.params.id });
});

// Kick Member
router.post('/:id/kick', auth, (req, res) => {
    const { userId } = req.body;
    try {
        // Verify requester is owner (simplistic permission check)
        const server = db.prepare('SELECT owner_id FROM servers WHERE id = ?').get(req.params.id);
        if (!server) return res.status(404).json({ error: 'Server not found' });
        if (server.owner_id !== req.session.userId) return res.status(403).json({ error: 'Only owner can kick' });

        db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(req.params.id, userId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Roles ---
// Get Roles
router.get('/:id/roles', auth, (req, res) => {
    try {
        const roles = db.prepare('SELECT * FROM roles WHERE server_id = ? ORDER BY position DESC').all(req.params.id);
        res.json(roles);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Create Role
router.post('/:id/roles', auth, (req, res) => {
    const { name, color } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const roleId = uuidv4();
    try {
        // Check permissions (owner only for now)
        const s = db.prepare('SELECT owner_id FROM servers WHERE id=?').get(req.params.id);
        if (s.owner_id !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });

        db.prepare('INSERT INTO roles (id, server_id, name, color) VALUES (?, ?, ?, ?)').run(roleId, req.params.id, name, color || '#99aab5');
        res.json({ success: true, id: roleId });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Assign Role
router.put('/:id/members/:userId/role', auth, (req, res) => {
    const { roleId } = req.body; // Pass null to remove
    try {
        const s = db.prepare('SELECT owner_id FROM servers WHERE id=?').get(req.params.id);
        if (s.owner_id !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });

        db.prepare('UPDATE server_members SET role_id = ? WHERE server_id = ? AND user_id = ?').run(roleId, req.params.id, req.params.userId);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get Members in Server
router.get('/:id/members', auth, (req, res) => {
    try {
        const members = db.prepare(`
            SELECT u.id, u.username, u.avatar, r.name as role_name, r.color as role_color, sm.role_id 
            FROM server_members sm
            JOIN users u ON sm.user_id = u.id
            LEFT JOIN roles r ON sm.role_id = r.id
            WHERE sm.server_id = ?
        `).all(req.params.id);
        res.json(members);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete Server
router.delete('/:id', auth, (req, res) => {
    try {
        const server = db.prepare('SELECT owner_id FROM servers WHERE id = ?').get(req.params.id);
        if (!server) return res.status(404).json({ error: 'Server not found' });
        if (server.owner_id !== req.session.userId) return res.status(403).json({ error: 'Only owner can delete' });

        db.prepare('DELETE FROM servers WHERE id = ?').run(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Generate Invite Code (Stub for now)
router.post('/:id/invite', auth, (req, res) => {
    // In a real app, store this in a 'server_invite_codes' table
    // For now, return a deterministic or random code
    const code = 'join_' + Buffer.from(req.params.id).toString('base64').substring(0, 8);
    res.json({ code });
});

// --- Server Invites (Pending Requests) ---
// Get pending server invites for me
router.get('/invites/me', auth, (req, res) => {
    try {
        const invites = db.prepare(`
            SELECT si.*, s.name as server_name, s.icon as server_icon, u.username as inviter_name 
            FROM server_invites si
            JOIN servers s ON s.id = si.server_id
            JOIN users u ON u.id = si.inviter_id
            WHERE si.invitee_id = ? AND si.status = 'pending'
        `).all(req.session.userId);
        res.json(invites);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Invite a specific user to a server
router.post('/:id/invite-user', auth, (req, res) => {
    const { userId } = req.body;
    try {
        // Check if inviter is member (or has permission)
        const member = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(req.params.id, req.session.userId);
        if (!member) return res.status(403).json({ error: 'You are not a member of this server' });

        const inviteId = uuidv4();
        db.prepare('INSERT INTO server_invites (id, server_id, inviter_id, invitee_id) VALUES (?, ?, ?, ?)').run(inviteId, req.params.id, req.session.userId, userId);

        // Notify user via socket
        const io = req.app.get('io');
        if (io) {
            // We don't have user socket mapping easily accessible on req.app usually, 
            // but we can broadcast a generic event or use a room if 'user-[id]' room exists.
            // Assuming socket.js joins 'user-[id]' room:
            io.to(`user-${userId}`).emit('server-invite-received');
            // If room doesn't exist, polling will handle it.
        }
        res.json({ success: true });
    } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(400).json({ error: 'User already invited' });
        res.status(500).json({ error: err.message });
    }
});

// Accept Invite
router.post('/invites/:id/accept', auth, (req, res) => {
    try {
        const invite = db.prepare('SELECT * FROM server_invites WHERE id = ? AND invitee_id = ?').get(req.params.id, req.session.userId);
        if (!invite) return res.status(404).json({ error: 'Invite not found' });
        if (invite.status !== 'pending') return res.status(400).json({ error: 'Invite not pending' });

        const txn = db.transaction(() => {
            db.prepare('UPDATE server_invites SET status = "accepted" WHERE id = ?').run(req.params.id);
            db.prepare('INSERT OR IGNORE INTO server_members (server_id, user_id) VALUES (?, ?)').run(invite.server_id, req.session.userId);
        });
        txn();
        res.json({ success: true, serverId: invite.server_id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Decline Invite
router.post('/invites/:id/decline', auth, (req, res) => {
    try {
        db.prepare('UPDATE server_invites SET status = "declined" WHERE id = ? AND invitee_id = ?').run(req.params.id, req.session.userId);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
