/**
 * Phase 5 detection, table-driven (T5-01 … T5-08) on real office data. Each case: what the
 * customer wrote → rule, certainty, courier, type, office (or suggestion) and the main reason.
 *
 * The table runs with every point type allowed (the Phase 5 spec). The owner's setting since
 * 14 Nov 2026 is offices only (settings.point_types): see the "offices only" block at the end.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DETECTION_SETTINGS,
  detectDelivery,
  type DeliveryDecision,
  type DetectionRule,
  type DetectionSettings,
  type GeoPoint,
} from '../src/detect/decide.ts';
import { callScript } from '../src/detect/call.ts';
import type { DetectionInput } from '../src/detect/signals.ts';
import { fakeDeps, northOf, pointById } from './detect-fixtures.ts';

interface Expect {
  rule: DetectionRule;
  certainty: DeliveryDecision['certainty'];
  carrier?: DeliveryDecision['carrier'];
  type?: DeliveryDecision['deliveryType'];
  /** "econt-4068": the resolved point (rule A) */
  point?: string;
  /** "speedy-202": the suggestion (rules C, D, E) */
  suggestion?: string | null;
  reason?: string;
  hint?: string;
}

interface Case {
  name: string;
  input: DetectionInput;
  geo?: Record<string, GeoPoint | null | 'busy'>;
  expect: Expect;
}

const burov = pointById('speedy', '202');
const trakia148 = pointById('speedy', '608');
const kapana = pointById('econt', '4064');
const mladost1 = pointById('econt', '1056');
const aytos = pointById('speedy', '190');

/** The Phase 5 spec: offices, lockers and mobile offices. */
const ALL_TYPES: DetectionSettings = {
  ...DEFAULT_DETECTION_SETTINGS,
  pointTypes: ['office', 'locker', 'mobile'],
};

