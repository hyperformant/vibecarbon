import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import App from './App';
import { AuthProvider } from './components/auth/AuthProvider';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ImpersonationBanner } from './components/ImpersonationBanner';
import { NotificationBar } from './components/NotificationDrawer';
import { SmoothScroll } from './components/SmoothScroll';
import { NotificationProvider } from './hooks/useNotifications';
import { OrganizationsProvider } from './hooks/useOrganizations';
import './lib/i18n';
import 'lenis/dist/lenis.css';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      retry: 1,
    },
  },
});

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element not found');

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
          <ErrorBoundary>
            <AuthProvider>
              <OrganizationsProvider>
                <NotificationProvider>
                  <SmoothScroll>
                    <div className="flex min-h-screen flex-col">
                      <ImpersonationBanner />
                      <NotificationBar />
                      <div className="flex-1">
                        <App />
                      </div>
                    </div>
                  </SmoothScroll>
                </NotificationProvider>
              </OrganizationsProvider>
            </AuthProvider>
          </ErrorBoundary>
        </ThemeProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
);
