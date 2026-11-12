import { formatDateTime } from '@happyhome/core';
import {
  batchView,
  buildBatchWorkbook,
  cellValue,
  columnHeader,
  columnType,
  normalizeVisibleColumns,
  PHOTO_HEADER,
  sofiaDate,
  type BatchView,
  type StoredFlag,
  type StoredOrder,
} from '@happyhome/core/import';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { useMember } from '../auth/AuthProvider';
import { FlagList, type FlagItem } from '../components/FlagBadge';
import { Icon } from '../components/Icon';
import { currentLocale, intlLocale } from '../i18n';
import { formatBytes, saveFile } from '../lib/download';
import { useSettings } from '../lib/settings';
import { supabase } from '../lib/supabase';
import { ArchiveStateText, BATCH_COLUMNS, SummaryLine, type BatchRow } from './ImportPage';

interface BatchFlag extends StoredFlag {
  id: string;
  reason_bg: string | null;
  reason_en: string | null;
}

interface LoadedBatch {
  batch: BatchRow & {
    encoding: string | null;
    row_count: number | null;
    storage_path: string | null;
  };
  stored: StoredOrder[];
  emails: Map<string, string | null>;
  outcomes: Map<string, string>;
  flags: BatchFlag[];
  uploader: string | null;
  photos: Map<string, string>;
}

const PAGE = 1000;

async function loadBatch(id: string): Promise<LoadedBatch | null> {
  const { data: batch, error } = await supabase
    .from('import_batches')
    .select(`${BATCH_COLUMNS}, encoding, row_count, storage_path`)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!batch) return null;

  type Link = {
    outcome: string;
    first_row: number | null;
    orders: {
      id: string;
      name: string;
      email: string | null;
      raw: Record<string, string>;
      order_lines: {
        line_no: number;
        source_row: number | null;
        raw: Record<string, string>;
        sku: string | null;
      }[];
    } | null;
  };
  const links: Link[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error: linkError } = await supabase
      .from('import_batch_orders')
      .select(
        'outcome, first_row, orders(id, name, email, raw, order_lines(line_no, source_row, raw, sku))',
      )
      .eq('batch_id', id)
      .order('first_row')
      .range(from, from + PAGE - 1);
    if (linkError) throw linkError;
    links.push(...((data ?? []) as unknown as Link[]));
    if (!data || data.length < PAGE) break;
  }

  const stored: StoredOrder[] = [];
  const emails = new Map<string, string | null>();
  const outcomes = new Map<string, string>();
  const skus = new Set<string>();
  for (const l of links) {
    if (!l.orders) continue;
    const o = l.orders;
    stored.push({
      id: o.id,
      name: o.name,
      first_row: l.first_row,
      raw: o.raw,
      lines: o.order_lines.map((x) => ({
        line_no: x.line_no,
        source_row: x.source_row,
        raw: x.raw,
      })),
    });
    emails.set(o.name, o.email);
    outcomes.set(o.name, l.outcome);
    o.order_lines.forEach((x) => x.sku && skus.add(x.sku));
  }

  const flagColumns =
    'id, severity, code, message_bg, message_en, reason_bg, reason_en, source_row, details, order_id';
  const { data: fileFlags } = await supabase
    .from('flags')
    .select(flagColumns)
    .eq('import_batch_id', id)
    .is('resolved_at', null);
  const orderFlags: typeof fileFlags = [];
  const ids = stored.map((s) => s.id);
  const nameOf = new Map(stored.map((s) => [s.id, s.name]));
  for (let i = 0; i < ids.length; i += 150) {
    const { data } = await supabase
      .from('flags')
      .select(flagColumns)
      .in('order_id', ids.slice(i, i + 150))
      .is('resolved_at', null);
    orderFlags.push(...(data ?? []));
  }
  const flags: BatchFlag[] = [...(fileFlags ?? []), ...orderFlags].map((f) => {
    const orderName = f.order_id ? (nameOf.get(f.order_id) ?? null) : null;
    return {
      id: f.id,
      severity: f.severity as BatchFlag['severity'],
      code: f.code,
      message_bg: f.message_bg,
      message_en: f.message_en,
      reason_bg: f.reason_bg,
      reason_en: f.reason_en,
      order_name: orderName,
      email: orderName ? (emails.get(orderName) ?? null) : null,
      source_row: f.source_row,
      details: (f.details ?? null) as BatchFlag['details'],
    };
  });

  let uploader: string | null = null;
  if (batch.uploaded_by) {
    const { data: m } = await supabase
      .from('members')
      .select('display_name')
      .eq('user_id', batch.uploaded_by)
      .maybeSingle();
    uploader = m?.display_name ?? null;
  }

  // Product photos (Phase 6 fills the product library; until then the cells stay empty).
  const photos = new Map<string, string>();
  if (skus.size) {
    const { data: products } = await supabase
      .from('products')
      .select('sku, photo_path')
      .in('sku', [...skus].slice(0, 300))
      .not('photo_path', 'is', null);
    const withPhoto = (products ?? []).filter((p) => p.sku && p.photo_path);
    if (withPhoto.length) {
      const { data: signed } = await supabase.storage.from('product-photos').createSignedUrls(
        withPhoto.map((p) => p.photo_path!),
        3600,
      );
      withPhoto.forEach((p, i) => {
        const url = signed?.[i]?.signedUrl;
        if (url) photos.set(p.sku!, url);
      });
    }
  }

  return {
    batch: batch as unknown as LoadedBatch['batch'],
    stored,
    emails,
    outcomes,
    flags,
    uploader,
    photos,
  };
}