const CASES: Case[] = [
  // --- A: courier + exactly one office / locker -----------------------------------------
  {
    name: 'Еконтомат Тракия (locker by the point type)',
    input: { address1: 'Еконтомат Тракия', city: 'Пловдив', zip: '4000' },
    expect: {
      rule: 'A',
      certainty: 'certain',
      carrier: 'econt',
      type: 'locker',
      point: 'econt-4068',
    },
  },
  {
    name: 'Еконт офис Капана',
    input: { address1: 'Еконт офис Капана', city: 'Пловдив' },
    expect: {
      rule: 'A',
      certainty: 'certain',
      carrier: 'econt',
      type: 'office',
      point: 'econt-4064',
    },
  },
  {
    name: 'офис Еконт – Капана',
    input: { address1: 'офис Еконт – Капана', city: 'Пловдив' },
    expect: { rule: 'A', certainty: 'certain', point: 'econt-4064' },
  },
  {
    name: 'Latin: Ekont ofis Kapana, Plovdiv',
    input: { address1: 'Ekont ofis Kapana', city: 'Plovdiv' },
    expect: { rule: 'A', certainty: 'certain', carrier: 'econt', point: 'econt-4064' },
  },
  {
    name: 'English: Econt office Kapana',
    input: { address1: 'Econt office Kapana', city: 'Plovdiv' },
    expect: { rule: 'A', certainty: 'certain', point: 'econt-4064' },
  },
  {
    name: 'typo: Ekonnt ofis Kapana',
    input: { address1: 'Ekonnt ofis Kapana', city: 'Пловдив' },
    expect: { rule: 'A', certainty: 'certain', carrier: 'econt', point: 'econt-4064' },
  },
  {
    name: 'office by its street address',
    input: { address1: 'Офис Спиди, ул. Константин Стоилов 19', city: 'Пловдив' },
    expect: {
      rule: 'A',
      certainty: 'certain',
      carrier: 'speedy',
      type: 'office',
      point: 'speedy-79',
    },
  },
  {
    name: 'Спиди автомат Кауфланд Тракия',
    input: { address1: 'Спиди автомат Кауфланд Тракия', city: 'Пловдив' },
    expect: {
      rule: 'A',
      certainty: 'certain',
      carrier: 'speedy',
      type: 'locker',
      point: 'speedy-9145',
    },
  },
  {
    name: 'автомат спиди кауфланд тракия (lower case)',
    input: { address1: 'автомат спиди кауфланд тракия', city: 'Пловдив' },
    expect: { rule: 'A', certainty: 'certain', point: 'speedy-9145' },
  },
  {
    name: 'Speedy автомат 9145 (by ID)',
    input: { address1: 'Speedy автомат 9145', city: 'Пловдив' },
    expect: {
      rule: 'A',
      certainty: 'certain',
      type: 'locker',
      point: 'speedy-9145',
      reason: 'point_matched',
    },
  },
  {
    name: 'офис еконт 4064 (by code)',
    input: { address1: 'офис еконт 4064', city: 'Пловдив' },
    expect: { rule: 'A', certainty: 'certain', point: 'econt-4064' },
  },
  {
    name: 'Еконт № 4007',
    input: { address1: 'Еконт № 4007', city: 'Пловдив' },
    expect: { rule: 'A', certainty: 'certain', point: 'econt-4007' },
  },
  {
    name: 'Ekont ofis Mladost 1, Sofia',
    input: { address1: 'Ekont ofis Mladost 1', city: 'Sofia' },
    expect: { rule: 'A', certainty: 'certain', carrier: 'econt', point: 'econt-1056' },
  },
  {
    name: 'Спиди Младост 1А',
    input: { address1: 'Спиди Младост 1А', city: 'София' },
    expect: { rule: 'A', certainty: 'certain', carrier: 'speedy', point: 'speedy-362' },
  },
  {
    name: 'Офис Еконт Тракия: the office, not the locker of the same name',
    input: { address1: 'Офис Еконт Тракия', city: 'Пловдив' },
    expect: { rule: 'A', certainty: 'certain', type: 'office', point: 'econt-4007' },
  },
  {
    name: 'upper case: ЕКОНТ ОФИС ТРАКИЯ, ПЛОВДИВ',
    input: { address1: 'ЕКОНТ ОФИС ТРАКИЯ', city: 'ПЛОВДИВ' },
    expect: { rule: 'A', certainty: 'certain', point: 'econt-4007' },
  },
  {
    name: 'Спийди офис Буров',
    input: { address1: 'Спийди офис Буров', city: 'Русе' },
    expect: { rule: 'A', certainty: 'certain', carrier: 'speedy', point: 'speedy-202' },
  },
  {
    name: 'до офис на Спиди Борисова',
    input: { address1: 'до офис на Спиди Борисова', city: 'Русе' },
    expect: { rule: 'A', certainty: 'certain', point: 'speedy-737' },
  },
  {
    name: 'Спиди Опера',
    input: { address1: 'Спиди Опера', city: 'Русе' },
    expect: { rule: 'A', certainty: 'certain', point: 'speedy-91' },
  },
  {
    name: 'office in Address2, city prefix гр.',
    input: { address1: 'Русе', address2: 'офис Спиди Технополис', city: 'гр. Русе' },
    expect: { rule: 'A', certainty: 'certain', point: 'speedy-371' },
  },
  {
    name: 'office named in the Company field',
    input: { address1: '', company: 'Спиди Чародейка', city: 'Русе' },
    expect: { rule: 'A', certainty: 'certain', point: 'speedy-791' },
  },
  {
    name: 'office named only in the note',
    input: { address1: 'Русе', notes: ['Моля до офис на Спиди Борците'], city: 'Русе' },
    expect: { rule: 'A', certainty: 'certain', point: 'speedy-776' },
  },
  {
    name: 'spidi (Latin) ofis Praktiker',
    input: { address1: 'spidi ofis praktiker', city: 'Ruse' },
    expect: { rule: 'A', certainty: 'certain', point: 'speedy-179' },
  },

  // --- C: the courier is clear, the office is not -----------------------------------------
  {
    name: 'до офис на спиди, Русе (several offices)',
    input: { address1: 'до офис на спиди', city: 'Русе' },
    geo: { 'до офис на спиди': northOf(burov, 0.2, 'city') },
    expect: {
      rule: 'C',
      certainty: 'uncertain',
      carrier: 'speedy',
      suggestion: 'speedy-202',
      reason: 'point_unclear',
      hint: 'geocode_city_only',
    },
  },
  {
    name: 'Офис Еконт – Пловдив Тест (legacy sample)',
    input: { address1: 'Офис Еконт – Пловдив Тест', city: 'Пловдив', zip: '4000' },
    expect: { rule: 'C', certainty: 'uncertain', carrier: 'econt', reason: 'point_unclear' },
  },
  {
    name: 'Офис Спиди – София Тест (legacy sample)',
    input: { address1: 'Офис Спиди – София Тест', city: 'София', zip: '1000' },
    expect: { rule: 'C', certainty: 'uncertain', carrier: 'speedy' },
  },
  {
    name: 'courier word alone is never certain (P5-17)',
    input: { address1: 'Еконт', city: 'Пловдив' },
    expect: { rule: 'C', certainty: 'uncertain', carrier: 'econt' },
  },
  {
    name: 'Спиди in a town with no offices known, address not found',
    input: { address1: 'Спиди', city: 'Варна' },
    expect: { rule: 'C', certainty: 'uncertain', carrier: 'speedy', suggestion: null },
  },
  {
    name: 'Еконт Тракия: office and locker of the same name → ambiguous',
    input: { address1: 'Еконт Тракия', city: 'Пловдив' },
    expect: { rule: 'C', certainty: 'uncertain', carrier: 'econt', reason: 'point_unclear' },
  },
  {
    name: 'Спиди Тракия: several Тракия offices',
    input: { address1: 'Спиди Тракия', city: 'Пловдив' },
    expect: { rule: 'C', certainty: 'uncertain', carrier: 'speedy' },
  },
  {
    name: 'Speedy, Sofia (Latin, nothing else)',
    input: { address1: 'Speedy', city: 'Sofia' },
    expect: { rule: 'C', certainty: 'uncertain', carrier: 'speedy' },
  },
  {
    name: 'Spidi ofis (typo + Latin)',
    input: { address1: 'Spidi ofis', city: 'Ruse' },
    expect: { rule: 'C', certainty: 'uncertain', carrier: 'speedy', type: 'office' },
  },
  {
    name: 'Спиди автомат: a locker is suggested',
    input: { address1: 'Спиди автомат', city: 'Пловдив' },
    geo: { 'Спиди автомат': northOf(trakia148, 0.3) },
    expect: {
      rule: 'C',
      certainty: 'uncertain',
      carrier: 'speedy',
      type: 'locker',
      suggestion: 'speedy-9145',
    },
  },
  {
    name: 'Ekont (Latin) alone',
    input: { address1: 'Ekont', city: 'Plovdiv' },
    expect: { rule: 'C', certainty: 'uncertain', carrier: 'econt' },
  },
  {
    name: 'econtomat alone: Econt, locker wanted',
    input: { address1: 'econtomat', city: 'Plovdiv' },
    expect: { rule: 'C', certainty: 'uncertain', carrier: 'econt', type: 'locker' },
  },
  {
    name: 'courier + street address, no office word → C',
    input: { address1: 'Еконт, ул. Иван Вазов 12', city: 'Пловдив' },
    geo: { 'Еконт, ул. Иван Вазов 12': northOf(kapana, 0.4) },
    expect: { rule: 'C', certainty: 'uncertain', carrier: 'econt', suggestion: 'econt-4064' },
  },
  {
    name: 'Speedy автомат 123, София: ID 123 is in Sliven → C',
    input: { address1: 'Speedy автомат 123', city: 'София' },
    expect: { rule: 'C', certainty: 'uncertain', carrier: 'speedy', type: 'locker' },
  },
  {
    name: 'е-конт офис',
    input: { address1: 'е-конт офис', city: 'Пловдив' },
    expect: { rule: 'C', certainty: 'uncertain', carrier: 'econt' },
  },
  {
    name: 'автомат Спиди Младост 4: office name fits, locker asked → not certain',
    input: { address1: 'автомат Спиди Младост 4', city: 'София' },
    expect: { rule: 'C', certainty: 'uncertain', carrier: 'speedy' },
  },
  {
    name: 'best name matches suggested when the address is not found',
    input: { address1: 'Спиди Тракия', city: 'Пловдив' },
    expect: { rule: 'C', certainty: 'uncertain', reason: 'point_unclear' },
  },
  {
    name: 'Спидито, до офиса',
    input: { address1: 'Спидито, до офиса', city: 'Русе' },
    expect: { rule: 'C', certainty: 'uncertain', carrier: 'speedy' },
  },

  // --- D: conflicting signals ------------------------------------------------------------------
  {
    name: 'Еконт или Спиди, все едно',
    input: { address1: 'Еконт или Спиди, все едно', city: 'Пловдив' },
    expect: { rule: 'D', certainty: 'uncertain', reason: 'both_carriers' },
  },
  {
    name: 'офис еконт + бл. 5, ап. 12 (Appendix B)',
    input: { address1: 'офис еконт', address2: 'бл. 5, ап. 12', city: 'Пловдив' },
    expect: { rule: 'D', certainty: 'uncertain', reason: 'point_and_flat' },
  },
  {
    name: 'Офис Еконт, ул. Иван Вазов 12 (office words + full street)',
    input: { address1: 'Офис Еконт, ул. Иван Вазов 12', city: 'Пловдив' },
    expect: { rule: 'D', certainty: 'uncertain', reason: 'point_and_street' },
  },
  {
    name: 'до адрес или офис',
    input: { address1: 'до адрес или офис', city: 'Русе' },
    expect: { rule: 'D', certainty: 'uncertain', reason: 'office_and_home' },
  },
  {
    name: 'Спиди до адрес, ул. Опитна 21',
    input: { address1: 'Спиди до адрес, ул. Опитна 21', city: 'Русе' },
    expect: { rule: 'D', certainty: 'uncertain', reason: 'point_and_home' },
  },
  {
    name: 'Econt or Speedy (English)',
    input: { address1: 'Econt or Speedy', city: 'Sofia' },
    expect: { rule: 'D', certainty: 'uncertain', reason: 'both_carriers' },
  },
  {
    name: 'a matched office + вх./ет. → conflict',
    input: { address1: 'Офис Спиди Буров, вх. А, ет. 3', city: 'Русе' },
    expect: { rule: 'D', certainty: 'uncertain', reason: 'point_and_flat' },
  },
  {
    name: 'street in Address1, "до офис на Еконт" in the note',
    input: { address1: 'ул. Примерна 12', notes: ['до офис на Еконт'], city: 'София' },
    expect: { rule: 'D', certainty: 'uncertain', reason: 'point_and_street' },
  },
  {
    name: 'Спиди in the address, Еконт in the note',
    input: { address1: 'Спиди Буров', notes: ['или Еконт'], city: 'Русе' },
    expect: { rule: 'D', certainty: 'uncertain', reason: 'both_carriers' },
  },

  // --- B: explicit home address --------------------------------------------------------------
  {
    name: 'ул. Примерна 12, личен адрес (Appendix B)',
    input: { address1: 'ул. Примерна 12, личен адрес', city: 'София' },
    expect: {
      rule: 'B',
      certainty: 'certain',
      type: 'address',
      carrier: 'econt',
      reason: 'home_requested',
    },
  },
  {
    name: 'до адрес: бул. Демо 7',
    input: { address1: 'до адрес: бул. Демо 7', city: 'Бургас' },
    expect: { rule: 'B', certainty: 'certain', type: 'address' },
  },
  {
    name: 'ж.к. + бл., до врата',
    input: { address1: 'ж.к. Тестов, бл. 5, до врата', city: 'Варна' },
    expect: { rule: 'B', certainty: 'certain', type: 'address' },
  },
  {
    name: 'home address, ul. Primerna 12 (English/Latin)',
    input: { address1: 'home address, ul. Primerna 12', city: 'Sofia' },
    expect: { rule: 'B', certainty: 'certain', type: 'address' },
  },
  {
    name: 'Do adres, zh.k. Mladost 1 bl. 12',
    input: { address1: 'Do adres, zh.k. Mladost 1 bl. 12', city: 'Sofia' },
    expect: { rule: 'B', certainty: 'certain', type: 'address' },
  },
  {
    name: 'home word in the note, street in Address1',
    input: { address1: 'ул. Опитна 21', notes: ['Моля, доставка до адрес'], city: 'Русе' },
    expect: { rule: 'B', certainty: 'certain', type: 'address' },
  },
  {
    name: 'личен адрес without a street → uncertain',
    input: { address1: 'личен адрес', city: 'Русе' },
    expect: { rule: 'B', certainty: 'uncertain', type: 'address', reason: 'home_incomplete' },
  },
  {
    name: 'вкъщи, ул. Пробна 4',
    input: { address1: 'вкъщи, ул. Пробна 4', city: 'Стара Загора' },
    expect: { rule: 'B', certainty: 'certain', type: 'address' },
  },

  // --- E: nothing said → nearest office / locker within range ---------------------------------
  {
    name: 'ул. Опитна 21, Русе: an office 0.3 km away',
    input: { address1: 'ул. Опитна 21', city: 'Русе', zip: '7000' },
    geo: { 'ул. Опитна 21': northOf(burov, 0.3) },
    expect: {
      rule: 'E',
      certainty: 'uncertain',
      carrier: 'speedy',
      type: 'office',
      suggestion: 'speedy-202',
      reason: 'nearest_point',
      hint: 'looks_like_home',
    },
  },
  {
    name: 'T5-07: nearest at 0.8 km (range 1 km) → suggested',
    input: { address1: 'ул. Славянска 5', city: 'Айтос' },
    geo: { 'ул. Славянска 5': northOf(aytos, 0.8) },
    expect: {
      rule: 'E',
      certainty: 'uncertain',
      carrier: 'speedy',
      type: 'office',
      suggestion: 'speedy-190',
      reason: 'nearest_point',
    },
  },
  {
    // Owner's "middle way" (14 Nov 2026): no office within range + a complete street address
    // found beyond the town → certain, to the address (P5-14 said "uncertain").
    name: 'T5-07: nearest at 1.5 km (range 1 km) → home address, certain',
    input: { address1: 'ул. Славянска 9', city: 'Айтос' },
    geo: { 'ул. Славянска 9': northOf(aytos, 1.5) },
    expect: {
      rule: 'E',
      certainty: 'certain',
      type: 'address',
      suggestion: null,
      reason: 'no_point_in_range_home',
    },
  },
  {
    name: 'с. Малко село 5: nothing within range → home address',
    input: { address1: 'с. Малко село 5', city: 'Малко село' },
    geo: { 'с. Малко село 5': { lat: 42.9, lng: 25.1, precision: 'city' } },
    expect: {
      rule: 'E',
      certainty: 'uncertain',
      type: 'address',
      carrier: 'econt',
      reason: 'no_point_in_range',
    },
  },
  {
    name: 'empty address with a town: the town centre',
    input: { address1: '', city: 'Пловдив' },
    geo: { '': { ...kapana, precision: 'city' } },
    expect: {
      rule: 'E',
      certainty: 'uncertain',
      carrier: 'econt',
      suggestion: 'econt-4064',
      hint: 'geocode_city_only',
    },
  },
  {
    name: 'ж.к. Тракия бл. 148 → the Speedy office in that block',
    input: { address1: 'ж.к. Тракия бл. 148', city: 'Пловдив' },
    geo: {
      'ж.к. Тракия бл. 148': { lat: trakia148.lat!, lng: trakia148.lng!, precision: 'block' },
    },
    expect: {
      rule: 'E',
      certainty: 'uncertain',
      carrier: 'speedy',
      suggestion: 'speedy-608',
      hint: 'looks_like_home',
    },
  },
  {
    name: 'ул. Йерусалим 50, София: Econt Младост 1 nearby',
    input: { address1: 'ул. Йерусалим 50', city: 'София' },
    geo: { 'ул. Йерусалим 50': northOf(mladost1, 0.1) },
    expect: { rule: 'E', certainty: 'uncertain', suggestion: 'econt-1056' },
  },
  {
    name: '"Тест" (no courier, no office word) is just an address',
    input: { address1: 'Тест 5', city: 'Пловдив' },
    geo: { 'Тест 5': northOf(kapana, 0.5) },
    expect: { rule: 'E', certainty: 'uncertain', suggestion: 'econt-4064' },
  },
  {
    name: 'apteka is not "apt" (Speedy)',
    input: { address1: 'до аптеката, ул. Буров 4', city: 'Русе' },
    geo: { 'до аптеката, ул. Буров 4': northOf(burov, 0.05) },
    expect: { rule: 'E', certainty: 'uncertain', suggestion: 'speedy-202' },
  },
  {
    name: 'office word without a courier, unknown name → nearest office',
    input: { address1: 'до офис', city: 'Русе' },
    geo: { 'до офис': northOf(burov, 0.1) },
    expect: { rule: 'E', certainty: 'uncertain', type: 'office', suggestion: 'speedy-202' },
  },
  {
    name: 'office word without a courier, a known name → suggested, not certain',
    input: { address1: 'офис Капана', city: 'Пловдив' },
    expect: {
      rule: 'C',
      certainty: 'uncertain',
      carrier: 'econt',
      suggestion: 'econt-4064',
      reason: 'point_without_carrier',
    },
  },

  // --- F: error --------------------------------------------------------------------------------
  {
    name: 'BOX NOW Лозенец (Appendix B)',
    input: { address1: 'BOX NOW Лозенец', city: 'София' },
    expect: { rule: 'F', certainty: 'error', reason: 'other_courier' },
  },
  {
    name: 'empty address, empty city',
    input: { address1: '', city: '' },
    expect: { rule: 'F', certainty: 'error', reason: 'no_city' },
  },
  {
    name: 'boxnow автомат',
    input: { address1: 'boxnow автомат', city: 'Пловдив' },
    expect: { rule: 'F', certainty: 'error', reason: 'other_courier' },
  },
  {
    name: 'бокс нау in the note',
    input: { address1: 'ул. Опитна 21', notes: ['до бокс нау'], city: 'Русе' },
    expect: { rule: 'F', certainty: 'error', reason: 'other_courier' },
  },
  {
    name: 'Sameday',
    input: { address1: 'Sameday locker', city: 'Пловдив' },
    expect: { rule: 'F', certainty: 'error', reason: 'other_courier' },
  },
  {
    name: 'abroad (legacy sample #2005, Roma)',
    input: { address1: 'Via di Prova 3', city: 'Roma', zip: '00184', country: 'IT' },
    expect: { rule: 'F', certainty: 'error', reason: 'not_bulgaria' },
  },
  {
    name: 'address not found on the map',
    input: { address1: 'ул. Несъществуваща 1', city: 'Измислено' },
    expect: { rule: 'F', certainty: 'error', reason: 'geocode_failed' },
  },
  {
    name: 'only a postcode is enough to try',
    input: { address1: 'ул. Опитна 21', city: '', zip: '7000' },
    expect: { rule: 'F', certainty: 'error', reason: 'geocode_failed' },
  },
];

