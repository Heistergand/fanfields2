// FanFields 3 usage stats server : collects anonymous presence pings from the plugin (hashed
// agent id, faction — nothing else) and serves an admin dashboard to review them.
// Aucune dépendance externe (Node >= 18), même approche que le serveur iitc-sync voisin.
//
// Le plugin envoie un ping "je suis là" à chaque changement de visibilité (visible/caché) et
// toutes les STATS_PING_INTERVAL_MS tant qu'il reste visible, plutôt qu'une durée déjà calculée
// côté client : en usage réel, IITC n'est souvent ouvert que quelques secondes (vérifier la
// prochaine action), pas assez pour qu'un minuteur côté client ait le temps de se déclencher.
// C'est donc ici, dans handleCollect, que l'écart entre deux pings consécutifs d'un même agent
// devient une durée — voir SESSION_GAP_MS.
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '8080', 10);
const DATA_DIR = process.env.DATA_DIR || '/data';
const EVENTS_DIR = path.join(DATA_DIR, 'events');
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');
const ADMIN_DIR = path.join(__dirname, 'admin');
const GEOIP_FILE = path.join(__dirname, 'geoip', 'ipv4-regions.bin');

// L'origine du plugin : les en-têtes CORS ci-dessous ne sont qu'un confort pour un appel
// fetch() depuis ce contexte précis (la réponse à /collect est lisible par le script). Ils ne
// protègent pas le serveur : un script tiers peut toujours poster sur /collect directement
// (sendBeacon et un simple POST texte ne sont jamais bloqués par le navigateur avant l'envoi).
// La vraie protection, ci-dessous, c'est la validation stricte du corps et la limite de débit
// par IP.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://intel.ingress.com';

// ---- Limites ----
const MAX_BODY = 4 * 1024;
const PROTOCOL_VERSION = 1;
const AGENT_HASH_RE = /^[0-9a-f]{64}$/; // HMAC-SHA256 hex, calculé côté client (voir le plugin)
const FACTIONS = ['ENL', 'RES'];
// Écart maximum entre deux pings consécutifs d'un même agent pour que l'écart compte comme du
// temps actif continu (le plugin re-ping toutes les 60 s tant qu'il est visible, donc une marge
// large face à la gigue réseau/du minuteur). Au-delà, le plugin a été refermé entre les deux :
// cet intervalle ne doit pas compter.
const SESSION_GAP_MS = 3 * 60 * 1000;
const MAX_SECONDS_PER_EVENT = Math.round(SESSION_GAP_MS / 1000);
const WINDOW_MS = 60 * 1000;
const MAX_EVENTS_PER_IP = 30; // large : plusieurs agents peuvent partager une IP (NAT, 4G...)
const MAX_LOGIN_FAILURES_PER_IP = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 731; // ~2 ans, borne le coût d'agrégation d'une requête /admin/api/stats

// Fichiers de données lisibles uniquement par le processus
process.umask(0o077);

// ---- GeoIP (pays -> région, IPv4 seulement) ----
// Table compacte pré-calculée (voir stats-server/geoip/README.md) : plages d'IPv4 triées,
// chaque entrée démarre une nouvelle région. Généré hors-ligne depuis GeoLite2 (sapics/
// ip-location-db), jamais régénéré au runtime. Une IP non trouvée (IPv6, table absente) retombe
// sur 'other'.
const REGIONS = ['other', 'north_america', 'south_america', 'west_europe', 'middle_east_africa', 'east_europe', 'china', 'asia'];
let geoStarts = new Uint32Array(0);
let geoRegionIds = new Uint8Array(0);
try {
  const buf = fs.readFileSync(GEOIP_FILE);
  const n = Math.floor(buf.length / 5);
  geoStarts = new Uint32Array(n);
  geoRegionIds = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    geoStarts[i] = buf.readUInt32BE(i * 5);
    geoRegionIds[i] = buf.readUInt8(i * 5 + 4);
  }
  console.log('GeoIP : ' + n + ' plages chargées');
} catch (e) {
  console.error('GeoIP indisponible (' + e.message + ') : toutes les régions seront "other"');
}

