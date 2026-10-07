import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { ApiError } from './api';
import ErrorBoundary from './components/ErrorBoundary';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 10_000 },
  },
  // An expired session otherwise leaves every page showing "Authentication
  // required" with no way back; drop the session instead and show the login.
  queryCache: new QueryCache({
    onError: (error) => {
      if (error instanceof ApiError && error.status === 401) {
        queryClient.setQueryData(['me'], null);
      }
    },
  }),
});

/**
 * Register the service worker — what makes the dashboard installable as a
 * phone app. Dev is skipped on purpose: a worker caching Vite's module graph
 * serves stale modules after every edit.
 *
 * Failure here is never fatal. The app works fine uninstalled, so a browser
 * that refuses the worker (private mode, an unsupported browser, an http://
 * origin) just loses the install option.
 */
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