describe('T5-01: detection cases from Appendix B and real offices', () => {
  it('has at least 60 cases', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(60);
  });

  it.each(CASES)('$name', async ({ input, geo, expect: want }) => {
    const out = await detectDelivery(input, fakeDeps(geo), ALL_TYPES);
    expect(out.kind).toBe('decided');
    if (out.kind !== 'decided') return;
    const d = out.decision;
    const got: Expect = { rule: d.rule, certainty: d.certainty };
    if ('carrier' in want) got.carrier = d.carrier;
    if ('type' in want) got.type = d.deliveryType;
    if ('point' in want) got.point = d.point?.id;
    if ('suggestion' in want) got.suggestion = d.suggestion?.id ?? null;
    if ('reason' in want) got.reason = d.reasons.find((r) => r.code === want.reason)?.code;
    if ('hint' in want) got.hint = d.hints.find((r) => r.code === want.hint)?.code;
    expect(got, JSON.stringify(d.reasons.map((r) => r.bg))).toEqual(want);
  });
});

describe('T5-02 / T5-03: Latin text, typos and the Appendix B examples', () => {
  const carrierOf = async (address1: string) => {
    const out = await detectDelivery({ address1, city: 'Пловдив' }, fakeDeps());
    return out.kind === 'decided' ? out.decision.carrier : null;
  };
  it.each([
    ['Ekont', 'econt'],
    ['ekonta', 'econt'],
    ['Econt', 'econt'],
    ['ЕКОНТ', 'econt'],
    ['еконтомат', 'econt'],
    ['Spidi', 'speedy'],
    ['spiidi', 'speedy'],
    ['Спийди', 'speedy'],
    ['speedy', 'speedy'],
    ['Spidy', 'speedy'],
    ['автомат спиди', 'speedy'],
  ])('%s → %s', async (text, carrier) => {
    expect(await carrierOf(text)).toBe(carrier);
  });
});

