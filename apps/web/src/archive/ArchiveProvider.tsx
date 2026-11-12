/**
 * Raw CSV archive for the owner (P2-16 … P2-22). When the owner opens the app:
 *   1. files older than settings.raw_csv_retention_days move to "waiting" (never deleted);
 *   2. if this computer has a chosen folder with permission, each waiting file is
 *      saved there, checked, recorded, and only then deleted from cloud storage;
 *   3. otherwise the files keep waiting and the banner shows how many.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  archiveToFolder,
  buildArchiveZip,
  confirmZipDownloaded,
  needsArchiveWork,
  type ArchiveBatch,
  type ArchiveFolder,
  type ArchiveOutcome,
  type ZipArchive,
} from './archiver';
import {
  desktopFolder,
  folderAccessSupported,
  folderPermission,
  handleFolder,
  pickFolder,
} from './folder';
import { defaultComputerName, loadLocal, saveLocal } from './localStore';
import { loadArchiveWork, markDue, supabaseArchiveBackend } from './supabaseBackend';

export type FolderState =
  | { kind: 'desktop'; name: string }
  | { kind: 'none' }
  | { kind: 'chosen'; name: string; permission: 'granted' | 'prompt' | 'denied' }
  | { kind: 'unsupported' };

interface ArchiveContextValue {
  /** files that still need archive work */
  waiting: ArchiveBatch[];
  folder: FolderState;
  computer: string;
  busy: boolean;
  results: ArchiveOutcome[];
  error: boolean;
  zip: ZipArchive | null;
  chooseFolder: () => Promise<void>;
  allowFolder: () => Promise<void>;
  archiveNow: () => Promise<void>;
  prepareZip: () => Promise<ZipArchive | null>;
  confirmZip: () => Promise<void>;
  setComputer: (name: string) => Promise<void>;
  refresh: () => Promise<void>;
}

const ArchiveContext = createContext<ArchiveContextValue | null>(null);

const FOLDER_KEY = 'folder';
const COMPUTER_KEY = 'computer';

export function ArchiveProvider({ children }: { children: ReactNode }) {
  const [waiting, setWaiting] = useState<ArchiveBatch[]>([]);
  const [folder, setFolder] = useState<FolderState>({ kind: 'none' });
  const [computer, setComputerState] = useState(defaultComputerName());
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ArchiveOutcome[]>([]);
  const [error, setError] = useState(false);
  const [zipArchive, setZip] = useState<ZipArchive | null>(null);
  const handleRef = useRef<FileSystemDirectoryHandle | null>(null);
  const computerRef = useRef(computer);
  const running = useRef(false);

  const writableFolder = useCallback(async (): Promise<ArchiveFolder | null> => {
    const desktop = desktopFolder();
    if (desktop) return desktop;
    const handle = handleRef.current;
    if (!handle) return null;
    return (await folderPermission(handle)) === 'granted' ? handleFolder(handle) : null;
  }, []);

  const refresh = useCallback(async () => {
    try {
      setWaiting((await loadArchiveWork()).filter(needsArchiveWork));
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  /** Archives every waiting file into the folder, if there is one with permission. */
  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const target = await writableFolder();
      const work = (await loadArchiveWork()).filter(needsArchiveWork);
      if (target && work.length) {
        const out = await archiveToFolder(
          work,
          target,
          supabaseArchiveBackend,
          computerRef.current,
        );
        setResults(out);
      }
      await refresh();
    } catch {
      setError(true);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, [refresh, writableFolder]);

  // On app open (owner): load this computer's folder, move due files to waiting, archive.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const name = await loadLocal<string>(COMPUTER_KEY);
      if (name && !cancelled) {
        computerRef.current = name;
        setComputerState(name);
      }
      const desktop = desktopFolder();
      if (desktop) setFolder({ kind: 'desktop', name: desktop.name });
      else if (!folderAccessSupported()) setFolder({ kind: 'unsupported' });
      else {
        const handle = await loadLocal<FileSystemDirectoryHandle>(FOLDER_KEY);
        if (handle && !cancelled) {
          handleRef.current = handle;
          let permission: 'granted' | 'prompt' | 'denied';
          try {
            permission = await folderPermission(handle);
          } catch {
            permission = 'prompt';
          }
          setFolder({ kind: 'chosen', name: handle.name, permission });
        }
      }
      try {
        await markDue(false);
      } catch {
        if (!cancelled) setError(true);
      }
      if (!cancelled) await run();
    })();
    return () => {
      cancelled = true;
    };
  }, [run]);

  const chooseFolder = useCallback(async () => {
    const handle = await pickFolder();
    if (!handle) return;
    handleRef.current = handle;
    await saveLocal(FOLDER_KEY, handle);
    setFolder({
      kind: 'chosen',
      name: handle.name,
      permission: await folderPermission(handle, true),
    });
    await run();
  }, [run]);

  const allowFolder = useCallback(async () => {
    const handle = handleRef.current;
    if (!handle) return;
    const permission = await folderPermission(handle, true);
    setFolder({ kind: 'chosen', name: handle.name, permission });
    if (permission === 'granted') await run();
  }, [run]);

  const archiveNow = useCallback(async () => {
    setBusy(true);
    try {
      await markDue(true);
    } catch {
      setError(true);
    }
    await run();
    setBusy(false);
  }, [run]);

  const prepareZip = useCallback(async () => {
    setBusy(true);
    try {
      await markDue(true);
      const work = (await loadArchiveWork()).filter(needsArchiveWork);
      const archive = await buildArchiveZip(work, supabaseArchiveBackend);
      setZip(archive);
      setResults(archive.failed);
      await refresh();
      return archive;
    } catch {
      setError(true);
      return null;
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const confirmZip = useCallback(async () => {
    if (!zipArchive) return;
    setBusy(true);
    try {
      setResults(
        await confirmZipDownloaded(zipArchive.entries, supabaseArchiveBackend, computerRef.current),
      );
      setZip(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh, zipArchive]);

  const setComputer = useCallback(async (name: string) => {
    const clean = name.trim().slice(0, 60) || defaultComputerName();
    computerRef.current = clean;
    setComputerState(clean);
    await saveLocal(COMPUTER_KEY, clean);
  }, []);

  const value = useMemo<ArchiveContextValue>(
    () => ({
      waiting,
      folder,
      computer,
      busy,
      results,
      error,
      zip: zipArchive,
      chooseFolder,
      allowFolder,
      archiveNow,
      prepareZip,
      confirmZip,
      setComputer,
      refresh,
    }),
    [
      waiting,
      folder,
      computer,
      busy,
      results,
      error,
      zipArchive,
      chooseFolder,
      allowFolder,
      archiveNow,
      prepareZip,
      confirmZip,
      setComputer,
      refresh,
    ],
  );

  return <ArchiveContext.Provider value={value}>{children}</ArchiveContext.Provider>;
}

/** null outside the provider (packers have no archive). */
// eslint-disable-next-line react-refresh/only-export-components
export function useArchive(): ArchiveContextValue | null {
  return useContext(ArchiveContext);
}
