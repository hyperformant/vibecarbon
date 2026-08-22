import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { useAuth } from './components/auth/AuthProvider';
import { SidebarLayout } from './components/layouts/SidebarLayout';
import { useDocsVisibility } from './hooks/api';
import { applyTheme } from './lib/theme';

// Eagerly loaded (landing page critical path)
import Home from './pages/Home';

// Lazy-loaded pages
const AuthCallback = lazy(() => import('./pages/AuthCallback'));
const Login = lazy(() => import('./pages/Login'));
const ForgotPassword = lazy(() => import('./pages/ForgotPassword'));
const ResetPassword = lazy(() => import('./pages/ResetPassword'));
const MFAVerify = lazy(() => import('./pages/MFAVerify'));
const Onboarding = lazy(() => import('./pages/Onboarding'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const UIComponents = lazy(() => import('./pages/UIComponents'));
const Charts = lazy(() => import('./pages/Charts'));
const NotFound = lazy(() => import('./pages/NotFound'));
const HomePreview = lazy(() => import('./pages/HomePreview'));

// Content pages
const ApiDocs = lazy(() => import('./pages/ApiDocs'));
const Blog = lazy(() => import('./pages/Blog'));
const Changelog = lazy(() => import('./pages/Changelog'));
const Docs = lazy(() => import('./pages/Docs'));
const Legal = lazy(() => import('./pages/Legal'));
const Checkout = lazy(() => import('./pages/Checkout'));
const Pricing = lazy(() => import('./pages/Pricing'));

// Settings
const Profile = lazy(() => import('./pages/settings/Profile'));
const Billing = lazy(() => import('./pages/settings/Billing'));
const Security = lazy(() => import('./pages/settings/Security'));

// Organizations
const OrgDetails = lazy(() => import('./pages/organizations/Details'));
const OrgMembers = lazy(() => import('./pages/organizations/Members'));

// Admin
const AdminDashboard = lazy(() => import('./pages/admin/Dashboard'));
const AdminOrganizations = lazy(() => import('./pages/admin/Organizations'));
const AdminUsers = lazy(() => import('./pages/admin/Users'));
const AdminLogs = lazy(() => import('./pages/admin/Logs'));
const AdminNotifications = lazy(() => import('./pages/admin/Notifications'));
const AdminInfrastructure = lazy(() => import('./pages/admin/Infrastructure'));
const AdminSettings = lazy(() => import('./pages/admin/Settings'));
const AdminTheme = lazy(() => import('./pages/admin/Theme'));
const AdminJobs = lazy(() => import('./pages/admin/Jobs'));
const AdminContactSubmissions = lazy(() => import('./pages/admin/ContactSubmissions'));
const AdminNewsletter = lazy(() => import('./pages/admin/Newsletter'));
const Contact = lazy(() => import('./pages/Contact'));

function PageSpinner() {
  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
    </div>
  );
}

function ScrollToTop() {
  const { pathname } = useLocation();
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional trigger on route change
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return <PageSpinner />;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  // Redirect to onboarding if not completed (skip for settings/billing so checkout can complete)
  if (
    !user.user_metadata?.onboarding_completed &&
    location.pathname !== '/onboarding' &&
    !location.pathname.startsWith('/settings/billing')
  ) {
    return <Navigate to="/onboarding" replace />;
  }

  return <>{children}</>;
}

/**
 * Gates a documentation route on its runtime visibility setting, so a
 * bookmarked or guessed URL cannot reach a surface the operator turned off.
 *
 * Holds the spinner while the setting is in flight instead of optimistically
 * rendering, so a disabled docs page never flashes its content before
 * disappearing. Note this is a visibility gate, not a security boundary —
 * the docs bundles still ship to the client either way.
 */
function DocsRoute({ surface, children }: { surface: 'user' | 'api'; children: React.ReactNode }) {
  const { userDocsEnabled, apiDocsEnabled, isLoading } = useDocsVisibility();

  if (isLoading) {
    return <PageSpinner />;
  }

  const enabled = surface === 'api' ? apiDocsEnabled : userDocsEnabled;

  if (!enabled) {
    return <NotFound />;
  }

  return <>{children}</>;
}

function SuperAdminProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, isSuperAdmin, isLoading } = useAuth();

  if (isLoading) {
    return <PageSpinner />;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (!isSuperAdmin) {
    return <Navigate to="/dashboard" replace />;
  }

  return <>{children}</>;
}