function ipv4ToInt(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2]), c = Number(m[3]), d = Number(m[4]);
  if (a > 255 || b > 255 || c > 255 || d > 255) return null;
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function regionForIp(ip) {
  const n = ipv4ToInt(ip);
  if (n === null || geoStarts.length === 0) return 'other';
  let lo = 0, hi = geoStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (geoStarts[mid] <= n) lo = mid; else hi = mid - 1;
  }
  return REGIONS[geoRegionIds[lo]];
}

// IP du client : dernière entrée de X-Forwarded-For, posée par Traefik et non falsifiable par
// le client (les en-têtes fournis par le client sont ignorés).
function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',');
  return xff[xff.length - 1].trim() || req.socket.remoteAddress;
}

// ---- Compteur glissant (anti force brute / anti abus) ----
function makeCounter(windowMs) {
  const map = new Map();
  return {
    count: function (key) {
      const e = map.get(key);
      if (!e) return 0;
      if (Date.now() - e.since > windowMs) { map.delete(key); return 0; }
      return e.count;
    },
    add: function (key) {
      if (this.count(key) === 0) map.set(key, { count: 0, since: Date.now() });
      map.get(key).count++;
    },
    purge: function () {
      const now = Date.now();
      map.forEach(function (e, k) { if (now - e.since > windowMs) map.delete(k); });
    }
  };
}
const collectLimiter = makeCounter(WINDOW_MS);
const loginFailures = makeCounter(LOGIN_WINDOW_MS);

// Dernier ping vu par agent (hash -> ts), pour transformer deux pings consécutifs en durée dans
// handleCollect. Purgé ci-dessous comme les autres : une entrée plus vieille que SESSION_GAP_MS
// aurait de toute façon donné 0 seconde au prochain ping, la purge ne fait qu'éviter de la
// garder en mémoire indéfiniment pour un agent qui ne revient jamais.
const lastSeen = new Map();

setInterval(function () {
  collectLimiter.purge();
  loginFailures.purge();
  purgeSessions();
  const cutoff = Date.now() - SESSION_GAP_MS;
  lastSeen.forEach(function (ts, agent) { if (ts < cutoff) lastSeen.delete(agent); });
}, 60 * 1000).unref();

// ---- Mots de passe (admin uniquement : un seul compte) ----
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const MIN_NEW_PASSWORD = 12;
const MAX_PASSWORD = 200;
const GENERATED_PASSWORD_LENGTH = 20;
const GENERATED_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SESSION_TTL = 8 * 60 * 60 * 1000;

function scrypt(password, salt, N) {
  return new Promise(function (resolve, reject) {
    crypto.scrypt(password, salt, 32, Object.assign({}, SCRYPT, { N: N }), function (err, key) {
      if (err) reject(err); else resolve(key);
    });
  });
}
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return scrypt(password, salt, SCRYPT.N).then(function (key) {
    return { salt: salt, hash: key.toString('hex'), N: SCRYPT.N };
  });
}
function checkPassword(auth, password) {
  return scrypt(password, auth.salt, auth.N || SCRYPT.N).then(function (key) {
    return crypto.timingSafeEqual(key, Buffer.from(auth.hash, 'hex'));
  });
}
function randomPassword() {
  const bytes = crypto.randomBytes(GENERATED_PASSWORD_LENGTH);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += GENERATED_ALPHABET[bytes[i] % GENERATED_ALPHABET.length];
  return out;
}

// Compte admin : { user, auth: { salt, hash, N } }. Créé au premier démarrage avec un mot de
// passe aléatoire affiché UNE SEULE FOIS dans les logs du conteneur (jamais stocké en clair, ni
// dans une variable d'environnement, ni dans un fichier) ; modifiable ensuite depuis la page
// admin (route password ci-dessous).
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
let admin = null;
const sessions = new Map(); // jeton -> expiration

