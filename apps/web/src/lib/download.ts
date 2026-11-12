/** Hands the browser a file to save (Excel, CSV, ZIP). */
export function saveFile(data: Blob | Uint8Array, fileName: string, type: string): void {
  const blob = data instanceof Blob ? data : new Blob([data as Uint8Array<ArrayBuffer>], { type });
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 30_000);
}

/** "1,2 MB" style size in the UI language. */
export function formatBytes(bytes: number | null | undefined, locale: string): string {
  if (bytes == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: u ? 1 : 0 }).format(n)} ${units[u]}`;
}
