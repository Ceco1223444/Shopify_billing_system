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
import { PresenceProvider } from './realtime/PresenceProvider';

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

  return (
    <PresenceProvider member={state.member}>
      <Routes>
        <Route path="/login" element={<Navigate to={returnTo} replace />} />
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/shipments" replace />} />
          <Route path="shipments" element={<PlaceholderPage page="shipments" />} />
          <Route path="import" element={<PlaceholderPage page="import" />} />
          <Route path="products" element={<PlaceholderPage page="products" />} />
          <Route path="stock" element={<PlaceholderPage page="stock" />} />
          <Route path="reports" element={<PlaceholderPage page="reports" />} />
          <Route path="settings" element={<PlaceholderPage page="settings" />} />
          {devPagesEnabled && <Route path="dev/sync" element={<DevSyncPage />} />}
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </PresenceProvider>
  );
}