describe('T5-03: the Appendix B examples resolve to the right point and type', () => {
  // The legacy samples name an invented office "Пловдив Тест"; here it exists (a test office).
  const plovdivTest = {
    ...pointById('econt', '4064'),
    id: 'econt-test',
    external_id: '9999',
    name_bg: 'Пловдив Тест',
    address_text: 'Пловдив ул. Тестова 1',
  };
  const withTestOffice = () => {
    const deps = fakeDeps();
    const inCity = deps.pointsInCity;
    return {
      ...deps,
      pointsInCity: async (city: string | null, zip: string | null) => [
        ...(await inCity(city, zip)),
        ...(city === 'Пловдив' ? [plovdivTest] : []),
      ],
    };
  };
  const decide = async (address1: string) => {
    const out = await detectDelivery(
      { address1, city: 'Пловдив', zip: '4000' },
      withTestOffice(),
      ALL_TYPES,
    );
    if (out.kind !== 'decided') throw new Error('busy');
    return out.decision;
  };

  it('"Офис Еконт – Пловдив Тест" → that Econt office, type office, certain', async () => {
    const d = await decide('Офис Еконт – Пловдив Тест');
    expect([d.rule, d.certainty, d.carrier, d.deliveryType, d.point?.id]).toEqual([
      'A',
      'certain',
      'econt',
      'office',
      'econt-test',
    ]);
  });

  it('"еконтомат Тракия" → the Econt locker of that name, type locker', async () => {
    const d = await decide('еконтомат Тракия');
    expect([d.rule, d.certainty, d.carrier, d.deliveryType, d.point?.id]).toEqual([
      'A',
      'certain',
      'econt',
      'locker',
      pointById('econt', '4068').id,
    ]);
  });

  it('"автомат спиди Кауфланд Тракия" → the Speedy locker, type locker', async () => {
    const d = await decide('автомат спиди Кауфланд Тракия');
    expect([d.rule, d.certainty, d.carrier, d.deliveryType, d.point?.id]).toEqual([
      'A',
      'certain',
      'speedy',
      'locker',
      pointById('speedy', '9145').id,
    ]);
  });

  it('"еконтомат" alone: Econt, a locker, but which one is not clear → uncertain', async () => {
    const d = await decide('еконтомат');
    expect([d.rule, d.certainty, d.carrier]).toEqual(['C', 'uncertain', 'econt']);
  });
});

