/**
 * Delivery point detection (Phase 5): carrier, delivery type, the exact office / locker, and how
 * certain that is, with the reasons in Bulgarian and English. Rules A–F of P5-10 … P5-17.
 *
 * Pure apart from the injected lookups (offices of a town, offices by code, geocoder, nearest
 * offices), so every rule is tested with in-memory data. The Edge Function passes the real ones.
 *
 * Owner's changes of 14 Nov 2026:
 *  - settings.point_types (default: offices only). Lockers and mobile offices the customer names
 *    are still recognised, so the reason can say why the app asks, but the app never decides,
 *    suggests or offers a point of a type the shop does not ship to.
 *  - Rule E "middle way": nothing mentioned, no office within range, and a complete street
 *    address found on the map (not only the town) → certain, delivery to the address.
 */
import type { SupportedCarrier } from '../domain.ts';
import { isBulgaria } from '../geo/address.ts';
import { mergeDictionary, type DetectionDictionary } from './dictionary.ts';
import {
  DEFAULT_POINT_TYPES,
  pickMatch,
  scorePoints,
  type PointCandidate,
  type ScoredPoint,
} from './match.ts';
import type { PointType } from '../couriers/points.ts';
import { analyze, type DetectionInput, type PointWord, type Signals } from './signals.ts';

export type Certainty = 'certain' | 'uncertain' | 'error';
export type DeliveryType = 'office' | 'locker' | 'address';
export type DetectionRule = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

export interface Reason {
  code: string;
  bg: string;
  en: string;
}

export interface GeoPoint {
  lat: number;
  lng: number;
  precision: 'street' | 'block' | 'quarter' | 'city';
}

export interface DetectionSettings {
  /** settings.office_range_km (rule E). */
  officeRangeKm: number;
  /** settings.home_carrier_tie_break. */
  homeCarrierTieBreak: SupportedCarrier;
  /** settings.point_types: the kinds of points the shop ships to. Never empty. */
  pointTypes: PointType[];
  dictionary: DetectionDictionary;
}

export const DEFAULT_DETECTION_SETTINGS: DetectionSettings = {
  officeRangeKm: 1,
  homeCarrierTieBreak: 'econt',
  pointTypes: [...DEFAULT_POINT_TYPES],
  dictionary: mergeDictionary(null),
};

export interface DetectionDeps {
  /** Active offices and lockers of both couriers in the town (name or postcode). */
  pointsInCity(city: string | null, zip: string | null): Promise<PointCandidate[]>;
  /** Active points of a courier whose ID or code is one of `codes`. */
  pointsByCode(carrier: SupportedCarrier, codes: string[]): Promise<PointCandidate[]>;
  /** null = not found; 'busy' = try again later (the geocoder's rate limit). */
  geocode(input: DetectionInput): Promise<GeoPoint | null | 'busy'>;
  /** Active points ordered by distance, with distance_km. */
  nearestPoints(
    at: { lat: number; lng: number },
    options: {
      carriers?: SupportedCarrier[];
      types?: PointCandidate['type'][];
      maxKm: number;
      limit: number;
    },
  ): Promise<PointCandidate[]>;
}

export interface DeliveryDecision {
  rule: DetectionRule;
  certainty: Certainty;
  carrier: SupportedCarrier | null;
  deliveryType: DeliveryType | null;
  /** The resolved office / locker (rule A only). */
  point: PointCandidate | null;
  /** What to propose on the call (rules C, D, E). */
  suggestion: PointCandidate | null;
  /** Other close candidates (best matches, or points within 200 m of the suggestion). */
  alternatives: PointCandidate[];
  reasons: Reason[];
  hints: Reason[];
  geo: GeoPoint | null;
  /** The courier / office words came with a typo. */
  typo: boolean;
}

export type DetectionOutcome = { kind: 'decided'; decision: DeliveryDecision } | { kind: 'busy' };

/** Two suggestions closer than this to each other are a tie (P5-16). */
export const TIE_DISTANCE_KM = 0.2;
/** A name match weaker than this is not worth suggesting. */
const BEST_MATCH_MIN_SCORE = 0.3;
/** How far rule C looks for the named courier's nearest point. */
const RULE_C_SEARCH_KM = 30;

