/**
 * T4-04: the Speedy parsers against saved snapshots of Speedy's public pages (13 Nov 2026,
 * trimmed to 124 offices and lockers). T4-05: broken snapshots are reported as failures, so the
 * sync keeps the stored offices (tests/integration/courier-sync.test.ts checks the database side).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  decodeEntities,
  mergeSpeedy,
  parseSpeedyMapData,
  parseSpeedyOfficeList,
  pointProblems,
  splitSpeedyAddress,
  type SpeedyListEntry,
} from '../src/couriers/index.ts';

const read = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const LIST = read('speedy-offices-list.html');
const MAP = read('speedy-officesmap.html');

function parsedList(): SpeedyListEntry[] {
  const result = parseSpeedyOfficeList(LIST);
  if (!result.ok) throw new Error(`list not parsed: ${result.reason}`);
  return result.entries;
}

describe('Speedy office list (T4-04)', () => {
  it('reads every office and locker of the snapshot', () => {
    const result = parseSpeedyOfficeList(LIST);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toHaveLength(124);
    expect(result.problems).toEqual([]);
    expect(result.entries.filter((e) => e.isLocker)).toHaveLength(61);
  });

  it('an office: ID, name, city, postcode, address and hours', () => {
    const aytos = parsedList().find((e) => e.id === '190')!;
    expect(aytos).toEqual({
      id: '190',
      name: 'АЙТОС - КИРИЛ И МЕТОДИЙ (УЛ.)',
      isLocker: false,
      settlementType: 'гр.',
      city: 'Айтос',
      postcode: '8500',
      addressText: 'гр. Айтос [8500] ул. Кирил и Методий No 17',
      hours: {
        weekdays: { from: '09:30', to: '17:30' },
        saturday: { from: '09:30', to: '13:00' },
        sunday: null,
      },
    });
  });

  it('a locker: "(АВТОМАТ)" in the name, open around the clock', () => {
    const locker = parsedList().find((e) => e.id === '9364')!;
    expect(locker).toMatchObject({
      name: 'АЙТОС - СЛАВЯНСКА (УЛ.) (АВТОМАТ)',
      isLocker: true,
      city: 'Айтос',
      postcode: '8500',
      hours: {
        weekdays: { from: '00:00', to: '23:59' },
        saturday: { from: '00:00', to: '23:59' },
        sunday: { from: '00:00', to: '23:59' },
      },
    });
  });

  it('big cities without a [postcode]: the city still comes out, the postcode stays empty', () => {
    const entries = parsedList();
    // ("СОФИЯ - ЛОЗЕН" is in the village of Лозен: "с. Лозен [1151]" — that one keeps Лозен.)
    const sofia = entries.filter((e) => e.addressText.startsWith('гр. София '));
    expect(sofia.length).toBeGreaterThan(5);
    for (const e of sofia) expect(e.city, e.addressText).toBe('София');
    expect(entries.find((e) => e.addressText.startsWith('с. Лозен'))?.city).toBe('Лозен');
    const tarnovo = entries.filter((e) => e.name.startsWith('ВЕЛИКО ТЪРНОВО'));
    expect(tarnovo.length).toBeGreaterThan(0);
    for (const e of tarnovo) expect(e.city, e.addressText).toBe('Велико Търново');
  });

  it('every entry has an ID, a city and some hours; villages and resorts keep their type', () => {
    const entries = parsedList();
    for (const e of entries) {
      expect(e.id).toMatch(/^\d+$/);
      expect(e.city, e.addressText).toBeTruthy();
      expect(e.hours, e.id).not.toBeNull();
    }
    expect(entries.some((e) => e.settlementType === 'с.')).toBe(true);
    expect(entries.some((e) => e.settlementType === 'к.к.' && e.postcode)).toBe(true);
    expect(entries.filter((e) => e.postcode).every((e) => /^\d{4}$/.test(e.postcode!))).toBe(true);
  });

  it('tolerates other attribute order, quotes, spacing and entities', () => {
    const block = (id: number) =>
      `<DIV class='divOffice x' onClick="officeClick(${id})" id=${id} tabindex=0 >` +
      `<b>ТЕСТ &amp; ТЕСТ&nbsp;&nbsp;[${id}]</b><BR/><i>Адрес:</i> <b>с. Тестово [1234] ул. &quot;Първа&quot; No 1</b>` +
      `<br><i>(пон-пет):</i>  <b>9:00 – 18:00</b><br><i>(съб)</i><b>Почивен ден</b></DIV>`;
    const html = Array.from({ length: 120 }, (_, i) => block(1000 + i)).join('\n');
    const result = parseSpeedyOfficeList(html);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries[0]).toMatchObject({
      id: '1000',
      name: 'ТЕСТ & ТЕСТ',
      city: 'Тестово',
      postcode: '1234',
      addressText: 'с. Тестово [1234] ул. "Първа" No 1',
      hours: { weekdays: { from: '09:00', to: '18:00' }, saturday: null },
    });
  });
});

describe('Speedy list, broken pages (T4-05)', () => {
  it('a page without office blocks (markup changed) is a failure, not an empty list', () => {
    const renamed = LIST.replaceAll('divOffice"', 'officeCard"');
    expect(parseSpeedyOfficeList(renamed)).toEqual({
      ok: false,
      reason: 'too_few_entries',
      found: 0,
    });
  });

  it('a page cut off after a few offices is a failure', () => {
    const cut = LIST.slice(0, LIST.indexOf('id="9418"'));
    const result = parseSpeedyOfficeList(cut);
    expect(result.ok).toBe(false);
  });

  it('a page whose entries lost their address lines is a failure', () => {
    const noAddress = LIST.replaceAll('<i>Адрес:</i>', '<i>Location:</i>');
    expect(parseSpeedyOfficeList(noAddress)).toMatchObject({
      ok: false,
      reason: 'unreadable_entries',
    });
  });

  it('an error page / empty answer is a failure', () => {
    expect(parseSpeedyOfficeList('<html><body>503 Service Unavailable</body></html>').ok).toBe(
      false,
    );
    expect(parseSpeedyOfficeList('').ok).toBe(false);
  });
});

describe('Speedy map page coordinates', () => {
  it('reads the coordinates and type of every office on the map', () => {
    const result = parseSpeedyMapData(MAP);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.points.size).toBe(123);
    expect(result.points.get('9364')).toEqual({
      lat: 42.699224,
      lng: 27.248308,
      officeType: 'APT',
    });
    expect(result.points.get('190')?.officeType).toBe('OFFICE');
  });

  it('a map page without the office data is a failure', () => {
    expect(
      parseSpeedyMapData('<html><script>var speedy_offices = {};</script></html>'),
    ).toMatchObject({
      ok: false,
      reason: 'no_coordinates',
    });
  });
});

describe('list + map → points', () => {
  it('every point is valid; the office missing from the map has no coordinates', () => {
    const map = parseSpeedyMapData(MAP);
    if (!map.ok) throw new Error('map');
    const entries = parsedList();
    const { points, withoutCoordinates } = mergeSpeedy(entries, map.points);
    expect(points).toHaveLength(124);
    expect(withoutCoordinates).toBe(1);
    for (const p of points) expect(pointProblems(p), p.externalId).toEqual([]);
    const missing = points.find((p) => p.lat === null)!;
    expect(missing.externalId).toBe(entries.at(-1)!.id);
    expect(missing).toMatchObject({ coordSource: null, coordConfidence: null });
    const located = points.find((p) => p.externalId === '9364')!;
    expect(located).toMatchObject({
      carrier: 'speedy',
      code: '9364',
      type: 'locker',
      coordSource: 'speedy_map',
      coordConfidence: 3,
      nameEn: null,
    });
  });

  it('without the map page every point is kept, with no coordinates', () => {
    const { points, withoutCoordinates } = mergeSpeedy(parsedList(), null);
    expect(withoutCoordinates).toBe(points.length);
  });
});

describe('helpers', () => {
  it('splitSpeedyAddress', () => {
    expect(
      splitSpeedyAddress('гр. Стара Загора жк Казански бл. 1', 'СТАРА ЗАГОРА - КАЗАНСКИ'),
    ).toEqual({
      settlementType: 'гр.',
      city: 'Стара Загора',
      postcode: null,
    });
    expect(splitSpeedyAddress('к.к. Слънчев бряг [8240] кв. Пясъците', 'КК СЛЪНЧЕВ БРЯГ')).toEqual({
      settlementType: 'к.к.',
      city: 'Слънчев бряг',
      postcode: '8240',
    });
    expect(splitSpeedyAddress('гр. Долна баня ул. Искър No 2', 'ДРУГО ИМЕ')).toMatchObject({
      city: 'Долна баня',
    });
  });

  it('decodeEntities', () => {
    expect(decodeEntities('a&nbsp;&amp;&nbsp;b &#1040;&#x411; &quot;x&quot; &bogus;')).toBe(
      'a & b АБ "x" &bogus;',
    );
  });
});