describe('T5-08: Shipping Method has no effect', () => {
  const methods = [
    'Free shipping',
    'Standard',
    'Спиди – до автомат',
    'Econt office',
    'Личен адрес',
  ];
  it.each(CASES.slice(0, 40))('$name', async ({ input, geo }) => {
    const plain = await detectDelivery(input, fakeDeps(geo));
    for (const shippingMethod of methods) {
      expect(await detectDelivery({ ...input, shippingMethod }, fakeDeps(geo))).toEqual(plain);
    }
  });
});

describe('geocoder busy / only when needed', () => {
  it('a busy geocoder postpones the decision', async () => {
    const out = await detectDelivery(
      { address1: 'ул. Опитна 21', city: 'Русе' },
      fakeDeps({ 'ул. Опитна 21': 'busy' }),
    );
    expect(out).toEqual({ kind: 'busy' });
  });

  it('rules A, B and F never ask the geocoder', async () => {
    for (const input of [
      { address1: 'Еконтомат Тракия', city: 'Пловдив' },
      { address1: 'ул. Примерна 12, личен адрес', city: 'София' },
      { address1: 'BOX NOW', city: 'София' },
    ]) {
      const deps = fakeDeps();
      await detectDelivery(input, deps);
      expect(deps.geocoded).toEqual([]);
    }
  });
});

