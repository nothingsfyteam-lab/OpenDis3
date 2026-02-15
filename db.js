const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'owndc.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const tables = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    email TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    avatar TEXT DEFAULT '',
    status TEXT DEFAULT 'offline',
    created_at TEXT DEFAULT (datetime('now')),
    bio TEXT DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS friends (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    friend_id TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (friend_id) REFERENCES users(id),
    UNIQUE(user_id, friend_id)
  )`,
  `CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT DEFAULT 'text',
    owner_id TEXT NOT NULL,
    server_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (owner_id) REFERENCES users(id),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS channel_members (
    channel_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    joined_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (channel_id, user_id),
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
    FOREIGN KEY (sender_id) REFERENCES users(id)
  )`,
  `CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    icon TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (owner_id) REFERENCES users(id)
  )`,
  `CREATE TABLE IF NOT EXISTS roles (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#99aab5',
    permissions TEXT DEFAULT '0',
    position INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS server_members (
    server_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role_id TEXT,
    joined_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (server_id, user_id),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS groups_table (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    avatar TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (owner_id) REFERENCES users(id)
  )`,
  `CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT DEFAULT 'member',
    joined_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (group_id, user_id),
    FOREIGN KEY (group_id) REFERENCES groups_table(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`,
  `CREATE TABLE IF NOT EXISTS group_messages (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (group_id) REFERENCES groups_table(id) ON DELETE CASCADE,
    FOREIGN KEY (sender_id) REFERENCES users(id)
  )`,
  `CREATE TABLE IF NOT EXISTS direct_messages (
    id TEXT PRIMARY KEY,
    sender_id TEXT NOT NULL,
    receiver_id TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (sender_id) REFERENCES users(id),
    FOREIGN KEY (receiver_id) REFERENCES users(id)
  )`,
  `CREATE TABLE IF NOT EXISTS server_invites (
     id TEXT PRIMARY KEY,
     server_id TEXT NOT NULL,
     inviter_id TEXT NOT NULL,
     invitee_id TEXT NOT NULL,
     status TEXT DEFAULT 'pending',
     created_at TEXT DEFAULT (datetime('now')),
     FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
     FOREIGN KEY (inviter_id) REFERENCES users(id),
     FOREIGN KEY (invitee_id) REFERENCES users(id),
     UNIQUE(server_id, invitee_id)
  )`
];

tables.forEach(sql => {
  try {
    db.exec(sql);
  } catch (err) {
    console.error("Error executing SQL:", sql);
    console.error(err);
  }
});

// Idempotent column additions for existing DBs
try { db.exec("ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''"); } catch (e) { }
try { db.exec("ALTER TABLE channels ADD COLUMN server_id TEXT REFERENCES servers(id) ON DELETE CASCADE"); } catch (e) { }
try { db.exec("ALTER TABLE server_members ADD COLUMN role_id TEXT REFERENCES roles(id) ON DELETE SET NULL"); } catch (e) { }

module.exports = db;

module.exports = db;
