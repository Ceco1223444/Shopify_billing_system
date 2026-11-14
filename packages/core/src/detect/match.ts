/**
 * Office matching (P5-07 … P5-09): the customer's remaining words against the distinctive part
 * of each active office's name and address (town, courier and office words removed), with
 * trigram similarity. A match is accepted only with score ≥ 0.75 AND 0.10 above the next one.
 */
import type { SupportedCarrier } from '../domain.ts';
import type { DetectionDictionary } from './dictionary.ts';
import { findTerms, textForms } from './normalize.ts';
import { cityWords, distinctiveWords, type PointWord } from './signals.ts';
import { similarity } from './trigram.ts';

export const MATCH_MIN_SCORE = 0.75;
export const MATCH_MIN_MARGIN = 0.1;

/** An active office / locker as the detection sees it (from points_in_city / nearest_points). */
export interface PointCandidate {
  id: string;
  carrier: SupportedCarrier;
  type: 'office' | 'locker' | 'mobile';
  name_bg: string;
  city: string | null;
  postcode: string | null;
  address_text: string | null;
  external_id: string;
  code?: string | null;
  lat?: number | null;
  lng?: number | null;
  /** Set by nearest_points. */
  distance_km?: number | null;
}

export interface ScoredPoint {
  point: PointCandidate;
  score: number;
}

/** "Пловдив 24/7 Еконтомат - Тракия" → "trakia"; "ПЛОВДИВ - ТРАКИЯ (ЖК), БЛ.100" → "trakia 100". */
export function pointCore(
  text: string | null,
  town: Set<string>,
  dictionary: DetectionDictionary,
): string {
  const forms = textForms((text ?? '').replace(/24\s*\/\s*7/g, ' '));
  const consumed = new Set<number>();
  const words = [
    ...dictionary.econt,
    ...dictionary.speedy,
    ...dictionary.office,
    ...dictionary.locker,
  ];
  for (const h of findTerms(forms, words)) {
    if (h.fuzzy) continue;
    for (let i = h.start; i < h.end; i++) consumed.add(i);
  }
  return distinctiveWords(forms, consumed, town);
}

export function scorePoints(
  remaining: string,
  points: PointCandidate[],
  city: string | null | undefined,
  dictionary: DetectionDictionary,
): ScoredPoint[] {
  if (!remaining.trim()) return [];
  return points
    .map((point) => {
      const town = cityWords(city);
      for (const w of cityWords(point.city, point.postcode)) town.add(w);
      const name = pointCore(point.name_bg, town, dictionary);
      const address = pointCore(point.address_text, town, dictionary);
      return {
        point,
        score: Math.max(similarity(remaining, name), address ? similarity(remaining, address) : 0),
      };
    })
    .sort((a, b) => b.score - a.score || a.point.name_bg.localeCompare(b.point.name_bg));
}

export type MatchResult =
  | { kind: 'match'; point: PointCandidate; score: number; by: 'name' | 'code' }
  | { kind: 'ambiguous'; best: ScoredPoint[] }
  | { kind: 'none'; best: ScoredPoint[] };

/**
 * P5-08 with one addition: when the two best are an office and a locker with the same score and
 * the customer named only one of the two kinds ("Еконтомат Тракия"), that kind wins. The type
 * stored is still the matched point's own type (P5-09).
 */
export function pickMatch(scored: ScoredPoint[], pointWords: PointWord[]): MatchResult {
  const best = scored.slice(0, 5);
  const [first, ...rest] = scored;
  if (!first || first.score < MATCH_MIN_SCORE) return { kind: 'none', best };
  const second = rest[0];
  if (!second || first.score - second.score >= MATCH_MIN_MARGIN) {
    return { kind: 'match', point: first.point, score: first.score, by: 'name' };
  }
  if (pointWords.length === 1) {
    const wanted = pointWords[0] === 'locker' ? ['locker'] : ['office', 'mobile'];
    const close = scored.filter((s) => first.score - s.score < MATCH_MIN_MARGIN);
    const ofKind = close.filter((s) => wanted.includes(s.point.type));
    if (ofKind.length === 1 && ofKind[0]!.score >= MATCH_MIN_SCORE) {
      return { kind: 'match', point: ofKind[0]!.point, score: ofKind[0]!.score, by: 'name' };
    }
  }
  return { kind: 'ambiguous', best };
}
