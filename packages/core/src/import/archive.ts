/**
 * Archiving raw CSV files to a folder on the owner's computer (P2-16 … P2-23).
 * Pure helpers: file names, the retention rule and choosing a free name.
 * The file writing itself lives in the web app (File System Access API) and,
 * later, in the desktop app (Node file access).
 */
import { APP_TIME_ZONE } from '../locale';

/** Characters Windows does not allow in file names, and control characters. */
const BAD_FILE_CHARS = /[<>:"/\\|?*\p{Cc}]/gu;

export function safeFileName(name: string): string {
  const cleaned = name
    .replace(BAD_FILE_CHARS, '_')
    .replace(/[. ]+$/, '')
    .trim();
  return cleaned || 'orders';
}

/** Calendar date (YYYY-MM-DD) of an instant in Bulgarian time. */
export function sofiaDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export interface ArchiveName {
  /** sub-folder: the import year */
  dir: string;
  /** <import date>_<original file name>.csv */
  file: string;
}

/** `<folder>/<year>/<import date>_<original file name>.csv` (import date in Bulgarian time). */
export function archiveName(originalName: string, importedAt: Date | string): ArchiveName {
  const date = sofiaDate(importedAt);
  const base = safeFileName(originalName).replace(/\.csv$/i, '');
  return { dir: date.slice(0, 4), file: `${date}_${base}.csv` };
}

/** "name.csv" -> "name (2).csv" for n = 2, … */
export function withSuffix(file: string, n: number): string {
  if (n <= 1) return file;
  const m = /^(.*?)(\.[^.]*)?$/.exec(file)!;
  return `${m[1]} (${n})${m[2] ?? ''}`;
}

/** The first name that does not exist yet: never overwrite an existing file. */
export async function firstFreeName(
  file: string,
  exists: (candidate: string) => Promise<boolean>,
  maxTries = 1000,
): Promise<string> {
  for (let n = 1; n <= maxTries; n++) {
    const candidate = withSuffix(file, n);
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error(`No free file name for ${file}`);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A raw CSV is due for archiving once it is older than settings.raw_csv_retention_days. */
export function isPastRetention(
  importedAt: Date | string,
  retentionDays: number,
  now = new Date(),
): boolean {
  const t = (importedAt instanceof Date ? importedAt : new Date(importedAt)).getTime();
  return now.getTime() - t > retentionDays * DAY_MS;
}
