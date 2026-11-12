import { useTranslation } from 'react-i18next';
import { useAuth, useMember } from '../auth/AuthProvider';
import { Icon } from './Icon';

/**
 * Browsers keep ONE login for all their tabs and windows. If someone signs in as another
 * person in a different tab, this window silently becomes that person. Say so loudly,
 * because the audit log records every edit under the signed-in name.
 */
export function AccountSwitchedNotice() {
  const { t } = useTranslation();
  const { accountSwitchedElsewhere, dismissAccountSwitched } = useAuth();
  const member = useMember();
  if (!accountSwitchedElsewhere) return null;
  return (
    <div className="notice notice-warn" role="alert" data-testid="account-switched">
      <p>
        <Icon name="warn" /> {t('auth.accountSwitched', { name: member.displayName })}
      </p>
      <button type="button" className="button-secondary" onClick={dismissAccountSwitched}>
        {t('auth.accountSwitchedDismiss')}
      </button>
    </div>
  );
}
