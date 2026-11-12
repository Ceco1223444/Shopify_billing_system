import { useTranslation } from 'react-i18next';
import { Outlet } from 'react-router';
import { ArchiveBanner } from '../archive/ArchiveBanner';
import { ArchiveProvider } from '../archive/ArchiveProvider';
import { useMember } from '../auth/AuthProvider';
import { AccountSwitchedNotice } from './AccountSwitchedNotice';
import { NavBar } from './NavBar';
import { TopBar } from './TopBar';

export function Layout() {
  const { t } = useTranslation();
  const member = useMember();
  const shell = (
    <div className="shell">
      <a className="skip-link" href="#main">
        {t('app.skipToContent')}
      </a>
      <TopBar />
      <NavBar />
      <AccountSwitchedNotice />
      <ArchiveBanner />
      <main id="main" className="main">
        <Outlet />
      </main>
    </div>
  );
  // Only the owner keeps and archives the raw CSV files (Phase 2).
  return member.role === 'owner' ? (
    <ArchiveProvider key={member.userId}>{shell}</ArchiveProvider>
  ) : (
    shell
  );
}
