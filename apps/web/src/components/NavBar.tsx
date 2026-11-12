import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router';

const NAV_ITEMS = [
  { to: '/shipments', key: 'shipments', icon: '📦' },
  { to: '/import', key: 'import', icon: '📥' },
  { to: '/products', key: 'products', icon: '🛏️' },
  { to: '/stock', key: 'stock', icon: '🗃️' },
  { to: '/reports', key: 'reports', icon: '📊' },
  { to: '/settings', key: 'settings', icon: '⚙️' },
] as const;

export function NavBar() {
  const { t } = useTranslation();
  return (
    <nav className="nav" aria-label={t('nav.label')}>
      <ul>
        {NAV_ITEMS.map((item) => (
          <li key={item.to}>
            <NavLink to={item.to}>
              <span aria-hidden="true">{item.icon}</span> {t(`nav.${item.key}`)}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
