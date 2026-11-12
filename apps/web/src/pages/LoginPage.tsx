import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../components/Icon';
import { LanguageToggle } from '../components/LanguageToggle';
import { supabase } from '../lib/supabase';

type LoginError = 'invalid' | 'network' | 'unknown';

export function LoginPage() {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LoginError | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { error: authError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (authError) {
        setError(
          authError.code === 'invalid_credentials' || authError.status === 400
            ? 'invalid'
            : authError.status === 0 || authError.name === 'AuthRetryableFetchError'
              ? 'network'
              : 'unknown',
        );
      }
      // On success AuthProvider sees the new session and the app opens.
    } catch {
      setError('network');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="login-card">
        <div className="login-head">
          <img src="/favicon.svg" alt="" width={48} height={48} />
          <span className="topbar-shop">{t('app.shopName')}</span>
          <LanguageToggle />
        </div>
        <h1>{t('auth.title')}</h1>
        <p>{t('auth.intro')}</p>
        <form onSubmit={(e) => void onSubmit(e)} noValidate>
          <label htmlFor="email">{t('auth.email')}</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <label htmlFor="password">{t('auth.password')}</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && (
            <p className="badge badge-error" role="alert">
              <Icon name="error" /> {t(`auth.errors.${error}`)}
            </p>
          )}
          <button type="submit" className="button-primary" disabled={busy}>
            {busy ? t('auth.submitting') : t('auth.submit')}
          </button>
        </form>
      </div>
    </div>
  );
}
