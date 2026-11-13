/**
 * Phase 4 acceptance: "No call to api.speedy.bg and no Google service anywhere in the code."
 * Scans the app's source (not docs, not tests) for those hosts.
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
      if (!/\.(ts|tsx|js|mjs|sql|html|json)$/.test(file)) continue;
      const text = readFileSync(file, 'utf8');
      for (const pattern of FORBIDDEN) {
        if (pattern.test(text)) hits.push(`${relative(root, file)}: ${pattern}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