const CARRIER = {
  econt: { bg: 'Еконт', en: 'Econt' },
  speedy: { bg: 'Спиди', en: 'Speedy' },
} as const;

export function formatKm(km: number, lang: 'bg' | 'en'): string {
  const rounded = km < 10 ? Math.round(km * 10) / 10 : Math.round(km);
  const text = lang === 'bg' ? String(rounded).replace('.', ',') : String(rounded);
  return `${text} ${lang === 'bg' ? 'км' : 'km'}`;
}

export function pointLabel(point: PointCandidate, lang: 'bg' | 'en'): string {
  return `${CARRIER[point.carrier][lang]} ${point.name_bg}`;
}

const reason = (code: string, bg: string, en: string): Reason => ({ code, bg, en });

const kindWord = (words: PointWord[]) =>
  words.length === 1 && words[0] === 'locker'
    ? { bg: 'автоматът', en: 'locker' }
    : { bg: 'офисът', en: 'office' };

const typesFor = (words: PointWord[]): PointCandidate['type'][] =>
  words.length === 1
    ? words[0] === 'locker'
      ? ['locker']
      : ['office', 'mobile']
    : ['office', 'locker', 'mobile'];

const deliveryTypeOf = (p: PointCandidate): DeliveryType =>
  p.type === 'locker' ? 'locker' : 'office';

const KIND: Record<PointType, { bg: string; en: string; bgMany: string; enMany: string }> = {
  office: { bg: 'офис', en: 'an office', bgMany: 'офиси', enMany: 'offices' },
  locker: { bg: 'автомат', en: 'a locker', bgMany: 'автомати', enMany: 'lockers' },
  mobile: {
    bg: 'подвижен офис',
    en: 'a mobile office',
    bgMany: 'подвижни офиси',
    enMany: 'mobile offices',
  },
};

/** "офис" or "офис или автомат": the points the shop ships to, for the reasons. */
export function pointsWord(types: PointType[], lang: 'bg' | 'en'): string {
  return types.includes('locker')
    ? lang === 'bg'
      ? 'офис или автомат'
      : 'office or locker'
    : lang === 'bg'
      ? 'офис'
      : 'office';
}

/**
 * P5-16: nearest first; points of the other courier within 200 m of it are offered too. On an
 * exact tie (same 10 m) the cheaper one would win (Phase 7 prices), then the tie-break courier.
 */
export function orderSuggestions(
  points: PointCandidate[],
  tieBreak: SupportedCarrier,
): PointCandidate[] {
  const sorted = [...points].sort((a, b) => {
    const da = Math.round((a.distance_km ?? 0) * 100);
    const db = Math.round((b.distance_km ?? 0) * 100);
    if (da !== db) return da - db;
    return (a.carrier === tieBreak ? 0 : 1) - (b.carrier === tieBreak ? 0 : 1);
  });
  const first = sorted[0];
  if (!first) return [];
  return [
    first,
    ...sorted
      .slice(1)
      .filter((p) => (p.distance_km ?? 0) - (first.distance_km ?? 0) < TIE_DISTANCE_KM),
  ];
}

function geoHints(geo: GeoPoint | null): Reason[] {
  return geo?.precision === 'city'
    ? [
        reason(
          'geocode_city_only',
          'Адресът е намерен само до града: разстоянието е приблизително.',
          'The address was found only to the town: the distance is approximate.',
        ),
      ]
    : [];
}

