import {
  columnCatalog,
  columnHeader,
  DEFAULT_VISIBLE_COLUMNS,
  hiddenColumnsFor,
  normalizeVisibleColumns,
} from '@happyhome/core/import';
import type { Json } from '@happyhome/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../components/Icon';
import type { SettingValue } from '../lib/settings';
import { supabase } from '../lib/supabase';

interface Item {
  name: string;
  shown: boolean;
}

function move<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length || from === to) return list;
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

/** P2-10: every column found in the imported files; show/hide and reorder. */
export function ColumnChooser({
  visible,
  save,
}: {
  visible: Json | undefined;
  save: (entries: Record<string, SettingValue>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [items, setItems] = useState<Item[] | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');

  useEffect(() => {
    let cancelled = false;
    void supabase
      .from('import_batches')
      .select('columns')
      .limit(1000)
      .then(({ data }) => {
        if (cancelled) return;
        const chosen = normalizeVisibleColumns(visible);
        const catalog = columnCatalog(
          (data ?? []).map((b) => b.columns),
          chosen,
        );
        setItems(catalog.map((name) => ({ name, shown: chosen.includes(name) })));
      });
    return () => {
      cancelled = true;
    };
  }, [visible]);

  if (!items) return <p className="muted">{t('app.loading')}</p>;

  const shown = items.filter((i) => i.shown);
  const update = (next: Item[]) => {
    setItems(next);
    setState('idle');
  };
  const onSave = async () => {
    if (!shown.length) return;
    setState('saving');
    const chosen = shown.map((i) => i.name);
    try {
      await save({ visible_columns: chosen, hidden_columns: hiddenColumnsFor(chosen) });
      setState('saved');
    } catch {
      setState('failed');
    }
  };
  const reset = () =>
    update([
      ...DEFAULT_VISIBLE_COLUMNS.map((name) => ({ name, shown: true })),
      ...items
        .filter((i) => !DEFAULT_VISIBLE_COLUMNS.includes(i.name))
        .map((i) => ({ ...i, shown: false })),
    ]);

  return (
    <div>
      <p className="muted">{t('settings.columns.dragHint')}</p>
      <p data-testid="columns-count">
        {t('settings.columns.count', { shown: shown.length, total: items.length })}
      </p>
      <ol className="column-list" data-testid="column-list">
        {items.map((item, i) => (
          <li
            key={item.name}
            data-column={item.name}
            className={`column-item${dragging === i ? ' column-dragging' : ''}${item.shown ? '' : ' column-hidden'}`}
            draggable
            onDragStart={(e) => {
              setDragging(i);
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', String(i));
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              // The row being dragged is kept in state (dataTransfer is only set so Firefox starts the drag).
              if (dragging !== null) update(move(items, dragging, i));
              setDragging(null);
            }}
            onDragEnd={() => setDragging(null)}
          >
            <span className="drag-handle">
              <Icon name="drag" />
            </span>
            <label className="column-label">
              <input
                type="checkbox"
                checked={item.shown}
                aria-label={t('settings.columns.show', { column: item.name })}
                onChange={(e) =>
                  update(items.map((x, k) => (k === i ? { ...x, shown: e.target.checked } : x)))
                }
              />
              <span>
                {columnHeader(item.name)}
                {columnHeader(item.name) !== item.name && (
                  <span className="muted"> ({item.name})</span>
                )}
                {DEFAULT_VISIBLE_COLUMNS.includes(item.name) && (
                  <span className="muted"> · {t('settings.columns.default')}</span>
                )}
              </span>
            </label>
            <span className="column-moves">
              <button
                type="button"
                className="button-icon"
                aria-label={t('settings.columns.up', { column: item.name })}
                disabled={i === 0}
                onClick={() => update(move(items, i, i - 1))}
              >
                ↑
              </button>
              <button
                type="button"
                className="button-icon"
                aria-label={t('settings.columns.down', { column: item.name })}
                disabled={i === items.length - 1}
                onClick={() => update(move(items, i, i + 1))}
              >
                ↓
              </button>
            </span>
          </li>
        ))}
      </ol>
      {!shown.length && (
        <p className="badge badge-warn" role="alert">
          <Icon name="warn" /> {t('settings.columns.atLeastOne')}
        </p>
      )}
      <div className="row actions">
        <button
          type="button"
          className="button-primary"
          disabled={!shown.length || state === 'saving'}
          onClick={() => void onSave()}
          data-testid="save-columns"
        >
          {state === 'saving' ? t('settings.columns.saving') : t('settings.columns.save')}
        </button>
        <button type="button" onClick={reset}>
          {t('settings.columns.reset')}
        </button>
      </div>
      {state === 'saved' && (
        <p className="badge badge-ok" role="status" data-testid="columns-saved">
          <Icon name="ok" /> {t('settings.columns.saved')}
        </p>
      )}
      {state === 'failed' && (
        <p className="badge badge-error" role="alert">
          <Icon name="error" /> {t('settings.columns.saveFailed')}
        </p>
      )}
    </div>
  );
}
