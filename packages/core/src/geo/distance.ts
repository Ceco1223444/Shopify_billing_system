/** A point on the map, in degrees (WGS 84). */
export interface LatLng {
  lat: number;
  lng: number;
}

/** Mean Earth radius (IUGG), km. */
export const EARTH_RADIUS_KM = 6371.0088;

const rad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Great-circle distance in km (haversine). On the WGS 84 ellipsoid the true distance differs
 * by at most about 0.5 %, which is plenty for "the nearest office" (the database uses PostGIS
 * geography distances, which are exact on the ellipsoid).
 */
export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Rough box around Bulgaria (with a margin), to reject coordinates that are clearly wrong. */
export const BULGARIA_BOUNDS = { minLat: 41.2, maxLat: 44.3, minLng: 22.3, maxLng: 28.7 } as const;

export function isInBulgaria(p: LatLng): boolean {
  return (
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    p.lat >= BULGARIA_BOUNDS.minLat &&
    p.lat <= BULGARIA_BOUNDS.maxLat &&
    p.lng >= BULGARIA_BOUNDS.minLng &&
    p.lng <= BULGARIA_BOUNDS.maxLng
  );
}
