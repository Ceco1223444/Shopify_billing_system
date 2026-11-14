/**
 * Phase 4 acceptance: "No call to api.speedy.bg and no Google service anywhere in the code."
 * Scans the app's source (not docs, not tests) for those hosts.
 *
 * Phase 5 (P5-15) asks for plain Google Maps / Google search LINKS a person opens for an address
 * the app cannot place. Those two link forms are allowed in that one file, which must not fetch.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const SOURCE_DIRS = [
  'apps/web/src',
  'apps/web/index.html',
  'packages/core/src',
  'supabase/functions',
  'supabase/migrations',
  'scripts',
];
const FORBIDDEN = [
  /api\.speedy\.bg/i,
  /googleapis\.com/i,
  /maps\.google\./i,
  /google\.[a-z.]+\/maps/i,
  /gstatic\.com/i,
];

/** P5-15: links shown to a person (no API, no key, never fetched by the app). */
const ALLOWED_LINKS: Record<string, string[]> = {
  'packages/core/src/detect/call.ts': [
    'https://www.google.com/maps/search/?api=1&query=',
    'https://www.google.com/search?q=',
  ],
};

function files(path: string): string[] {
  const full = join(root, path);
  if (statSync(full).isFile()) return [full];
  return readdirSync(full).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist') return [];
    return files(join(path, name));
  });
}

describe('forbidden services', () => {
  it('no source file mentions api.speedy.bg or a Google Maps / Geocoding host', () => {
    const hits: string[] = [];
    for (const file of SOURCE_DIRS.flatMap(files)) {
      if (!/\.(ts|tsx|js|mjs|sql|html|json)$/.test(file) || /\.test\.tsx?$/.test(file)) continue;
      const name = relative(root, file).split('\\').join('/');
      let text = readFileSync(file, 'utf8');
      for (const link of ALLOWED_LINKS[name] ?? []) text = text.split(link).join('');
      for (const pattern of FORBIDDEN) {
        if (pattern.test(text)) hits.push(`${relative(root, file)}: ${pattern}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('the file with the Google links never fetches anything', () => {
    for (const name of Object.keys(ALLOWED_LINKS)) {
      expect(readFileSync(join(root, name), 'utf8')).not.toMatch(/\bfetch\s*\(|XMLHttpRequest/);
    }
  });
});
