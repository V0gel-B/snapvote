// Unit tests for the pure game rules:  npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMITS, InputError, newGameCode, newId, normalizeConfig, cleanNickname,
  shuffle, sanitizeBallot, tally, rankPlayers, sniffImageType,
} from '../src/logic.js';

test('game codes avoid look-alike characters and are 5 long', () => {
  for (let i = 0; i < 500; i++) assert.match(newGameCode(), /^[A-HJ-NP-Z2-9]{5}$/);
});

test('ids are random and unique', () => {
  const ids = new Set(Array.from({ length: 2000 }, newId));
  assert.equal(ids.size, 2000);
  for (const id of ids) assert.match(id, /^[a-z0-9]{22}$/);
});

test('config is validated and clamped', () => {
  const { rounds } = normalizeConfig({ rounds: [{ task: '  Red  ', points: 99999, submitSeconds: 1, voteSeconds: 'x' }] });
  assert.deepEqual(rounds[0], { task: 'Red', points: LIMITS.maxPoints, submitSeconds: LIMITS.minSeconds, voteSeconds: 30, exampleId: null });
  assert.throws(() => normalizeConfig({ rounds: [] }), InputError);
  assert.throws(() => normalizeConfig({ rounds: [{ task: ' ' }] }), /Round 1 needs a task/);
  assert.throws(() => normalizeConfig({ rounds: Array(21).fill({ task: 'a' }) }), /At most 20/);
});

test('nicknames are trimmed, collapsed and bounded', () => {
  assert.equal(cleanNickname('  Anna   Lena \n'), 'Anna Lena');
  assert.equal(cleanNickname('x'.repeat(50)).length, LIMITS.maxNickname);
  assert.throws(() => cleanNickname('   '), InputError);
});

test('shuffle keeps every item exactly once', () => {
  const items = Array.from({ length: 50 }, (_, i) => i);
  const out = shuffle(items);
  assert.deepEqual([...out].sort((a, b) => a - b), items);
  assert.notStrictEqual(out, items);
});

test('ballots: no self-votes, no duplicates, max 3, only gallery images', () => {
  const gallery = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(sanitizeBallot(['a', 'a', 'mine', 'zz', 'b', 'c', 'd'], [...gallery, 'mine'], 'mine'), ['a', 'b', 'c']);
  assert.deepEqual(sanitizeBallot('nope', gallery, null), []);
});

test('tally counts sanitized ballots only', () => {
  const images = [{ id: 'A', playerId: 'p1' }, { id: 'B', playerId: 'p2' }, { id: 'C', playerId: 'p3' }];
  const counts = tally([
    { voterId: 'p1', targets: ['A', 'B', 'C', 'B'] }, // self-vote + duplicate ignored
    { voterId: 'p2', targets: ['A'] },
    { voterId: 'p4', targets: ['A', 'B', 'C', 'X'] }, // late joiner without a photo
  ], images);
  assert.deepEqual(Object.fromEntries(counts), { A: 2, B: 2, C: 2 });
});

test('ranking shares places on ties', () => {
  const ranked = rankPlayers([
    { nickname: 'Cleo', score: 100 }, { nickname: 'Bob', score: 300 }, { nickname: 'Alice', score: 300 }, { nickname: 'Dan', score: 0 },
  ]);
  assert.deepEqual(ranked.map((p) => [p.nickname, p.rank]), [['Alice', 1], ['Bob', 1], ['Cleo', 3], ['Dan', 4]]);
});

test('image sniffing accepts JPEG/PNG/WebP only', () => {
  assert.equal(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0])), 'image/jpeg');
  assert.equal(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'image/png');
  assert.equal(sniffImageType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(sniffImageType(new TextEncoder().encode('<svg onload=alert(1)>')), null);
  assert.equal(sniffImageType(new TextEncoder().encode('GIF89a......')), null);
});
