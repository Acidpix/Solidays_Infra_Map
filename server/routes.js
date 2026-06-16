const express = require('express');
const router = express.Router();
const db = require('./db');
const zabbix = require('./zabbix');
const milestone = require('./milestone');
const { evaluateAll } = require('./triggers');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '../data');
function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
}

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
    const milestoneMacro = (db.getConfig('milestone') || {}).macroName || '{$MILESTONE_ID}';
    const devices = await zabbix.getHosts(cfg, categories, milestoneMacro);
    evaluateAll(devices);
    applyPositions(devices);
    devicesCache = devices;
    lastFetch = Date.now();
    fetchError = null;
    // Récapitulatif de catégorisation (diagnostic)
    const counts = {};
    let noGroups = 0;
    for (const d of devices) {
      counts[d.type] = (counts[d.type] || 0) + 1;
      if (!d.hostGroups || !d.hostGroups.length) noGroups++;
    }
    console.log(`[Zabbix] ${devices.length} hôtes · catégories:`, counts, `· sans host group: ${noGroups}`);
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

// Recalcule la catégorie (type) des équipements en cache à partir de leurs host groups
// mémorisés et de la config catégories à jour — sans re-interroger Zabbix.
function recategorize() {
  const cats = db.getAllCategories();
  for (const d of devicesCache) {
    if (!d.hostGroups) continue; // mock / pas de host groups → on conserve le type
    d.type = zabbix.detectCategory({ hostGroups: d.hostGroups }, cats) || 'uncat';
  }
  evaluateAll(devicesCache);
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
  recategorize();
  res.json(cat);
});

router.put('/categories/:id', (req, res) => {
  db.upsertCategory({ ...req.body, id: req.params.id });
  recategorize();
  res.json({ ok: true });
});

router.delete('/categories/:id', (req, res) => {
  db.deleteCategory(req.params.id);
  recategorize();
  res.json({ ok: true });
});

/* ── GROUPS ───────────────────────────────────────────────── */
router.get('/groups', (req, res) => {
  res.json(db.getAllGroups());
});

router.post('/groups', (req, res) => {
  const { name, x, y, deviceIds = [], placed = 0 } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = uuid();
  db.createGroup(id, name, x || 0.5, y || 0.5, deviceIds, placed);
  res.json({ id, name, x: x || 0.5, y: y || 0.5, deviceIds, disabled: 0, placed: placed ? 1 : 0, partial: 0 });
});

