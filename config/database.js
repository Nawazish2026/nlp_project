const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.resolve(__dirname, '../graph.db');
const db = new Database(dbPath);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

const initDb = () => {
    db.exec(`CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        label TEXT,
        properties TEXT
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY,
        source TEXT,
        target TEXT,
        type TEXT,
        properties TEXT
    )`);
    return Promise.resolve();
};

const runQuery = (sql, params = []) => {
    try {
        const stmt = db.prepare(sql);
        return Promise.resolve(stmt.all(...params));
    } catch (err) {
        return Promise.reject(err);
    }
};

const execute = (sql, params = []) => {
    try {
        const stmt = db.prepare(sql);
        const result = stmt.run(...params);
        return Promise.resolve(result);
    } catch (err) {
        return Promise.reject(err);
    }
};

module.exports = { db, initDb, runQuery, execute };
