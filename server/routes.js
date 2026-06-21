const express = require('express');
const router = express.Router();
const db = require('./db');
const zabbix = require('./zabbix');
const milestone = require('./milestone');
const auth = require('./auth');
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
    applyFov(devicesCache);
    return;
  }
  try {
    const categories = db.getAllCategories();
    const ms = db.getConfig('milestone') || {};
    const devices = await zabbix.getHosts(cfg, categories, ms.macroName || '{$MILESTONE_ID}', ms.ipMacroName || '{$MILESTONE.IP}');
    evaluateAll(devices);
    applyPositions(devices);
    applyFov(devices);
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

// Attache les paramètres de cône de champ de vision (device_fov) aux équipements.
function applyFov(devices) {
  const rows = db.getAllFov();
  const fovMap = {};
  for (const r of rows) fovMap[r.device_id] = { dir: r.dir, angle: r.angle, range: r.range, enabled: r.enabled };
  for (const d of devices) {
    if (fovMap[d.id]) d.fov = fovMap[d.id];
    else delete d.fov;
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

/* ── AUTH (routes publiques avant le middleware) ──────────── */
// Statut de connexion : indique si des comptes existent (sinon → écran de configuration
// initiale côté client) et si la requête courante est authentifiée.
router.get('/auth/status', (req, res) => {
  const session = auth.getSession(auth.tokenFromReq(req));
  const role = session ? (db.getUser(session.username) || {}).role || null : null;
  res.json({ hasUsers: db.countUsers() > 0, authenticated: !!session, user: session ? session.username : null, role });
});

// Création du tout premier compte — autorisée uniquement tant qu'aucun compte n'existe.
router.post('/auth/setup', (req, res) => {
  if (db.countUsers() > 0) return res.status(403).json({ error: 'Configuration déjà initialisée' });
  const username = String((req.body || {}).username || '').trim();
  const password = String((req.body || {}).password || '');
  if (username.length < 3) return res.status(400).json({ error: 'Identifiant trop court (3 caractères min.)' });
  if (password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (6 caractères min.)' });
  db.createUser(username, auth.hashPassword(password), 'admin'); // premier compte = administrateur
  auth.setSessionCookie(res, auth.createSession(username));
  res.json({ ok: true, user: username, role: 'admin' });
});

router.post('/auth/login', (req, res) => {
  const username = String((req.body || {}).username || '').trim();
  const password = String((req.body || {}).password || '');
  const u = db.getUser(username);
  if (!u || !auth.verifyPassword(password, u.pass_hash))
    return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect' });
  auth.setSessionCookie(res, auth.createSession(username));
  res.json({ ok: true, user: username, role: u.role });
});

router.post('/auth/logout', (req, res) => {
  auth.destroySession(auth.tokenFromReq(req));
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

// ── À partir d'ici, toute route exige une session valide ──────
router.use(auth.requireAuth);

// Réserve une route aux administrateurs (les comptes restreints reçoivent 403).
function requireAdmin(req, res, next) {
  const u = db.getUser(req.user);
  if (!u || u.role !== 'admin') return res.status(403).json({ error: 'Action réservée aux administrateurs' });
  next();
}

router.get('/auth/me', (req, res) => {
  const u = db.getUser(req.user) || {};
  res.json({ user: req.user, role: u.role || null });
});

/* ── UTILISATEURS (gestion des comptes — admin uniquement) ── */
router.get('/users', requireAdmin, (req, res) => {
  res.json(db.getAllUsers().map(u => ({ username: u.username, role: u.role, created_at: u.created_at, current: u.username === req.user })));
});

router.post('/users', requireAdmin, (req, res) => {
  const username = String((req.body || {}).username || '').trim();
  const password = String((req.body || {}).password || '');
  const role = (req.body || {}).role === 'restricted' ? 'restricted' : 'admin';
  if (username.length < 3) return res.status(400).json({ error: 'Identifiant trop court (3 caractères min.)' });
  if (password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (6 caractères min.)' });
  if (db.getUser(username)) return res.status(409).json({ error: 'Cet identifiant existe déjà' });
  db.createUser(username, auth.hashPassword(password), role);
  res.json({ ok: true });
});

router.patch('/users/:username/password', requireAdmin, (req, res) => {
  const password = String((req.body || {}).password || '');
  if (!db.getUser(req.params.username)) return res.status(404).json({ error: 'Utilisateur introuvable' });
  if (password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (6 caractères min.)' });
  db.updateUserPassword(req.params.username, auth.hashPassword(password));
  res.json({ ok: true });
});

router.delete('/users/:username', requireAdmin, (req, res) => {
  if (!db.getUser(req.params.username)) return res.status(404).json({ error: 'Utilisateur introuvable' });
  if (db.countUsers() <= 1) return res.status(400).json({ error: 'Impossible de supprimer le dernier compte' });
  db.deleteUser(req.params.username);
  res.json({ ok: true });
});

/* ── DEVICES ──────────────────────────────────────────────── */
router.get('/devices', (req, res) => {
  res.json({ devices: devicesCache, lastFetch, error: fetchError });
});

router.post('/devices/refresh', async (req, res) => {
  await fetchDevices();
  res.json({ devices: devicesCache, lastFetch, error: fetchError });
});

router.patch('/devices/:id/position', requireAdmin, (req, res) => {
  const { x, y } = req.body;
  if (x == null || y == null) return res.status(400).json({ error: 'x and y required' });
  db.upsertPosition(req.params.id, x, y);
  const dev = devicesCache.find(d => d.id === req.params.id);
  if (dev) { dev.x = x; dev.y = y; dev.onMap = true; }
  res.json({ ok: true });
});

router.delete('/devices/:id/position', requireAdmin, (req, res) => {
  db.deleteDevicePosition(req.params.id);
  const dev = devicesCache.find(d => d.id === req.params.id);
  if (dev) { dev.onMap = false; delete dev.x; delete dev.y; }
  res.json({ ok: true });
});

// Cône de champ de vision : orientation (dir), portée (range), angle d'ouverture, affichage (enabled).
router.patch('/devices/:id/fov', requireAdmin, (req, res) => {
  const { dir, angle, range, enabled } = req.body || {};
  const fov = db.upsertFov(req.params.id, { dir, angle, range, enabled });
  const dev = devicesCache.find(d => d.id === req.params.id);
  if (dev) dev.fov = fov;
  res.json({ ok: true, fov });
});

router.delete('/devices/:id/fov', requireAdmin, (req, res) => {
  db.deleteFov(req.params.id);
  const dev = devicesCache.find(d => d.id === req.params.id);
  if (dev) delete dev.fov;
  res.json({ ok: true });
});

/* ── CATEGORIES ───────────────────────────────────────────── */
router.get('/categories', (req, res) => {
  res.json(db.getAllCategories());
});

router.post('/categories', requireAdmin, (req, res) => {
  const cat = req.body;
  if (!cat.id) cat.id = uuid();
  db.upsertCategory(cat);
  recategorize();
  res.json(cat);
});

router.put('/categories/:id', requireAdmin, (req, res) => {
  db.upsertCategory({ ...req.body, id: req.params.id });
  recategorize();
  res.json({ ok: true });
});

router.delete('/categories/:id', requireAdmin, (req, res) => {
  db.deleteCategory(req.params.id);
  recategorize();
  res.json({ ok: true });
});

/* ── GROUPS ───────────────────────────────────────────────── */
router.get('/groups', (req, res) => {
  res.json(db.getAllGroups());
});

router.post('/groups', requireAdmin, (req, res) => {
  const { name, x, y, deviceIds = [], placed = 0 } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = uuid();
  db.createGroup(id, name, x || 0.5, y || 0.5, deviceIds, placed);
  res.json({ id, name, x: x || 0.5, y: y || 0.5, deviceIds, disabled: 0, placed: placed ? 1 : 0, partial: 0 });
});

router.put('/groups/:id', requireAdmin, (req, res) => {
  const { name, x, y, deviceIds = [], disabled, placed, partial } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  db.updateGroup(req.params.id, name, x, y, deviceIds, disabled, placed, partial);
  res.json({ ok: true });
});

router.delete('/groups/:id', requireAdmin, (req, res) => {
  db.deleteGroup(req.params.id);
  res.json({ ok: true });
});

/* ── EXPORT / IMPORT (positions, points, cônes, calibration) ─ */
// Exporte la mise en page de la carte dans un JSON portable (positions des
// équipements, points/groupes, champs de vision, calibration GPS).
router.get('/export', requireAdmin, (req, res) => {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    positions: db.getAllPositions(),   // [{device_id,x,y,updated_at}]
    groups: db.getAllGroups(),         // [{id,name,x,y,deviceIds,...}]
    fov: db.getAllFov(),               // [{device_id,dir,angle,range,enabled}]
    gps: db.getConfig('gps') || null,  // {bounds, rotation…}
  };
  res.setHeader('Content-Disposition', 'attachment; filename="solidays-map.json"');
  res.json(payload);
});

// Restaure une mise en page exportée. Fusion par id (non destructif) : les
// positions/points/cônes absents du fichier sont conservés tels quels.
router.post('/import', requireAdmin, (req, res) => {
  const data = req.body || {};
  const positions = Array.isArray(data.positions) ? data.positions : [];
  const groups = Array.isArray(data.groups) ? data.groups : [];
  const fov = Array.isArray(data.fov) ? data.fov : [];
  const stats = { positions: 0, groups: 0, fov: 0 };

  db.db.transaction(() => {
    for (const p of positions) {
      if (!p || p.device_id == null || p.x == null || p.y == null) continue;
      db.upsertPosition(p.device_id, p.x, p.y);
      stats.positions++;
    }
    for (const f of fov) {
      if (!f || f.device_id == null) continue;
      db.upsertFov(f.device_id, f);
      stats.fov++;
    }
    const existing = new Set(db.getAllGroups().map(g => g.id));
    for (const g of groups) {
      if (!g || !g.id || !g.name) continue;
      const ids = Array.isArray(g.deviceIds) ? g.deviceIds : [];
      if (existing.has(g.id))
        db.updateGroup(g.id, g.name, g.x, g.y, ids, g.disabled, g.placed, g.partial);
      else
        db.createGroup(g.id, g.name, g.x ?? 0.5, g.y ?? 0.5, ids, g.placed, g.source_id ?? null, g.partial, g.disabled);
      stats.groups++;
    }
    if (data.gps && typeof data.gps === 'object') db.setConfig('gps', data.gps);
  })();

  // Réapplique sur le cache en mémoire pour que /api/devices reflète l'import.
  applyPositions(devicesCache);
  applyFov(devicesCache);
  res.json({ ok: true, ...stats });
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
  const safeMs = maskMilestone(milestoneCfg);
  res.json({ zabbix: safe, display: displayCfg, gps: gpsCfg, mapview: mapviewCfg, sync: safeSync, milestone: safeMs });
});

router.post('/config', (req, res) => {
  // Comptes restreints : seul l'onglet « Affichage » est autorisé (display partagé).
  // Toute autre clé de config (zabbix, sync, milestone, calibration GPS) est ignorée.
  const isAdmin = (db.getUser(req.user) || {}).role === 'admin';
  if (!isAdmin) {
    // Fusion : un compte restreint n'envoie que labels/halos/grid — on préserve les autres
    // clés partagées (ex. iconScale réglée par l'admin) plutôt que de les écraser.
    if (req.body.display) db.setConfig('display', { ...(db.getConfig('display') || {}), ...req.body.display });
    return res.json({ ok: true });
  }
  const { zabbix: z, display } = req.body;
  if (z) {
    const existing = db.getConfig('zabbix') || {};
    if (z.pass === '••••••••') z.pass = existing.pass || '';
    db.setConfig('zabbix', z);
    scheduleRefresh();
  }
  if (display) db.setConfig('display', { ...(db.getConfig('display') || {}), ...display });
  if ('gps' in req.body) db.setConfig('gps', req.body.gps);
  if ('mapview' in req.body) db.setConfig('mapview', req.body.mapview);
  if ('sync' in req.body && req.body.sync) {
    const s = { ...req.body.sync };
    const existing = db.getConfig('sync') || {};
    if (s.apiKey === '••••••••') s.apiKey = existing.apiKey || '';
    db.setConfig('sync', s);
  }
  if ('milestone' in req.body) {
    db.setConfig('milestone', mergeMilestoneSecrets(req.body.milestone || {}, db.getConfig('milestone') || {}));
    scheduleRefresh(); // les noms de macro peuvent avoir changé → re-poll Zabbix
  }
  res.json({ ok: true });
});

/* ── Helpers config Milestone (basic user global + IP par caméra) ── */
const MASK = '••••••••';

// Masque le mot de passe (identifiants globaux) avant envoi au client.
function maskMilestone(m) {
  if (!m) return null;
  return { ...m, password: m.password ? MASK : '' };
}

// Restaure le mot de passe masqué à partir de l'existant.
function mergeMilestoneSecrets(incoming, existing) {
  const m = { ...incoming };
  if (m.password === MASK) m.password = existing.password || '';
  return m;
}

// Construit l'URL d'un serveur Milestone depuis l'IP remontée par la macro.
function serverUrlFromIp(ip, m) {
  if (!ip) return m.serverUrl || '';
  if (/^https?:\/\//i.test(ip)) return ip.replace(/\/+$/, '');
  const proto = m.proto || 'https';
  const port = m.port ? `:${m.port}` : '';
  return `${proto}://${ip}${port}`;
}

// Profil de connexion pour une caméra : URL dérivée de l'IP + identifiants globaux + ICE.
function serverProfile(ip) {
  const m = db.getConfig('milestone') || {};
  return {
    serverUrl: serverUrlFromIp(ip, m),
    username: m.username, password: m.password, clientId: m.clientId,
    stunUrl: m.stunUrl, turnUrl: m.turnUrl, turnUser: m.turnUser, turnPass: m.turnPass,
  };
}

// Anti-SSRF : on n'accepte de se connecter qu'aux IP de serveur réellement remontées par Zabbix.
function isAllowedServer(ip) {
  if (!ip) return true; // pas d'IP → fallback config (serverUrl global éventuel)
  for (const d of (devicesCache || [])) if (d.milestoneServer === ip) return true;
  return false;
}

router.post('/config/test', requireAdmin, async (req, res) => {
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
// On mémorise le serveur de chaque session pour router les appels suivants (multi-sites).
const sessionServers = new Map(); // sessionId -> serverKey

// Test d'authentification (basic user global) contre l'IP d'un serveur — bouton Paramètres.
router.post('/camera/test', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const m = db.getConfig('milestone') || {};
    const cfg = {
      serverUrl: serverUrlFromIp(body.ip, { ...m, proto: body.proto || m.proto, port: body.port != null ? body.port : m.port }),
      username: body.username != null ? body.username : m.username,
      password: (!body.password || body.password === MASK) ? (m.password || '') : body.password,
      clientId: body.clientId || m.clientId,
    };
    if (!cfg.serverUrl) return res.status(400).json({ ok: false, error: 'IP serveur requise' });
    await milestone.getToken(cfg, true);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

router.post('/camera/session', async (req, res) => {
  try {
    const { deviceId, streamId, server } = req.body || {};
    if (!deviceId) return res.status(400).json({ error: 'deviceId requis' });
    if (!isAllowedServer(server)) return res.status(400).json({ error: 'serveur Milestone non reconnu' });
    const r = await milestone.createSession(serverProfile(server), deviceId, streamId);
    if (r && r.sessionId) sessionServers.set(r.sessionId, server || '');
    res.json(r);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

router.patch('/camera/session/:id', async (req, res) => {
  try { await milestone.sendAnswer(serverProfile(sessionServers.get(req.params.id)), req.params.id, (req.body || {}).answerSDP); res.json({ ok: true }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

router.post('/camera/session/:id/ice', async (req, res) => {
  try { await milestone.postIce(serverProfile(sessionServers.get(req.params.id)), req.params.id, (req.body || {}).candidates); res.json({ ok: true }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

router.get('/camera/session/:id/ice', async (req, res) => {
  try { res.json((await milestone.getIce(serverProfile(sessionServers.get(req.params.id)), req.params.id)) || { candidates: [] }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

router.delete('/camera/session/:id', async (req, res) => {
  try { await milestone.closeSession(serverProfile(sessionServers.get(req.params.id)), req.params.id); } catch (_) {}
  sessionServers.delete(req.params.id);
  res.json({ ok: true });
});

// Snapshot JPEG live (fallback H265) : le serveur transcode, le navigateur n'a aucun codec à décoder.
router.get('/camera/snapshot/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const server = req.query.server || '';
    if (!deviceId) return res.status(400).send('deviceId requis');
    if (!isAllowedServer(server)) return res.status(400).send('serveur Milestone non reconnu');
    const w = parseInt(req.query.w, 10) || 0, h = parseInt(req.query.h, 10) || 0;
    const { buffer, contentType } = await milestone.getSnapshot(serverProfile(server), deviceId, w, h);
    res.set('Cache-Control', 'no-store');
    if (!buffer) return res.status(204).end(); // pas de frame dispo à cet instant (transitoire)
    res.set('Content-Type', contentType);
    res.send(buffer);
  } catch (e) { res.status(502).send(e.message); }
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

router.post('/sync', requireAdmin, async (req, res) => {
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

router.post('/triggers', requireAdmin, (req, res) => {
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

router.delete('/triggers/:id', requireAdmin, (req, res) => {
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
    { id:'d1',  name:'WAVE-SCENE-01',  type:'wave', ip:'10.0.1.11', location:'Scène Solidarité', ping:true,  latency:2.1,  signal:-58, power:42.5, temp:38, uptime:'12j 4h' },
    { id:'d2',  name:'WAVE-SCENE-02',  type:'wave', ip:'10.0.1.12', location:'Scène Paris',      ping:true,  latency:2.4,  signal:-62, power:39.1, temp:41, uptime:'12j 4h' },
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
