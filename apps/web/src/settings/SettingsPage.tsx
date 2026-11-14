import { SETTINGS_DEFAULTS } from '@happyhome/core';
import { useTranslation } from 'react-i18next';
import { useMember } from '../auth/AuthProvider';
import { Icon } from '../components/Icon';
import { useSettings } from '../lib/settings';
import { ArchiveSettings } from './ArchiveSettings';
import { ColumnChooser } from './ColumnChooser';
import { DeliverySettings } from './DeliverySettings';

export function SettingsPage() {
  const { t } = useTranslation();
  const member = useMember();
  const settings = useSettings();

  if (member.role !== 'owner') {
    return (
      <section>
        <h1>{t('pages.settings.title')}</h1>
        <p className="badge badge-info" data-testid="settings-owner-only">
          <Icon name="info" /> {t('settings.ownerOnly')}
        </p>
      </section>
    );
  }

  const retention = Number(
    settings.values?.raw_csv_retention_days ?? SETTINGS_DEFAULTS.raw_csv_retention_days,
  );

  return (
    <section>
      <h1>{t('pages.settings.title')}</h1>
      <p>{t('pages.settings.intro')}</p>

      <div className="card" id="columns">
        <h2>{t('settings.columns.title')}</h2>
        <p>{t('settings.columns.intro')}</p>
        {settings.values ? (
          <ColumnChooser visible={settings.values.visible_columns} save={settings.save} />
        ) : (
          <p className="muted">{t('app.loading')}</p>
        )}
      </div>

      <div className="card" id="delivery">
        <h2>{t('settings.delivery.title')}</h2>
        <p>{t('settings.delivery.intro')}</p>
        {settings.values ? (
          <DeliverySettings values={settings.values} save={settings.save} />
        ) : (
          <p className="muted">{t('app.loading')}</p>
        )}
      </div>

      <div className="card" id="archive">
        <h2>{t('settings.archive.title')}</h2>
        <ArchiveSettings retentionDays={Number.isFinite(retention) ? retention : 90} />
      </div>
    </section>
  );
}
