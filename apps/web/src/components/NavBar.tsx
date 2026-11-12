import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router';
import { devPagesEnabled } from '../lib/supabase';

const NAV_ITEMS = [
  { to: '/shipments', key: 'shipments', icon: '📦' },
  { to: '/import', key: 'import', icon: '📥' },
  { to: '/products', key: 'products', icon: '🛏️' },
  { to: '/stock', key: 'stock', icon: '🗃️' },
  { to: '/reports', key: 'reports', icon: '📊' },
  { to: '/settings', key: 'settings', icon: '⚙️' },
] as const;

/** Connection check: only where the dev pages are on (pnpm dev / dev:hosted, or VITE_ENABLE_DEV_PAGES). */
const DEV_ITEM = { to: '/dev/sync', key: 'connectionCheck', icon: '🔌' } as const;

const ITEMS = devPagesEnabled ? [...NAV_ITEMS, DEV_ITEM] : NAV_ITEMS;

export function NavBar() {
  const { t } = useTranslation();
  return (
    <nav className="nav" aria-label={t('nav.label')}>
      <ul>
        {ITEMS.map((item) => (
          <li key={item.to} className={item === DEV_ITEM ? 'nav-dev' : undefined}>
            <NavLink to={item.to}>
              <span aria-hidden="true">{item.icon}</span> {t(`nav.${item.key}`)}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
