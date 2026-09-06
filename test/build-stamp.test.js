'use strict';

/**
 * The deploy-verification stamp.
 *
 * Portainer polls and reports back to nobody, so "did my push land" could only
 * be inferred from whether the page looked different — which is exactly the
 * thing a cache can fake.
 *
 * The property worth defending is that the stamp MOVES when the code moves. A
 * stamp that silently stops tracking is worse than none: it reports "nothing
 * changed" for a deploy that did, in the confident direction.
 *
 * ── Why there is no asset cache-busting here ─────────────────────────────────
 * Cloudflare caches CSS and JS for four hours and overrides the origin, which
 * is why the other services now version their asset URLs. This one has no asset
 * URLs: public/index.html carries all of its CSS and JS inline, so there is
 * nothing to version and no stale-asset failure to guard against. The last test
 * pins that, so if a stylesheet is ever split out the gap is reported rather
 * than inherited silently.
 *
 * Run: node --test test/build-stamp.test.js
 */

const { test } = require('node:test');
const assert   = require('node:assert');
const fs       = require('node:fs');
const path     = require('node:path');

const root = path.join(__dirname, '..');
const { BUILD, sourceFiles } = require('../build');

function stampWith(relPath) {
  const target   = path.join(root, relPath);
  const original = fs.readFileSync(target);
  try {
    fs.writeFileSync(target, Buffer.concat([original, Buffer.from('\n<!-- build-stamp probe -->\n')]));
    delete require.cache[require.resolve('../build')];
    return require('../build').BUILD;
  } finally {
    fs.writeFileSync(target, original);
    delete require.cache[require.resolve('../build')];
  }
}

test('the stamp is a real hash, not the failure value', () => {
  assert.match(BUILD, /^[0-9a-f]{12}$/);
  assert.notStrictEqual(BUILD, 'unknown');
});

test('editing the server moves the stamp', () => {
  assert.notStrictEqual(stampWith('index.js'), BUILD, 'editing index.js did not move the stamp');
});

// The page is the product here, so a change to it is the deploy you most want
// to confirm.
test('editing the page moves the stamp too', () => {
  assert.notStrictEqual(stampWith('public/index.html'), BUILD,
    'editing public/index.html did not move the stamp');
});

test('the walk covers what ships and excludes dependencies', () => {
  const files = sourceFiles();
  assert.ok(files.includes('index.js'), 'index.js is not covered by the stamp');
  assert.ok(files.includes('public/index.html'), 'the page is not covered by the stamp');
  assert.ok(!files.some(f => f.includes('node_modules')), 'node_modules must not be hashed');
  assert.ok(!files.includes('package-lock.json'), 'the lockfile is deliberately excluded');
});

test('/health and /api/build are served before the static mount', () => {
  const src    = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  const static_ = src.indexOf('express.static');
  assert.ok(static_ > 0, 'expected a static mount');
  for (const route of ["app.get('/health'", "app.get('/api/build'"]) {
    const at = src.indexOf(route);
    assert.ok(at > 0, `${route} is not registered`);
    assert.ok(at < static_, `${route} is registered after the static mount`);
  }
});

/**
 * If this starts failing, the page has grown an external stylesheet or script
 * and now needs the versioned-URL treatment the other services got — see
 * octopus-health or octopus-author's build.js for the asset() helper. Left as a
 * test rather than a comment because a comment does not notice.
 */
test('the page still carries no external CSS or JS to go stale', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const external = [...html.matchAll(/(?:href|src)="([^"]*\.(?:css|js))"/g)].map(m => m[1]);
  assert.deepEqual(external, [],
    'this page now links an external asset. Cloudflare caches CSS and JS for ' +
    'four hours and overrides the origin, so it needs a ?v=<hash> URL or a ' +
    'shipped fix will be invisible for that long and look like a failed deploy');
});
