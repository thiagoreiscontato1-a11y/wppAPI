const crypto = require('crypto');

const SESSION_COOKIE = 'wppapi_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES_PER_IP = 5;
// Barreira extra caso o IP real não chegue ao servidor (proxy mal configurado ou IP falsificado).
const LOGIN_MAX_FAILURES_GLOBAL = 50;
const PUBLIC_PATHS = new Set(['/healthz', '/login.html', '/login.js', '/styles.css', '/favicon.ico', '/api/login']);

function safeEqual(a, b) {
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

function parseCookies(header) {
  const cookies = {};
  String(header || '').split(';').forEach((part) => {
    const index = part.indexOf('=');
    if (index < 0) return;
    const name = part.slice(0, index).trim();
    try { cookies[name] = decodeURIComponent(part.slice(index + 1).trim()); } catch {}
  });
  return cookies;
}

// Pedidos de navegador trazem Origin (ou Referer); se vierem de outro site, são recusados.
// `allowedOrigins` (textos ou RegExp) libera endereços de proxies que reescrevem o Host,
// como o encaminhamento de portas do GitHub Codespaces.
function isSameOrigin(req, allowedOrigins = []) {
  const source = req.headers.origin || req.headers.referer;
  if (!source) return true;
  let url;
  try { url = new URL(source); } catch { return false; }
  if (url.host === req.headers.host) return true;
  return allowedOrigins.some((allowed) => (allowed instanceof RegExp ? allowed.test(url.origin) : allowed === url.origin));
}

// Endereços públicos das portas do próprio Codespace (https://<codespace>-<porta>.<domínio>).
function codespacesOrigin(env = process.env) {
  const { CODESPACE_NAME: name, GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: domain } = env;
  if (!name || !domain) return null;
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^https://${escape(name)}-\\d+\\.${escape(domain)}$`);
}

// Recusa com um aviso no log (uma vez por origem) explicando como liberar o endereço.
function createOriginCheck({ allowedOrigins = [], logger = console } = {}) {
  const warned = new Set();
  return function isAllowedOrigin(req) {
    if (isSameOrigin(req, allowedOrigins)) return true;
    const source = String(req.headers.origin || req.headers.referer);
    let origin = source;
    try { origin = new URL(source).origin; } catch {}
    if (!warned.has(origin) && warned.size < 100) {
      warned.add(origin);
      logger.warn(`Pedido recusado: a origem ${origin} não corresponde ao servidor (${req.headers.host}). Se este endereço é o seu, adicione-o em ALLOWED_ORIGINS.`);
    }
    return false;
  };
}

function createLoginLimiter() {
  const perIp = new Map();
  const global = { count: 0, windowStart: 0, lockedUntil: 0 };

  function retryAfterMs(bucket, now) {
    return bucket && bucket.lockedUntil > now ? bucket.lockedUntil - now : 0;
  }
  function recordFailure(bucket, max, now) {
    if (now - bucket.windowStart > LOGIN_WINDOW_MS) {
      bucket.count = 0;
      bucket.windowStart = now;
    }
    bucket.count += 1;
    if (bucket.count >= max) {
      bucket.count = 0;
      bucket.lockedUntil = now + LOGIN_LOCK_MS;
    }
  }

  return {
    check(ip, now = Date.now()) {
      return Math.max(retryAfterMs(perIp.get(ip), now), retryAfterMs(global, now));
    },
    fail(ip, now = Date.now()) {
      if (perIp.size > 10000) {
        for (const [key, bucket] of perIp) {
          if (bucket.lockedUntil <= now && now - bucket.windowStart > LOGIN_WINDOW_MS) perIp.delete(key);
        }
      }
      let bucket = perIp.get(ip);
      if (!bucket) {
        bucket = { count: 0, windowStart: now, lockedUntil: 0 };
        perIp.set(ip, bucket);
      }
      recordFailure(bucket, LOGIN_MAX_FAILURES_PER_IP, now);
      recordFailure(global, LOGIN_MAX_FAILURES_GLOBAL, now);
    },
    succeed(ip) {
      perIp.delete(ip);
    },
  };
}

function createAuth({ user, password, isAllowedOrigin = isSameOrigin }) {
  const enabled = Boolean(password);
  const sessions = new Map();
  const limiter = createLoginLimiter();

  function sessionFrom(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return null;
    const session = sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      sessions.delete(token);
      return null;
    }
    return { token, ...session };
  }

  function setSessionCookie(req, res, token, maxAgeMs) {
    const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
    // req.secure considera X-Forwarded-Proto apenas de proxies confiáveis (trust proxy).
    if (req.secure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  function isAuthenticated(req) {
    return !enabled || Boolean(sessionFrom(req));
  }

  // Middleware para o Express e para o Socket.IO (io.engine.use), que usa req/res do Node.
  function requireLogin(req, res, next) {
    const pathname = (req.url || '/').split('?')[0];
    if (!enabled || PUBLIC_PATHS.has(pathname) || sessionFrom(req)) return next();
    const wantsPage = req.method === 'GET' && String(req.headers.accept || '').includes('text/html');
    if (wantsPage) {
      res.statusCode = 302;
      res.setHeader('Location', '/login.html');
      return res.end();
    }
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Faça login para continuar.', login: true }));
  }

  function requireSameOrigin(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || isAllowedOrigin(req)) return next();
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Pedido de outra origem recusado.' }));
  }

  function login(req, res) {
    if (!enabled) return res.json({ ok: true });
    const ip = req.ip || req.socket?.remoteAddress || 'desconhecido';
    const retryMs = limiter.check(ip);
    if (retryMs) {
      res.setHeader('Retry-After', String(Math.ceil(retryMs / 1000)));
      return res.status(429).json({ error: `Muitas tentativas. Tente novamente em ${Math.ceil(retryMs / 60000)} min.` });
    }
    // Compara os dois campos sempre, para o tempo de resposta não indicar qual estava errado.
    const userMatches = safeEqual(req.body?.user ?? '', user);
    const passwordMatches = safeEqual(req.body?.password ?? '', password);
    if (!userMatches || !passwordMatches) {
      limiter.fail(ip);
      console.warn(`Tentativa de login recusada (${ip}).`);
      return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
    }
    limiter.succeed(ip);
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, { user, expiresAt: Date.now() + SESSION_TTL_MS });
    for (const [key, session] of sessions) if (session.expiresAt <= Date.now()) sessions.delete(key);
    setSessionCookie(req, res, token, SESSION_TTL_MS);
    res.json({ ok: true });
  }

  function logout(req, res) {
    const session = sessionFrom(req);
    if (session) sessions.delete(session.token);
    setSessionCookie(req, res, '', 0);
    res.json({ ok: true });
  }

  return { enabled, isAuthenticated, requireLogin, requireSameOrigin, login, logout };
}

module.exports = { createAuth, createLoginLimiter, createOriginCheck, isSameOrigin, codespacesOrigin, LOGIN_MAX_FAILURES_PER_IP, LOGIN_MAX_FAILURES_GLOBAL };
