import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { AuthProvider } from './auth/AuthProvider';
import { i18nReady } from './i18n';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing from index.html');

void i18nReady.then(() => {
  createRoot(root).render(
    <StrictMode>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </StrictMode>,
  );
});
