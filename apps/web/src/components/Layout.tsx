import { useTranslation } from 'react-i18next';
import { Outlet } from 'react-router';
import { AccountSwitchedNotice } from './AccountSwitchedNotice';
import { NavBar } from './NavBar';
import { TopBar } from './TopBar';

export function Layout() {
  const { t } = useTranslation();
  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        {t('app.skipToContent')}
      </a>
      <TopBar />
      <NavBar />
      <AccountSwitchedNotice />
      <main id="main" className="main">
        <Outlet />
      </main>
    </div>
  );
}
