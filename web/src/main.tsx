import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './index.css';
import { ApiError } from './lib/api';
import { SessionProvider } from './lib/session';
import { ToastProvider } from './lib/toast';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      // retry only transient failures (network / server), never permission or validation errors
      retry: (count, e) => count < 3 && (!(e instanceof ApiError) || e.status === 0 || e.status >= 500),
      retryDelay: (n) => Math.min(1000 * 2 ** n, 8000),
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <SessionProvider>
            <App />
          </SessionProvider>
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
