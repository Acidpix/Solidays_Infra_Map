const express = require('express');
const router = express.Router();
const db = require('./db');
const zabbix = require('./zabbix');
const { evaluateAll } = require('./triggers');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function uuid() { return require('crypto').randomUUID(); }

/* ── State cache ──────────────────────────────────────────── */
let devicesCache = [];
let lastFetch = 0;
let fetchError = null;
let refreshTimer = null;

async function fetchDevices() {
  const cfg = db.getConfig('zabbix');
  if (!cfg || !cfg.host) {
    devicesCache = getMockDevices();
    evaluateAll(devicesCache);
    applyPositions(devicesCache);
    return;
  }
  try {
    const categories = db.getAllCategories();
    const devices = await zabbix.getHosts(cfg, categories);
    evaluateAll(devices);
    applyPositions(devices);
    devicesCache = devices;
    lastFetch = Date.now();
    fetchError = null;
  } catch (e) {
    fetchError = e.message;
    console.error('[Zabbix] fetch error:', e.message);
  }
}

function applyPositions(devices) {
  const positions = db.getAllPositions();
  const posMap = {};
  for (const p of positions) posMap[p.device_id] = p;
  for (const d of devices) {
    if (posMap[d.id]) {
      d.x = posMap[d.id].x;
      d.y = posMap[d.id].y;
      d.onMap = true;
    } else {
      d.onMap = false;
    }
  }
}

function scheduleRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  const cfg = db.getConfig('zabbix');
  if (!cfg || !cfg.autoRefresh) return;
  const interval = (cfg.refresh || 30) * 1000;
  refreshTimer = setInterval(fetchDevices, interval);
  console.log(`[Refresh] scheduled every ${cfg.refresh || 30}s`);
}

fetchDevices().then(scheduleRefresh);

/* ── DEVICES ──────────────────────────────────────────────── */
router.get('/devices', (req, res) => {
  res.json({ devices: devicesCache, lastFetch, error: fetchError });
});

router.post('/devices/refresh', async (req, res) => {
  await fetchDevices();
  res.json({ devices: devicesCache, lastFetch, error: fetchError });
});

router.patch('/devices/:id/position', (req, res) => {
  const { x, y } = req.body;
  if (x == null || y == null) return res.status(400).json({ error: 'x and y required' });
  db.upsertPosition(req.params.id, x, y);
  const dev = devicesCache.find(d => d.id === req.params.id);
  if (dev) { dev.x = x; dev.y = y; dev.onMap = true; }
  res.json({ ok: true });
});

router.delete('/devices/:id/position', (req, res) => {
  db.deleteDevicePosition(req.params.id);
  const dev = devicesCache.find(d => d.id === req.params.id);
  if (dev) { dev.onMap = false; delete dev.x; delete dev.y; }
  res.json({ ok: true });
});

/* ── CATEGORIES ───────────────────────────────────────────── */
router.get('/categories', (req, res) => {
  res.json(db.getAllCategories());
});

router.post('/categories', (req, res) => {
  const cat = req.body;
  if (!cat.id) cat.id = uuid();
  db.upsertCategory(cat);
  res.json(cat);
});

router.put('/categories/:id', (req, res) => {
  db.upsertCategory({ ...req.body, id: req.params.id });
  res.json({ ok: true });
});

router.delete('/categories/:id', (req, res) => {
  db.deleteCategory(req.params.id);
  res.json({ ok: true });
});

/* ── GROUPS ───────────────────────────────────────────────── */
router.get('/groups', (req, res) => {
  res.json(db.getAllGroups());
});

router.post('/groups', (req, res) => {
  const { name, x, y, deviceIds } = req.body;
  if (!name || !deviceIds) return res.status(400).json({ error: 'name and deviceIds required' });
  const id = uuid();
  db.createGroup(id, name, x || 0.5, y || 0.5, deviceIds);
  res.json({ id, name, x, y, deviceIds });
});

