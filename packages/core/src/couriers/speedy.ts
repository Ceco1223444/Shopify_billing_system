/**
 * Speedy in MANUAL mode: offices and lockers from Speedy's PUBLIC web pages (not an API).
 * Phase 13 replaces this with the Speedy location/office API.
 *
 *   List  https://services.speedy.bg/office_locator_widget_v2/offices_list.php?lang=bg&countryId=
 *         one <div class="divOffice" id="ID"> per office: name + [ID], "Адрес:" line with the
 *         postcode in [brackets] (not for every office), hours for (пон-пет), (съб), (нед).
 *   Map   https://services.speedy.bg/officesmap_v2/?lang=bg&id=<office ID>
 *         embeds every office's coordinates in its page script:
 *         `190: {oID: 190, officeName: '…', Y: 42.69, X: 27.25, officeType: 'APT', …}`
 *
 * Both parsers are tolerant (attribute order, spacing, entities, missing lines) and report
 * failure instead of guessing, so a changed page never deactivates the stored offices (P4-10).
 */
import type { CourierPoint, OpeningSpan, WorkingHours } from './points.ts';
import { cleanCoordinates } from './points.ts';

export const SPEEDY_LIST_URL =
  'https://services.speedy.bg/office_locator_widget_v2/offices_list.php?lang=bg&countryId=';
export const speedyMapUrl = (officeId: string): string =>
  `https://services.speedy.bg/officesmap_v2/?lang=bg&id=${encodeURIComponent(officeId)}`;

/** Fewer entries than this means the page is not the office list any more. */
export const SPEEDY_MIN_ENTRIES = 100;

export interface SpeedyListEntry {
  id: string;
  name: string;
  isLocker: boolean;
  /** гр. / с. / к.к. as written before the city */
  settlementType: string | null;
  city: string | null;
  postcode: string | null;
  addressText: string;
  hours: WorkingHours | null;
}

export type SpeedyListResult =
  | { ok: true; entries: SpeedyListEntry[]; problems: string[] }
  | { ok: false; reason: string; found: number };

export interface SpeedyMapPoint {
  lat: number;
  lng: number;
  /** OFFICE or APT (locker) */
  officeType: string | null;
}

export type SpeedyMapResult =
  { ok: true; points: Map<string, SpeedyMapPoint> } | { ok: false; reason: string; found: number };

// --- small HTML helpers ----------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n =
        code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1));
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** Text lines of an HTML fragment: <br> and block ends start a new line; tags removed. */
function htmlLines(fragment: string): string[] {
  return decodeEntities(
    fragment
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:div|p|li|tr)>/gi, '\n')
      .replace(/<[^>]*>/g, ''),
  )
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
}

// --- list page --------------------------------------------------------------------------------

const DAY_LABELS: Record<string, keyof WorkingHours> = {
  'пон-пет': 'weekdays',
  'mon-fri': 'weekdays',
  съб: 'saturday',
  sat: 'saturday',
  нед: 'sunday',
  sun: 'sunday',
};

function parseHoursValue(value: string): OpeningSpan | null {
  const m = /(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/.exec(value);
  if (!m) return null; // "Почивен ден" / "Closed"
  return { from: `${m[1]!.padStart(2, '0')}:${m[2]}`, to: `${m[3]!.padStart(2, '0')}:${m[4]}` };
}

const LOCKER = /\((?:АВТОМАТ|AUTOMAT|APT)\)/i;
const SETTLEMENT = /^(гр\.|с\.|к\.к\.|ж\.к\.|кв\.|gr\.|s\.)\s*/i;

/** "АЙТОС - КИРИЛ И МЕТОДИЙ (УЛ.)" → "АЙТОС"; "АСЕНОВГРАД (АВТОМАТ)" → "АСЕНОВГРАД". */
function cityFromName(name: string): string {
  return name
    .split(' - ')[0]!
    .replace(/\([^)]*\)/g, '')
    .trim();
}

/**
 * City and postcode from "гр. Айтос [8500] ул. Кирил и Методий No 17". Without a [postcode]
 * the city is the start of the address that matches the start of the office name
 * ("СОФИЯ - …" → "гр. София …").
 */
export function splitSpeedyAddress(
  address: string,
  officeName: string,
): Pick<SpeedyListEntry, 'settlementType' | 'city' | 'postcode'> {
  const prefix = SETTLEMENT.exec(address);
  const settlementType = prefix ? prefix[1]!.toLowerCase() : null;
  const rest = prefix ? address.slice(prefix[0].length) : address;

  const bracket = /^([^[\]]+?)\s*\[(\d{4})\]/.exec(rest);
  if (bracket) return { settlementType, city: bracket[1]!.trim(), postcode: bracket[2]! };

  const fromName = cityFromName(officeName);
  if (fromName && rest.toUpperCase().startsWith(fromName.toUpperCase())) {
    const next = rest.charAt(fromName.length);
    if (next === '' || /[\s,]/.test(next)) {
      return { settlementType, city: rest.slice(0, fromName.length).trim(), postcode: null };
    }
  }
  // Last resort: the words before the first street / quarter keyword.
  const m =
    /^(.+?)(?=\s+(?:ул\.|бул\.|жк|ж\.к\.|кв\.|пл\.|м-т|к-с|р-н|УЛ\.|БУЛ\.|No\b|\d)|,|$)/u.exec(
      rest,
    );
  return { settlementType, city: m?.[1]?.trim() || null, postcode: null };
}

