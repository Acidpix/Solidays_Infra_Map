const express = require('express');
const router = express.Router();
const db = require('./db');
const zabbix = require('./zabbix');
const { evaluateAll } = require('./triggers');
const { v4: uuidv4 } = require('crypto');

function uuid() { return require('crypto').randomUUID(); }

/* ── State cache ──────────────────────────────── */
let devicesCache = [];      // last fetched + evaluated devices
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
    const devices = await zabbix.getHosts(cfg);
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
    if (posMap[d.id]) { d.x = posMap[d.id].x; d.y = posMap[d.id].y; }
    else { d.x = Math.random() * 0.8 + 0.1; d.y = Math.random() * 0.8 + 0.1; }
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

// Initial load
fetchDevices().then(scheduleRefresh);

/* ── DEVICES ──────────────────────────────────── */
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
  if (dev) { dev.x = x; dev.y = y; }
  res.json({ ok: true });
});

/* ── GROUPS ──────────────────────────────────── */
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

/* ── CONFIG ──────────────────────────────────── */
router.get('/config', (req, res) => {
  const zabbixCfg = db.getConfig('zabbix') || {};
  const displayCfg = db.getConfig('display') || {};
  const colorCfg = db.getConfig('typeColors') || {};
  // Never send password back
  const safe = { ...zabbixCfg, pass: zabbixCfg.pass ? '••••••••' : '' };
  res.json({ zabbix: safe, display: displayCfg, typeColors: colorCfg });
});

router.post('/config', (req, res) => {
  const { zabbix: z, display, typeColors } = req.body;
  if (z) {
    const existing = db.getConfig('zabbix') || {};
    // Keep existing password if placeholder sent
    if (z.pass === '••••••••') z.pass = existing.pass || '';
    db.setConfig('zabbix', z);
    scheduleRefresh();
  }
  if (display)     db.setConfig('display', display);
  if (typeColors)  db.setConfig('typeColors', typeColors);
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

/* ── TRIGGERS ──────────────────────────────────── */
router.get('/triggers', (req, res) => {
  const triggers = db.getAllTriggers();
  // Group by category
  const grouped = { wave: [], ap: [], sw: [], cam: [] };
  for (const t of triggers) {
    if (grouped[t.category]) grouped[t.category].push({ ...t, enabled: !!t.enabled });
  }
  res.json(grouped);
});

router.post('/triggers', (req, res) => {
  const triggers = req.body; // array or object grouped by cat
  const flat = Array.isArray(triggers) ? triggers : Object.values(triggers).flat();
  for (const t of flat) {
    if (!t.id) t.id = uuid();
    t.enabled = t.enabled ? 1 : 0;
    db.upsertTrigger(t);
  }
  // Re-evaluate with new triggers
  evaluateAll(devicesCache);
  res.json({ ok: true });
});

router.delete('/triggers/:id', (req, res) => {
  db.deleteTrigger(req.params.id);
  evaluateAll(devicesCache);
  res.json({ ok: true });
});

/* ── ALERTS ──────────────────────────────────── */
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

/* ── MOCK DATA (when no Zabbix configured) ──── */
function getMockDevices() {
  return [
    { id:'d1',  name:'WAVE-SCENE-01',  type:'wave', ip:'10.0.1.11', ping:true,  latency:2.1,  signal:-58, channel:149, uptime:'12j 4h' },
    { id:'d2',  name:'WAVE-SCENE-02',  type:'wave', ip:'10.0.1.12', ping:true,  latency:2.4,  signal:-62, channel:149, uptime:'12j 4h' },
    { id:'d3',  name:'WAVE-BACKSTAGE', type:'wave', ip:'10.0.1.13', ping:true,  latency:18.7, signal:-81, channel:153, uptime:'3j 2h'  },
    { id:'d4',  name:'AP-SCENE-A1',    type:'ap',   ip:'10.0.2.21', ping:true,  latency:1.2,  signal:-45, channel:6,   clients:34, uptime:'12j 4h' },
    { id:'d5',  name:'AP-SCENE-A2',    type:'ap',   ip:'10.0.2.22', ping:true,  latency:1.4,  signal:-48, channel:11,  clients:28, uptime:'12j 4h' },
    { id:'d6',  name:'AP-BACKSTAGE-1', type:'ap',   ip:'10.0.2.23', ping:false, latency:null, signal:null,channel:1,   clients:0,  uptime:'0h'     },
    { id:'d7',  name:'AP-CATERING',    type:'ap',   ip:'10.0.2.24', ping:true,  latency:2.1,  signal:-55, channel:6,   clients:12, uptime:'12j 4h' },
    { id:'d8',  name:'SW-CORE-01',     type:'sw',   ip:'10.0.0.1',  ping:true,  latency:0.4,  ports:24, portsUp:22, uptime:'15j 6h' },
    { id:'d9',  name:'SW-SCENE-01',    type:'sw',   ip:'10.0.0.2',  ping:true,  latency:0.6,  ports:16, portsUp:14, uptime:'12j 4h' },
    { id:'d10', name:'SW-BACKSTAGE',   type:'sw',   ip:'10.0.0.3',  ping:true,  latency:0.5,  ports:16, portsUp:9,  uptime:'12j 4h' },
    { id:'d11', name:'CAM-ENTREE-01',  type:'cam',  ip:'10.0.3.31', ping:true,  latency:1.8,  resolution:'1080p', fps:25, uptime:'12j 4h' },
    { id:'d12', name:'CAM-SCENE-01',   type:'cam',  ip:'10.0.3.32', ping:true,  latency:2.2,  resolution:'4K',    fps:30, uptime:'12j 4h' },
    { id:'d13', name:'CAM-BACKSTAGE',  type:'cam',  ip:'10.0.3.33', ping:true,  latency:42.0, resolution:'1080p', fps:12, uptime:'12j 4h' },
    { id:'d14', name:'CAM-PARKING',    type:'cam',  ip:'10.0.3.34', ping:true,  latency:3.1,  resolution:'1080p', fps:25, uptime:'5j 2h'  },
  ];
}

module.exports = router;