router.put('/groups/:id', (req, res) => {
  const { name, x, y, deviceIds } = req.body;
  if (!name || !deviceIds) return res.status(400).json({ error: 'name and deviceIds required' });
  db.updateGroup(req.params.id, name, x, y, deviceIds);
  res.json({ ok: true });
});

router.delete('/groups/:id', (req, res) => {
  db.deleteGroup(req.params.id);
  res.json({ ok: true });
});

/* ── CONFIG ───────────────────────────────────────────────── */
router.get('/config', (req, res) => {
  const zabbixCfg = db.getConfig('zabbix') || {};
  const displayCfg = db.getConfig('display') || {};
  const safe = { ...zabbixCfg, pass: zabbixCfg.pass ? '••••••••' : '' };
  res.json({ zabbix: safe, display: displayCfg });
});

router.post('/config', (req, res) => {
  const { zabbix: z, display } = req.body;
  if (z) {
    const existing = db.getConfig('zabbix') || {};
    if (z.pass === '••••••••') z.pass = existing.pass || '';
    db.setConfig('zabbix', z);
    scheduleRefresh();
  }
  if (display) db.setConfig('display', display);
  res.json({ ok: true });
});

router.post('/config/test', async (req, res) => {
  try {
    const cfg = req.body;
    const version = await zabbix.testConnection(cfg);
    res.json({ ok: true, version });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* ── ZABBIX HOST GROUPS (pour autocomplete) ───────────────── */
router.get('/zabbix/groups', async (req, res) => {
  try {
    const cfg = db.getConfig('zabbix');
    if (!cfg || !cfg.host) return res.json([]);
    const groups = await zabbix.getGroups(cfg);
    res.json(groups);
  } catch (e) {
    res.json([]);
  }
});

/* ── TRIGGERS ─────────────────────────────────────────────── */
router.get('/triggers', (req, res) => {
  const triggers = db.getAllTriggers();
  const categories = db.getAllCategories();
  const grouped = {};
  for (const cat of categories) grouped[cat.id] = [];
  for (const t of triggers) {
    if (!grouped[t.category]) grouped[t.category] = [];
    grouped[t.category].push({ ...t, enabled: !!t.enabled });
  }
  res.json(grouped);
});

router.post('/triggers', (req, res) => {
  const triggers = req.body;
  const flat = Array.isArray(triggers) ? triggers : Object.values(triggers).flat();
  for (const t of flat) {
    if (!t.id) t.id = uuid();
    t.enabled = t.enabled ? 1 : 0;
    db.upsertTrigger(t);
  }
  evaluateAll(devicesCache);
  res.json({ ok: true });
});

router.delete('/triggers/:id', (req, res) => {
  db.deleteTrigger(req.params.id);
  evaluateAll(devicesCache);
  res.json({ ok: true });
});

/* ── ALERTS ───────────────────────────────────────────────── */
router.get('/alerts', (req, res) => {
  const { limit, device_id, severity, unresolved_only, days } = req.query;
  const alerts = db.getAlerts({
    limit: limit ? parseInt(limit) : 200,
    device_id,
    severity,
    unresolved_only: unresolved_only === '1' || unresolved_only === 'true',
    days: days ? parseInt(days) : null,
  });
  const stats = db.getAlertStats();
  res.json({ alerts, stats });
});

router.patch('/alerts/:id/resolve', (req, res) => {
  db.resolveAlert(parseInt(req.params.id));
  res.json({ ok: true });
});

/* ── MAP BACKGROUND ───────────────────────────────────────── */
function bgFile() {
  const files = fs.existsSync(DATA_DIR)
    ? fs.readdirSync(DATA_DIR).filter(f => f.startsWith('background.'))
    : [];
  return files.length ? path.join(DATA_DIR, files[0]) : null;
}

router.get('/map/background', (req, res) => {
  const file = bgFile();
  if (!file) return res.status(404).json({ error: 'No background' });
  res.sendFile(file);
});

router.post('/map/background', (req, res) => {
  const { data } = req.body;
  if (!data || !data.startsWith('data:')) return res.status(400).json({ error: 'Invalid data URL' });
  const match = data.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) return res.status(400).json({ error: 'Invalid format' });
  const [, mime, b64] = match;
  const extMap = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
  const ext = extMap[mime] || 'bin';
  // Remove any existing background
  fs.readdirSync(DATA_DIR).filter(f => f.startsWith('background.')).forEach(f => fs.unlinkSync(path.join(DATA_DIR, f)));
  fs.writeFileSync(path.join(DATA_DIR, `background.${ext}`), Buffer.from(b64, 'base64'));
  res.json({ ok: true });
});

router.delete('/map/background', (req, res) => {
  if (fs.existsSync(DATA_DIR))
    fs.readdirSync(DATA_DIR).filter(f => f.startsWith('background.')).forEach(f => fs.unlinkSync(path.join(DATA_DIR, f)));
  res.json({ ok: true });
});

/* ── MOCK DATA ────────────────────────────────────────────── */
function getMockDevices() {
  return [
    { id:'d1',  name:'WAVE-SCENE-01',  type:'wave', ip:'10.0.1.11', ping:true,  latency:2.1,  signal:-58, uptime:'12j 4h' },
    { id:'d2',  name:'WAVE-SCENE-02',  type:'wave', ip:'10.0.1.12', ping:true,  latency:2.4,  signal:-62, uptime:'12j 4h' },
    { id:'d3',  name:'WAVE-BACKSTAGE', type:'wave', ip:'10.0.1.13', ping:true,  latency:18.7, signal:-81, uptime:'3j 2h'  },
    { id:'d4',  name:'AP-SCENE-A1',    type:'ap',   ip:'10.0.2.21', ping:true,  latency:1.2,  signal:-45, clients:34, uptime:'12j 4h' },
    { id:'d5',  name:'AP-SCENE-A2',    type:'ap',   ip:'10.0.2.22', ping:true,  latency:1.4,  signal:-48, clients:28, uptime:'12j 4h' },
    { id:'d6',  name:'AP-BACKSTAGE-1', type:'ap',   ip:'10.0.2.23', ping:false, latency:null, signal:null, clients:0,  uptime:'0h' },
    { id:'d7',  name:'AP-CATERING',    type:'ap',   ip:'10.0.2.24', ping:true,  latency:2.1,  signal:-55, clients:12, uptime:'12j 4h' },
    { id:'d8',  name:'SW-CORE-01',     type:'sw',   ip:'10.0.0.1',  ping:true,  latency:0.4,  ports:24, portsUp:22, uptime:'15j 6h' },
    { id:'d9',  name:'SW-SCENE-01',    type:'sw',   ip:'10.0.0.2',  ping:true,  latency:0.6,  ports:16, portsUp:14, uptime:'12j 4h' },
    { id:'d10', name:'SW-BACKSTAGE',   type:'sw',   ip:'10.0.0.3',  ping:true,  latency:0.5,  ports:16, portsUp:9,  uptime:'12j 4h' },
    { id:'d11', name:'CAM-ENTREE-01',  type:'cam',  ip:'10.0.3.31', ping:true,  latency:1.8,  fps:25, uptime:'12j 4h' },
    { id:'d12', name:'CAM-SCENE-01',   type:'cam',  ip:'10.0.3.32', ping:true,  latency:2.2,  fps:30, uptime:'12j 4h' },
    { id:'d13', name:'CAM-BACKSTAGE',  type:'cam',  ip:'10.0.3.33', ping:true,  latency:42.0, fps:12, uptime:'12j 4h' },
    { id:'d14', name:'CAM-PARKING',    type:'cam',  ip:'10.0.3.34', ping:true,  latency:3.1,  fps:25, uptime:'5j 2h'  },
  ];
}

module.exports = router;
