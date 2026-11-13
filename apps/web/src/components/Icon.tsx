/**
 * Status icons. Colour is never the only signal: every status shows an icon AND
 * a word (brief section 2). Icons are decorative; the word carries the meaning.
 */
const ICONS = {
  ok: '✅',
  warn: '⚠️',
  error: '⛔',
  info: 'ℹ️',
  live: '🟢',
  offline: '🔴',
  wait: '⏳',
  eyes: '👀',
  check: '✔',
  /** same customer / many products (the legacy yellow rows) */
  multi: '◆',
  drag: '⠿',
  phone: '📞',
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name }: { name: IconName }) {
  return <span aria-hidden="true">{ICONS[name]}</span>;
}
