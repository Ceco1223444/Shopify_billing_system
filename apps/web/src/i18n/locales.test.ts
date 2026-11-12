import { describe, expect, it } from 'vitest';
import bg from './locales/bg.json';
import en from './locales/en.json';

type Tree = { [key: string]: string | Tree };

/** Flattens {a: {b: 'x'}} to {'a.b': 'x'}; plural suffixes (_one/_other) stay part of the key. */
function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else for (const [k, v] of flatten(value, path)) out.set(k, v);
  }
  return out;
}

const placeholders = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();

describe('locale files', () => {
  const bgKeys = flatten(bg as Tree);
  const enKeys = flatten(en as Tree);

  it('have exactly the same keys in Bulgarian and English', () => {
    expect([...enKeys.keys()].sort()).toEqual([...bgKeys.keys()].sort());
  });

  it('have no empty strings', () => {
    for (const [key, value] of [...bgKeys, ...enKeys]) {
      expect(value.trim(), key).not.toBe('');
    }
  });

  it('use the same {{placeholders}} in both languages', () => {
    for (const [key, bgValue] of bgKeys) {
      expect(placeholders(enKeys.get(key) ?? ''), key).toEqual(placeholders(bgValue));
    }
  });
});
