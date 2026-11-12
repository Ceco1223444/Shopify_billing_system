import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthProvider';
import { Icon } from '../components/Icon';
import { LanguageToggle } from '../components/LanguageToggle';

export function NoAccessPage() {
  const { t } = useTranslation();
  const { signOut } = useAuth();
  return (
    <div className="login">
      <div className="login-card">
        <div className="login-head">
          <span className="topbar-shop">{t('app.shopName')}</span>
          <LanguageToggle />
        </div>
        <h1>{t('auth.noAccess.title')}</h1>
        <p className="badge badge-warn" role="alert">
          <Icon name="warn" /> {t('auth.noAccess.body')}
        </p>
        <button type="button" className="button-secondary" onClick={() => void signOut()}>
          {t('auth.logout')}
        </button>
      </div>
    </div>
  );
}
