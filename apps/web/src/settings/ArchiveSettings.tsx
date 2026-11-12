import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useArchive } from '../archive/ArchiveProvider';
import type { ArchiveOutcome } from '../archive/archiver';
import { Icon } from '../components/Icon';
import { saveFile } from '../lib/download';

function Outcome({ o }: { o: ArchiveOutcome }) {
  const { t } = useTranslation();
  if (o.status === 'archived')
    return (
      <li className="badge badge-ok">
        <Icon name="ok" />{' '}
        {o.path
          ? t('settings.archive.saved', { path: o.path })
          : t('settings.archive.retriedDelete', { name: o.fileName })}
      </li>
    );
  if (o.reason === 'delete')
    return (
      <li className="badge badge-warn">
        <Icon name="warn" /> {t('settings.archive.failedDelete', { name: o.fileName })}
      </li>
    );
  return (
    <li className="badge badge-error">
      <Icon name="error" />{' '}
      {t('settings.archive.failed', {
        name: o.fileName,
        reason: t(`settings.archive.reason.${o.reason}`),
      })}
    </li>
  );
}

/** Settings → "Архив на CSV файловете" (P2-16 … P2-22). */
export function ArchiveSettings({ retentionDays }: { retentionDays: number }) {
  const { t } = useTranslation();
  const archive = useArchive();
  const [computer, setComputer] = useState<string | null>(null);
  if (!archive) return null;
  const { folder, waiting, busy } = archive;
  const name = computer ?? archive.computer;

  return (
    <div data-testid="archive-settings">
      <p>{t('settings.archive.intro', { days: retentionDays })}</p>

      <p data-testid="archive-folder">
        {folder.kind === 'chosen' && t('settings.archive.folder', { name: folder.name })}
        {folder.kind === 'desktop' && t('settings.archive.desktopFolder', { name: folder.name })}
        {folder.kind === 'none' && t('settings.archive.noFolder')}
      </p>

      {folder.kind === 'unsupported' ? (
        <div className="card">
          <p className="badge badge-info">
            <Icon name="info" /> {t('settings.archive.unsupported')}
          </p>
          <div className="row actions">
            <button
              type="button"
              className="button-primary"
              disabled={busy}
              onClick={() =>
                void archive.prepareZip().then((zip) => {
                  if (zip && zip.entries.length)
                    saveFile(
                      zip.bytes,
                      `happyhome-csv-archive-${new Date().toISOString().slice(0, 10)}.zip`,
                      'application/zip',
                    );
                })
              }
            >
              {t('settings.archive.zip')}
            </button>
          </div>
          {archive.zip && archive.zip.entries.length > 0 && (
            <div>
              <p>{t('settings.archive.zipReady', { count: archive.zip.entries.length })}</p>
              <button
                type="button"
                className="button-primary"
                disabled={busy}
                onClick={() => void archive.confirmZip()}
              >
                {t('settings.archive.zipConfirm')}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="row actions">
          {folder.kind !== 'desktop' && (
            <button
              type="button"
              className={folder.kind === 'none' ? 'button-primary' : undefined}
              onClick={() => void archive.chooseFolder()}
              data-testid="choose-folder"
            >
              {folder.kind === 'none' ? t('settings.archive.choose') : t('settings.archive.change')}
            </button>
          )}
          {folder.kind === 'chosen' && folder.permission !== 'granted' && (
            <button
              type="button"
              className="button-primary"
              onClick={() => void archive.allowFolder()}
            >
              {t('settings.archive.allow')}
            </button>
          )}
          <button
            type="button"
            disabled={
              busy ||
              (folder.kind === 'chosen' && folder.permission !== 'granted') ||
              folder.kind === 'none'
            }
            onClick={() => void archive.archiveNow()}
            data-testid="archive-now"
          >
            {t('settings.archive.now')}
          </button>
        </div>
      )}
      {folder.kind === 'chosen' && folder.permission === 'prompt' && (
        <p className="muted">{t('settings.archive.allowHint')}</p>
      )}
      {folder.kind === 'chosen' && folder.permission === 'denied' && (
        <p className="badge badge-warn">
          <Icon name="warn" /> {t('settings.archive.denied')}
        </p>
      )}
      {folder.kind !== 'unsupported' && (
        <p className="muted">{t('settings.archive.nowHint', { days: retentionDays })}</p>
      )}

      <p data-testid="archive-waiting" role="status">
        {busy
          ? t('settings.archive.busy')
          : waiting.length
            ? t('settings.archive.waiting', { count: waiting.length })
            : t('settings.archive.nothingWaiting')}
      </p>
      {archive.results.length > 0 && (
        <ul className="archive-results">
          {archive.results.map((o) => (
            <Outcome key={o.batchId} o={o} />
          ))}
        </ul>
      )}
      {archive.error && (
        <p className="badge badge-error">
          <Icon name="error" /> {t('settings.archive.loadFailed')}
        </p>
      )}

      <label htmlFor="computer-name">{t('settings.archive.computer')}</label>
      <div className="row">
        <input
          id="computer-name"
          value={name}
          maxLength={60}
          onChange={(e) => setComputer(e.target.value)}
        />
        <button
          type="button"
          onClick={() => {
            void archive.setComputer(name);
            setComputer(null);
          }}
        >
          {t('settings.archive.saveComputer')}
        </button>
      </div>
      <p className="muted">{t('settings.archive.computerHint')}</p>
    </div>
  );
}
