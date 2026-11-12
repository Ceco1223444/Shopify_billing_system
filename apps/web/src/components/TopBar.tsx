import { useTranslation } from 'react-i18next';
import { useAuth, useMember } from '../auth/AuthProvider';
import { formatNameList } from '../lib/listFormat';
import { usePresence } from '../realtime/PresenceProvider';
import { LanguageToggle } from './LanguageToggle';

export function TopBar() {
  const { t } = useTranslation();
  const member = useMember();
  const { signOut } = useAuth();
  const { othersOnline } = usePresence();
  const names = othersOnline.map((p) => p.displayName);

  return (
    <header className="topbar">
      <div className="topbar-brand">
        <img src="/favicon.svg" alt="" width={32} height={32} />
        <span className="topbar-shop">{t('app.shopName')}</span>
      </div>
      <p className="topbar-online" data-testid="online-now">
        <span className="dot" aria-hidden="true" />
        {names.length > 0
          ? t('topbar.online', { names: formatNameList(names) })
          : t('topbar.onlineNobody')}
      </p>
      <div className="topbar-user">
        <span data-testid="current-user">
          {t('topbar.signedInAs', { name: member.displayName })}{' '}
          <span className="muted">({t(`topbar.role.${member.role}`)})</span>
        </span>
        <LanguageToggle />
        <button type="button" className="button-secondary" onClick={() => void signOut()}>
          {t('auth.logout')}
        </button>
      </div>
    </header>
  );
}
