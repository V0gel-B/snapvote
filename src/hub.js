import { DurableObject } from 'cloudflare:workers';
import {
  LIMITS, InputError, newGameCode, newId, newToken, normalizeConfig, cleanNickname,
  shuffle, sanitizeBallot, tally, rankPlayers, sniffImageType,
} from './logic.js';

// Leave headroom under the free plan's 5 GB of Durable Object storage.
const STORAGE_SOFT_LIMIT = 4.5 * 1024 ** 3;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;

/**
 * One Durable Object ("the hub") owns every game:
 *  - SQLite tables for games, players, photos (as BLOBs) and ballots,
 *  - hibernatable WebSockets tagged by game code,
 *  - a single storage alarm that fires at the next round deadline.
 * Every state change is written to SQLite first, then pushed to every
 * connected screen as a full, per-viewer snapshot.
 */
export class SnapVoteHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.loginFailures = new Map();
    this.msgBudget = new WeakMap();
    this.migrate();
    // Keep-alive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  migrate() {
    const s = this.sql;
    s.exec(`CREATE TABLE IF NOT EXISTS games (
      code TEXT PRIMARY KEY, host_token TEXT NOT NULL, host_name TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER,
      phase TEXT NOT NULL, deadline INTEGER, state TEXT NOT NULL)`);
    s.exec(`CREATE TABLE IF NOT EXISTS players (
      game_code TEXT NOT NULL, id TEXT NOT NULL, token TEXT NOT NULL, nickname TEXT NOT NULL,
      score INTEGER NOT NULL DEFAULT 0, joined_at INTEGER NOT NULL,
      PRIMARY KEY (game_code, id))`);
    s.exec(`CREATE TABLE IF NOT EXISTS images (
      id TEXT PRIMARY KEY, game_code TEXT NOT NULL, round INTEGER NOT NULL, player_id TEXT,
      kind TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL,
      votes INTEGER NOT NULL DEFAULT 0, points INTEGER NOT NULL DEFAULT 0, bytes BLOB NOT NULL)`);
    s.exec(`CREATE INDEX IF NOT EXISTS images_by_round ON images (game_code, round)`);
    s.exec(`CREATE UNIQUE INDEX IF NOT EXISTS images_one_per_player ON images (game_code, round, player_id) WHERE kind = 'sub'`);
    s.exec(`CREATE TABLE IF NOT EXISTS votes (
      game_code TEXT NOT NULL, round INTEGER NOT NULL, voter_id TEXT NOT NULL,
      targets TEXT NOT NULL, locked INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
      PRIMARY KEY (game_code, round, voter_id))`);
  }

  // ------------------------------------------------------------ data access

  getGame(code) {
    const row = this.sql.exec('SELECT * FROM games WHERE code = ?', String(code || '').toUpperCase()).toArray()[0];
    if (!row) return null;
    return { ...row, state: JSON.parse(row.state) };
  }

  saveGame(g) {
    g.updated_at = Date.now();
    this.sql.exec(
      'UPDATE games SET phase = ?, deadline = ?, state = ?, updated_at = ?, finished_at = ? WHERE code = ?',
      g.phase, g.deadline ?? null, JSON.stringify(g.state), g.updated_at, g.finished_at ?? null, g.code,
    );
  }

  players(code) {
    return this.sql.exec('SELECT id, nickname, score, joined_at FROM players WHERE game_code = ? ORDER BY joined_at', code).toArray();
  }

  player(code, id, token) {
    const p = this.sql.exec('SELECT id, token, nickname, score FROM players WHERE game_code = ? AND id = ?', code, String(id || '')).toArray()[0];
    return p && p.token === token ? p : null;
  }

  roundImages(code, round) {
    return this.sql.exec(
      "SELECT id, player_id AS playerId, votes, points, created_at FROM images WHERE game_code = ? AND round = ? AND kind = 'sub' ORDER BY created_at",
      code, round,
    ).toArray();
  }

  roundBallots(code, round) {
    return this.sql.exec('SELECT voter_id AS voterId, targets, locked FROM votes WHERE game_code = ? AND round = ?', code, round)
      .toArray()
      .map((b) => ({ ...b, targets: JSON.parse(b.targets) }));
  }

  sockets(code) {
    return this.ctx.getWebSockets(code).filter((ws) => ws.readyState === 1);
  }

  connectedPlayerIds(code) {
    const ids = new Set();
    for (const ws of this.sockets(code)) {
      const a = ws.deserializeAttachment();
      if (a?.role === 'player') ids.add(a.pid);
    }
    return ids;
  }

  // ------------------------------------------------------------ login throttling

  loginGate(ip, kind) {
    const key = `${kind}|${ip}`;
    const entry = this.loginFailures.get(key);
    if (entry && Date.now() - entry.since > LOGIN_WINDOW_MS) this.loginFailures.delete(key);
    const current = this.loginFailures.get(key);
    if (current && current.count >= LOGIN_MAX_FAILURES) {
      return { blocked: true, retryAfter: Math.ceil((current.since + LOGIN_WINDOW_MS - Date.now()) / 1000) };
    }
    return { blocked: false };
  }

  loginFailed(ip, kind) {
    const key = `${kind}|${ip}`;
    const entry = this.loginFailures.get(key) || { count: 0, since: Date.now() };
    entry.count += 1;
    this.loginFailures.set(key, entry);
    if (this.loginFailures.size > 5000) this.loginFailures.clear(); // bounded memory
  }

  loginSucceeded(ip, kind) {
    this.loginFailures.delete(`${kind}|${ip}`);
  }

  // ------------------------------------------------------------ RPC: host setup

  // RPC methods return {ok:false, error} for problems the user should see —
  // custom error classes don't survive the RPC boundary.
  guard(fn) {
    try { return { ok: true, ...fn() }; }
    catch (e) {
      if (e instanceof InputError) return { ok: false, error: e.message };
      throw e;
    }
  }

  createGame(args) { return this.guard(() => this._createGame(args)); }
  joinGame(code, nickname) { return this.guard(() => this._joinGame(code, nickname)); }
  submitImage(args) { return this.guard(() => this._submitImage(args)); }

  _createGame({ config, examples = [] }) {
    const { rounds, hostName } = normalizeConfig(config);
    let code;
    do { code = newGameCode(); } while (this.getGame(code));
    const now = Date.now();
    for (const ex of examples) {
      const r = rounds[ex.round];
      if (!r || !ex.bytes || ex.bytes.byteLength > LIMITS.maxImageBytes) continue;
      const mime = sniffImageType(ex.bytes);
      if (!mime) continue;
      const id = newId();
      this.sql.exec(
        "INSERT INTO images (id, game_code, round, player_id, kind, mime, size, created_at, bytes) VALUES (?, ?, ?, NULL, 'example', ?, ?, ?, ?)",
        id, code, ex.round, mime, ex.bytes.byteLength, now, ex.bytes,
      );
      r.exampleId = id;
    }
    const hostToken = newToken();
    const state = { rounds, round: -1, gallery: [], board: null, revealed: 0, finaleAt: null };
    this.sql.exec(
      'INSERT INTO games (code, host_token, host_name, created_at, updated_at, phase, deadline, state) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)',
      code, hostToken, hostName || null, now, now, 'lobby', JSON.stringify(state),
    );
    return { code, hostToken };
  }

  // ------------------------------------------------------------ RPC: players

  _joinGame(code, rawNickname) {
    const g = this.getGame(code);
    if (!g) throw new InputError('No game with that code. Check the code on the host screen.');
    if (g.phase === 'ceremony') throw new InputError('This game is already at the final ceremony.');
    const nickname = cleanNickname(rawNickname);
    const count = this.sql.exec('SELECT COUNT(*) AS n FROM players WHERE game_code = ?', g.code).one().n;
    if (count >= LIMITS.maxPlayers) throw new InputError('This game is full.');
    const taken = this.sql.exec('SELECT 1 FROM players WHERE game_code = ? AND lower(nickname) = lower(?)', g.code, nickname).toArray().length;
    if (taken) throw new InputError('Someone already uses that name in this game — pick another.');
    const id = newId();
    const token = newToken();
    this.sql.exec('INSERT INTO players (game_code, id, token, nickname, score, joined_at) VALUES (?, ?, ?, ?, 0, ?)', g.code, id, token, nickname, Date.now());
    this.broadcast(g.code);
    return { code: g.code, playerId: id, token, nickname };
  }

  _submitImage({ code, playerId, token, round, bytes }) {
    const g = this.getGame(code);
    if (!g) throw new InputError('Game not found.');
    const p = this.player(g.code, playerId, token);
    if (!p) throw new InputError('You are not part of this game any more — rejoin with the code.');
    if (g.phase !== 'submit' || Number(round) !== g.state.round + 1) {
      throw new InputError('Too late — this round is no longer taking photos.');
    }
    if (!bytes || bytes.byteLength === 0) throw new InputError('That photo was empty.');
    if (bytes.byteLength > LIMITS.maxImageBytes) throw new InputError('That photo is too large.');
    const mime = sniffImageType(bytes);
    if (!mime) throw new InputError('Only JPEG, PNG or WebP photos are supported.');
    if (this.sql.databaseSize > STORAGE_SOFT_LIMIT) {
      throw new InputError('Storage is full. Ask the host to download and delete old games in the admin panel.');
    }
    const r = g.state.round;
    // Re-submitting inside the window replaces the earlier photo.
    this.sql.exec("DELETE FROM images WHERE game_code = ? AND round = ? AND player_id = ? AND kind = 'sub'", g.code, r, p.id);
    this.sql.exec(
      "INSERT INTO images (id, game_code, round, player_id, kind, mime, size, created_at, bytes) VALUES (?, ?, ?, ?, 'sub', ?, ?, ?, ?)",
      newId(), g.code, r, p.id, mime, bytes.byteLength, Date.now(), bytes,
    );
    const everyone = this.players(g.code).map((x) => x.id);
    const submitted = new Set(this.roundImages(g.code, r).map((i) => i.playerId));
    if (everyone.every((id) => submitted.has(id))) this.endSubmit(g);
    this.broadcast(g.code);
    return {};
  }

  gameInfo(code) {
    const g = this.getGame(code);
    return g ? { exists: true, code: g.code, phase: g.phase, hostName: g.host_name } : { exists: false };
  }

  getImage(id) {
    const row = this.sql.exec('SELECT mime, bytes FROM images WHERE id = ?', String(id || '')).toArray()[0];
    return row ? { mime: row.mime, bytes: row.bytes } : null;
  }

  // ------------------------------------------------------------ RPC: admin

  adminListGames() {
    const games = this.sql.exec(`
      SELECT g.code, g.host_name AS hostName, g.created_at AS createdAt, g.finished_at AS finishedAt,
             g.phase, g.state,
             (SELECT COUNT(*) FROM players p WHERE p.game_code = g.code) AS players,
             (SELECT COUNT(*) FROM images i WHERE i.game_code = g.code AND i.kind = 'sub') AS photos,
             (SELECT COALESCE(SUM(size), 0) FROM images i WHERE i.game_code = g.code) AS bytes
      FROM games g ORDER BY g.created_at DESC`).toArray();
    return {
      games: games.map(({ state, ...g }) => {
        const s = JSON.parse(state);
        return { ...g, rounds: s.rounds.length, tasks: s.rounds.map((r) => r.task) };
      }),
      storage: { usedBytes: this.sql.databaseSize, limitBytes: 5 * 1024 ** 3 },
    };
  }

  adminManifest(code) {
    const g = this.getGame(code);
    if (!g) return null;
    const names = new Map(this.players(g.code).map((p) => [p.id, p.nickname]));
    const images = this.sql.exec(
      "SELECT id, round, player_id AS playerId, kind, mime, size, votes, points FROM images WHERE game_code = ? ORDER BY round, votes DESC, created_at",
      g.code,
    ).toArray().map((img) => ({
      ...img,
      round: img.round + 1, // human numbering, matches `rounds[].number`
      nickname: img.playerId ? names.get(img.playerId) || '(removed player)' : null,
    }));
    return {
      code: g.code,
      hostName: g.host_name,
      createdAt: g.created_at,
      finishedAt: g.finished_at,
      phase: g.phase,
      rounds: g.state.rounds.map((r, i) => ({ number: i + 1, task: r.task, points: r.points })),
      leaderboard: rankPlayers(this.players(g.code)).map(({ id, nickname, score, rank }) => ({ id, nickname, score, rank })),
      images,
    };
  }

  adminDeleteGame(code) {
    const g = this.getGame(code);
    if (!g) return { deleted: false };
    for (const ws of this.sockets(g.code)) {
      try { ws.close(4000, 'This game was deleted'); } catch {}
    }
    this.sql.exec('DELETE FROM images WHERE game_code = ?', g.code);
    this.sql.exec('DELETE FROM votes WHERE game_code = ?', g.code);
    this.sql.exec('DELETE FROM players WHERE game_code = ?', g.code);
    this.sql.exec('DELETE FROM games WHERE code = ?', g.code);
    this.rearm();
    return { deleted: true };
  }

  // ------------------------------------------------------------ WebSockets

  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    const g = this.getGame(url.searchParams.get('code'));
    if (!g) return new Response('Game not found', { status: 404 });
    const role = url.searchParams.get('role');
    const token = url.searchParams.get('token') || '';
    let attachment;
    if (role === 'host') {
      if (token !== g.host_token) return new Response('Not the host', { status: 403 });
      attachment = { code: g.code, role: 'host' };
    } else {
      const p = this.player(g.code, url.searchParams.get('pid'), token);
      if (!p) return new Response('Unknown player', { status: 403 });
      attachment = { code: g.code, role: 'player', pid: p.id };
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const tags = [g.code, attachment.role === 'host' ? `host:${g.code}` : `p:${attachment.pid}`];
    this.ctx.acceptWebSocket(server, tags);
    server.serializeAttachment(attachment);
    this.broadcast(g.code); // the new screen gets its snapshot; others see the "online" dot
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > 4000) return;
    if (!this.withinBudget(ws)) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const a = ws.deserializeAttachment();
    if (!a) return;
    const g = this.getGame(a.code);
    if (!g) { try { ws.close(4000, 'This game was deleted'); } catch {} return; }
    if (msg.t === 'sync') {
      ws.send(JSON.stringify({ t: 'state', now: Date.now(), s: this.viewFor(g, this.sharedView(g), a) }));
      return;
    }
    try {
      if (a.role === 'host') this.onHostMessage(g, msg);
      else this.onPlayerMessage(g, a.pid, msg);
    } catch (err) {
      ws.send(JSON.stringify({ t: 'error', message: err instanceof InputError ? err.message : 'Something went wrong.' }));
      if (!(err instanceof InputError)) console.error(err);
    }
  }

  async webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch {}
    const a = ws.deserializeAttachment();
    if (a) this.broadcast(a.code);
  }

  async webSocketError(ws) {
    const a = ws.deserializeAttachment();
    if (a) this.broadcast(a.code);
  }

  withinBudget(ws) {
    const now = Date.now();
    const b = this.msgBudget.get(ws) || { windowStart: now, count: 0 };
    if (now - b.windowStart > 1000) { b.windowStart = now; b.count = 0; }
    b.count += 1;
    this.msgBudget.set(ws, b);
    return b.count <= 12;
  }

  onHostMessage(g, msg) {
    switch (msg.t) {
      case 'start':
        if (g.phase !== 'lobby') return;
        if (this.players(g.code).length === 0) throw new InputError('Wait until at least one player has joined.');
        g.state.round = 0;
        this.startSubmit(g);
        break;
      case 'endPhase':
        if (g.phase === 'submit') this.endSubmit(g);
        else if (g.phase === 'vote') this.finishVoting(g);
        break;
      case 'next':
        if (g.phase !== 'results') return;
        if (g.state.round >= g.state.rounds.length - 1) this.startCeremony(g);
        else { g.state.round += 1; this.startSubmit(g); }
        break;
      case 'finishEarly':
        if (g.phase === 'results') this.startCeremony(g);
        break;
      case 'reveal':
        this.revealNext(g);
        break;
      case 'kick':
        this.kick(g, String(msg.pid || ''));
        break;
      case 'removePhoto':
        this.removePhoto(g, String(msg.imageId || ''));
        break;
      default:
        return;
    }
    this.broadcast(g.code);
  }

  onPlayerMessage(g, pid, msg) {
    if (msg.t !== 'vote' || g.phase !== 'vote') return;
    const r = g.state.round;
    const own = this.roundImages(g.code, r).find((i) => i.playerId === pid)?.id;
    const targets = sanitizeBallot(msg.targets, g.state.gallery, own);
    const locked = msg.lock ? 1 : 0;
    const prev = this.sql.exec('SELECT targets, locked FROM votes WHERE game_code = ? AND round = ? AND voter_id = ?', g.code, r, pid).toArray()[0];
    const json = JSON.stringify(targets);
    if (prev && prev.targets === json && prev.locked === locked) return; // nothing changed
    this.sql.exec(
      `INSERT INTO votes (game_code, round, voter_id, targets, locked, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (game_code, round, voter_id) DO UPDATE SET targets = excluded.targets, locked = excluded.locked, updated_at = excluded.updated_at`,
      g.code, r, pid, json, locked, Date.now(),
    );
    if (locked) {
      const eligible = this.eligibleVoters(g);
      const lockedIds = new Set(this.roundBallots(g.code, r).filter((b) => b.locked).map((b) => b.voterId));
      if (eligible.length > 0 && eligible.every((id) => lockedIds.has(id))) this.finishVoting(g);
    }
    this.broadcast(g.code);
  }

  // ------------------------------------------------------------ phase machine

  startSubmit(g) {
    const round = g.state.rounds[g.state.round];
    g.phase = 'submit';
    g.deadline = Date.now() + round.submitSeconds * 1000;
    g.state.gallery = [];
    this.saveGame(g);
    this.rearm();
  }

  /** Players who have at least one photo to vote for (anything but their own). */
  eligibleVoters(g) {
    const images = this.roundImages(g.code, g.state.round);
    return this.players(g.code)
      .map((p) => p.id)
      .filter((id) => images.some((img) => img.playerId !== id));
  }

  endSubmit(g) {
    if (g.phase !== 'submit') return;
    const images = this.roundImages(g.code, g.state.round);
    g.state.gallery = shuffle(images.map((i) => i.id));
    if (images.length === 0 || this.eligibleVoters(g).length === 0) {
      g.phase = 'vote'; // tally immediately: nobody can vote
      this.saveGame(g);
      this.finishVoting(g);
      return;
    }
    g.phase = 'vote';
    g.deadline = Date.now() + g.state.rounds[g.state.round].voteSeconds * 1000;
    this.saveGame(g);
    this.rearm();
  }

  finishVoting(g) {
    if (g.phase !== 'vote') return;
    const r = g.state.round;
    const round = g.state.rounds[r];
    const images = this.roundImages(g.code, r);
    const counts = tally(this.roundBallots(g.code, r), images);
    const perPlayer = new Map();
    for (const img of images) {
      const votes = counts.get(img.id) || 0;
      const points = votes * round.points;
      this.sql.exec('UPDATE images SET votes = ?, points = ? WHERE id = ?', votes, points, img.id);
      perPlayer.set(img.playerId, (perPlayer.get(img.playerId) || 0) + points);
    }
    for (const [pid, pts] of perPlayer) {
      if (pts) this.sql.exec('UPDATE players SET score = score + ? WHERE game_code = ? AND id = ?', pts, g.code, pid);
    }
    g.phase = 'results';
    g.deadline = null;
    this.saveGame(g);
    this.rearm();
  }

  startCeremony(g) {
    g.phase = 'ceremony';
    g.deadline = null;
    g.state.board = rankPlayers(this.players(g.code))
      .slice(0, LIMITS.ceremonySize)
      .map(({ id, nickname, score, rank }) => ({ id, nickname, score, rank }));
    g.state.revealed = 0;
    g.state.finaleAt = null;
    if (g.state.board.length === 0) g.finished_at = Date.now();
    this.saveGame(g);
    this.rearm();
  }

  revealNext(g) {
    if (g.phase !== 'ceremony') return;
    const n = g.state.board.length;
    if (g.state.revealed >= n) return;
    // Everyone still hidden shares first place? Then they're revealed together
    // in the finale, so a joint winner never spoils the drum-roll.
    const hidden = g.state.board.slice(0, n - g.state.revealed);
    if (hidden.every((e) => e.rank === 1)) g.state.revealed = n;
    else g.state.revealed += 1;
    if (g.state.revealed === n) {
      g.state.finaleAt = Date.now() + LIMITS.finaleDelayMs;
      g.finished_at = Date.now();
    }
    this.saveGame(g);
  }

  kick(g, pid) {
    const p = this.sql.exec('SELECT id FROM players WHERE game_code = ? AND id = ?', g.code, pid).toArray()[0];
    if (!p) return;
    // A removed player's photo for the round in progress goes too (moderation).
    if (g.state.round >= 0 && (g.phase === 'submit' || g.phase === 'vote')) {
      const img = this.roundImages(g.code, g.state.round).find((i) => i.playerId === pid);
      if (img) this.removePhoto(g, img.id);
    }
    this.sql.exec('DELETE FROM players WHERE game_code = ? AND id = ?', g.code, pid);
    if (g.state.round >= 0) this.sql.exec('DELETE FROM votes WHERE game_code = ? AND round = ? AND voter_id = ?', g.code, g.state.round, pid);
    for (const ws of this.ctx.getWebSockets(`p:${pid}`)) {
      try { ws.close(4001, 'Removed by the host'); } catch {}
    }
  }

  /** Host moderation: take a photo out of the round (and back out its points). */
  removePhoto(g, imageId) {
    const img = this.sql.exec("SELECT id, player_id AS playerId, round, points FROM images WHERE id = ? AND game_code = ? AND kind = 'sub'", imageId, g.code).toArray()[0];
    if (!img) return;
    if (img.points) this.sql.exec('UPDATE players SET score = MAX(0, score - ?) WHERE game_code = ? AND id = ?', img.points, g.code, img.playerId);
    this.sql.exec('DELETE FROM images WHERE id = ?', img.id);
    if (img.round === g.state.round && g.state.gallery.includes(img.id)) {
      g.state.gallery = g.state.gallery.filter((id) => id !== img.id);
      this.saveGame(g);
    }
  }

  async alarm() {
    const now = Date.now();
    const due = this.sql.exec("SELECT code, phase, deadline FROM games WHERE phase IN ('submit', 'vote') AND deadline IS NOT NULL").toArray();
    for (const row of due) {
      const grace = row.phase === 'submit' ? LIMITS.submitGraceMs : LIMITS.voteGraceMs;
      if (row.deadline + grace > now + 25) continue;
      const g = this.getGame(row.code);
      if (g.phase === 'submit') this.endSubmit(g);
      else if (g.phase === 'vote') this.finishVoting(g);
      this.broadcast(g.code);
    }
    this.rearm();
  }

  rearm() {
    const rows = this.sql.exec("SELECT phase, deadline FROM games WHERE phase IN ('submit', 'vote') AND deadline IS NOT NULL").toArray();
    if (rows.length === 0) { this.ctx.storage.deleteAlarm(); return; }
    const next = Math.min(...rows.map((r) => r.deadline + (r.phase === 'submit' ? LIMITS.submitGraceMs : LIMITS.voteGraceMs)));
    this.ctx.storage.setAlarm(Math.max(next, Date.now() + 10));
  }

  // ------------------------------------------------------------ snapshots

  broadcast(code) {
    const sockets = this.sockets(code);
    if (sockets.length === 0) return;
    const g = this.getGame(code);
    if (!g) return;
    const shared = this.sharedView(g);
    for (const ws of sockets) {
      const a = ws.deserializeAttachment();
      try { ws.send(JSON.stringify({ t: 'state', now: Date.now(), s: this.viewFor(g, shared, a) })); } catch {}
    }
  }

  sharedView(g) {
    const online = this.connectedPlayerIds(g.code);
    const players = rankPlayers(this.players(g.code));
    const r = g.state.round;
    const images = r >= 0 ? this.roundImages(g.code, r) : [];
    const ballots = r >= 0 ? this.roundBallots(g.code, r) : [];
    return { online, players, images, ballots, eligible: g.phase === 'vote' ? this.eligibleVoters(g) : [] };
  }

  viewFor(g, shared, viewer) {
    const { online, players, images, ballots, eligible } = shared;
    const isHost = viewer.role === 'host';
    const r = g.state.round;
    const round = r >= 0 ? g.state.rounds[r] : null;
    const totalRounds = g.state.rounds.length;
    const isLastRound = r === totalRounds - 1;
    const finalStretch = g.phase === 'ceremony' || (g.phase === 'results' && isLastRound);
    const ceremonyDone = g.phase === 'ceremony' && g.state.revealed >= (g.state.board?.length || 0);
    // Totals stay hidden from the last round's results until the ceremony has
    // revealed everyone, so the #1 reveal is actually a surprise.
    const hideScores = finalStretch && !ceremonyDone;
    const submitted = new Set(images.map((i) => i.playerId));
    const lockedIds = new Set(ballots.filter((b) => b.locked).map((b) => b.voterId));

    const view = {
      code: g.code,
      phase: g.phase,
      round: r + 1,
      totalRounds,
      isLastRound,
      hostName: g.host_name,
      deadline: g.deadline,
      scoresHidden: hideScores,
      players: players.map((p) => ({
        id: p.id,
        nickname: p.nickname,
        online: online.has(p.id),
        score: hideScores ? null : p.score,
        rank: hideScores ? null : p.rank,
        submitted: g.phase === 'submit' ? submitted.has(p.id) : undefined,
      })),
    };
    if (round) {
      view.task = round.task;
      view.points = round.points;
      view.exampleUrl = round.exampleId ? `/img/${round.exampleId}` : null;
    }
    const mine = viewer.role === 'player' ? players.find((p) => p.id === viewer.pid) : null;
    if (mine) view.me = { id: mine.id, nickname: mine.nickname, score: hideScores ? null : mine.score };

    if (g.phase === 'submit') {
      view.progress = { done: submitted.size, total: players.length };
      if (mine) view.me.submitted = submitted.has(mine.id);
    }

    if (g.phase === 'vote') {
      const ownId = mine ? images.find((i) => i.playerId === mine.id)?.id : null;
      view.gallery = g.state.gallery.filter((id) => id !== ownId).map((id) => ({ id, url: `/img/${id}` }));
      view.progress = { done: eligible.filter((id) => lockedIds.has(id)).length, total: eligible.length };
      if (mine) {
        const b = ballots.find((x) => x.voterId === mine.id);
        view.me.votes = b ? b.targets : [];
        view.me.locked = Boolean(b?.locked);
        view.me.canVote = eligible.includes(mine.id);
      }
    }

    if (g.phase === 'results') {
      const names = new Map(players.map((p) => [p.id, p.nickname]));
      view.results = images
        .slice()
        .sort((a, b) => b.votes - a.votes || a.created_at - b.created_at)
        .map((img) => ({
          id: isHost ? img.id : undefined,
          url: `/img/${img.id}`,
          nickname: names.get(img.playerId) || '(removed player)',
          votes: img.votes,
          points: img.points,
          mine: Boolean(mine && img.playerId === mine.id),
        }));
    }

    if (g.phase === 'ceremony') {
      const board = g.state.board || [];
      const k = g.state.revealed;
      view.ceremony = {
        total: board.length,
        revealed: k,
        // Only what has been revealed leaves the server — no peeking at #1.
        entries: board.slice(board.length - k),
        finaleAt: g.state.finaleAt,
      };
      if (isHost) {
        const hiddenEntries = board.slice(0, board.length - k);
        view.ceremony.nextRank = hiddenEntries.length ? hiddenEntries[hiddenEntries.length - 1].rank : null;
        view.ceremony.nextIsFinale = hiddenEntries.length > 0 && hiddenEntries.every((e) => e.rank === 1);
      }
    }
    return view;
  }
}