router.put('/groups/:id', (req, res) => {
  const { name, x, y, deviceIds = [], disabled, placed, partial } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  db.updateGroup(req.params.id, name, x, y, deviceIds, disabled, placed, partial);
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
  const gpsCfg = db.getConfig('gps') || null;
  const mapviewCfg = db.getConfig('mapview') || null;
  const syncCfg = db.getConfig('sync') || null;
  const milestoneCfg = db.getConfig('milestone') || null;
  const safe = { ...zabbixCfg, pass: zabbixCfg.pass ? '••••••••' : '' };
  const safeSync = syncCfg ? { ...syncCfg, apiKey: syncCfg.apiKey ? '••••••••' : '' } : null;
  const safeMs = milestoneCfg ? { ...milestoneCfg, password: milestoneCfg.password ? '••••••••' : '' } : null;
  res.json({ zabbix: safe, display: displayCfg, gps: gpsCfg, mapview: mapviewCfg, sync: safeSync, milestone: safeMs });
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
  if ('gps' in req.body) db.setConfig('gps', req.body.gps);
  if ('mapview' in req.body) db.setConfig('mapview', req.body.mapview);
  if ('sync' in req.body && req.body.sync) {
    const s = { ...req.body.sync };
    const existing = db.getConfig('sync') || {};
    if (s.apiKey === '••••••••') s.apiKey = existing.apiKey || '';
    db.setConfig('sync', s);
  }
  if ('milestone' in req.body) {
    const m = { ...(req.body.milestone || {}) };
    const existing = db.getConfig('milestone') || {};
    if (m.password === '••••••••') m.password = existing.password || '';
    db.setConfig('milestone', m);
    scheduleRefresh(); // le nom de macro peut avoir changé → re-poll Zabbix
  }
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

/* ── CAMÉRA / WebRTC (proxy Milestone) ────────────────────── */
// Le backend porte le login (token OAuth compte de service) et proxifie la signalisation
// WebRTC : le navigateur ne reçoit jamais d'identifiants Milestone.
function msCfg() { return db.getConfig('milestone') || {}; }

// Test d'authentification (compte de service) — utilisé par le bouton des Paramètres.
router.post('/camera/test', async (req, res) => {
  try {
    const body = req.body || {};
    const existing = db.getConfig('milestone') || {};
    const cfg = { ...existing, ...body };
    if (!body.password || body.password === '••••••••') cfg.password = existing.password || '';
    await milestone.getToken(cfg, true);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

router.post('/camera/session', async (req, res) => {
  try {
    const { deviceId, streamId } = req.body || {};
    if (!deviceId) return res.status(400).json({ error: 'deviceId requis' });
    res.json(await milestone.createSession(msCfg(), deviceId, streamId));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

router.patch('/camera/session/:id', async (req, res) => {
  try { await milestone.sendAnswer(msCfg(), req.params.id, (req.body || {}).answerSDP); res.json({ ok: true }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

router.post('/camera/session/:id/ice', async (req, res) => {
  try { await milestone.postIce(msCfg(), req.params.id, (req.body || {}).candidates); res.json({ ok: true }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

router.get('/camera/session/:id/ice', async (req, res) => {
  try { res.json((await milestone.getIce(msCfg(), req.params.id)) || { candidates: [] }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

router.delete('/camera/session/:id', async (req, res) => {
  try { await milestone.closeSession(msCfg(), req.params.id); } catch (_) {}
  res.json({ ok: true });
});

/* ── SYNC (Device Assigner → groupes) ─────────────────────── */
// Normalise un nom pour la correspondance approximative (maj, sans séparateurs)
function normName(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

// Déduit l'état activé/désactivé/partiel d'un groupe depuis le placedStatus du point distant.
// full  → tout le matériel est posé   → activé, alertes normales
// partial → une partie est posée      → activé, mais erreurs masquées (équipement restant normal)
// none/empty/absent → rien n'est posé → désactivé (alertes masquées), comportement existant
function deployState(p) {
  switch (p && p.placedStatus) {
    case 'full': return { disabled: 0, placed: 1, partial: 0 };
    case 'partial': return { disabled: 0, placed: 0, partial: 1 };
    default: return { disabled: 1, placed: 0, partial: 0 };
  }
}

function syncPoints(points) {
  // Index des devices Zabbix par nom normalisé
  const byNorm = new Map();
  for (const d of devicesCache) {
    const n = normName(d.name);
    if (n && !byNorm.has(n)) byNorm.set(n, d);
  }
  function matchDevice(rawName) {
    const n = normName(rawName);
    if (!n) return null;
    if (byNorm.has(n)) return byNorm.get(n);            // correspondance exacte (normalisée)
    let best = null, bestDiff = Infinity;               // correspondance partielle : meilleur candidat
    for (const [dn, d] of byNorm) {
      const shorter = dn.length < n.length ? dn : n;
      if (shorter.length >= 4 && (dn.includes(n) || n.includes(dn))) {
        const diff = Math.abs(dn.length - n.length);
        if (diff < bestDiff) { bestDiff = diff; best = d; }
      }
    }
    return best;
  }

  const existing = db.getAllGroups();
  const bySource = new Map();
  const byName = new Map();
  for (const g of existing) {
    if (g.source_id) bySource.set(g.source_id, g);
    byName.set(g.name.trim().toLowerCase(), g);
  }

  let created = 0, updated = 0, matched = 0, newIdx = 0;
  const unmatched = [];
  const place = () => {                                 // grille pour les nouveaux groupes
    const cols = 8, col = newIdx % cols, row = Math.floor(newIdx / cols);
    newIdx++;
    return { x: Math.min(0.95, 0.08 + col * 0.11), y: Math.min(0.95, 0.10 + row * 0.11) };
  };

  for (const p of points) {
    if (!p || !p.name) continue;
    const matIds = [];
    for (const m of (p.material || [])) {
      const dev = matchDevice(m.name) || matchDevice(m.serialNumber);
      if (dev) { if (!matIds.includes(dev.id)) matIds.push(dev.id); matched++; }
      else unmatched.push({ point: p.name, material: m.name || m.serialNumber || m.unitId || '?' });
    }
    const ds = deployState(p);
    const g = bySource.get(p.id) || byName.get(p.name.trim().toLowerCase());
    if (g) {
      db.updateGroup(g.id, p.name, g.x, g.y, matIds, ds.disabled, ds.placed, ds.partial);
      updated++;
    } else {
      const pos = place();
      db.createGroup(uuid(), p.name, pos.x, pos.y, matIds, ds.placed, p.id, ds.partial, ds.disabled);
      created++;
    }
  }

  return {
    ok: true, pointsTotal: points.length,
    groupsCreated: created, groupsUpdated: updated,
    devicesMatched: matched, unmatchedCount: unmatched.length,
    unmatched: unmatched.slice(0, 100),
  };
}

router.post('/sync', async (req, res) => {
  try {
    const cfg = db.getConfig('sync') || {};
    const url = (req.body && req.body.url) || cfg.url;
    let apiKey = (req.body && req.body.apiKey) || cfg.apiKey;
    if (apiKey === '••••••••') apiKey = cfg.apiKey;
    if (!url) return res.status(400).json({ error: 'URL de synchronisation non configurée' });

    const base = url.replace(/\/+$/, '').replace(/\/api\/v1\/points$/, '');
    const endpoint = base + '/api/v1/points/';
    const headers = {};
    if (apiKey) headers['X-Api-Key'] = apiKey;

    const r = await fetch(endpoint, { headers });
    if (!r.ok) return res.status(502).json({ error: `API distante: HTTP ${r.status}` });
    const points = await r.json();
    if (!Array.isArray(points)) return res.status(502).json({ error: "Réponse inattendue de l'API distante" });

    res.json(syncPoints(points));
  } catch (e) {
    res.status(500).json({ error: e.message });
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

/* ── DEBUG : catégorisation par host group ────────────────── */
router.get('/debug/categorize', (req, res) => {
  const cats = db.getAllCategories().map(c => ({ id: c.id, name: c.name, zabbix_groups: c.zabbix_groups }));
  const devices = devicesCache.map(d => {
    const matched = cats.filter(c => (c.zabbix_groups || []).some(zg =>
      (d.hostGroups || []).some(hg => hg.toLowerCase().includes(zg.toLowerCase()))));
    return { name: d.name, type: d.type, hostGroups: d.hostGroups || null, matched: matched.map(c => c.id) };
  });
  res.json({ categories: cats, devices });
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
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('background.'));
    return files.length ? path.join(DATA_DIR, files[0]) : null;
  } catch (_) { return null; }
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
  try {
    ensureDataDir();
    fs.readdirSync(DATA_DIR).filter(f => f.startsWith('background.')).forEach(f => fs.unlinkSync(path.join(DATA_DIR, f)));
    fs.writeFileSync(path.join(DATA_DIR, `background.${ext}`), Buffer.from(b64, 'base64'));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/map/background', (req, res) => {
  try {
    fs.readdirSync(DATA_DIR).filter(f => f.startsWith('background.')).forEach(f => fs.unlinkSync(path.join(DATA_DIR, f)));
  } catch (_) {}
  res.json({ ok: true });
});

/* ── MOCK DATA ────────────────────────────────────────────── */
function getMockDevices() {
  return [
    { id:'d1',  name:'WAVE-SCENE-01',  type:'wave', ip:'10.0.1.11', ping:true,  latency:2.1,  signal:-58, power:42.5, temp:38, uptime:'12j 4h' },
    { id:'d2',  name:'WAVE-SCENE-02',  type:'wave', ip:'10.0.1.12', ping:true,  latency:2.4,  signal:-62, power:39.1, temp:41, uptime:'12j 4h' },
    { id:'d3',  name:'WAVE-BACKSTAGE', type:'wave', ip:'10.0.1.13', ping:true,  latency:18.7, signal:-81, power:55.8, temp:63, uptime:'3j 2h'  },
    { id:'d4',  name:'AP-SCENE-A1',    type:'ap',   ip:'10.0.2.21', ping:true,  latency:1.2,  signal:-45, clients:34, connFailure:0, uptime:'12j 4h' },
    { id:'d5',  name:'AP-SCENE-A2',    type:'ap',   ip:'10.0.2.22', ping:true,  latency:1.4,  signal:-48, clients:28, connFailure:3, uptime:'12j 4h' },
    { id:'d6',  name:'AP-BACKSTAGE-1', type:'ap',   ip:'10.0.2.23', ping:false, latency:null, signal:null, clients:0,  connFailure:12, uptime:'0h' },
    { id:'d7',  name:'AP-CATERING',    type:'ap',   ip:'10.0.2.24', ping:true,  latency:2.1,  signal:-55, clients:12, uptime:'12j 4h' },
    { id:'d8',  name:'SW-CORE-01',     type:'sw',   ip:'10.0.0.1',  ping:true,  latency:0.4,  ports:24, portsUp:22, temp:44, power:88, uptime:'15j 6h' },
    { id:'d9',  name:'SW-SCENE-01',    type:'sw',   ip:'10.0.0.2',  ping:true,  latency:0.6,  ports:16, portsUp:14, temp:49, power:61, uptime:'12j 4h' },
    { id:'d10', name:'SW-BACKSTAGE',   type:'sw',   ip:'10.0.0.3',  ping:true,  latency:0.5,  ports:16, portsUp:9,  temp:52, power:58, uptime:'12j 4h' },
    { id:'d11', name:'CAM-ENTREE-01',  type:'cam',  ip:'10.0.3.31', ping:true,  latency:1.8,  fps:25, uptime:'12j 4h' },
    { id:'d12', name:'CAM-SCENE-01',   type:'cam',  ip:'10.0.3.32', ping:true,  latency:2.2,  fps:30, uptime:'12j 4h' },
    { id:'d13', name:'CAM-BACKSTAGE',  type:'cam',  ip:'10.0.3.33', ping:true,  latency:42.0, fps:12, uptime:'12j 4h' },
    { id:'d14', name:'CAM-PARKING',    type:'cam',  ip:'10.0.3.34', ping:true,  latency:3.1,  fps:25, uptime:'5j 2h'  },
  ];
}

module.exports = router;