function saveAdmin() {
  fs.mkdirSync(path.dirname(ADMIN_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(ADMIN_FILE + '.tmp', JSON.stringify(admin), { mode: 0o600 });
  fs.renameSync(ADMIN_FILE + '.tmp', ADMIN_FILE);
}

function loadAdmin() {
  try {
    admin = JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'));
    return Promise.resolve();
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const password = randomPassword();
  return hashPassword(password).then(function (auth) {
    admin = { user: ADMIN_USER, auth: auth };
    saveAdmin();
    console.log('================================================================');
    console.log(' Compte admin créé. Identifiants (ne seront plus jamais affichés) :');
    console.log('   utilisateur : ' + ADMIN_USER);
    console.log('   mot de passe : ' + password);
    console.log(' Changez ce mot de passe depuis la page admin dès la première connexion.');
    console.log('================================================================');
  });
}

function purgeSessions() {
  const now = Date.now();
  sessions.forEach(function (exp, t) { if (exp < now) sessions.delete(t); });
}
function adminSession(req) {
  const header = String(req.headers.authorization || '');
  const token = header.indexOf('Bearer ') === 0 ? header.slice(7) : '';
  const exp = token && sessions.get(token);
  if (!exp || exp < Date.now()) return null;
  return token;
}

// ---- Stockage des événements (un fichier JSON Lines par jour UTC) ----
// Pas de base de données, donc pas de requêtes SQL et aucune surface d'injection SQL : chaque
// ligne est un objet JSON ajouté en fin de fichier (fs.appendFileSync, écriture atomique au
// niveau du système de fichiers pour un petit payload comme celui-ci).
function dayKeyFromTs(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function appendEvent(e) {
  fs.mkdirSync(EVENTS_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(EVENTS_DIR, dayKeyFromTs(e.ts) + '.jsonl');
  fs.appendFileSync(file, JSON.stringify(e) + '\n', { mode: 0o600 });
}

// `day` est toujours validé par DATE_RE avant d'arriver ici (voir handleStats) : impossible d'y
// glisser un ".." ou un séparateur de chemin.
function readDayFile(day) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(EVENTS_DIR, day + '.jsonl'), 'utf8');
  } catch (e) {
    return [];
  }
  const out = [];
  raw.split('\n').forEach(function (line) {
    if (!line) return;
    try {
      const e = JSON.parse(line);
      if (e && AGENT_HASH_RE.test(e.agent) && FACTIONS.indexOf(e.faction) !== -1 &&
        REGIONS.indexOf(e.region) !== -1 && typeof e.seconds === 'number') {
        out.push(e);
      }
    } catch (parseError) { /* ligne corrompue : ignorée */ }
  });
  return out;
}

function listDays(from, to) {
  const days = [];
  let d = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (d <= end && days.length <= MAX_RANGE_DAYS) {
    days.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() + 24 * 60 * 60 * 1000);
  }
  return days;
}

function aggregate(from, to, factionFilter, regionFilter) {
  const days = listDays(from, to);
  let totalEvents = 0, totalSeconds = 0;
  const totalAgents = new Set();
  const byDay = [];
  const factionSeconds = {}, factionAgents = {};
  const regionSeconds = {}, regionAgents = {};
  FACTIONS.forEach(function (f) { factionSeconds[f] = 0; factionAgents[f] = new Set(); });
  REGIONS.forEach(function (r) { regionSeconds[r] = 0; regionAgents[r] = new Set(); });

  days.forEach(function (day) {
    const dayAgents = new Set();
    let daySeconds = 0;
    readDayFile(day).forEach(function (e) {
      // Les répartitions par facette ignorent leur propre filtre (mais respectent l'autre et
      // la plage de dates), pour que le camembert facture reste utile même quand on a déjà
      // filtré dessus.
      if (regionFilter === 'all' || e.region === regionFilter) {
        factionSeconds[e.faction] += e.seconds;
        factionAgents[e.faction].add(e.agent);
      }
      if (factionFilter === 'all' || e.faction === factionFilter) {
        regionSeconds[e.region] += e.seconds;
        regionAgents[e.region].add(e.agent);
      }
      if ((factionFilter === 'all' || e.faction === factionFilter) &&
        (regionFilter === 'all' || e.region === regionFilter)) {
        totalEvents++;
        totalSeconds += e.seconds;
        totalAgents.add(e.agent);
        dayAgents.add(e.agent);
        daySeconds += e.seconds;
      }
    });
    byDay.push({ date: day, seconds: daySeconds, uniqueAgents: dayAgents.size });
  });

  return {
    from: from,
    to: to,
    totals: { events: totalEvents, seconds: totalSeconds, uniqueAgents: totalAgents.size },
    byDay: byDay,
    byFaction: FACTIONS.map(function (f) {
      return { faction: f, seconds: factionSeconds[f], uniqueAgents: factionAgents[f].size };
    }),
    byRegion: REGIONS.map(function (r) {
      return { region: r, seconds: regionSeconds[r], uniqueAgents: regionAgents[r].size };
    })
  };
}

// ---- Routes publiques ----
function handleCollect(req, res, body) {
  if (body.v !== PROTOCOL_VERSION) return send(res, 426, { error: 'upgrade required' });

  const agent = String(body.agent || '').toLowerCase();
  if (!AGENT_HASH_RE.test(agent)) return send(res, 400, { error: 'invalid agent' });

  const faction = String(body.faction || '');
  if (FACTIONS.indexOf(faction) === -1) return send(res, 400, { error: 'invalid faction' });

  const ip = clientIp(req);
  if (collectLimiter.count(ip) >= MAX_EVENTS_PER_IP) return send(res, 429, { error: 'too many events' });
  collectLimiter.add(ip);

  // Le client n'envoie ni durée ni horodatage : juste "je suis là, maintenant" (l'horloge du
  // serveur fait foi). Un écart avec le ping précédent du même agent assez court pour être le
  // même coup d'œil compte comme actif ; un écart plus long veut dire que le plugin a été
  // refermé entre les deux, et ce temps-là ne compte pas.
  const now = Date.now();
  const previous = lastSeen.get(agent);
  const gap = previous ? now - previous : 0;
  const seconds = (gap > 0 && gap <= SESSION_GAP_MS) ? Math.min(MAX_SECONDS_PER_EVENT, Math.round(gap / 1000)) : 0;
  lastSeen.set(agent, now);

  appendEvent({ ts: now, agent: agent, faction: faction, region: regionForIp(ip), seconds: seconds });
  send(res, 204);
}

// ---- Administration ----
function handleAdminApi(req, res, route, body) {
  const ip = clientIp(req);

  if (route === 'login') {
    if (loginFailures.count(ip) >= MAX_LOGIN_FAILURES_PER_IP) return send(res, 429, { error: 'too many failures' });
    const user = String(body.user || '');
    const password = String(body.password || '');
    if (!password || password.length > MAX_PASSWORD) return send(res, 401, { error: 'unauthorized' });
    return checkPassword(admin.auth, password).then(function (ok) {
      if (!ok || user.toLowerCase() !== admin.user.toLowerCase()) {
        loginFailures.add(ip);
        console.log('Échec de connexion admin depuis ' + ip);
        return send(res, 401, { error: 'unauthorized' });
      }
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, Date.now() + SESSION_TTL);
      send(res, 200, { token: token, user: admin.user });
    });
  }

  const token = adminSession(req);
  if (!token) return send(res, 401, { error: 'unauthorized' });

  if (route === 'logout') {
    sessions.delete(token);
    return send(res, 200, { ok: true });
  }

  if (route === 'password') {
    const current = String(body.current || '');
    const next = String(body.password || '');
    if (next.length < MIN_NEW_PASSWORD || next.length > MAX_PASSWORD) {
      return send(res, 400, { error: 'weak password', min: MIN_NEW_PASSWORD });
    }
    if (loginFailures.count(ip) >= MAX_LOGIN_FAILURES_PER_IP) return send(res, 429, { error: 'too many failures' });
    return checkPassword(admin.auth, current).then(function (ok) {
      if (!ok) {
        loginFailures.add(ip);
        return send(res, 403, { error: 'wrong password' });
      }
      return hashPassword(next).then(function (auth) {
        admin.auth = auth;
        saveAdmin();
        sessions.forEach(function (exp, t) { if (t !== token) sessions.delete(t); });
        console.log('Mot de passe admin changé');
        send(res, 200, { ok: true });
      });
    });
  }

  if (route === 'stats') {
    const today = new Date().toISOString().slice(0, 10);
    const from = DATE_RE.test(body.from) ? body.from : dayKeyFromTs(Date.now() - 29 * 24 * 60 * 60 * 1000);
    const to = DATE_RE.test(body.to) ? body.to : today;
    if (from > to) return send(res, 400, { error: 'invalid range' });
    const factionFilter = FACTIONS.indexOf(body.faction) !== -1 ? body.faction : 'all';
    const regionFilter = REGIONS.indexOf(body.region) !== -1 ? body.region : 'all';
    const result = aggregate(from, to, factionFilter, regionFilter);
    result.admin = { user: admin.user };
    return send(res, 200, result);
  }

  return send(res, 404, { error: 'not found' });
}

