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

async function api(cfg, method, path, jsonBody) {
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
    console.error(`[Milestone] ${method} ${path} → HTTP ${res.status} : ${text}`);
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
async function closeSession(cfg, sessionId) { try { return await api(cfg, 'DELETE', `/Session/${sessionId}`); } catch { return null; } }

module.exports = { getToken, createSession, sendAnswer, postIce, getIce, closeSession };