export default function App() {
  useQuery({
    queryKey: ['app-theme'],
    queryFn: async () => {
      const r = await fetch('/api/v1/admin/theme');
      if (!r.ok) return null;
      const data = await r.json();
      if (data?.theme && Object.keys(data.theme).length > 0) applyTheme(data.theme);
      return data;
    },
    staleTime: 1000 * 60 * 30, // 30 minutes
    refetchOnWindowFocus: false,
  });

  return (
    <Suspense fallback={<PageSpinner />}>
      <ScrollToTop />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/home-preview" element={<HomePreview />} />
        <Route
          path="/api/docs"
          element={
            <DocsRoute surface="api">
              <ApiDocs />
            </DocsRoute>
          }
        />
        <Route path="/blog" element={<Blog />} />
        <Route path="/blog/:slug" element={<Blog />} />
        <Route path="/changelog" element={<Changelog />} />
        <Route path="/changelog/:slug" element={<Changelog />} />
        <Route path="/checkout" element={<Checkout />} />
        <Route path="/pricing" element={<Pricing />} />
        <Route
          path="/docs"
          element={
            <DocsRoute surface="user">
              <Docs />
            </DocsRoute>
          }
        />
        <Route
          path="/docs/:slug"
          element={
            <DocsRoute surface="user">
              <Docs />
            </DocsRoute>
          }
        />
        <Route path="/contact" element={<Contact />} />
        <Route path="/privacy" element={<Legal />} />
        <Route path="/terms" element={<Legal />} />
        <Route path="/legal/:slug" element={<Legal />} />
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Login />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/mfa-verify" element={<MFAVerify />} />
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route
          path="/onboarding"
          element={
            <ProtectedRoute>
              <Onboarding />
            </ProtectedRoute>
          }
        />
        {/* Protected routes with sidebar layout */}
        <Route
          element={
            <ProtectedRoute>
              <SidebarLayout />
            </ProtectedRoute>
          }
        >
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/ui-components" element={<UIComponents />} />
          <Route path="/charts" element={<Charts />} />
          <Route path="/settings" element={<Navigate to="/settings/profile" replace />} />
          <Route path="/settings/profile" element={<Profile />} />
          <Route path="/settings/billing" element={<Billing />} />
          <Route path="/settings/security" element={<Security />} />
          <Route path="/organizations/:orgId" element={<Navigate to="details" replace />} />
          <Route path="/organizations/:orgId/details" element={<OrgDetails />} />
          <Route path="/organizations/:orgId/members" element={<OrgMembers />} />
        </Route>
        {/* Admin routes with sidebar layout */}
        <Route
          element={
            <SuperAdminProtectedRoute>
              <SidebarLayout />
            </SuperAdminProtectedRoute>
          }
        >
          <Route path="/admin" element={<Navigate to="/admin/dashboard" replace />} />
          <Route path="/admin/dashboard" element={<AdminDashboard />} />
          <Route path="/admin/organizations" element={<AdminOrganizations />} />
          <Route path="/admin/users" element={<AdminUsers />} />
          <Route path="/admin/logs" element={<AdminLogs />} />
          <Route path="/admin/notifications" element={<AdminNotifications />} />
          <Route path="/admin/infrastructure" element={<AdminInfrastructure />} />
          <Route path="/admin/jobs" element={<AdminJobs />} />
          <Route path="/admin/contact" element={<AdminContactSubmissions />} />
          <Route path="/admin/newsletter" element={<AdminNewsletter />} />
          <Route path="/admin/settings" element={<AdminSettings />} />
          <Route path="/admin/theme" element={<AdminTheme />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  );
}