export function parseSpeedyOfficeList(html: string): SpeedyListResult {
  const blocks = [
    ...html.matchAll(/<div\b([^>]*\bclass\s*=\s*["'][^"']*\bdivOffice\b[^"']*["'][^>]*)>/gi),
  ];
  if (blocks.length < SPEEDY_MIN_ENTRIES) {
    return { ok: false, reason: 'too_few_entries', found: blocks.length };
  }

  const entries: SpeedyListEntry[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < blocks.length; i++) {
    const start = blocks[i]!.index! + blocks[i]![0].length;
    const end = i + 1 < blocks.length ? blocks[i + 1]!.index! : html.length;
    const lines = htmlLines(html.slice(start, end));
    const idAttr = attr(blocks[i]![1]!, 'id');

    const head = lines[0] ?? '';
    const idMatch = /\[(\d+)\]\s*$/.exec(head);
    const id = idMatch?.[1] ?? (idAttr && /^\d+$/.test(idAttr) ? idAttr : null);
    const name = head.replace(/\s*\[\d+\]\s*$/, '').trim();
    const addressLine = lines.find((l) => /^(?:Адрес|Address)\s*:/i.test(l));
    if (!id || !name || !addressLine) {
      problems.push(`entry ${i + 1}: ${!id ? 'no id' : !name ? 'no name' : 'no address'}`);
      continue;
    }
    if (seen.has(id)) {
      problems.push(`entry ${i + 1}: duplicate id ${id}`);
      continue;
    }
    seen.add(id);

    const addressText = addressLine.replace(/^(?:Адрес|Address)\s*:\s*/i, '').trim();
    const hours: WorkingHours = {};
    for (const line of lines) {
      const h = /^\(([^)]+)\)\s*:?\s*(.*)$/.exec(line);
      const day = h ? DAY_LABELS[h[1]!.trim().toLowerCase()] : undefined;
      if (h && day) hours[day] = parseHoursValue(h[2]!);
    }
    entries.push({
      id,
      name,
      isLocker: LOCKER.test(name),
      addressText,
      hours: Object.keys(hours).length ? hours : null,
      ...splitSpeedyAddress(addressText, name),
    });
  }

  // A page where most entries cannot be read has changed format: report it, keep old data.
  if (entries.length < SPEEDY_MIN_ENTRIES || problems.length > blocks.length * 0.2) {
    return { ok: false, reason: 'unreadable_entries', found: entries.length };
  }
  return { ok: true, entries, problems };
}

// --- map page ---------------------------------------------------------------------------------

/** Coordinates of every office from the map page's script data. */
export function parseSpeedyMapData(html: string): SpeedyMapResult {
  const points = new Map<string, SpeedyMapPoint>();
  const objects = html.matchAll(/\{\s*oID\s*:\s*['"]?(\d+)['"]?\s*,([^{}]*)\}/g);
  let found = 0;
  for (const m of objects) {
    found++;
    const body = m[2]!;
    const num = (key: string) => {
      const v = new RegExp(`\\b${key}\\s*:\\s*['"]?(-?\\d+(?:\\.\\d+)?)`).exec(body);
      return v ? Number(v[1]) : NaN;
    };
    const coords = cleanCoordinates(num('Y'), num('X'));
    if (!coords) continue;
    const type = /\bofficeType\s*:\s*['"]([A-Z_]+)['"]/.exec(body)?.[1] ?? null;
    points.set(m[1]!, { ...coords, officeType: type });
  }
  if (points.size < SPEEDY_MIN_ENTRIES) {
    return { ok: false, reason: 'no_coordinates', found };
  }
  return { ok: true, points };
}

// --- both together ----------------------------------------------------------------------------

export interface MergedSpeedy {
  points: CourierPoint[];
  withoutCoordinates: number;
}

/** List entries + map coordinates → points. Points missing from the map get no coordinates. */
export function mergeSpeedy(
  entries: SpeedyListEntry[],
  map: Map<string, SpeedyMapPoint> | null,
): MergedSpeedy {
  let withoutCoordinates = 0;
  const points = entries.map((e): CourierPoint => {
    const at = map?.get(e.id) ?? null;
    if (!at) withoutCoordinates++;
    return {
      carrier: 'speedy',
      externalId: e.id,
      code: e.id,
      type: e.isLocker || at?.officeType === 'APT' ? 'locker' : 'office',
      nameBg: e.name,
      nameEn: null,
      city: e.city,
      postcode: e.postcode,
      addressText: e.addressText,
      lat: at?.lat ?? null,
      lng: at?.lng ?? null,
      coordConfidence: at ? 3 : null,
      coordSource: at ? 'speedy_map' : null,
      workingHours: e.hours,
      phone: null,
      raw: {
        settlement_type: e.settlementType,
        map_type: at?.officeType ?? null,
      },
    };
  });
  return { points, withoutCoordinates };
}
