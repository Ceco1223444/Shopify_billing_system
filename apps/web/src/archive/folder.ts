/**
 * The archive folder on this computer.
 *  - Chrome / Edge: File System Access API. The folder handle is kept in IndexedDB;
 *    the browser may ask again for permission (then a button asks for it).
 *  - Desktop app (later phase): window.happyhomeDesktop.archiveFolder, which writes
 *    with Node file access to the folder chosen once in the desktop app — no prompts.
 *    Browsers never reveal a folder's full path, so the desktop app asks for the
 *    folder once with its own dialog.
 *  - Other browsers (Firefox, Safari): no folder access; the app offers a ZIP download.
 */
import type { ArchiveFolder } from './archiver';

type Permission = 'granted' | 'denied' | 'prompt';

interface PermissionHandle {
  queryPermission?: (d: { mode: 'readwrite' }) => Promise<Permission>;
  requestPermission?: (d: { mode: 'readwrite' }) => Promise<Permission>;
}

interface WritableFile {
  write(data: BufferSource): Promise<void>;
  close(): Promise<void>;
}

export interface DesktopArchiveFolder extends ArchiveFolder {
  /** shown to the owner, e.g. "D:\HappyHome\CSV" */
  name: string;
}

declare global {
  interface Window {
    showDirectoryPicker?: (options?: {
      id?: string;
      mode?: 'readwrite';
    }) => Promise<FileSystemDirectoryHandle>;
    happyhomeDesktop?: { archiveFolder?: DesktopArchiveFolder };
  }
}

export function desktopFolder(): DesktopArchiveFolder | null {
  return (typeof window !== 'undefined' && window.happyhomeDesktop?.archiveFolder) || null;
}

export function folderAccessSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

/** Opens the browser's folder picker (needs a click). */
export async function pickFolder(): Promise<FileSystemDirectoryHandle | null> {
  if (!window.showDirectoryPicker) return null;
  try {
    return await window.showDirectoryPicker({ id: 'happyhome-csv-archive', mode: 'readwrite' });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return null; // the owner closed the picker
    throw e;
  }
}

/** Current permission; with `ask` the browser shows its prompt (only from a click). */
export async function folderPermission(
  handle: FileSystemDirectoryHandle,
  ask = false,
): Promise<Permission> {
  const h = handle as unknown as PermissionHandle;
  if (!h.queryPermission) return 'granted';
  const now = await h.queryPermission({ mode: 'readwrite' });
  if (now === 'granted' || !ask || !h.requestPermission) return now;
  return h.requestPermission({ mode: 'readwrite' });
}

function isNotFound(e: unknown): boolean {
  return (
    e instanceof DOMException && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')
  );
}

export function handleFolder(root: FileSystemDirectoryHandle): ArchiveFolder {
  return {
    async exists(dir, file) {
      try {
        const d = await root.getDirectoryHandle(dir);
        await d.getFileHandle(file);
        return true;
      } catch (e) {
        if (isNotFound(e)) return false;
        throw e;
      }
    },
    async write(dir, file, bytes) {
      const d = await root.getDirectoryHandle(dir, { create: true });
      try {
        await d.getFileHandle(file);
        throw new Error(`${dir}/${file} already exists`); // never overwrite
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
      const handle = await d.getFileHandle(file, { create: true });
      const writable = (await (
        handle as unknown as { createWritable(): Promise<WritableFile> }
      ).createWritable()) as WritableFile;
      await writable.write(bytes as Uint8Array<ArrayBuffer>);
      await writable.close();
    },
    async read(dir, file) {
      const d = await root.getDirectoryHandle(dir);
      const f = await (await d.getFileHandle(file)).getFile();
      return new Uint8Array(await f.arrayBuffer());
    },
  };
}
