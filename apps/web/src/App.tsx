import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { useAuth } from './auth/AuthProvider';
import { Layout } from './components/Layout';
import { devPagesEnabled } from './lib/supabase';
import { DevSyncPage } from './pages/DevSyncPage';
import { LoginPage } from './pages/LoginPage';
import { NoAccessPage } from './pages/NoAccessPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { PlaceholderPage } from './pages/PlaceholderPage';
import { ShipmentPage } from './shipments/ShipmentPage';
import { ShipmentsPage } from './shipments/ShipmentsPage';
import { PresenceProvider } from './realtime/PresenceProvider';

// The Shopify converter and the Excel writer are big and only the owner's screens use them:
// load them on first visit, so the packers' phones download less.
const ImportPage = lazy(() =>
  import('./import/ImportPage').then((m) => ({ default: m.ImportPage })),
);
const BatchPage = lazy(() => import('./import/BatchPage').then((m) => ({ default: m.BatchPage })));
const SettingsPage = lazy(() =>
  import('./settings/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);

interface FromState {
  from?: string;
}

export function App() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const location = useLocation();

  if (state.status === 'loading') {
    return (
      <p className="full-page-message" role="status">
        {t('app.loading')}
      </p>
    );
  }

  if (state.status === 'signed_out') {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="*"
          element={
            <Navigate
              to="/login"
              replace
              state={{ from: location.pathname + location.search } satisfies FromState}
            />
          }
        />
      </Routes>
    );
  }

  if (state.status === 'no_access') return <NoAccessPage />;

  const returnTo = (location.state as FromState | null)?.from ?? '/shipments';
  const loading = (
    <p className="muted" role="status">
      {t('app.loading')}
    </p>
  );

  return (
    <PresenceProvider member={state.member}>
      <Routes>
        <Route path="/login" element={<Navigate to={returnTo} replace />} />
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/shipments" replace />} />
          <Route path="shipments" element={<ShipmentsPage />} />
          <Route path="shipments/:shipmentId" element={<ShipmentPage />} />
          <Route
            path="import"
            element={
              <Suspense fallback={loading}>
                <ImportPage />
              </Suspense>
            }
          />
          <Route
            path="import/:batchId"
            element={
              <Suspense fallback={loading}>
                <BatchPage />
              </Suspense>
            }
          />
          <Route path="products" element={<PlaceholderPage page="products" />} />
          <Route path="stock" element={<PlaceholderPage page="stock" />} />
          <Route path="reports" element={<PlaceholderPage page="reports" />} />
          <Route
            path="settings"
            element={
              <Suspense fallback={loading}>
                <SettingsPage />
              </Suspense>
            }
          />
          {devPagesEnabled && <Route path="dev/sync" element={<DevSyncPage />} />}
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </PresenceProvider>
  );
}
