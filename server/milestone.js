/*
 * Client Milestone XProtect — flux vidéo caméra via WebRTC (API Gateway).
 *
 * Login centralisé : le backend obtient un token OAuth depuis l'IDP avec un compte
 * de service (compte Windows/AD : username = "DOMAINE\\utilisateur"), puis proxifie
 * la signalisation WebRTC. Le navigateur ne voit jamais les identifiants ni le token.
 *
 * Endpoints Milestone utilisés :
 *   POST {serverUrl}/IDP/connect/token                        (OAuth, form-encoded)
 *   POST   {serverUrl}/API/REST/v1/WebRTC/Session             → {sessionId, offerSDP}
 *   PATCH  {serverUrl}/API/REST/v1/WebRTC/Session/{id}        {answerSDP}
 *   POST   {serverUrl}/API/REST/v1/WebRTC/IceCandidates/{id}  {candidates:[...]}
 *   GET    {serverUrl}/API/REST/v1/WebRTC/IceCandidates/{id}  → {candidates:[...]}
 *   DELETE {serverUrl}/API/REST/v1/WebRTC/Session/{id}        (best-effort)
 */
const fetch = require('node-fetch');
const https = require('https');

// Milestone génère souvent un certificat auto-signé → on tolère les certs non vérifiés.
const insecureAgent = new https.Agent({ rejectUnauthorized: false });
function agentFor(url) { return url.startsWith('https') ? insecureAgent : undefined; }

// Cache des tokens, un par profil serveur (clé = serverUrl|username|clientId).
// Plusieurs serveurs Milestone (architecture fédérée / multi-sites) cohabitent.
const _toks = new Map(); // key -> { access_token, exp }

function root(cfg) { return String(cfg.serverUrl || '').replace(/\/+$/, ''); }
function cfgKey(cfg) { return `${root(cfg)}|${cfg.username}|${cfg.clientId || 'GrantValidatorClient'}`; }

// force=true : ignore le cache (et ne le pollue pas) — pour le test d'authentification.
async function getToken(cfg, force = false) {
  if (!cfg || !cfg.serverUrl) throw new Error('Milestone non configuré (URL serveur manquante)');
  const key = cfgKey(cfg);
  if (!force) { const c = _toks.get(key); if (c && Date.now() < c.exp - 60000) return c.access_token; }

  const url = root(cfg) + '/IDP/connect/token';
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: cfg.clientId || 'GrantValidatorClient',
    username: cfg.username || '',
    password: cfg.password || '',
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    agent: agentFor(url),
    timeout: 15000,
  });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { throw new Error(`IDP a renvoyé une réponse non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`); }
  if (!res.ok || !j.access_token) {
    throw new Error(`Authentification Milestone échouée (HTTP ${res.status}): ${j.error_description || j.error || text.slice(0, 150)}`);
  }
  if (!force) _toks.set(key, { access_token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 });
  return j.access_token;
}

function apiBase(cfg) { return root(cfg) + '/API/REST/v1/WebRTC'; }

async function api(cfg, method, path, jsonBody, quiet = false) {
  const token = await getToken(cfg);
  const url = apiBase(cfg) + path;
  const opt = { method, headers: { Authorization: `Bearer ${token}` }, agent: agentFor(url), timeout: 15000 };
  if (jsonBody !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(jsonBody); }
  if (jsonBody !== undefined && method === 'POST' && path === '/Session') {
    console.log(`[Milestone] POST /Session deviceId=${jsonBody.deviceId} streamId=${jsonBody.streamId || '(défaut)'} url=${url}`);
  }
  const res = await fetch(url, opt);
  const text = await res.text();
  let j = null; if (text) { try { j = JSON.parse(text); } catch { /* corps non-JSON toléré (PATCH/POST vides) */ } }
  if (!res.ok) {
    // L'erreur Milestone est souvent une AggregateException dont la cause racine est en fin de texte.
    if (!quiet) console.error(`[Milestone] ${method} ${path} → HTTP ${res.status} : ${text}`);
    const detail = (j && (j.error_description || j.error || j.message)) || text;
    throw new Error(`Milestone WebRTC ${method} ${path} → HTTP ${res.status}: ${String(detail).slice(0, 500)}`);
  }
  return j;
}

// Construit la liste iceServers depuis la config (vide = candidats host suffisent en LAN).
function iceServers(cfg) {
  const list = [];
  if (cfg.turnUrl) {
    const t = { urls: cfg.turnUrl };
    if (cfg.turnUser) t.username = cfg.turnUser;
    if (cfg.turnPass) t.credential = cfg.turnPass;
    list.push(t);
  }
  if (cfg.stunUrl) list.push({ urls: cfg.stunUrl });
  return list;
}

