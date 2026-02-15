const Database = require('better-sqlite3');
const db = new Database('debug.db');

const sql = `CREATE TABLE IF NOT EXISTS server_members (
    server_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role_id TEXT,
    joined_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (server_id, user_id),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (role_id) REFERENCES roles(id) ON SET NULL
  )`;

try {
    db.exec(sql);
    console.log("Success");
} catch (err) {
    console.error(err);
}
