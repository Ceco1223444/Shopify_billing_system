/**
 * T4-02: haversine against known distances, within 0.5 %.
 *
 * "Known" = distances on the WGS 84 ellipsoid, computed with Vincenty's inverse formula (below),
 * which is checked first against Vincenty's own published test line (Flinders Peak → Buninyong,
 * 54 972.271 m), plus the textbook lengths of one degree along the equator and the meridian.
 */
import { describe, expect, it } from 'vitest';
import { haversineKm, isInBulgaria, type LatLng } from './distance.ts';

/** WGS 84 geodesic distance in km (Vincenty 1975, inverse problem). */
function vincentyKm(p1: LatLng, p2: LatLng): number {
  const a = 6378137;
  const f = 1 / 298.257223563;
  const b = (1 - f) * a;
  const rad = (d: number) => (d * Math.PI) / 180;
  const L = rad(p2.lng - p1.lng);
  const U1 = Math.atan((1 - f) * Math.tan(rad(p1.lat)));
  const U2 = Math.atan((1 - f) * Math.tan(rad(p2.lat)));
  const [sinU1, cosU1, sinU2, cosU2] = [Math.sin(U1), Math.cos(U1), Math.sin(U2), Math.cos(U2)];
  let lambda = L;
  let sinSigma = 0;
  let cosSigma = 0;
  let sigma = 0;
  let cos2Alpha = 0;
  let cos2SigmaM = 0;
  for (let i = 0; i < 200; i++) {
    const sinL = Math.sin(lambda);
    const cosL = Math.cos(lambda);
    sinSigma = Math.sqrt((cosU2 * sinL) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cosL) ** 2);
    if (sinSigma === 0) return 0;
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosL;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cosU1 * cosU2 * sinL) / sinSigma;
    cos2Alpha = 1 - sinAlpha ** 2;
    cos2SigmaM = cos2Alpha === 0 ? 0 : cosSigma - (2 * sinU1 * sinU2) / cos2Alpha;
    const C = (f / 16) * cos2Alpha * (4 + f * (4 - 3 * cos2Alpha));
    const next =
      L +
      (1 - C) *
        f *
        sinAlpha *
        (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM ** 2)));
    const done = Math.abs(next - lambda) < 1e-12;
    lambda = next;
    if (done) break;
  }
  const u2 = (cos2Alpha * (a * a - b * b)) / (b * b);
  const A = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
  const B = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
  const deltaSigma =
    B *
    sinSigma *
    (cos2SigmaM +
      (B / 4) *
        (cosSigma * (-1 + 2 * cos2SigmaM ** 2) -
          (B / 6) * cos2SigmaM * (-3 + 4 * sinSigma ** 2) * (-3 + 4 * cos2SigmaM ** 2)));
  return (b * A * (sigma - deltaSigma)) / 1000;
}

const dms = (d: number, m: number, s: number) => Math.sign(d) * (Math.abs(d) + m / 60 + s / 3600);

const CITIES: Record<string, LatLng> = {
  sofia: { lat: 42.6977, lng: 23.3219 },
  plovdiv: { lat: 42.1354, lng: 24.7453 },
  varna: { lat: 43.2141, lng: 27.9147 },
  burgas: { lat: 42.5048, lng: 27.4626 },
  ruse: { lat: 43.8356, lng: 25.9657 },
  vidin: { lat: 43.9962, lng: 22.8679 },
  kardzhali: { lat: 41.6338, lng: 25.3777 },
};

describe('haversineKm (T4-02)', () => {
  it('the Vincenty reference reproduces its published test line', () => {
    const flinders = { lat: dms(-37, 57, 3.7203), lng: dms(144, 25, 29.5244) };
    const buninyong = { lat: dms(-37, 39, 10.1561), lng: dms(143, 55, 35.3839) };
    expect(vincentyKm(flinders, buninyong)).toBeCloseTo(54.972271, 5);
  });

  it('one degree along the equator and along the meridian at 45°', () => {
    const equator = haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 });
    expect(Math.abs(equator - 111.3195) / 111.3195).toBeLessThan(0.005);
    const meridian = haversineKm({ lat: 44.5, lng: 25 }, { lat: 45.5, lng: 25 });
    expect(Math.abs(meridian - 111.132) / 111.132).toBeLessThan(0.005);
  });

  const pairs: [string, string][] = [
    ['sofia', 'plovdiv'],
    ['sofia', 'varna'],
    ['plovdiv', 'burgas'],
    ['ruse', 'kardzhali'],
    ['vidin', 'burgas'],
  ];
  it.each(pairs)('%s → %s is within 0.5 %% of the ellipsoid distance', (from, to) => {
    const a = CITIES[from]!;
    const b = CITIES[to]!;
    const truth = vincentyKm(a, b);
    expect(Math.abs(haversineKm(a, b) - truth) / truth).toBeLessThan(0.005);
  });

  it('short distances inside a town (≈ 1 km) are within 0.5 % as well', () => {
    const a = { lat: 42.1354, lng: 24.7453 };
    const b = { lat: 42.1444, lng: 24.7453 }; // ~1 km north
    const truth = vincentyKm(a, b);
    expect(truth).toBeGreaterThan(0.99);
    expect(Math.abs(haversineKm(a, b) - truth) / truth).toBeLessThan(0.005);
  });

  it('is symmetric and zero for the same point', () => {
    const { sofia, varna } = CITIES as Record<'sofia' | 'varna', LatLng>;
    expect(haversineKm(sofia, varna)).toBeCloseTo(haversineKm(varna, sofia), 9);
    expect(haversineKm(sofia, sofia)).toBe(0);
  });
});

describe('isInBulgaria', () => {
  it('accepts Bulgarian towns and rejects 0,0 and neighbours far away', () => {
    for (const p of Object.values(CITIES)) expect(isInBulgaria(p)).toBe(true);
    expect(isInBulgaria({ lat: 0, lng: 0 })).toBe(false);
    expect(isInBulgaria({ lat: 44.4268, lng: 26.1025 })).toBe(false); // Bucharest
    expect(isInBulgaria({ lat: Number.NaN, lng: 25 })).toBe(false);
  });
});