describe('offices only (owner, 14 Nov 2026: big parcels, settings.point_types = office)', () => {
  const decide = async (input: DetectionInput, geo: Record<string, GeoPoint | null> = {}) => {
    const out = await detectDelivery(input, fakeDeps(geo), DEFAULT_DETECTION_SETTINGS);
    if (out.kind !== 'decided') throw new Error('busy');
    return out.decision;
  };
  const codes = (d: DeliveryDecision) => d.reasons.map((r) => r.code);
  const onlyOffices = (d: DeliveryDecision) =>
    [d.point, d.suggestion, ...d.alternatives].every((p) => !p || p.type === 'office');

  it('is the default', () => {
    expect(DEFAULT_DETECTION_SETTINGS.pointTypes).toEqual(['office']);
  });

  it.each([
    ['Еконтомат Тракия', 'econt'],
    ['Спиди автомат Кауфланд Тракия', 'speedy'],
    ['Speedy автомат 9145', 'speedy'],
  ])('"%s": the locker is recognised, a nearby %s office is suggested', async (text, carrier) => {
    const d = await decide({ address1: text, city: 'Пловдив', zip: '4000' });
    expect([d.rule, d.certainty, d.carrier, d.deliveryType]).toEqual([
      'C',
      'uncertain',
      carrier,
      'office',
    ]);
    expect(codes(d)).toContain('point_type_not_used');
    expect(codes(d)).toContain('suggest_near_named');
    expect(d.suggestion?.type).toBe('office');
    expect(d.suggestion?.carrier).toBe(carrier);
    expect(onlyOffices(d)).toBe(true);
    expect(d.reasons[0]!.bg).toMatch(/не изпращаме до автомати/);
  });

  it('"Спиди автомат" alone: the courier is clear, an office is suggested, not a locker', async () => {
    const d = await decide(
      { address1: 'Спиди автомат', city: 'Пловдив' },
      { 'Спиди автомат': northOf(trakia148, 0.3) },
    );
    expect([d.rule, d.certainty, d.carrier, d.deliveryType]).toEqual([
      'C',
      'uncertain',
      'speedy',
      'office',
    ]);
    expect(codes(d)).toEqual(expect.arrayContaining(['point_unclear', 'locker_not_used']));
    expect(d.suggestion?.type).toBe('office');
    expect(onlyOffices(d)).toBe(true);
  });

  it('a locker named without a courier: an office near it is suggested', async () => {
    const d = await decide({ address1: 'до автомат Кауфланд Тракия', city: 'Пловдив' });
    expect([d.rule, d.certainty, d.deliveryType]).toEqual(['C', 'uncertain', 'office']);
    expect(codes(d)[0]).toBe('point_type_not_used');
    expect(onlyOffices(d)).toBe(true);
  });

  it('an office named clearly is still certain (rule A)', async () => {
    const d = await decide({ address1: 'Еконт офис Капана', city: 'Пловдив' });
    expect([d.rule, d.certainty, d.deliveryType, d.point?.id]).toEqual([
      'A',
      'certain',
      'office',
      kapana.id,
    ]);
  });

  it('rule E ignores lockers: a locker 0.1 km away does not count, the office does', async () => {
    const locker = pointById('econt', '4068');
    const d = await decide(
      { address1: 'ул. Тестова 3', city: 'Пловдив' },
      { 'ул. Тестова 3': northOf(locker as Required<typeof locker>, 0.1) },
    );
    expect(d.rule).toBe('E');
    expect(onlyOffices(d)).toBe(true);
    if (d.suggestion) {
      expect(d.certainty).toBe('uncertain');
      expect(d.suggestion.type).toBe('office');
    } else {
      // No office within 1 km of that spot: the owner's middle way sends it to the address.
      expect([d.certainty, d.deliveryType]).toEqual(['certain', 'address']);
    }
  });

  it('middle way: no office within range → certain to the address only when complete and found', async () => {
    const far = { lat: 42.9, lng: 25.1 };
    const street = await decide(
      { address1: 'ул. Дълга 7', city: 'Малко село' },
      { 'ул. Дълга 7': { ...far, precision: 'street' } },
    );
    expect([street.rule, street.certainty, street.deliveryType]).toEqual([
      'E',
      'certain',
      'address',
    ]);
    expect(codes(street)).toEqual(['no_point_in_range_home', 'home_carrier_later']);
    expect(street.reasons[0]!.bg).toBe('Няма офис до 1 км, адресът е пълен — изпращаме до адреса.');

    // Only the town found: the distance means nothing → still a call.
    const town = await decide(
      { address1: 'ул. Дълга 8', city: 'Малко село' },
      { 'ул. Дълга 8': { ...far, precision: 'city' } },
    );
    expect([town.certainty, town.deliveryType]).toEqual(['uncertain', 'address']);

    // No number: not complete → a call, and the reason says why.
    const noNumber = await decide(
      { address1: 'ул. Дълга', city: 'Малко село' },
      { 'ул. Дълга': { ...far, precision: 'street' } },
    );
    expect(noNumber.certainty).toBe('uncertain');
    expect(codes(noNumber)).toEqual(['no_point_in_range', 'address_incomplete']);

    // The customer asked for an office (none near): never sent home without a call.
    const askedOffice = await decide(
      { address1: 'до офис, ул. Дълга 9', city: 'Малко село' },
      { 'до офис, ул. Дълга 9': { ...far, precision: 'street' } },
    );
    expect(askedOffice.certainty).toBe('uncertain');
  });

  it('the call script says "офис", not "офис или автомат"', async () => {
    const d = await decide({ address1: 'Спиди', city: 'Пловдив' });
    const script = callScript({ ...d, suggestion: null, deliveryType: null }, '#2008');
    expect(script).toMatch(/До кой офис на Спиди/);
    expect(script).not.toMatch(/автомат/);
    expect(
      callScript({ ...d, suggestion: null, deliveryType: null }, '#2008', {
        pointTypes: ['office', 'locker'],
      }),
    ).toMatch(/офис или автомат/);
  });
});
