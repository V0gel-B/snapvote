#!/usr/bin/env node
// Run SnapVote on this computer for testing: npm run dev  ->  http://localhost:8787
// Uses local passwords from .dev.vars (created on first run).
import { existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vars = join(root, '.dev.vars');
if (!existsSync(join(root, 'node_modules', 'wrangler'))) {
  console.error('Run `npm install` first.');
  process.exit(1);
}
if (!existsSync(vars)) {
  writeFileSync(vars, 'SITE_PASSWORD="player-pass"\nADMIN_PASSWORD="admin-pass"\n');
  console.log('Created .dev.vars with local test passwords: player = player-pass, admin = admin-pass');
}
console.log('SnapVote dev server: http://localhost:8787  (player password "player-pass", admin "admin-pass" unless you changed .dev.vars)\n');
const child = spawn(process.execPath, [join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), 'dev', ...process.argv.slice(2)], {
  cwd: root, stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
});
child.on('close', (code) => process.exit(code ?? 0));
