import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { ApiError } from './lib/api';
import { Toaster } from './components/ui/sonner';
import { TooltipProvider } from './components/ui/tooltip';
import './index.css';

/** A session that expires mid-use sends the person back to sign in instead of leaving dead screens. */
function onAuthError(error: unknown) {
  if (error instanceof ApiError && error.status === 401 && window.location.pathname !== '/login') {
    window.location.assign('/login');
  }
}

const queryClient = new QueryClient({
  // The session query handles its own 401 (it redirects and remembers where you were going).
  queryCache: new QueryCache({ onError: (error, query) => query.queryKey[0] !== 'me' && onAuthError(error) }),
  mutationCache: new MutationCache({ onError: onAuthError }),
  defaultOptions: {
    queries: { staleTime: 15_000, refetchOnWindowFocus: false },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <TooltipProvider delayDuration={250}>
          <App />
          <Toaster position="bottom-right" richColors closeButton />
        </TooltipProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
