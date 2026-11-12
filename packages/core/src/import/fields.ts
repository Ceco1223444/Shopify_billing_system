/**
 * Typed values read from Shopify export cells. Pure functions; the original text
 * always stays in orders.raw / order_lines.raw.
 */

/** "12.34" -> 1234 cents. Only plain decimals (the legacy `num` rule); anything else -> null. */
export function parseMoneyCents(value: string | null | undefined): number | null {
  const s = String(value ?? '').trim();
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const whole = Number(m[2]);
  const frac = (m[3] ?? '').padEnd(3, '0');
  // Round half away from zero on the third decimal, using integers only.
  let cents = whole * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cents += 1;
  const result = sign * cents;
  return Number.isSafeInteger(result) ? result || 0 : null;
}

/**
 * Shopify date "2026-11-02 09:15:00 +0200" (also "…T…", "+02:00", "Z", no seconds)
 * -> ISO "2026-11-02T09:15:00+02:00". Without a time zone, or invalid -> null.
 */
export function parseShopifyDate(value: string | null | undefined): string | null {
  const s = String(value ?? '').trim();
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})$/.exec(
    s,
  );
  if (!m) return null;
  const zone = m[4] === 'Z' ? 'Z' : m[4]!.replace(/^([+-]\d{2}):?(\d{2})$/, '$1:$2');
  const iso = `${m[1]}T${m[2]}${m[3] ?? ':00'}${zone}`;
  return Number.isNaN(new Date(iso).getTime()) ? null : iso;
}

/** "true" / "false" (any case) -> boolean, anything else -> null. */
export function parseBool(value: string | null | undefined): boolean | null {
  const s = String(value ?? '')
    .trim()
    .toLowerCase();
  if (s === 'true') return true;
  if (s === 'false') return false;
  return null;
}

/** A whole number >= 0, else null (the legacy check flags the line). */
export function parseQuantity(value: string | null | undefined): number | null {
  const s = String(value ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n <= 2_000_000_000 ? n : null;
}

export interface NoteAttribute {
  name: string;
  value: string;
}

/** Shopify writes cart attributes one per line as "name: value". */
export function parseNoteAttributes(value: string | null | undefined): NoteAttribute[] {
  return String(value ?? '')
    .split(/\r\n?|\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf(':');
      return i > 0
        ? { name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() }
        : { name: '', value: line };
    });
}

/** Trimmed, lower case; '' -> null. Used to match customers by email. */
export function normalizeEmail(value: string | null | undefined): string | null {
  const s = String(value ?? '')
    .trim()
    .toLowerCase();
  return s || null;
}

/** '' -> null after trimming. */
export function textOrNull(value: string | null | undefined): string | null {
  const s = String(value ?? '').trim();
  return s ? s : null;
}
