#!/usr/bin/env node
// One-click deploy of SnapVote to Cloudflare Workers (free plan).
//
//   1. installs the deploy tool (wrangler) into this folder
//   2. opens your browser to log in / create a free Cloudflare account
//   3. uploads SnapVote and prints your public link
//   4. creates the player + admin passwords and stores them as secrets
//
// Re-run any time to publish changes; your passwords are kept.
// Flags: --reset-passwords   generate new passwords (logs everyone out)

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdtempSync, rmdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt } from 'node:crypto';
import os from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const isWin = process.platform === 'win32';
const args = new Set(process.argv.slice(2));
const ACCESS_JSON = join(root, '.snapvote-access.json');
const ACCESS_TXT = join(root, 'SNAPVOTE-ACCESS.txt');
const WRANGLER = process.env.SNAPVOTE_WRANGLER || join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'); // override = tests only

const c = { bold: (s) => `\x1b[1m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`, cyan: (s) => `\x1b[36m${s}\x1b[0m` };
const step = (n, msg) => console.log(`\n${c.cyan(`[${n}/4]`)} ${c.bold(msg)}`);
const fail = (msg) => { console.error(`\n${c.red('✖')} ${msg}\n`); process.exit(1); };

// ------------------------------------------------------------------ helpers
function run(cmd, argv, { capture = false, input, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, {
      cwd: root,
      stdio: [input !== undefined ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'],
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', ...env },
      shell: false,
    });
    let out = '';
    if (capture) {
      child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
      child.stderr.on('data', (d) => { out += d; process.stderr.write(d); });
    }
    if (input !== undefined) { child.stdin.write(input); child.stdin.end(); }
    child.on('close', (code) => resolve({ code, out }));
    child.on('error', (err) => resolve({ code: 1, out: String(err) }));
  });
}
const wrangler = (argv, opts) => run(process.execPath, [WRANGLER, ...argv], opts);
function quiet(argv) {
  const r = spawnSync(process.execPath, [WRANGLER, ...argv], { cwd: root, encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

const WORDS = ['apple', 'bagel', 'banjo', 'cactus', 'candle', 'comet', 'daisy', 'disco', 'dragon', 'falcon', 'fiesta', 'galaxy', 'gecko',
  'ginger', 'glitter', 'hammock', 'honey', 'igloo', 'jelly', 'jungle', 'kiwi', 'koala', 'lemon', 'llama', 'mango', 'maple', 'marble',
  'meadow', 'mocha', 'nacho', 'noodle', 'ocean', 'olive', 'panda', 'pepper', 'pickle', 'pixel', 'planet', 'popcorn', 'pretzel', 'puffin',
  'quartz', 'radish', 'rocket', 'saffron', 'sherbet', 'sparrow', 'sprout', 'sunset', 'taco', 'tiger', 'toffee', 'tulip', 'velvet',
  'waffle', 'walrus', 'wizard', 'yeti', 'zebra', 'zeppelin'];
const word = () => WORDS[randomInt(WORDS.length)];
const newPasswords = () => ({
  sitePassword: `${word()}-${word()}-${randomInt(1000, 10000)}`,
  adminPassword: `${word()}-${word()}-${word()}-${randomInt(1000, 10000)}`,
});

function openBrowser(url) {
  try {
    if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else if (isWin) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* the URL is printed anyway */ }
}

// ------------------------------------------------------------------ main
console.log(c.bold('\n📸  SnapVote — deploy to the internet (free, Cloudflare Workers)'));

const major = Number(process.versions.node.split('.')[0]);
if (major < 22) fail(`Node.js 22 or newer is needed (you have ${process.versions.node}).\n  Install the LTS version from https://nodejs.org and run this again.`);

step(1, 'Installing the deploy tool');
if (!existsSync(WRANGLER)) {
  const npm = isWin ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: root, stdio: 'inherit', shell: isWin });
  if (r.status !== 0 || !existsSync(WRANGLER)) fail('npm install failed. Check your internet connection and try again.');
}
console.log(c.green('  ✓ ready'));

step(2, 'Connecting to your Cloudflare account');
let who = quiet(['whoami']);
if (/not authenticated/i.test(who.out) || who.code !== 0) {
  console.log('  Your browser will open. Log in to Cloudflare — or click "Sign up" to create a free account');
  console.log('  (no credit card needed) — then click "Allow". Come back here afterwards.');
  const r = await wrangler(['login']);
  if (r.code !== 0) fail('Login did not complete. Run the script again to retry.');
  who = quiet(['whoami']);
  if (/not authenticated/i.test(who.out)) fail('Still not logged in. Run the script again to retry.');
}
const email = who.out.match(/associated with the email\s+(\S+?)\.?\s*$/m)?.[1];
console.log(c.green(`  ✓ logged in${email ? ` as ${email}` : ''}`));

step(3, 'Uploading SnapVote');
console.log('  (First time only: Cloudflare may ask you to pick a free workers.dev subdomain — just type a name.)\n');
// Run interactively (so Cloudflare can ask questions) and read the result
// from wrangler's machine-readable output file.
const outDir = mkdtempSync(join(os.tmpdir(), 'snapvote-out-'));
const outFile = join(outDir, 'wrangler-output.json');
const dep = await wrangler(['deploy'], { env: { WRANGLER_OUTPUT_FILE_PATH: outFile } });
let url = null;
try {
  for (const line of readFileSync(outFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    if (entry.type === 'deploy') url = (entry.targets || []).find((t) => /workers\.dev/.test(t)) || entry.targets?.[0] || url;
  }
} catch {}
try { unlinkSync(outFile); } catch {}
try { rmdirSync(outDir); } catch {}
if (dep.code !== 0) {
  fail('The upload failed — see the messages above.\n  If it mentions a workers.dev subdomain: open https://dash.cloudflare.com → Workers & Pages, pick a free subdomain, then run this again.\n  Otherwise, running the script again usually fixes temporary errors.');
}
if (url && !/^https?:\/\//.test(url)) url = `https://${url}`;

step(4, 'Setting up passwords');
let access = null;
try { access = JSON.parse(readFileSync(ACCESS_JSON, 'utf8')); } catch {}
const list = quiet(['secret', 'list', '--format', 'json']);
let remote = [];
try { remote = JSON.parse(list.out.slice(list.out.indexOf('['))).map((s) => s.name); } catch {}
const remoteHasBoth = remote.includes('SITE_PASSWORD') && remote.includes('ADMIN_PASSWORD');

let upload = null;
if (args.has('--reset-passwords')) {
  access = { ...newPasswords() };
  upload = access;
  console.log('  Generating new passwords (everyone will need to log in again).');
} else if (access?.sitePassword && access?.adminPassword) {
  if (!remoteHasBoth) upload = access;
  console.log(c.green('  ✓ keeping your existing passwords'));
} else if (remoteHasBoth) {
  console.log(c.yellow('  Passwords are already set on Cloudflare, but not saved on this computer.'));
  console.log(c.yellow('  If you lost them, run this again with --reset-passwords to make new ones.'));
} else {
  access = { ...newPasswords() };
  upload = access;
}
if (upload) {
  const dir = mkdtempSync(join(os.tmpdir(), 'snapvote-'));
  const file = join(dir, 'secrets.json');
  writeFileSync(file, JSON.stringify({ SITE_PASSWORD: upload.sitePassword, ADMIN_PASSWORD: upload.adminPassword }), { mode: 0o600 });
  const r = await wrangler(['secret', 'bulk', file], { capture: true });
  try { unlinkSync(file); rmdirSync(dir); } catch {}
  if (r.code !== 0) fail('Could not save the passwords. Run the script again.');
  console.log(c.green('  ✓ passwords stored securely on Cloudflare'));
}

const site = url || access?.url;
if (access) {
  access.url = site || access.url;
  writeFileSync(ACCESS_JSON, JSON.stringify(access, null, 2), { mode: 0o600 });
  writeFileSync(ACCESS_TXT, [
    'SnapVote — your access details (keep this file private)',
    '',
    `Website:          ${site || '(see your Cloudflare dashboard → Workers & Pages → snapvote)'}`,
    `Host a game:      ${site ? site + '/host' : ''}`,
    `Admin panel:      ${site ? site + '/admin' : ''}`,
    '',
    `PLAYER password:  ${access.sitePassword}    <- share this with the people playing`,
    `ADMIN password:   ${access.adminPassword}    <- keep to yourself (hosting + photo downloads)`,
    '',
    'Players scan the QR code on your host screen, enter the player password once, and join.',
    'Run the deploy script again to publish updates (passwords are kept).',
    '',
  ].join(os.EOL));
}

console.log(`\n${c.green(c.bold('✅  SnapVote is live!'))}\n`);
if (site) {
  console.log(`   Website:          ${c.bold(site)}`);
  console.log(`   Host a game:      ${c.bold(site + '/host')}`);
  console.log(`   Admin panel:      ${site}/admin`);
}
if (access) {
  console.log(`\n   PLAYER password:  ${c.bold(access.sitePassword)}   ← give this to players`);
  console.log(`   ADMIN password:   ${c.bold(access.adminPassword)}   ← only for you`);
  console.log(`\n   Saved to ${c.bold('SNAPVOTE-ACCESS.txt')} in this folder.`);
}
if (site) {
  console.log('\n   Opening the host page in your browser…\n');
  openBrowser(`${site}/host`);
}