export async function detectDelivery(
  input: DetectionInput,
  deps: DetectionDeps,
  settings: DetectionSettings = DEFAULT_DETECTION_SETTINGS,
): Promise<DetectionOutcome> {
  const signals = analyze(input, settings.dictionary);
  const base = {
    point: null,
    suggestion: null,
    alternatives: [] as PointCandidate[],
    hints: [] as Reason[],
    geo: null as GeoPoint | null,
    typo: signals.typo,
  };
  /** Set when the named kind (office / locker) differs from the best match's kind. */
  let kindMismatch: PointCandidate | null = null;
  /** The point the customer named, of a type the shop does not ship to (settings.point_types). */
  const named = { notUsed: null as PointCandidate | null };
  const allowed = (p: PointCandidate) => settings.pointTypes.includes(p.type);
  /** What to look for when suggesting: the named kind if the shop ships to it, else its types. */
  const usableTypes = (words: PointWord[]): PointType[] => {
    const kinds = typesFor(words).filter((t) => settings.pointTypes.includes(t));
    return kinds.length ? kinds : settings.pointTypes;
  };
  const lockerNotUsed = (words: PointWord[]) =>
    words.includes('locker') && !settings.pointTypes.includes('locker');
  const notUsedReason = (p: PointCandidate) =>
    reason(
      'point_type_not_used',
      `Клиентът иска ${KIND[p.type].bg} (${pointLabel(p, 'bg')}), но не изпращаме до ${KIND[p.type].bgMany}.`,
      `The customer asks for ${KIND[p.type].en} (${pointLabel(p, 'en')}), but we do not ship to ${KIND[p.type].enMany}.`,
    );
  const decided = (d: Omit<DeliveryDecision, 'typo'> & { typo?: boolean }): DetectionOutcome => ({
    kind: 'decided',
    decision: { typo: signals.typo, ...d },
  });
  const error = (r: Reason): DetectionOutcome =>
    decided({
      ...base,
      rule: 'F',
      certainty: 'error',
      carrier: null,
      deliveryType: null,
      reasons: [r],
    });

  // F: another courier, no town, abroad (P5-15).
  if (signals.otherCourier) {
    return error(
      reason(
        'other_courier',
        `Посочен е друг куриер (${signals.otherCourier}). Изпращаме само с Еконт и Спиди.`,
        `Another courier is mentioned (${signals.otherCourier}). We ship only with Econt and Speedy.`,
      ),
    );
  }
  const city = input.city?.trim() || null;
  const zip = input.zip?.trim() || null;
  if (!city && !zip) {
    return error(reason('no_city', 'Няма град и пощенски код.', 'There is no town or postcode.'));
  }
  if (!isBulgaria(input.country)) {
    return error(
      reason('not_bulgaria', 'Адресът не е в България.', 'The address is not in Bulgaria.'),
    );
  }

  let geoCache: GeoPoint | null | 'busy' | undefined;
  const geocode = async () => {
    if (geoCache === undefined) geoCache = await deps.geocode(input);
    return geoCache;
  };

  // Two couriers named: conflict (D), suggest the nearest point of either.
  if (signals.carriers.length === 2) {
    return conflict(
      [
        reason(
          'both_carriers',
          'Посочени са и Еконт, и Спиди.',
          'Both Econt and Speedy are mentioned.',
        ),
      ],
      null,
    );
  }

  const carrier = signals.carriers[0] ?? null;
  const townPoints = await deps.pointsInCity(city, zip);

  if (carrier) {
    const conflicts: Reason[] = [];
    if (signals.home) {
      conflicts.push(
        reason(
          'point_and_home',
          `Посочен е ${CARRIER[carrier].bg}, но и доставка до адрес.`,
          `${CARRIER[carrier].en} is mentioned, but so is delivery to the address.`,
        ),
      );
    }
    if (signals.flatDetails) {
      conflicts.push(
        reason(
          'point_and_flat',
          `Посочен е ${CARRIER[carrier].bg}, но адресът има вход, етаж или апартамент като домашен адрес.`,
          `${CARRIER[carrier].en} is mentioned, but the address has an entrance, floor or flat like a home address.`,
        ),
      );
    }

    const match = await matchPoint(carrier, townPoints);
    if (match.kind === 'match' && !conflicts.length) {
      const how =
        match.by === 'code'
          ? { bg: 'по номер', en: 'by its number' }
          : {
              bg: `по име или адрес (${Math.round(match.score * 100)}%)`,
              en: `by name or address (${Math.round(match.score * 100)}%)`,
            };
      return decided({
        ...base,
        rule: 'A',
        certainty: 'certain',
        carrier,
        deliveryType: deliveryTypeOf(match.point),
        point: match.point,
        reasons: [
          reason(
            'point_matched',
            `Посочен е ${pointLabel(match.point, 'bg')}: намерен ${how.bg}.`,
            `${pointLabel(match.point, 'en')} is named: found ${how.en}.`,
          ),
        ],
      });
    }

    if (!conflicts.length && signals.streetAddress && signals.pointWords.length) {
      conflicts.push(
        reason(
          'point_and_street',
          `Посочен е офис на ${CARRIER[carrier].bg}, но и пълен уличен адрес.`,
          `An ${CARRIER[carrier].en} office is mentioned, but so is a full street address.`,
        ),
      );
    }
    if (conflicts.length)
      return conflict(
        conflicts,
        carrier,
        match.kind === 'match' ? [match.point] : match.best.map((s) => s.point),
      );

    // C: the courier is clear, the office is not (or it is a point we do not ship to).
    const kind = kindWord(signals.pointWords);
    const notUsed = named.notUsed;
    const reasons = notUsed
      ? [notUsedReason(notUsed)]
      : [
          reason(
            'point_unclear',
            `Посочен е ${CARRIER[carrier].bg}, но ${kind.bg} не е ясен.`,
            `${CARRIER[carrier].en} is mentioned, but the ${kind.en} is not clear.`,
          ),
        ];
    if (!notUsed && lockerNotUsed(signals.pointWords)) {
      reasons.push(
        reason(
          'locker_not_used',
          'Не изпращаме до автомати: предложен е офис.',
          'We do not ship to lockers: an office is suggested.',
        ),
      );
    }
    if (kindMismatch) {
      const m: PointCandidate = kindMismatch;
      const named =
        signals.pointWords[0] === 'locker'
          ? { bg: 'автомат', en: 'a locker' }
          : { bg: 'офис', en: 'an office' };
      const found =
        m.type === 'locker' ? { bg: 'автомат', en: 'a locker' } : { bg: 'офис', en: 'an office' };
      reasons.push(
        reason(
          'point_kind_differs',
          `Клиентът пише ${named.bg}, а по име подхожда ${found.bg}: ${pointLabel(m, 'bg')}.`,
          `The customer writes ${named.en}, but the name fits ${found.en}: ${pointLabel(m, 'en')}.`,
        ),
      );
    } else if (match.kind === 'ambiguous') {
      reasons.push(
        reason(
          'point_ambiguous',
          `Подхождат няколко: ${match.best
            .slice(0, 3)
            .map((s) => s.point.name_bg)
            .join('; ')}.`,
          `Several fit: ${match.best
            .slice(0, 3)
            .map((s) => s.point.name_bg)
            .join('; ')}.`,
        ),
      );
    }
    const suggestion =
      (notUsed && (await nearNamed(notUsed, carrier))) ||
      (await suggestFor(carrier, signals.pointWords, match.kind === 'match' ? [] : match.best));
    if (suggestion === 'busy') return { kind: 'busy' };
    return decided({
      ...base,
      rule: 'C',
      certainty: 'uncertain',
      carrier,
      deliveryType: suggestion.point
        ? deliveryTypeOf(suggestion.point)
        : signals.pointWords.length === 1 &&
            signals.pointWords[0] === 'locker' &&
            settings.pointTypes.includes('locker')
          ? 'locker'
          : 'office',
      suggestion: suggestion.point,
      alternatives: suggestion.alternatives,
      reasons: [...reasons, ...suggestion.reasons],
      hints: geoHints(suggestion.geo),
      geo: suggestion.geo,
    });
  }

  // No courier named.
  if (signals.home && signals.pointWords.length) {
    return conflict(
      [
        reason(
          'office_and_home',
          'Посочени са и офис или автомат, и доставка до адрес.',
          'Both an office or locker and delivery to the address are mentioned.',
        ),
      ],
      null,
    );
  }
  if (signals.home) {
    // B: an explicit home address with a street / ж.к. and a number / block.
    if (signals.streetAddress) {
      return decided({
        ...base,
        rule: 'B',
        certainty: 'certain',
        carrier: settings.homeCarrierTieBreak,
        deliveryType: 'address',
        reasons: [
          reason(
            'home_requested',
            'Клиентът иска доставка до адрес, и адресът е пълен.',
            'The customer asks for delivery to the address, and the address is complete.',
          ),
          reason(
            'home_carrier_later',
            `Куриерът ще се избере по цена; засега: ${CARRIER[settings.homeCarrierTieBreak].bg}.`,
            `The courier will be chosen by price; for now: ${CARRIER[settings.homeCarrierTieBreak].en}.`,
          ),
        ],
      });
    }
    return decided({
      ...base,
      rule: 'B',
      certainty: 'uncertain',
      carrier: settings.homeCarrierTieBreak,
      deliveryType: 'address',
      reasons: [
        reason(
          'home_incomplete',
          'Клиентът иска доставка до адрес, но адресът е непълен (липсва улица или номер).',
          'The customer asks for delivery to the address, but the address is incomplete (no street or number).',
        ),
      ],
    });
  }

  // An office or locker named without a courier: match both couriers' points of the town.
  if (signals.pointWords.length) {
    const scored = scorePoints(signals.remaining, townPoints, city, settings.dictionary);
    const match = pickMatch(scored, signals.pointWords);
    if (match.kind === 'match' && !allowed(match.point)) {
      const near = await nearNamed(match.point, null);
      if (near) {
        return decided({
          ...base,
          rule: 'C',
          certainty: 'uncertain',
          carrier: near.point.carrier,
          deliveryType: deliveryTypeOf(near.point),
          suggestion: near.point,
          alternatives: near.alternatives,
          reasons: [notUsedReason(match.point), ...near.reasons],
        });
      }
    } else if (match.kind === 'match') {
      return decided({
        ...base,
        rule: 'C',
        certainty: 'uncertain',
        carrier: match.point.carrier,
        deliveryType: deliveryTypeOf(match.point),
        suggestion: match.point,
        reasons: [
          reason(
            'point_without_carrier',
            `Посочен е офис или автомат без куриер; подхожда ${pointLabel(match.point, 'bg')}.`,
            `An office or locker is named without a courier; ${pointLabel(match.point, 'en')} fits.`,
          ),
        ],
      });
    }
  }

  // E: nothing (clear) mentioned → the nearest office or locker within range.
  const geo = await geocode();
  if (geo === 'busy') return { kind: 'busy' };
  if (!geo) {
    return error(
      reason(
        'geocode_failed',
        'Адресът не е намерен на картата.',
        'The address could not be found on the map.',
      ),
    );
  }
  const hints = [...geoHints(geo)];
  if (signals.streetHints) {
    hints.push(
      reason(
        'looks_like_home',
        'Адресът изглежда като домашен.',
        'The address looks like a home address.',
      ),
    );
  }
  const near = orderSuggestions(
    await deps.nearestPoints(geo, {
      types: usableTypes(signals.pointWords),
      maxKm: settings.officeRangeKm,
      limit: 5,
    }),
    settings.homeCarrierTieBreak,
  );
  const first = near[0];
  const range = formatKm(settings.officeRangeKm, 'bg');
  const rangeEn = formatKm(settings.officeRangeKm, 'en');
  const word = pointsWord(settings.pointTypes, 'bg');
  const wordEn = pointsWord(settings.pointTypes, 'en');
  if (!first) {
    // Owner's "middle way" (14 Nov 2026): nothing asked for, no office near, and a complete
    // street address that the map found (not only the town) → send it to the address.
    if (!signals.pointWords.length && signals.streetAddress && geo.precision !== 'city') {
      return decided({
        ...base,
        rule: 'E',
        certainty: 'certain',
        carrier: settings.homeCarrierTieBreak,
        deliveryType: 'address',
        geo,
        hints,
        reasons: [
          reason(
            'no_point_in_range_home',
            `Няма ${word} до ${range}, адресът е пълен — изпращаме до адреса.`,
            `No ${wordEn} within ${rangeEn}, and the address is complete — it goes to the address.`,
          ),
          reason(
            'home_carrier_later',
            `Куриерът ще се избере по цена; засега: ${CARRIER[settings.homeCarrierTieBreak].bg}.`,
            `The courier will be chosen by price; for now: ${CARRIER[settings.homeCarrierTieBreak].en}.`,
          ),
        ],
      });
    }
    const why: Reason[] = [];
    if (signals.pointWords.length) {
      why.push(
        reason(
          'point_named_none_near',
          `Клиентът пише ${pointsWord(['office', 'locker'], 'bg')}, но такъв не е намерен.`,
          `The customer writes ${pointsWord(['office', 'locker'], 'en')}, but none was found.`,
        ),
      );
    } else if (!signals.streetAddress) {
      why.push(
        reason(
          'address_incomplete',
          'Адресът е непълен (липсва улица или номер).',
          'The address is incomplete (no street or number).',
        ),
      );
    }
    return decided({
      ...base,
      rule: 'E',
      certainty: 'uncertain',
      carrier: settings.homeCarrierTieBreak,
      deliveryType: 'address',
      geo,
      hints,
      reasons: [
        reason(
          'no_point_in_range',
          `Няма ${word} до ${range} — предложен е личен адрес.`,
          `No ${wordEn} within ${rangeEn} — delivery to the address is suggested.`,
        ),
        ...why,
      ],
    });
  }
  return decided({
    ...base,
    rule: 'E',
    certainty: 'uncertain',
    carrier: first.carrier,
    deliveryType: deliveryTypeOf(first),
    suggestion: first,
    alternatives: near.slice(1),
    geo,
    hints,
    reasons: [
      reason(
        'nearest_point',
        `Не е посочен офис. Най-близо: ${pointLabel(first, 'bg')}, ${formatKm(first.distance_km ?? 0, 'bg')}.`,
        `No office is named. Nearest: ${pointLabel(first, 'en')}, ${formatKm(first.distance_km ?? 0, 'en')}.`,
      ),
    ],
  });

  // ---------------------------------------------------------------------------------------

  async function matchPoint(
    c: SupportedCarrier,
    town: PointCandidate[],
  ): Promise<
    | { kind: 'match'; point: PointCandidate; score: number; by: 'name' | 'code' }
    | { kind: 'ambiguous' | 'none'; best: ScoredPoint[] }
  > {
    if (signals.codes.length) {
      // An ID or code counts only for a point in the order's town ("автомат 123" in Sofia must
      // not pick Speedy office 123 in Sliven).
      const inTown = new Set(town.map((p) => p.id));
      const byCode = (await deps.pointsByCode(c, signals.codes)).filter(
        (p) => p.carrier === c && inTown.has(p.id),
      );
      if (byCode.length === 1)
        return usable(kindChecked({ kind: 'match', point: byCode[0]!, score: 1, by: 'code' }));
    }
    const scored = scorePoints(
      signals.remaining,
      town.filter((p) => p.carrier === c),
      city,
      settings.dictionary,
    );
    const picked = pickMatch(scored, signals.pointWords);
    return picked.kind === 'match' ? usable(kindChecked(picked, scored)) : picked;
  }

  /** A clear match of a type the shop does not ship to is remembered and not decided on. */
  function usable<
    M extends
      | { kind: 'match'; point: PointCandidate; score: number; by: 'name' | 'code' }
      | { kind: 'ambiguous'; best: ScoredPoint[] },
  >(m: M): M | { kind: 'none'; best: ScoredPoint[] } {
    if (m.kind !== 'match' || allowed(m.point)) return m;
    named.notUsed = m.point;
    return { kind: 'none', best: [] };
  }

  /** The nearest points the shop ships to around a point the customer named (same courier). */
  async function nearNamed(
    p: PointCandidate,
    c: SupportedCarrier | null,
  ): Promise<{
    point: PointCandidate;
    alternatives: PointCandidate[];
    reasons: Reason[];
    geo: GeoPoint | null;
  } | null> {
    if (p.lat == null || p.lng == null) return null;
    const near = orderSuggestions(
      await deps.nearestPoints(
        { lat: p.lat, lng: p.lng },
        {
          carriers: c ? [c] : undefined,
          types: settings.pointTypes,
          maxKm: RULE_C_SEARCH_KM,
          limit: 5,
        },
      ),
      settings.homeCarrierTieBreak,
    );
    const first = near[0];
    if (!first) return null;
    return {
      point: first,
      alternatives: near.slice(1),
      geo: null,
      reasons: [
        reason(
          'suggest_near_named',
          `Предложен е най-близкият ${KIND[first.type].bg} до него: ${pointLabel(first, 'bg')}, ${formatKm(first.distance_km ?? 0, 'bg')}.`,
          `Suggested: the nearest ${first.type === 'office' ? 'office' : KIND[first.type].en} to it, ${pointLabel(first, 'en')}, ${formatKm(first.distance_km ?? 0, 'en')}.`,
        ),
      ],
    };
  }

  /**
   * The customer named one kind ("автомат") and the match is the other kind (an office called
   * "Младост 4"): not certain. The type is never changed to fit the word (P5-09); a person asks.
   */
  function kindChecked(
    match: { kind: 'match'; point: PointCandidate; score: number; by: 'name' | 'code' },
    scored: ScoredPoint[] = [{ point: match.point, score: match.score }],
  ):
    | { kind: 'match'; point: PointCandidate; score: number; by: 'name' | 'code' }
    | { kind: 'ambiguous'; best: ScoredPoint[] } {
    if (signals.pointWords.length !== 1) return match;
    const wantsLocker = signals.pointWords[0] === 'locker';
    const isLocker = match.point.type === 'locker';
    if (wantsLocker === isLocker) return match;
    kindMismatch = match.point;
    return { kind: 'ambiguous', best: scored.slice(0, 5) };
  }

  /** C / D suggestion: the courier's nearest point to the address, else the best name matches. */
  async function suggestFor(
    c: SupportedCarrier | null,
    words: PointWord[],
    best: ScoredPoint[],
  ): Promise<
    | {
        point: PointCandidate | null;
        alternatives: PointCandidate[];
        reasons: Reason[];
        geo: GeoPoint | null;
      }
    | 'busy'
  > {
    const geo = await geocode();
    if (geo === 'busy') return 'busy';
    if (geo) {
      const near = orderSuggestions(
        await deps.nearestPoints(geo, {
          carriers: c ? [c] : undefined,
          types: usableTypes(words),
          maxKm: c ? RULE_C_SEARCH_KM : settings.officeRangeKm,
          limit: 5,
        }),
        settings.homeCarrierTieBreak,
      );
      const first = near[0];
      if (first) {
        return {
          point: first,
          alternatives: near.slice(1),
          geo,
          reasons: [
            reason(
              'suggest_nearest',
              `Предложен е най-близкият до адреса: ${pointLabel(first, 'bg')}, ${formatKm(first.distance_km ?? 0, 'bg')}.`,
              `Suggested: the nearest to the address, ${pointLabel(first, 'en')}, ${formatKm(first.distance_km ?? 0, 'en')}.`,
            ),
          ],
        };
      }
    }
    const top = best
      .filter((s) => s.score >= BEST_MATCH_MIN_SCORE && usableTypes(words).includes(s.point.type))
      .slice(0, 3)
      .map((s) => s.point);
    if (top[0]) {
      return {
        point: top[0],
        alternatives: top.slice(1),
        geo: geo ?? null,
        reasons: [
          reason(
            'suggest_best_match',
            `Предложен е най-подходящият по име: ${pointLabel(top[0], 'bg')}.`,
            `Suggested: the best match by name, ${pointLabel(top[0], 'en')}.`,
          ),
        ],
      };
    }
    return { point: null, alternatives: [], geo: geo ?? null, reasons: [] };
  }

  async function conflict(
    reasons: Reason[],
    c: SupportedCarrier | null,
    candidates: PointCandidate[] = [],
  ): Promise<DetectionOutcome> {
    const suggestion = await suggestFor(
      c,
      signals.pointWords,
      candidates.map((point) => ({ point, score: 1 })),
    );
    if (suggestion === 'busy') return { kind: 'busy' };
    return decided({
      ...base,
      rule: 'D',
      certainty: 'uncertain',
      carrier: suggestion.point?.carrier ?? c,
      deliveryType: suggestion.point ? deliveryTypeOf(suggestion.point) : null,
      suggestion: suggestion.point,
      alternatives: suggestion.alternatives,
      reasons: [...reasons, ...suggestion.reasons],
      hints: geoHints(suggestion.geo),
      geo: suggestion.geo,
    });
  }
}

export type { Signals };
