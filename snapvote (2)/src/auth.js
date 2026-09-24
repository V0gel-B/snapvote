// Two passwords, two stateless signed cookies:
//   SITE_PASSWORD  -> sv_site  : players (join games, see photos)
//   ADMIN_PASSWORD -> sv_admin : you (host games, admin panel, downloads)
// Cookie value = HMAC(password, label). Changing a password in Cloudflare
// instantly invalidates every cookie issued for the old one.

const enc = new TextEncoder();

export const COOKIE = { site: 'sv_site', admin: 'sv_admin' };
const MAX_AGE = { site: 60 * 60 * 24 * 30, admin: 60 * 60 * 24 * 7 };

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.byteLength !== y.byteLength) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

/**
 * Returns null when both passwords are usable, otherwise a reason. The site
 * stays locked (fail closed) until this passes, so a half-finished setup is
 * never left open.
 */
export function configProblem(env) {
  const site = env.SITE_PASSWORD || '';
  const admin = env.ADMIN_PASSWORD || '';
  if (!site || !admin) return 'missing';
  if (site.startsWith('replace-with') || admin.startsWith('replace-with')) return 'placeholder';
  if (site.length < 8 || admin.length < 8) return 'short';
  if (site === admin) return 'same';
  return null;
}

export function configured(env) {
  return configProblem(env) === null;
}

function secretFor(env, kind) {
  return kind === 'admin' ? env.ADMIN_PASSWORD : env.SITE_PASSWORD;
}

export async function expectedCookie(env, kind) {
  return hmacHex(secretFor(env, kind), `snapvote-${kind}-v1`);
}

/** Constant-time password check (compares HMACs so lengths always match). */
export async function passwordMatches(env, kind, candidate) {
  if (typeof candidate !== 'string' || !candidate) return false;
  const secret = secretFor(env, kind);
  const [a, b] = await Promise.all([hmacHex(secret, `pw:${candidate}`), hmacHex(secret, `pw:${secret}`)]);
  return safeEqual(a, b);
}

export function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** Returns { site, admin } booleans for this request. Admin implies site. */
export async function sessionOf(request, env) {
  if (!configured(env)) return { site: false, admin: false };
  const [siteExpected, adminExpected] = await Promise.all([expectedCookie(env, 'site'), expectedCookie(env, 'admin')]);
  const admin = safeEqual(readCookie(request, COOKIE.admin) || '', adminExpected);
  const site = admin || safeEqual(readCookie(request, COOKIE.site) || '', siteExpected);
  return { site, admin };
}

export function cookieHeader(name, value, { secure, maxAge }) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export async function loginCookies(env, kind, secure) {
  const cookies = [];
  cookies.push(cookieHeader(COOKIE.site, await expectedCookie(env, 'site'), { secure, maxAge: MAX_AGE.site }));
  if (kind === 'admin') {
    cookies.push(cookieHeader(COOKIE.admin, await expectedCookie(env, 'admin'), { secure, maxAge: MAX_AGE.admin }));
  }
  return cookies;
}

export function logoutCookies(secure) {
  return [
    cookieHeader(COOKIE.site, '', { secure, maxAge: 0 }),
    cookieHeader(COOKIE.admin, '', { secure, maxAge: 0 }),
  ];
}
