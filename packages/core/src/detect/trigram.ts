/**
 * Trigram similarity like PostgreSQL's pg_trgm `similarity()` (P5-07): every word is padded with
 * two spaces in front and one behind, cut into 3-letter pieces, and the score is
 * shared pieces / all distinct pieces (0 … 1). Done here, on the Latin copies, so it is the same
 * for Cyrillic and Latin text and can be tested without a database.
 */

export function trigrams(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue;
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  }
  return out;
}

export function similarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}