async function createSession(cfg, deviceId, streamId) {
  if (!deviceId) throw new Error('deviceId (GUID caméra) requis');
  const ice = iceServers(cfg);
  const body = { deviceId, includeAudio: false };
  if (streamId) body.streamId = streamId;
  if (ice.length) body.iceServers = ice;
  const j = await api(cfg, 'POST', '/Session', body);
  const sessionId = j && (j.sessionId || j.SessionId);
  const offerSDP = j && (j.offerSDP || j.OfferSDP);
  // Diagnostic : combien de candidats le serveur embarque dans l'offer SDP, et sur quelles IP ?
  let sdp = offerSDP; if (sdp && typeof sdp === 'object') sdp = sdp.sdp; if (typeof sdp === 'string' && sdp.charAt(0) === '{') { try { sdp = JSON.parse(sdp).sdp; } catch {} }
  const cand = String(sdp || '').match(/^a=candidate:.*/gmi) || [];
  const ips = [...new Set(cand.map(c => c.split(/\s+/)[4]).filter(Boolean))];
  console.log(`[Milestone] Session ${sessionId} créée — offerSDP ${offerSDP ? 'OK' : 'ABSENT'}, ${cand.length} candidat(s) embarqué(s)${ips.length ? ' sur ' + ips.join(', ') : ''}`);
  // On renvoie au navigateur les iceServers (pour configurer son RTCPeerConnection à l'identique).
  return { sessionId, offerSDP, iceServers: ice };
}

function sendAnswer(cfg, sessionId, answerSDP) { return api(cfg, 'PATCH', `/Session/${sessionId}`, { answerSDP }); }
function postIce(cfg, sessionId, candidates) { return api(cfg, 'POST', `/IceCandidates/${sessionId}`, { candidates: candidates || [] }); }
async function getIce(cfg, sessionId) {
  const j = await api(cfg, 'GET', `/IceCandidates/${sessionId}`);
  const n = (j && Array.isArray(j.candidates)) ? j.candidates.length : 0;
  if (n) console.log(`[Milestone] GET /IceCandidates/${sessionId} → ${n} candidat(s) serveur`);
  return j;
}
// Best-effort : certaines versions de l'API Gateway n'autorisent pas DELETE sur /Session (HTTP 405) ;
// la session expire alors d'elle-même côté serveur. On reste silencieux pour ne pas polluer les logs.
async function closeSession(cfg, sessionId) { try { return await api(cfg, 'DELETE', `/Session/${sessionId}`, undefined, true); } catch { return null; } }

/* ── Snapshot JPEG (fallback H265) ──────────────────────────────────
 * Le navigateur ne décode pas le H.265 en WebRTC (Chrome/Edge) → la <video> reste noire.
 * Comme le client web Milestone, on récupère alors des images JPEG transcodées par le
 * Recording Server : le navigateur n'a plus aucun codec à gérer, il affiche des <img>.
 * Endpoint : POST {serverUrl}/API/REST/v1/cameras/{cameraId}?task=JpegGetLive  {width,height}
 * (transcodage CPU côté Recording Server — à réserver au fallback). Milestone 2025R3+. */
function restBase(cfg) { return root(cfg) + '/API/REST/v1'; }

// Cherche récursivement la première chaîne base64 « longue » dans la réponse JSON
// (le format exact — champ data/blob/image… — n'est pas documenté, on reste tolérant).
function findBase64(o, depth = 0) {
  if (depth > 6 || o == null) return null;
  if (typeof o === 'string') return (o.length > 256 && /^[A-Za-z0-9+/=\s]+$/.test(o)) ? o.replace(/\s+/g, '') : null;
  if (Array.isArray(o)) { for (const v of o) { const r = findBase64(v, depth + 1); if (r) return r; } return null; }
  if (typeof o === 'object') {
    for (const k of ['blob', 'bytes', 'base64', 'image', 'data', 'snapshot', 'jpeg']) {
      if (o[k] != null) { const r = findBase64(o[k], depth + 1); if (r) return r; }
    }
    for (const v of Object.values(o)) { const r = findBase64(v, depth + 1); if (r) return r; }
  }
  return null;
}

async function getSnapshot(cfg, cameraId, width, height) {
  if (!cameraId) throw new Error('cameraId (GUID caméra) requis');
  const token = await getToken(cfg);
  const url = `${restBase(cfg)}/cameras/${encodeURIComponent(cameraId)}?task=JpegGetLive`;
  // Width/Height sont OBLIGATOIRES pour JpegGetLive (HTTP 400 sinon) → défauts si non fournis.
  const body = { width: Math.round(width) || 1280, height: Math.round(height) || 720 };
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    agent: agentFor(url),
    timeout: 15000,
  });
  const ct = res.headers.get('content-type') || '';
  if (!res.ok) {
    const text = await res.text();
    console.error(`[Milestone] JpegGetLive ${cameraId} → HTTP ${res.status} : ${text.slice(0, 300)}`);
    throw new Error(`Milestone JpegGetLive → HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  // Réponse soit en image brute (Content-Type image/*), soit en JSON enveloppant du base64.
  if (ct.startsWith('image/')) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 100) return { buffer: buf, contentType: ct };
    return { buffer: null }; // 200 mais corps vide → frame indisponible (transitoire)
  }
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch { /* ni image ni JSON */ }
  const b64 = j ? findBase64(j) : null;
  if (!b64) {
    // HTTP 200 sans JPEG exploitable = pas de frame dispo à cet instant (transcodeur, cadence…).
    // Transitoire, pas une vraie erreur : on signale « pas d'image » et le client garde la précédente.
    console.warn(`[Milestone] JpegGetLive ${cameraId} → 200 sans image (${ct || 'sans type'}) : ${text.slice(0, 120)}`);
    return { buffer: null };
  }
  return { buffer: Buffer.from(b64, 'base64'), contentType: 'image/jpeg' };
}

module.exports = { getToken, createSession, sendAnswer, postIce, getIce, closeSession, getSnapshot };
