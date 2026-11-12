import { formatDate, formatDateTime } from '@happyhome/core';
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useMember } from '../auth/AuthProvider';
import { FlagList } from '../components/FlagBadge';
import { Icon } from '../components/Icon';
import { currentLocale, intlLocale } from '../i18n';
import { formatBytes } from '../lib/download';
import { supabase } from '../lib/supabase';
import {
  importOneFile,
  type ImportCounts,
  type ImportFailure,
  type ImportOutcome,
  type ImportStage,
} from './runImport';

interface FileJob {
  key: string;
  file: File;
  stage: ImportStage | null;
  outcome: ImportOutcome | null;
}

export interface BatchRow {
  id: string;
  created_at: string;
  file_name: string;
  file_size_bytes: number | null;
  sha256: string;
  orders_new: number;
  orders_updated: number;
  orders_unchanged: number;
  orders_skipped: number;
  orders_to_check: number;
  archive_state: 'stored' | 'waiting' | 'archived';
  archived_at: string | null;
  archived_on: string | null;
  archived_path: string | null;
  archive_method: 'folder' | 'zip' | null;
  raw_deleted_at: string | null;
  uploaded_by: string | null;
}

export const BATCH_COLUMNS =
  'id, created_at, file_name, file_size_bytes, sha256, orders_new, orders_updated, orders_unchanged, ' +
  'orders_skipped, orders_to_check, archive_state, archived_at, archived_on, archived_path, ' +
  'archive_method, raw_deleted_at, uploaded_by';

/** "12 нови поръчки · 3 вече внесени · 1 променена · 2 за проверка" */
export function SummaryLine({ counts }: { counts: ImportCounts }) {
  const { t } = useTranslation();
  const parts = [t('import.summary.new', { count: counts.new })];
  if (counts.unchanged) parts.push(t('import.summary.unchanged', { count: counts.unchanged }));
  if (counts.updated) parts.push(t('import.summary.updated', { count: counts.updated }));
  if (counts.to_check) parts.push(t('import.summary.toCheck', { count: counts.to_check }));
  if (counts.skipped) parts.push(t('import.summary.skipped', { count: counts.skipped }));
  return <span data-testid="import-summary">{parts.join(' · ')}</span>;
}

export function ArchiveStateText({ batch }: { batch: BatchRow }) {
  const { t } = useTranslation();
  const locale = currentLocale();
  if (batch.archive_state === 'archived' && batch.archived_at) {
    const date = formatDate(batch.archived_at, locale);
    return batch.archive_method === 'zip'
      ? t('import.archive.archivedZip', { date, computer: batch.archived_on ?? '' })
      : t('import.archive.archivedOn', {
          date,
          computer: batch.archived_on ?? '',
          path: batch.archived_path ?? '',
        });
  }
  return batch.archive_state === 'waiting'
    ? t('import.archive.waiting')
    : t('import.archive.stored');
}

const FAILURE_TEXT = {
  offline: 'import.failedOffline',
  not_ready: 'import.failedNotReady',
  service: 'import.failedService',
  owner_only: 'import.failedOwnerOnly',
  other: 'import.failed',
} as const satisfies Record<ImportFailure, string>;

function JobCard({ job }: { job: FileJob }) {
  const { t } = useTranslation();
  const o = job.outcome;
  return (
    <li className="card import-card" data-testid="import-card">
      <p className="import-card-name">
        <strong>{job.file.name}</strong>
      </p>
      {!o && job.stage && (
        <p className="badge badge-info" role="status">
          <Icon name="wait" /> {t(`import.stage.${job.stage}`)}
        </p>
      )}
      {o?.kind === 'done' && (
        <div className="row">
          <p className="badge badge-ok" data-testid="import-done">
            <Icon name="ok" /> {t('import.done')}: <SummaryLine counts={o.counts} />
          </p>
          <Link to={`/import/${o.batchId}`}>{t('import.open')}</Link>
        </div>
      )}
      {o?.kind === 'duplicate' && (
        <div>
          <p className="badge badge-warn" data-testid="import-duplicate" role="alert">
            <Icon name="warn" />{' '}
            {t('import.duplicate', {
              date: o.batch ? formatDateTime(o.batch.created_at, currentLocale()) : '—',
              name: o.batch?.file_name ?? job.file.name,
            })}
          </p>
          {o.batch && <Link to={`/import/${o.batch.id}`}>{t('import.duplicateOpen')}</Link>}
        </div>
      )}
      {o?.kind === 'not_importable' && (
        <div data-testid="import-refused" role="alert">
          <p className="badge badge-error">
            <Icon name="error" /> {t('import.notImportable')}
          </p>
          <FlagList
            flags={o.flags.map((f, i) => ({
              id: String(i),
              severity: f.severity,
              message: currentLocale() === 'bg' ? f.message_bg : f.message_en,
              reason: null,
              order: null,
            }))}
          />
        </div>
      )}
      {o?.kind === 'failed' && (
        <p className="badge badge-error" role="alert" data-testid="import-failed">
          <Icon name="error" /> {t(FAILURE_TEXT[o.reason])}
        </p>
      )}
    </li>
  );
}

