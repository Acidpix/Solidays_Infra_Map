const crypto = require('crypto');

// Authentification multi-comptes : mots de passe hashés (scrypt) en base, sessions
// par cookie. Les sessions sont en mémoire — un redémarrage du service oblige à se
// reconnecter (acceptable pour un outil d'événement, pas de dépendance externe).

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours
const COOKIE_NAME = 'netmap_session';

// token -> { username, expires }
const sessions = new Map();

// ── Mots de passe (scrypt + sel aléatoire) ───────────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hash] = parts;
  const hashBuf = Buffer.from(hash, 'hex');
  const test = crypto.scryptSync(String(password), salt, hashBuf.length);
  return hashBuf.length === test.length && crypto.timingSafeEqual(hashBuf, test);
}

// ── Sessions ─────────────────────────────────────────────────
function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username, expires: Date.now() + SESSION_TTL_MS });
  return token;
}

function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(token); return null; }
  return s;
}

function destroySession(token) { if (token) sessions.delete(token); }

// ── Cookies ──────────────────────────────────────────────────
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function tokenFromReq(req) {
  const cookies = parseCookies(req);
  if (cookies[COOKIE_NAME]) return cookies[COOKIE_NAME];
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: SESSION_TTL_MS });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

// ── Middleware ───────────────────────────────────────────────
function requireAuth(req, res, next) {
  const s = getSession(tokenFromReq(req));
  if (!s) return res.status(401).json({ error: 'Non authentifié' });
  req.user = s.username;
  next();
}

module.exports = {
  COOKIE_NAME, hashPassword, verifyPassword,
  createSession, getSession, destroySession,
  tokenFromReq, setSessionCookie, clearSessionCookie, requireAuth,
};
