import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'react';
import type { MapPoint } from './data';

/** OpenStreetMap's own tiles: light use only (one owner, one town at a time), with attribution. */
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const BULGARIA_CENTER: L.LatLngExpression = [42.7, 25.3];

export interface OfficeMapProps {
  points: MapPoint[];
  /** Accessible name of the map region. */
  label: string;
  /** Marker letters per carrier ("Е"/"С" in Bulgarian, "E"/"S" in English). */
  letters: Record<MapPoint['carrier'], string>;
  /** Popup texts: carrier and type names. */
  describe: (point: MapPoint) => { carrier: string; type: string };
}

/** Marker: the carrier letter on a shape per type (square office, round locker, diamond mobile). */
function markerIcon(point: MapPoint, letter: string): L.DivIcon {
  const pin = document.createElement('span');
  pin.className = `map-pin map-pin-${point.carrier} map-pin-${point.type}`;
  const text = document.createElement('span');
  text.className = 'map-pin-letter';
  text.textContent = letter;
  pin.append(text);
  return L.divIcon({
    html: pin,
    className: 'map-pin-wrap',
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

/** Popup content built from text nodes: courier data never becomes HTML. */
function popup(point: MapPoint, names: { carrier: string; type: string }): HTMLElement {
  const box = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = point.name_bg;
  const kind = document.createElement('div');
  kind.textContent = `${names.carrier} · ${names.type}`;
  box.append(title, kind);
  if (point.address_text) {
    const address = document.createElement('div');
    address.textContent = point.address_text;
    box.append(address);
  }
  return box;
}

export default function OfficeMap({ points, label, letters, describe }: OfficeMapProps) {
  const element = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);

  useEffect(() => {
    if (!element.current) return;
    const created = L.map(element.current, { scrollWheelZoom: false }).setView(BULGARIA_CENTER, 7);
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(created);
    map.current = created;
    return () => {
      created.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const current = map.current;
    if (!current) return;
    const layer = L.layerGroup().addTo(current);
    const placed = points.filter(
      (p): p is MapPoint & { lat: number; lng: number } => p.lat !== null && p.lng !== null,
    );
    for (const point of placed) {
      L.marker([point.lat, point.lng], {
        icon: markerIcon(point, letters[point.carrier]),
        title: point.name_bg,
        alt: point.name_bg,
      })
        .bindPopup(popup(point, describe(point)))
        .addTo(layer);
    }
    if (placed.length) {
      current.fitBounds(L.latLngBounds(placed.map((p) => [p.lat, p.lng] as L.LatLngTuple)), {
        padding: [24, 24],
        maxZoom: 15,
      });
    } else {
      current.setView(BULGARIA_CENTER, 7);
    }
    return () => {
      layer.remove();
    };
  }, [points, letters, describe]);

  return (
    <div
      ref={element}
      className="office-map"
      role="region"
      aria-label={label}
      data-testid="office-map"
    />
  );
}
