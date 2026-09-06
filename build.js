'use strict';
/**
 * build.js — one string identifying the code this container is running.
 *
 * Portainer polls and deploys on its own; nothing reports back. Without an
 * endpoint that moves when the code moves, a deploy that never landed and one
 * that landed without helping look identical from outside — octopus-science
 * lost three rounds of bug reports to exactly that.
 *
 * ── Derived, not a pasted constant ───────────────────────────────────────────
 * octopus-ee and octopus-science keep `const BUILD = '…'` because their browser
 * code carries the same literal and the comparison needs one. This service does
 * not, and needs the opposite property: a stamp you must remember to bump
 * reports "nothing changed" for a deploy that did, the first time anyone
 * forgets. That is a check failing quietly toward "everything is fine". So it
 * is computed at startup and cannot drift.
 *
 * ── What it covers ───────────────────────────────────────────────────────────
 * index.js plus public/index.html, which is the entire client — this page carries its CSS and JS inline, so there are no separate asset files. That is also why there is nothing here to cache-bust: the four-hour Cloudflare rule that catches CSS and JS does not apply to a document, and there is no asset URL to version.
 *
 * The files are found by WALKING the directory, not from a list here. A written
 * list stops covering the file just added, and that failure is silent in the
 * worst way: the guard goes quiet exactly for the newest code.
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const ROOT = __dirname;

// Dependencies are pinned by the lockfile and reinstalled per build; live data
// changes constantly, and hashing it would move the stamp for reasons that are
// not deploys.
const SKIP_DIRS  = new Set(['node_modules', '.git', 'data', 'test']);
const KEEP_EXT   = new Set(['.js', '.jsx', '.ts', '.tsx', '.json', '.ejs', '.css', '.html', '.mjs']);
const SKIP_FILES = new Set(['package-lock.json']);

function sourceFiles(dir = ROOT, prefix = '') {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  // Sorted explicitly: readdir order is not promised, and a hash depending on
  // it would differ between this laptop and the image.
  for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) {
        out.push(...sourceFiles(path.join(dir, e.name), rel));
      }
    } else if (KEEP_EXT.has(path.extname(e.name)) && !SKIP_FILES.has(e.name)) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * A stamp must never be the reason this service fails to boot, so every step is
 * guarded and the fallback is 'unknown' — deliberately not hash-shaped, so it
 * cannot be misread as a value. `unknown` is never `current`.
 */
function computeBuild() {
  try {
    const files = sourceFiles();
    if (!files.length) return 'unknown';
    const h = crypto.createHash('sha256');
    for (const f of files) {
      let src;
      try { src = fs.readFileSync(path.join(ROOT, f)); } catch { continue; }
      h.update(f);
      h.update(src);
    }
    return h.digest('hex').slice(0, 12);
  } catch {
    return 'unknown';
  }
}

const BUILD      = computeBuild();
const STARTED_AT = new Date().toISOString();

module.exports = { BUILD, STARTED_AT, sourceFiles };
