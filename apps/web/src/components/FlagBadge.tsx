import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './Icon';

export type FlagSeverity = 'red' | 'amber' | 'info';

const STYLE: Record<FlagSeverity, { cls: string; icon: 'error' | 'warn' | 'info' }> = {
  red: { cls: 'badge-error', icon: 'error' },
  amber: { cls: 'badge-warn', icon: 'warn' },
  info: { cls: 'badge-muted', icon: 'info' },
};

/** Severity as colour + icon + word (colour is never the only signal). */
export function FlagBadge({ severity }: { severity: FlagSeverity }) {
  const { t } = useTranslation();
  const s = STYLE[severity];
  return (
    <span className={`badge badge-small ${s.cls}`}>
      <Icon name={s.icon} /> {t(`flags.severity.${severity}`)}
    </span>
  );
}

export interface FlagItem {
  id: string;
  severity: FlagSeverity;
  message: string;
  reason: string | null;
  order: string | null;
  /** Buttons, links or a comparison under the message (Phase 3). */
  extra?: ReactNode;
}

export function FlagList({ flags }: { flags: FlagItem[] }) {
  const { t } = useTranslation();
  return (
    <ul className="flag-list">
      {flags.map((f) => (
        <li key={f.id} data-testid="flag" data-severity={f.severity}>
          <FlagBadge severity={f.severity} />
          {f.order && <strong className="flag-order">{f.order}</strong>}
          <span>{f.message}</span>
          {f.reason && (
            <span className="muted flag-reason">{t('flags.why', { reason: f.reason })}</span>
          )}
          {f.extra && <div className="flag-extra">{f.extra}</div>}
        </li>
      ))}
    </ul>
  );
}
