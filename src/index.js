import { configured, configProblem, sessionOf, passwordMatches, loginCookies, logoutCookies } from './auth.js';
import { LIMITS } from './logic.js';

export { SnapVoteHub } from './hub.js';

// Reachable without any password: just enough to render the login page.
const PUBLIC_PATHS = new Set(['/gate', '/gate.html', '/styles.css', '/js/gate.js', '/favicon.svg', '/healthz']);
// Need the admin password (you), not just the player password.
const ADMIN_PAGES = ['/host', '/admin'];

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
};

function withHeaders(response, extra = {}) {
  const r = new Response(response.body, response);
  for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...extra })) r.headers.set(k, v);
  return r;
}

const PROBLEMS = {
  missing: 'The two passwords haven’t been added yet.',
  placeholder: 'The passwords are still the example text — pick your own.',
  short: 'Each password needs at least 8 characters.',
  same: 'The player and admin passwords must be different.',
};

/** Friendly "almost there" page shown (instead of the game) until setup is complete. */
function setupPage(problem) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>SnapVote — almost ready</title><link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/styles.css"></head>
<body><main class="wrap narrow"><div class="topbar"><span class="brand"><span class="dot"></span>SnapVote</span></div>
<div class="card"><h1>Almost ready 🛠️</h1>
<div class="banner">${PROBLEMS[problem] || PROBLEMS.missing}</div>
<p>SnapVote stays locked until both passwords are set. In the Cloudflare dashboard:</p>
<ol class="muted" style="padding-left:20px;line-height:1.8">
<li>Open <a href="https://dash.cloudflare.com/?to=/:account/workers-and-pages" target="_blank" rel="noopener">Workers &amp; Pages</a> and click <strong>snapvote</strong>.</li>
<li>Go to <strong>Settings → Variables and Secrets</strong> and click <strong>+ Add</strong>.</li>
<li>Add <strong>SITE_PASSWORD</strong> (type <em>Secret</em>): the player password.</li>
<li>Add <strong>ADMIN_PASSWORD</strong> (type <em>Secret</em>): your own password, different from the player one.</li>
<li>Click <strong>Deploy</strong>, wait a few seconds and reload this page.</li>
</ol></div></main></body></html>`;
  return new Response(html, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '30', ...SECURITY_HEADERS } });
}

function hub(env) {
  return env.HUB.get(env.HUB.idFromName('hub'));
}

function redirectToGate(url, admin) {
  const next = url.pathname + url.search;
  const target = new URL('/gate', url);
  target.searchParams.set('next', next);
  if (admin) target.searchParams.set('admin', '1');
  return Response.redirect(target.toString(), 302);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const secure = url.protocol === 'https:';

    try {
      if (path === '/healthz') return new Response('ok');
      if ((path === '/gate' || path === '/gate.html') && !configured(env)) return setupPage(configProblem(env));
      if (PUBLIC_PATHS.has(path)) return withHeaders(await env.ASSETS.fetch(request));

      if (!configured(env)) {
        if (path.startsWith('/api/') || path === '/ws' || path.startsWith('/img/')) {
          return json({ error: 'SnapVote is almost ready: the passwords still need to be set in Cloudflare.' }, 503);
        }
        return setupPage(configProblem(env));
      }

      // ---------------------------------------------------------- login / logout
      if (path === '/api/login' && request.method === 'POST') {
        const { password, kind: rawKind } = await request.json().catch(() => ({}));
        const kind = rawKind === 'admin' ? 'admin' : 'site';
        const ip = request.headers.get('CF-Connecting-IP') || 'local';
        const gate = await hub(env).loginGate(ip, kind);
        if (gate.blocked) {
          return json({ error: `Too many wrong attempts. Try again in ${Math.ceil(gate.retryAfter / 60)} min.` }, 429, { 'Retry-After': String(gate.retryAfter) });
        }
        if (!(await passwordMatches(env, kind, password))) {
          await hub(env).loginFailed(ip, kind);
          return json({ error: 'Wrong password.' }, 403);
        }
        await hub(env).loginSucceeded(ip, kind);
        const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        for (const c of await loginCookies(env, kind, secure)) headers.append('Set-Cookie', c);
        return new Response(JSON.stringify({ ok: true }), { headers });
      }
      if (path === '/api/logout') {
        const headers = new Headers({ Location: '/gate' });
        for (const c of logoutCookies(secure)) headers.append('Set-Cookie', c);
        return new Response(null, { status: 302, headers });
      }

      // ---------------------------------------------------------- gate
      const session = await sessionOf(request, env);
      const isApi = path.startsWith('/api/') || path.startsWith('/img/') || path === '/ws';
      const needsAdmin = ADMIN_PAGES.some((p) => path === p || path === `${p}.html`) || path.startsWith('/api/admin/') || (path === '/api/games' && request.method === 'POST');
      if (!session.site) {
        return isApi ? json({ error: 'Please unlock SnapVote with the password first.' }, 401) : redirectToGate(url, needsAdmin);
      }
      if (needsAdmin && !session.admin) {
        return isApi ? json({ error: 'This needs the admin password.' }, 403) : redirectToGate(url, true);
      }

      // ---------------------------------------------------------- realtime
      if (path === '/ws') {
        if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'Expected a WebSocket' }, 426);
        return hub(env).fetch(request);
      }

      // ---------------------------------------------------------- photos
      const img = path.match(/^\/img\/([a-z0-9]{22})$/);
      if (img && request.method === 'GET') {
        const found = await hub(env).getImage(img[1]);
        if (!found) return new Response('Not found', { status: 404 });
        return new Response(found.bytes, {
          headers: {
            'Content-Type': found.mime,
            // Ids are random and never reused, so browsers can cache forever.
            'Cache-Control': 'private, max-age=31536000, immutable',
            ...SECURITY_HEADERS,
          },
        });
      }

      // ---------------------------------------------------------- game API
      if (path === '/api/session') return json({ admin: session.admin });

      if (path === '/api/games' && request.method === 'POST') {
        const form = await request.formData();
        let config;
        try { config = JSON.parse(form.get('config') || '{}'); } catch { return json({ error: 'Invalid setup data.' }, 400); }
        const examples = [];
        for (const [key, value] of form.entries()) {
          const m = key.match(/^example_(\d+)$/);
          if (m && typeof value === 'object' && value.size > 0 && value.size <= LIMITS.maxImageBytes) {
            examples.push({ round: Number(m[1]), bytes: await value.arrayBuffer() });
          }
        }
        const result = await hub(env).createGame({ config, examples });
        return result.ok ? json(result) : json({ error: result.error }, 400);
      }

      const info = path.match(/^\/api\/games\/([A-Za-z0-9]{5})$/);
      if (info && request.method === 'GET') return json(await hub(env).gameInfo(info[1].toUpperCase()));

      const join = path.match(/^\/api\/games\/([A-Za-z0-9]{5})\/join$/);
      if (join && request.method === 'POST') {
        const { nickname } = await request.json().catch(() => ({}));
        const result = await hub(env).joinGame(join[1].toUpperCase(), nickname);
        return result.ok ? json(result) : json({ error: result.error }, 400);
      }

      // HTTP fallback for networks that block WebSockets (some company Wi-Fi, VPNs, filters).
      const fallback = path.match(/^\/api\/games\/([A-Za-z0-9]{5})\/(poll|action)$/);
      if (fallback && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const auth = { role: body.role === 'host' ? 'host' : 'player', pid: String(body.pid || ''), token: String(body.token || '') };
        if (auth.role === 'host' && !session.admin) return json({ error: 'This needs the admin password.' }, 403);
        const code = fallback[1].toUpperCase();
        const result = fallback[2] === 'poll'
          ? await hub(env).pollState(code, auth, typeof body.v === 'string' ? body.v : null)
          : await hub(env).httpAction(code, auth, body.msg);
        return json(result, result.ok || result.ended ? 200 : 400);
      }

      const submit = path.match(/^\/api\/games\/([A-Za-z0-9]{5})\/photo$/);
      if (submit && request.method === 'POST') {
        const length = Number(request.headers.get('Content-Length') || 0);
        if (length > LIMITS.maxImageBytes) return json({ error: 'That photo is too large.' }, 413);
        const bytes = await request.arrayBuffer();
        const result = await hub(env).submitImage({
          code: submit[1].toUpperCase(),
          playerId: request.headers.get('X-Player-Id'),
          token: request.headers.get('X-Player-Token'),
          round: Number(request.headers.get('X-Round')),
          bytes,
        });
        return result.ok ? json({ ok: true }) : json({ error: result.error }, 400);
      }

      // ---------------------------------------------------------- admin API
      if (path === '/api/admin/games' && request.method === 'GET') return json(await hub(env).adminListGames());
      const manifest = path.match(/^\/api\/admin\/games\/([A-Za-z0-9]{5})$/);
      if (manifest && request.method === 'GET') {
        const m = await hub(env).adminManifest(manifest[1].toUpperCase());
        return m ? json(m) : json({ error: 'Game not found' }, 404);
      }
      if (manifest && request.method === 'DELETE') return json(await hub(env).adminDeleteGame(manifest[1].toUpperCase()));

      if (path.startsWith('/api/')) return json({ error: 'Not found' }, 404);

      // ---------------------------------------------------------- pages & assets
      const asset = await env.ASSETS.fetch(request);
      const isHtml = (asset.headers.get('Content-Type') || '').includes('text/html');
      return withHeaders(asset, isHtml ? { 'Cache-Control': 'no-store' } : {});
    } catch (err) {
      console.error(err);
      return json({ error: 'Server error — please try again.' }, 500);
    }
  },
};