function BatchHistory({ version }: { version: number }) {
  const { t } = useTranslation();
  const [batches, setBatches] = useState<BatchRow[] | null>(null);
  const locale = currentLocale();

  useEffect(() => {
    let cancelled = false;
    void supabase
      .from('import_batches')
      .select(BATCH_COLUMNS)
      .order('created_at', { ascending: false })
      .limit(500)
      .then(({ data }) => {
        if (!cancelled) setBatches((data ?? []) as unknown as BatchRow[]);
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  if (!batches) return <p className="muted">{t('app.loading')}</p>;
  if (!batches.length) return <p className="muted">{t('import.history.empty')}</p>;
  return (
    <div className="table-wrap">
      <table className="table" data-testid="batch-history">
        <thead>
          <tr>
            <th>{t('import.history.date')}</th>
            <th>{t('import.history.file')}</th>
            <th>{t('import.history.orders')}</th>
            <th>{t('import.history.size')}</th>
            <th>{t('import.history.csv')}</th>
            <th>{t('import.history.checksum')}</th>
          </tr>
        </thead>
        <tbody>
          {batches.map((b) => (
            <tr key={b.id}>
              <td>{formatDateTime(b.created_at, locale)}</td>
              <td>
                <Link to={`/import/${b.id}`}>{b.file_name}</Link>
              </td>
              <td>
                <SummaryLine
                  counts={{
                    new: b.orders_new,
                    updated: b.orders_updated,
                    unchanged: b.orders_unchanged,
                    skipped: b.orders_skipped,
                    to_check: b.orders_to_check,
                  }}
                />
              </td>
              <td className="num">{formatBytes(b.file_size_bytes, intlLocale())}</td>
              <td>
                <ArchiveStateText batch={b} />
              </td>
              <td>
                <code title={b.sha256}>{b.sha256.slice(0, 12)}…</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ImportPage() {
  const { t } = useTranslation();
  const member = useMember();
  const [jobs, setJobs] = useState<FileJob[]>([]);
  const [current, setCurrent] = useState<{ index: number; total: number; name: string } | null>(
    null,
  );
  const [over, setOver] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());

  const addFiles = useCallback((list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (!files.length) return;
    const added = files.map((file, i) => ({
      key: `${Date.now()}-${i}-${file.name}`,
      file,
      stage: null,
      outcome: null,
    }));
    setJobs((j) => [...added, ...j]);
    const update = (key: string, patch: Partial<FileJob>) =>
      setJobs((all) => all.map((j) => (j.key === key ? { ...j, ...patch } : j)));
    // One file after another: overlapping files are matched against what is already stored.
    queue.current = queue.current.then(async () => {
      for (const [i, job] of added.entries()) {
        setCurrent({ index: i + 1, total: added.length, name: job.file.name });
        let outcome: ImportOutcome;
        try {
          outcome = await importOneFile(job.file, (stage) => update(job.key, { stage }));
        } catch {
          outcome = { kind: 'failed', reason: 'other' };
        }
        update(job.key, { outcome, stage: null });
        if (outcome.kind === 'done') setHistoryVersion((v) => v + 1);
      }
      setCurrent(null);
    });
  }, []);

  if (member.role !== 'owner') {
    return (
      <section>
        <h1>{t('pages.import.title')}</h1>
        <p className="badge badge-info" data-testid="import-owner-only">
          <Icon name="info" /> {t('import.ownerOnly')}
        </p>
      </section>
    );
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    addFiles(e.dataTransfer.files);
  };

  return (
    <section>
      <h1>{t('pages.import.title')}</h1>
      <p>{t('pages.import.intro')}</p>

      <div
        className={`dropzone${over ? ' dropzone-over' : ''}`}
        data-testid="dropzone"
        role="button"
        tabIndex={0}
        onClick={() => input.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            input.current?.click();
          }
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <span className="dropzone-icon" aria-hidden="true">
          📥
        </span>
        <strong>{t('import.drop.title')}</strong>
        <span className="muted">{t('import.drop.hint')}</span>
        <span className="button-primary dropzone-button">{t('import.drop.button')}</span>
        <input
          ref={input}
          type="file"
          accept=".csv,text/csv,text/plain"
          multiple
          hidden
          data-testid="file-input"
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {current && (
        <div className="card" role="status" data-testid="import-progress">
          <p>
            {t('import.progress', {
              current: current.index,
              total: current.total,
              name: current.name,
            })}
          </p>
          <progress max={current.total} value={current.index - 1} />
        </div>
      )}

      {jobs.length > 0 && (
        <ul className="import-cards">
          {jobs.map((job) => (
            <JobCard key={job.key} job={job} />
          ))}
        </ul>
      )}

      <h2>{t('import.history.title')}</h2>
      <BatchHistory version={historyVersion} />
    </section>
  );
}
