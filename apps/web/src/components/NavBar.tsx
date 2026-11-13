import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router';
import { useMember } from '../auth/AuthProvider';
import { devPagesEnabled } from '../lib/supabase';

const NAV_ITEMS = [
  { to: '/shipments', key: 'shipments', icon: '📦' },
  // Importing Shopify files is the owner's job (Phase 2): packers don't see it.
  { to: '/import', key: 'import', icon: '📥', ownerOnly: true },
  // Courier offices and lockers, their sync and map (Phase 4): the owner's tool.
  { to: '/offices', key: 'offices', icon: '📍', ownerOnly: true },
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
  const member = useMember();
  const items = ITEMS.filter((item) => !('ownerOnly' in item) || member.role === 'owner');
  return (
    <nav className="nav" aria-label={t('nav.label')}>
      <ul>
        {items.map((item) => (
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
