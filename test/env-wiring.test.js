'use strict';

/**
 * Every env var the code reads must actually be passed through in
 * docker-compose.yml.
 *
 * A Portainer stack variable interpolates into the compose FILE. It is not
 * injected into the container. So a name the compose never mentions is simply
 * absent at runtime, no matter how confidently the Portainer UI shows it set —
 * the app sees undefined and takes its "not configured" branch, and the fix
 * looks like it was applied.
 *
 * This is the estate's most productive test. It exists in octopus-shopper
 * because ADMIN_USERNAME was read, never wired, and left 52 recipes invisible to
 * their owner; ported to octopus-budget on 2026-09-05 it immediately found
 * AUTH_PUBLIC_URL in the same state.
 *
 * Run: node --test test/env-wiring.test.js
 */

const { test } = require('node:test');
const assert   = require('node:assert');
const fs       = require('node:fs');
const path     = require('node:path');

const root    = path.join(__dirname, '..');
const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');

const SKIP_DIRS = new Set(["node_modules", "test", "data"]);

/** Every process.env.X read anywhere in this app's own source. */
function readsEnv() {
  const names = new Set();
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs|cjs|ts)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) {
        for (const m of fs.readFileSync(p, 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
          names.add(m[1]);
        }
      }
    }
  })(root);
  return names;
}

// Set by the runtime or by Docker itself, never by this compose file.
const AMBIENT = new Set(['NODE_ENV', 'PORT', 'HOME', 'PATH', 'TZ', 'PWD', 'USER']);

/**
 * Variables the code reads in order to confirm they are ABSENT.
 *
 * Wiring one of these would be actively harmful, so the test must be able to say
 * so rather than demanding every read be wired. octopus-claude is the case that
 * forced this: it reads ANTHROPIC_API_KEY only to warn that it leaked, and
 * deletes it before spawning, because setting it bills the metered API instead
 * of the flat subscription the service exists to use. Its compose says "DO NOT
 * set ANTHROPIC_API_KEY here" in as many words.
 *
 * Anything added here needs a comment saying why, or it becomes a place to
 * silence the test instead of fixing the wiring.
 */
const INTENTIONALLY_UNWIRED = new Set([]);

test('the scan finds something — it has not silently stopped matching', () => {
  const names = readsEnv();
  assert.ok(names.size >= 1, `only found ${names.size} env reads, which suggests the scan broke`);
  assert.ok(names.has('DEVICE_LABEL'), 'a known variable is missing from the scan');
});

/**
 * Compose has three ways to wire a variable, and all of them count:
 *   - NAME=value      set here (possibly interpolating a stack variable)
 *   - NAME            passed through from the environment Portainer supplies
 *   env_file: x.env   read from a file, which is untracked and unreadable here
 *
 * An earlier version of this test only recognised the first, and would have
 * reported alfred-js (which uses the second for all five of its variables) and
 * octopus-neith-api (which uses the third) as completely unwired. Both are
 * correct as written.
 */
const USES_ENV_FILE = /^\s*env_file:/m.test(compose);
const wired = name =>
  new RegExp(`^\\s*-\\s*${name}\\s*(=|$)`, 'm').test(compose);

test('every env var the code reads is passed through in docker-compose.yml', (t) => {
  if (USES_ENV_FILE) {
    return t.skip('compose uses env_file:, whose contents are untracked — cannot verify from here');
  }
  const missing = [...readsEnv()]
    .filter(n => !AMBIENT.has(n) && !INTENTIONALLY_UNWIRED.has(n))
    .filter(n => !wired(n))
    .sort();

  assert.deepStrictEqual(missing, [],
    `read at runtime but never reaching the container: ${missing.join(', ')} — setting these in Portainer will look like it worked and do nothing`);
});
