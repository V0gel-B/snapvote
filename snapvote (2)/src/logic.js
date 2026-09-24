// Pure game rules — no Workers APIs, so they can be unit-tested in Node.

/** An error whose message is safe and meant to be shown to the player. */
export class InputError extends Error {}

export const LIMITS = {
  maxRounds: 20,
  maxTaskLength: 200,
  minSeconds: 5,
  maxSeconds: 600,
  maxPoints: 10000,
  maxPlayers: 80,
  maxNickname: 20,
  maxVotes: 3,
  maxImageBytes: 1_500_000, // after client-side compression photos are ~150-450 KB
  ceremonySize: 10,
  submitGraceMs: 1500, // uploads already in flight when the timer hits 0 still count
  voteGraceMs: 500,
  finaleDelayMs: 3500, // drum-roll before the #1 name appears on every screen
};

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I

export function randomString(chars, length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  // Rejection sampling keeps the distribution uniform.
  const max = 256 - (256 % chars.length);
  let i = 0;
  while (out.length < length) {
    if (i >= bytes.length) { crypto.getRandomValues(bytes); i = 0; }
    const b = bytes[i++];
    if (b < max) out += chars[b % chars.length];
  }
  return out;
}

export const newGameCode = () => randomString(CODE_CHARS, 5);
export const newId = () => randomString('abcdefghijklmnopqrstuvwxyz0123456789', 22); // ~113 bits
export const newToken = () => randomString('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 32);

export function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Validate and normalize the host's setup form. Throws with a readable message. */
export function normalizeConfig(raw) {
  if (!raw || !Array.isArray(raw.rounds) || raw.rounds.length === 0) {
    throw new InputError('Add at least one round.');
  }
  if (raw.rounds.length > LIMITS.maxRounds) throw new InputError(`At most ${LIMITS.maxRounds} rounds.`);
  const rounds = raw.rounds.map((r, i) => {
    const task = String(r?.task ?? '').trim().slice(0, LIMITS.maxTaskLength);
    if (!task) throw new InputError(`Round ${i + 1} needs a task.`);
    return {
      task,
      points: clampInt(r.points, 1, LIMITS.maxPoints, 100),
      submitSeconds: clampInt(r.submitSeconds, LIMITS.minSeconds, LIMITS.maxSeconds, 60),
      voteSeconds: clampInt(r.voteSeconds, LIMITS.minSeconds, LIMITS.maxSeconds, 30),
      exampleId: null,
    };
  });
  const hostName = String(raw.hostName ?? '').trim().slice(0, LIMITS.maxNickname);
  return { rounds, hostName };
}

export function cleanNickname(raw) {
  const name = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LIMITS.maxNickname);
  if (!name) throw new InputError('Pick a nickname.');
  return name;
}

/** Fisher–Yates with crypto randomness. Returns a new array. */
export function shuffle(items) {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    const j = buf[0] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Sanitize one ballot: distinct ids, only images in this round's gallery,
 * never the voter's own image, at most LIMITS.maxVotes.
 */
export function sanitizeBallot(targets, galleryIds, ownImageId) {
  if (!Array.isArray(targets)) return [];
  const allowed = new Set(galleryIds);
  const out = [];
  for (const t of targets) {
    if (typeof t !== 'string' || !allowed.has(t) || t === ownImageId || out.includes(t)) continue;
    out.push(t);
    if (out.length >= LIMITS.maxVotes) break;
  }
  return out;
}

/**
 * Count votes per image. `ballots` is [{voterId, targets}], `images` is
 * [{id, playerId}]. Ballots are re-sanitized here so a stale or tampered
 * ballot can never count a self-vote or a 4th vote.
 */
export function tally(ballots, images) {
  const byId = new Map(images.map((img) => [img.id, img]));
  const ownByVoter = new Map(images.map((img) => [img.playerId, img.id]));
  const counts = new Map(images.map((img) => [img.id, 0]));
  const galleryIds = images.map((img) => img.id);
  for (const b of ballots) {
    const clean = sanitizeBallot(b.targets, galleryIds, ownByVoter.get(b.voterId));
    for (const id of clean) if (byId.has(id)) counts.set(id, counts.get(id) + 1);
  }
  return counts;
}

/** Sort by score desc, then name; ties share a rank (1, 2, 2, 4 ...). */
export function rankPlayers(players) {
  const sorted = players
    .slice()
    .sort((a, b) => b.score - a.score || a.nickname.localeCompare(b.nickname));
  let rank = 0;
  let prevScore = null;
  sorted.forEach((p, i) => {
    if (p.score !== prevScore) { rank = i + 1; prevScore = p.score; }
    p.rank = rank;
  });
  return sorted;
}

/** Recognize the image formats we accept by their magic bytes. */
export function sniffImageType(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (
    b.length > 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return 'image/webp';
  return null;
}
