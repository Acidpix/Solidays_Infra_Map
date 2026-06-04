const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '../db/netmap.db');
const db = new Database(DB_PATH);

// Perf pragmas
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ──────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS device_positions (
    device_id   TEXT PRIMARY KEY,
    x           REAL NOT NULL DEFAULT 0.5,
    y           REAL NOT NULL DEFAULT 0.5,
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS groups (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    x           REAL NOT NULL DEFAULT 0.5,
    y           REAL NOT NULL DEFAULT 0.5,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS group_devices (
    group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    device_id   TEXT NOT NULL,
    PRIMARY KEY (group_id, device_id)
  );

  CREATE TABLE IF NOT EXISTS triggers (
    id          TEXT PRIMARY KEY,
    category    TEXT NOT NULL,
    name        TEXT NOT NULL,
    metric      TEXT NOT NULL,
    op          TEXT NOT NULL,
    threshold   REAL NOT NULL DEFAULT 0,
    unit        TEXT NOT NULL DEFAULT '',
    severity    TEXT NOT NULL DEFAULT 'warn',
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS alert_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id   TEXT NOT NULL,
    device_name TEXT NOT NULL,
    trigger_id  TEXT,
    trigger_name TEXT NOT NULL,
    severity    TEXT NOT NULL,
    value       TEXT,
    fired_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    resolved_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_alert_history_device ON alert_history(device_id);
  CREATE INDEX IF NOT EXISTS idx_alert_history_fired  ON alert_history(fired_at DESC);
`);

// ── Default triggers ─────────────────────────────────────
const insertTrig = db.prepare(`
  INSERT OR IGNORE INTO triggers (id, category, name, metric, op, threshold, unit, severity, enabled)
  VALUES (@id, @category, @name, @metric, @op, @threshold, @unit, @severity, @enabled)
`);

const defaultTriggers = [
  // WAVE
  { id:'w1', category:'wave', name:'Ping KO',        metric:'ping',    op:'==', threshold:0,   unit:'',    severity:'crit', enabled:1 },
  { id:'w2', category:'wave', name:'Latence élevée', metric:'latency', op:'>',  threshold:15,  unit:'ms',  severity:'warn', enabled:1 },
  { id:'w3', category:'wave', name:'Signal faible',  metric:'signal',  op:'<',  threshold:-80, unit:'dBm', severity:'warn', enabled:1 },
  // AP
  { id:'a1', category:'ap',   name:'Ping KO',        metric:'ping',    op:'==', threshold:0,   unit:'',    severity:'crit', enabled:1 },
  { id:'a2', category:'ap',   name:'Latence élevée', metric:'latency', op:'>',  threshold:10,  unit:'ms',  severity:'warn', enabled:1 },
  { id:'a3', category:'ap',   name:'Signal faible',  metric:'signal',  op:'<',  threshold:-75, unit:'dBm', severity:'warn', enabled:1 },
  { id:'a4', category:'ap',   name:'Aucun client',   metric:'clients', op:'==', threshold:0,   unit:'',    severity:'warn', enabled:0 },
  // Switch
  { id:'s1', category:'sw',   name:'Ping KO',              metric:'ping',    op:'==', threshold:0,  unit:'',  severity:'crit', enabled:1 },
  { id:'s2', category:'sw',   name:'Latence élevée',       metric:'latency', op:'>',  threshold:5,  unit:'ms',severity:'warn', enabled:1 },
  { id:'s3', category:'sw',   name:'Ports UP < seuil (%)', metric:'portsUp', op:'<',  threshold:50, unit:'%', severity:'warn', enabled:1 },
  // Camera
  { id:'c1', category:'cam',  name:'Ping KO',        metric:'ping',    op:'==', threshold:0,   unit:'',    severity:'crit', enabled:1 },
  { id:'c2', category:'cam',  name:'FPS bas',        metric:'fps',     op:'<',  threshold:15,  unit:'fps', severity:'crit', enabled:1 },
  { id:'c3', category:'cam',  name:'Latence élevée', metric:'latency', op:'>',  threshold:30,  unit:'ms',  severity:'warn', enabled:1 },
];

const insertMany = db.transaction(() => {
  for (const t of defaultTriggers) insertTrig.run(t);
});
insertMany();

// ── Prepared statements ──────────────────────────────────
module.exports = {
  db,

  // Config
  getConfig: (key) => {
    const row = db.prepare('SELECT value FROM config WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : null;
  },
  setConfig: (key, value) => {
    db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?,?)').run(key, JSON.stringify(value));
  },

  // Positions
  getAllPositions: () => db.prepare('SELECT * FROM device_positions').all(),
  upsertPosition: (device_id, x, y) => {
    db.prepare(`INSERT INTO device_positions (device_id, x, y, updated_at)
      VALUES (?,?,?,unixepoch())
      ON CONFLICT(device_id) DO UPDATE SET x=excluded.x, y=excluded.y, updated_at=unixepoch()`)
      .run(device_id, x, y);
  },

  // Groups
  getAllGroups: () => {
    const groups = db.prepare('SELECT * FROM groups ORDER BY created_at').all();
    const getDevices = db.prepare('SELECT device_id FROM group_devices WHERE group_id=?');
    return groups.map(g => ({ ...g, deviceIds: getDevices.all(g.id).map(r => r.device_id) }));
  },
  createGroup: (id, name, x, y, deviceIds) => {
    const tx = db.transaction(() => {
      db.prepare('INSERT INTO groups (id, name, x, y) VALUES (?,?,?,?)').run(id, name, x, y);
      for (const did of deviceIds)
        db.prepare('INSERT INTO group_devices (group_id, device_id) VALUES (?,?)').run(id, did);
    });
    tx();
  },
  updateGroup: (id, name, x, y, deviceIds) => {
    const tx = db.transaction(() => {
      db.prepare('UPDATE groups SET name=?, x=?, y=?, updated_at=unixepoch() WHERE id=?').run(name, x, y, id);
      db.prepare('DELETE FROM group_devices WHERE group_id=?').run(id);
      for (const did of deviceIds)
        db.prepare('INSERT INTO group_devices (group_id, device_id) VALUES (?,?)').run(id, did);
    });
    tx();
  },
  deleteGroup: (id) => db.prepare('DELETE FROM groups WHERE id=?').run(id),

  // Triggers
  getAllTriggers: () => db.prepare('SELECT * FROM triggers ORDER BY category, created_at').all(),
  upsertTrigger: (t) => {
    db.prepare(`INSERT INTO triggers (id, category, name, metric, op, threshold, unit, severity, enabled)
      VALUES (@id, @category, @name, @metric, @op, @threshold, @unit, @severity, @enabled)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, metric=excluded.metric, op=excluded.op,
        threshold=excluded.threshold, unit=excluded.unit,
        severity=excluded.severity, enabled=excluded.enabled`).run(t);
  },
  deleteTrigger: (id) => db.prepare('DELETE FROM triggers WHERE id=?').run(id),
  saveTriggers: (triggers) => {
    const tx = db.transaction(() => {
      for (const t of triggers) {
        db.prepare(`INSERT INTO triggers (id, category, name, metric, op, threshold, unit, severity, enabled)
          VALUES (@id, @category, @name, @metric, @op, @threshold, @unit, @severity, @enabled)
          ON CONFLICT(id) DO UPDATE SET
            name=excluded.name, metric=excluded.metric, op=excluded.op,
            threshold=excluded.threshold, unit=excluded.unit,
            severity=excluded.severity, enabled=excluded.enabled`).run(t);
      }
    });
    tx();
  },

  // Alert history
  addAlert: (device_id, device_name, trigger_id, trigger_name, severity, value) => {
    return db.prepare(`INSERT INTO alert_history (device_id, device_name, trigger_id, trigger_name, severity, value)
      VALUES (?,?,?,?,?,?)`).run(device_id, device_name, trigger_id, trigger_name, severity, value ? String(value) : null);
  },
  resolveAlert: (id) => {
    db.prepare('UPDATE alert_history SET resolved_at=unixepoch() WHERE id=?').run(id);
  },
  getAlerts: ({ limit = 200, device_id, severity, unresolved_only, days } = {}) => {
    let q = 'SELECT * FROM alert_history WHERE 1=1';
    const params = [];
    if (device_id)      { q += ' AND device_id=?';       params.push(device_id); }
    if (severity)       { q += ' AND severity=?';         params.push(severity); }
    if (unresolved_only){ q += ' AND resolved_at IS NULL'; }
    if (days)           { q += ' AND fired_at >= unixepoch()-?'; params.push(days*86400); }
    q += ' ORDER BY fired_at DESC LIMIT ?';
    params.push(limit);
    return db.prepare(q).all(...params);
  },
  getAlertStats: () => {
    return db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN severity='crit' THEN 1 ELSE 0 END) as critical,
        SUM(CASE WHEN severity='warn' THEN 1 ELSE 0 END) as warning,
        SUM(CASE WHEN resolved_at IS NULL THEN 1 ELSE 0 END) as active
      FROM alert_history
      WHERE fired_at >= unixepoch() - 86400*7
    `).get();
  },
};