// Fichiers statiques de la page admin, chargés au démarrage
const ADMIN_FILES = Object.assign(Object.create(null), {
  '/admin/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/admin/admin.js': { file: 'admin.js', type: 'text/javascript; charset=utf-8' },
  '/admin/admin.css': { file: 'admin.css', type: 'text/css; charset=utf-8' },
  '/admin/favicon.png': { file: 'favicon.png', type: 'image/png' }
});
Object.keys(ADMIN_FILES).forEach(function (url) {
  const f = ADMIN_FILES[url];
  try { f.content = fs.readFileSync(path.join(ADMIN_DIR, f.file)); } catch (e) { f.content = null; }
});

function serveAdminFile(res, url) {
  const f = ADMIN_FILES[url];
  if (!f.content) return send(res, 404, { error: 'not found' });
  res.setHeader('Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; " +
    "form-action 'none'; base-uri 'none'; frame-ancestors 'none'");
  res.writeHead(200, { 'Content-Type': f.type });
  res.end(f.content);
}

// ---- HTTP ----
function send(res, status, obj) {
  res.writeHead(status, obj === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(obj === undefined ? '' : JSON.stringify(obj));
}

function readBody(req, res, handler) {
  const chunks = [];
  let size = 0;
  req.on('data', function (c) {
    size += c.length;
    if (size > MAX_BODY) { send(res, 413, { error: 'too large' }); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', function () {
    if (res.writableEnded) return;
    let body = {};
    if (chunks.length) {
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (e) {
        return send(res, 400, { error: 'invalid json' });
      }
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'invalid body' });
    Promise.resolve()
      .then(function () { return handler(body); })
      .catch(function (e) {
        console.error(e);
        if (!res.writableEnded) send(res, 500, { error: 'internal error' });
      });
  });
}

const server = http.createServer(function (req, res) {
  const url = req.url.split('?')[0];
  const isAdmin = url === '/admin' || url.indexOf('/admin/') === 0;
  if (!isAdmin) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('Strict-Transport-Security', 'max-age=31536000');

  if (req.method === 'OPTIONS') return send(res, 204);
  if (req.method === 'GET' && url === '/health') return send(res, 200, { ok: true });

  if (isAdmin) {
    if (req.method === 'GET' && url === '/admin') {
      res.writeHead(301, { Location: '/admin/' });
      return res.end();
    }
    if (req.method === 'GET' && ADMIN_FILES[url]) return serveAdminFile(res, url);
    const api = /^\/admin\/api\/([a-z-]+)$/.exec(url);
    if (api && req.method === 'POST') {
      if (!admin) return send(res, 503, { error: 'admin not ready' });
      return readBody(req, res, function (body) { return handleAdminApi(req, res, api[1], body); });
    }
    return send(res, 404, { error: 'not found' });
  }

  if (req.method !== 'POST' || url !== '/collect') return send(res, 404, { error: 'not found' });
  readBody(req, res, function (body) { return handleCollect(req, res, body); });
});

server.headersTimeout = 15 * 1000;
server.requestTimeout = 30 * 1000;
server.keepAliveTimeout = 5 * 1000;

loadAdmin().then(function () {
  server.listen(PORT, function () {
    console.log('FanFields 3 stats en écoute sur :' + PORT);
  });
}, function (e) {
  console.error(e);
  process.exit(1);
});
