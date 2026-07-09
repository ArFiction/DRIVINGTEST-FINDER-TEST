#!/usr/bin/env node
/**
 * Local runner - run the DVSA checker on your own computer instead of GitHub
 * Actions (your home/residential IP, no GitHub billing involved).
 *
 * Loads config from a .env file sitting next to this script, waits a random
 * 0-45 minutes so scheduled runs don't fire on an exact clock tick, then runs
 * one check. Pass --now to skip the wait (use that to test).
 *
 *   node run-local.mjs         # jittered - use this from a scheduler
 *   node run-local.mjs --now   # immediate - use this to test it works
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '.env');

if (!existsSync(envPath)) {
  console.error(`No .env file found at ${envPath}.`);
  console.error('Copy .env.example to .env and fill in your details first.');
  process.exit(2);
}

// Minimal .env parser (KEY=VALUE per line; # comments and blanks ignored).
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  const key = m[1];
  const value = m[2].trim().replace(/^["']|["']$/g, '');
  if (value !== '' && process.env[key] === undefined) process.env[key] = value;
}

const now = process.argv.includes('--now');
const delayMs = now ? 0 : Math.floor(Math.random() * 45 * 60 * 1000);
if (delayMs) {
  console.log(`Waiting ~${Math.round(delayMs / 60000)} min before checking (pass --now to skip)...`);
}

setTimeout(() => {
  const child = spawn(process.execPath, [join(here, 'src', 'check-tests.js')], {
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}, delayMs);
