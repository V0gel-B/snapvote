/* SnapVote shared client helpers (window.SV). No framework, no build step. */
(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /** Tiny safe DOM builder: h('div', {class: 'x', onclick: fn}, 'text', child) */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function show(el, visible) { if (el) el.hidden = !visible; }

  // ------------------------------------------------------------------ toast
  let toastTimer;
  function toast(message, kind = 'info') {
    let t = $('#sv-toast');
    if (!t) { t = h('div', { id: 'sv-toast', role: 'status', 'aria-live': 'polite' }); document.body.append(t); }
    t.textContent = message;
    t.dataset.kind = kind;
    t.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('visible'), kind === 'error' ? 5000 : 2600);
  }

  // ------------------------------------------------------------------ HTTP
  async function api(path, { method = 'GET', json, body, headers = {} } = {}) {
    const opts = { method, headers: { ...headers }, credentials: 'same-origin' };
    if (json !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(json); }
    else if (body !== undefined) opts.body = body;
    let res;
    try { res = await fetch(path, opts); }
    catch { throw Object.assign(new Error('No connection — check your internet and try again.'), { status: 0 }); }
    if (res.status === 401) { goToGate(false); throw Object.assign(new Error('Please log in again.'), { status: 401 }); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
    return data;
  }

  function goToGate(admin) {
    const next = location.pathname + location.search;
    location.href = `/gate?next=${encodeURIComponent(next)}${admin ? '&admin=1' : ''}`;
  }

  /** POST a photo with upload progress (fetch can't report upload progress). */
  function uploadPhoto(url, blob, headers, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      xhr.setRequestHeader('Content-Type', blob.type || 'image/jpeg');
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(data.error || `Upload failed (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error('Upload failed — check your connection and try again.'));
      xhr.ontimeout = xhr.onerror;
      xhr.timeout = 60000;
      xhr.send(blob);
    });
  }

  // ------------------------------------------------------------------ clock + timers
  let clockOffset = 0; // serverNow - clientNow
  const serverNow = () => Date.now() + clockOffset;

  const timers = new Set();
  /** Keep a countdown ring/number in sync with a server deadline. */
  function bindTimer(el, deadline, totalMs) {
    for (const t of timers) if (t.el === el) timers.delete(t);
    if (!el) return;
    if (!deadline) { el.hidden = true; return; }
    el.hidden = false;
    timers.add({ el, deadline, totalMs: Math.max(1000, totalMs || deadline - serverNow()) });
    paintTimers();
  }
  function paintTimers() {
    const now = serverNow();
    for (const t of timers) {
      if (!t.el.isConnected) { timers.delete(t); continue; }
      const leftMs = Math.max(0, t.deadline - now);
      const secs = Math.ceil(leftMs / 1000);
      const num = t.el.querySelector('.num');
      if (num && num.textContent !== String(secs)) num.textContent = secs;
      const fg = t.el.querySelector('.fg');
      if (fg) {
        const c = 2 * Math.PI * 42;
        fg.style.strokeDasharray = c;
        fg.style.strokeDashoffset = c * (1 - Math.min(1, leftMs / t.totalMs));
      }
      t.el.classList.toggle('low', secs <= 5);
      t.el.classList.toggle('done', leftMs === 0);
    }
  }
  setInterval(paintTimers, 200);

  function timerRing(extraClass = '') {
    return h('div', { class: `timer ${extraClass}`, role: 'timer', 'aria-label': 'Time left' },
      svgRing(), h('span', { class: 'num' }, '–'));
  }
  function svgRing() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('aria-hidden', 'true');
    for (const cls of ['bg', 'fg']) {
      const c = document.createElementNS(ns, 'circle');
      c.setAttribute('cx', '50'); c.setAttribute('cy', '50'); c.setAttribute('r', '42');
      c.setAttribute('class', cls);
      svg.append(c);
    }
    return svg;
  }

  // ------------------------------------------------------------------ realtime
  /**
   * Live connection that delivers full state snapshots.
   *  - Prefers a WebSocket (instant updates).
   *  - Phones drop sockets whenever the camera app opens: reconnects as soon
   *    as the page is visible again and resyncs from the server.
   *  - Some company Wi-Fi, VPNs and security filters block WebSockets. Then it
   *    switches to HTTPS long-polling ("compatibility mode"), which works
   *    through any network that can load web pages, and keeps quietly
   *    re-trying the WebSocket in the background.
   */
  function connect(params, { onState, onStatus, onEnd, onError }) {
    let ws = null;
    let attempt = 0;
    let stopped = false;
    let retryTimer = null;
    let pingTimer = null;
    let failures = 0;
    let everOpened = false;
    let polling = false;
    let pollVersion = null;
    let pollLoopId = 0;
    const auth = { role: params.role, pid: params.pid, token: params.token };

    const url = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?${new URLSearchParams(params)}`;
    const deliver = (m) => {
      if (typeof m.now === 'number') clockOffset = m.now - Date.now();
      if (typeof m.v === 'string') pollVersion = m.v;
      onState(m.s);
    };
    const end = (code) => { stopped = true; polling = false; clearTimeout(retryTimer); clearInterval(pingTimer); onStatus?.('ended'); onEnd?.(code); };

    function open() {
      if (stopped) return;
      clearTimeout(retryTimer);
      if (!polling) onStatus?.('connecting');
      try { ws = new WebSocket(url()); }
      catch { ws = null; failures += 1; startPolling(); return; }
      ws.onopen = () => {
        everOpened = true; attempt = 0; failures = 0;
        stopPolling();
        onStatus?.('online');
        ws.send(JSON.stringify({ t: 'sync' }));
        clearInterval(pingTimer);
        pingTimer = setInterval(() => { if (ws.readyState === 1) ws.send('ping'); }, 25000);
      };
      ws.onmessage = (ev) => {
        if (ev.data === 'pong') return;
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.t === 'state') deliver(m);
        else if (m.t === 'error') onError ? onError(m.message) : toast(m.message, 'error');
      };
      ws.onclose = async (ev) => {
        clearInterval(pingTimer);
        if (stopped) return;
        if (ev.code === 4000 || ev.code === 4001) return end(ev.code);
        failures += 1;
        if (failures === 3 && !polling) {
          // Maybe the password cookie expired.
          const res = await fetch('/api/session').catch(() => null);
          if (res && res.status === 401) return goToGate(params.role === 'host');
        }
        // WebSocket never worked (or keeps dying): use HTTPS long-polling.
        if ((!everOpened && failures >= 2) || failures >= 4) startPolling();
        if (polling) { retryTimer = setTimeout(open, 60000); return; } // quietly re-try the fast path
        onStatus?.('offline');
        schedule();
      };
    }
    function schedule() {
      clearTimeout(retryTimer);
      const delay = Math.min(8000, 500 * 2 ** attempt++) + Math.random() * 300;
      retryTimer = setTimeout(open, delay);
    }

    async function pollLoop(id) {
      let backoff = 1000;
      while (polling && !stopped && id === pollLoopId) {
        try {
          const res = await fetch(`/api/games/${encodeURIComponent(params.code)}/poll`, {
            method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...auth, v: pollVersion }),
          });
          if (res.status === 401) return goToGate(params.role === 'host');
          const m = await res.json();
          if (!polling || id !== pollLoopId) return; // the WebSocket came back meanwhile
          if (m.ended) return end(m.ended);
          if (m.ok) { deliver(m); onStatus?.('polling'); backoff = 1000; continue; }
          throw new Error(m.error || 'poll failed');
        } catch {
          if (!polling || id !== pollLoopId) return;
          onStatus?.('offline');
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(8000, backoff * 2);
        }
      }
    }
    function startPolling() {
      if (polling || stopped) return;
      polling = true;
      pollVersion = null;
      pollLoop(++pollLoopId);
    }
    function stopPolling() { polling = false; pollLoopId++; }

    async function sendHttp(msg) {
      try {
        const res = await fetch(`/api/games/${encodeURIComponent(params.code)}/action`, {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...auth, msg }),
        });
        const m = await res.json();
        if (m.ended) return end(m.ended);
        if (m.ok) deliver(m);
        else onError ? onError(m.error) : toast(m.error || 'Something went wrong.', 'error');
      } catch {
        toast('No connection — try again in a second.', 'error');
      }
    }

    const wake = () => {
      if (stopped) return;
      if (polling) { if (!ws || ws.readyState > 1) { attempt = 0; open(); } return; }
      if (!ws || ws.readyState > 1) { attempt = 0; open(); }
    };
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); });
    window.addEventListener('online', wake);

    open();
    return {
      send(msg) {
        if (ws && ws.readyState === 1) { ws.send(JSON.stringify(msg)); return true; }
        if (polling) { sendHttp(msg); return true; }
        toast('Reconnecting… try again in a second.', 'error');
        return false;
      },
      close() { stopped = true; polling = false; clearInterval(pingTimer); clearTimeout(retryTimer); ws?.close(); },
      get mode() { return polling ? 'polling' : 'websocket'; },
    };
  }

  function statusDot(state) {
    const labels = { online: 'Live', polling: 'Live (compatibility mode)', connecting: 'Connecting…', offline: 'Reconnecting…', ended: 'Ended' };
    const el = $('#conn');
    if (!el) return;
    el.dataset.state = state;
    el.textContent = labels[state] || state;
  }

  // ------------------------------------------------------------------ images
  async function decodeImage(file) {
    if ('createImageBitmap' in window) {
      try {
        const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
        return { source: bmp, width: bmp.width, height: bmp.height, done: () => bmp.close?.() };
      } catch { /* fall back to <img> */ }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      return { source: img, width: img.naturalWidth, height: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
    } catch {
      URL.revokeObjectURL(url);
      throw new Error("This photo format can't be opened here. Please pick a JPG or PNG.");
    }
  }

  /**
   * Resize + re-encode in the browser before upload: much faster on mobile
   * data, and re-encoding strips EXIF metadata such as GPS location.
   */
  async function compressImage(file, { maxDim = 1440, maxBytes = 600_000 } = {}) {
    if (!file || !/^image\//.test(file.type || 'image/')) throw new Error('Please choose a photo.');
    const img = await decodeImage(file);
    try {
      let scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      for (let attempt = 0; attempt < 6; attempt++) {
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        ctx.fillStyle = '#fff'; // transparent PNGs would otherwise turn black
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img.source, 0, 0, canvas.width, canvas.height);
        for (const q of [0.85, 0.75, 0.65]) {
          const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', q));
          if (blob && blob.size <= maxBytes) return blob;
        }
        scale *= 0.8;
      }
      throw new Error('That photo is too large even after shrinking it.');
    } finally {
      img.done();
    }
  }

  // ------------------------------------------------------------------ zip export
  const safeName = (s, max = 60) =>
    String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) || 'untitled';
  const pad = (n) => String(n).padStart(2, '0');
  const extFor = (mime) => ({ 'image/png': 'png', 'image/webp': 'webp' }[mime] || 'jpg');
  const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

  /** Build a zip of every photo in a game, organised by round, sorted by votes. */
  async function downloadGameZip(code, onProgress) {
    if (!window.fflate) throw new Error('Zip library failed to load.');
    const m = await api(`/api/admin/games/${encodeURIComponent(code)}`);
    const date = new Date(m.createdAt).toISOString().slice(0, 10);
    const root = `SnapVote ${m.code} ${date}`;
    const files = {};
    const rows = [['round', 'task', 'place_in_round', 'votes', 'points', 'player', 'file']];
    const byRound = new Map();
    for (const img of m.images) {
      if (!byRound.has(img.round)) byRound.set(img.round, []);
      byRound.get(img.round).push(img);
    }
    let done = 0;
    const total = m.images.length;
    for (const round of m.rounds) {
      const folder = `${root}/Round ${pad(round.number)} - ${safeName(round.task, 50)}`;
      const imgs = (byRound.get(round.number) || []).sort((a, b) => (a.kind === 'example') - (b.kind === 'example') || b.votes - a.votes);
      let place = 0;
      for (const img of imgs) {
        const res = await fetch(`/img/${img.id}`, { credentials: 'same-origin' });
        if (!res.ok) { done++; continue; }
        const bytes = new Uint8Array(await res.arrayBuffer());
        let name;
        if (img.kind === 'example') name = `_example image.${extFor(img.mime)}`;
        else {
          place += 1;
          name = `${pad(place)} - ${img.votes} vote${img.votes === 1 ? '' : 's'} - ${safeName(img.nickname, 30)}.${extFor(img.mime)}`;
          rows.push([round.number, round.task, place, img.votes, img.points, img.nickname, `${folder.slice(root.length + 1)}/${name}`]);
        }
        files[`${folder}/${name}`] = [bytes, { level: 0 }]; // photos are already compressed
        onProgress?.(++done / Math.max(1, total));
      }
    }
    files[`${root}/results.csv`] = fflate.strToU8(rows.map((r) => r.map(csvCell).join(',')).join('\r\n'));
    files[`${root}/results.json`] = fflate.strToU8(JSON.stringify({ code: m.code, createdAt: m.createdAt, rounds: m.rounds, leaderboard: m.leaderboard, photos: rows.slice(1).map(([round, task, place, votes, points, player, file]) => ({ round, task, place, votes, points, player, file })) }, null, 2));
    const zipped = fflate.zipSync(files);
    const blob = new Blob([zipped], { type: 'application/zip' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${root}.zip` });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    return { photos: rows.length - 1, bytes: blob.size };
  }

  function fmtBytes(n) {
    if (!n) return '0 KB';
    if (n < 1024 ** 2) return `${Math.max(1, Math.round(n / 1024))} KB`;
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
  }

  // ------------------------------------------------------------------ lightbox
  function openLightbox(src, caption) {
    const box = h('div', { class: 'lightbox', role: 'dialog', 'aria-modal': 'true', onclick: () => box.remove() },
      h('img', { src, alt: caption || 'Photo' }),
      caption ? h('p', {}, caption) : null,
      h('button', { class: 'btn ghost lightbox-close', 'aria-label': 'Close' }, '✕'));
    const onKey = (e) => { if (e.key === 'Escape') { box.remove(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
    document.body.append(box);
  }

  const store = {
    get(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
    del(key) { try { localStorage.removeItem(key); } catch {} },
  };

  const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  window.SV = {
    $, $$, h, show, toast, api, goToGate, uploadPhoto, serverNow, bindTimer, timerRing,
    connect, statusDot, compressImage, downloadGameZip, fmtBytes, openLightbox, store, reducedMotion,
  };
})();