function toItems(flags: BatchFlag[], locale: 'bg' | 'en'): FlagItem[] {
  const rank = { red: 0, amber: 1, info: 2 };
  return [...flags]
    .sort((a, b) => rank[a.severity] - rank[b.severity])
    .map((f) => ({
      id: f.id,
      severity: f.severity,
      message: locale === 'bg' ? f.message_bg : f.message_en,
      reason: locale === 'bg' ? f.reason_bg : f.reason_en,
      order: f.order_name,
    }));
}

function BatchTable({
  view,
  columns,
  photos,
}: {
  view: BatchView;
  columns: string[];
  photos: Map<string, string>;
}) {
  const { t } = useTranslation();
  return (
    <div className="table-wrap">
      <table className="table batch-table" data-testid="batch-table">
        <thead>
          <tr>
            <th className="mark-col">
              <span className="sr-only">{t('batch.multiRow')}</span>
            </th>
            {columns.map((c) => (
              <th key={c} data-column={c}>
                {columnHeader(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {view.rows.map((r) => (
            <tr
              key={`${r.order.key}:${r.line.row}:${r.line.out.join('|').length}`}
              className={[r.multi ? 'row-multi' : '', r.sep ? `row-${r.sep}` : ''].join(' ')}
              data-order={r.order.name}
            >
              <td className="mark-col">
                {r.multi && (
                  <span title={t('batch.multiRow')}>
                    <Icon name="multi" />
                    <span className="sr-only">{t('batch.multiRow')}</span>
                  </span>
                )}
              </td>
              {columns.map((c) => {
                if (c === PHOTO_HEADER) {
                  const sku = cellValue(r, 'Lineitem sku').trim();
                  const url = sku ? photos.get(sku) : undefined;
                  return (
                    <td key={c} className="photo-cell">
                      {url ? (
                        <img src={url} alt={cellValue(r, 'Lineitem name')} width={64} height={64} />
                      ) : (
                        <span className="photo-empty">{t('batch.noPhoto')}</span>
                      )}
                    </td>
                  );
                }
                return (
                  <td key={c} className={columnType(c) === 'text' ? undefined : 'num'}>
                    {cellValue(r, c)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BatchPage() {
  const { t } = useTranslation();
  const { batchId = '' } = useParams();
  const member = useMember();
  const settings = useSettings();
  // Keyed by batch id, so opening another batch shows "loading" without resetting state in the effect.
  const [loaded, setLoaded] = useState<{ id: string; data: LoadedBatch | null } | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);
  const data = loaded?.id === batchId ? loaded.data : undefined;
  const failed = failedId === batchId;
  const locale = currentLocale();

  useEffect(() => {
    let cancelled = false;
    loadBatch(batchId)
      .then((d) => {
        if (!cancelled) setLoaded({ id: batchId, data: d });
      })
      .catch(() => {
        if (!cancelled) setFailedId(batchId);
      });
    return () => {
      cancelled = true;
    };
  }, [batchId]);

  const view = useMemo(() => (data ? batchView(data.stored) : null), [data]);
  const columns = normalizeVisibleColumns(settings.values?.visible_columns);

  if (member.role !== 'owner') {
    return (
      <section>
        <p className="badge badge-info">
          <Icon name="info" /> {t('import.ownerOnly')}
        </p>
      </section>
    );
  }
  if (failed) return <p className="badge badge-error">{t('batch.loadFailed')}</p>;
  if (data === undefined || !view) return <p role="status">{t('batch.loading')}</p>;
  if (data === null) return <p>{t('batch.notFound')}</p>;

  const b = data.batch;
  const fileFlags = data.flags.filter((f) => !f.order_name);
  const orderFlags = data.flags.filter((f) => f.order_name);
  const csvStored = !!b.storage_path && !b.raw_deleted_at;

  const downloadExcel = () => {
    const bytes = buildBatchWorkbook(view, data.flags, {
      fileName: b.file_name,
      locale,
      visibleColumns: columns,
    });
    const base = b.file_name.replace(/\.csv$/i, '');
    saveFile(
      bytes,
      `shipping-orders-${sofiaDate(b.created_at)}-${base}.xlsx`,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  };
  const downloadCsv = async () => {
    const { data: blob } = await supabase.storage.from('raw-imports').download(b.storage_path!);
    if (blob) saveFile(blob, b.file_name, 'text/csv');
  };

  return (
    <section>
      <p>
        <Link to="/import">{t('batch.back')}</Link>
      </p>
      <h1 data-testid="batch-title">{b.file_name}</h1>
      <p>
        <SummaryLine
          counts={{
            new: b.orders_new,
            updated: b.orders_updated,
            unchanged: b.orders_unchanged,
            skipped: b.orders_skipped,
            to_check: b.orders_to_check,
          }}
        />
      </p>
      <dl className="kv card">
        <dt>{t('batch.importedAt')}</dt>
        <dd>{formatDateTime(b.created_at, locale)}</dd>
        {data.uploader && (
          <>
            <dt>{t('batch.importedBy')}</dt>
            <dd>{data.uploader}</dd>
          </>
        )}
        <dt>{t('batch.rows')}</dt>
        <dd>{b.row_count ?? '—'}</dd>
        <dt>{t('batch.size')}</dt>
        <dd>{formatBytes(b.file_size_bytes, intlLocale())}</dd>
        <dt>{t('batch.encoding')}</dt>
        <dd>{b.encoding ?? '—'}</dd>
        <dt>{t('batch.checksum')}</dt>
        <dd>
          <code className="wrap-anywhere">{b.sha256}</code>
        </dd>
        <dt>{t('batch.csvFile')}</dt>
        <dd data-testid="batch-archive-state">
          <ArchiveStateText batch={b} />
        </dd>
      </dl>

      <div className="row actions">
        <button
          type="button"
          className="button-primary"
          onClick={downloadExcel}
          data-testid="download-excel"
        >
          {t('batch.downloadExcel')}
        </button>
        <button
          type="button"
          disabled={!csvStored}
          onClick={() => void downloadCsv()}
          data-testid="download-csv"
        >
          {t('batch.downloadCsv')}
        </button>
      </div>
      {!csvStored && b.archived_at && (
        <p className="muted">
          {t('batch.csvGone', {
            where: b.archived_path
              ? `${b.archived_on ?? ''}: ${b.archived_path}`
              : (b.archived_on ?? ''),
          })}
        </p>
      )}

      <h2>{t('batch.problems')}</h2>
      {data.flags.length === 0 && <p className="muted">{t('batch.noProblems')}</p>}
      {fileFlags.length > 0 && (
        <div className="card">
          <h3>{t('batch.fileProblems')}</h3>
          <FlagList flags={toItems(fileFlags, locale)} />
        </div>
      )}
      {orderFlags.length > 0 && (
        <div className="card" data-testid="order-flags">
          <FlagList flags={toItems(orderFlags, locale)} />
        </div>
      )}

      <h2>{t('batch.lines')}</h2>
      <p className="muted">
        {t('batch.linesCount', { orders: view.counts.orders, rows: view.counts.productRows })} ·{' '}
        {t('batch.columnsHint')}
      </p>
      {view.rows.some((r) => r.multi) && (
        <p className="legend">
          <span className="swatch" aria-hidden="true" /> {t('batch.multiLegend')}
        </p>
      )}
      <BatchTable view={view} columns={columns} photos={data.photos} />
    </section>
  );
}
