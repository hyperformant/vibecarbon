import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';
import { useMfaRequired } from '../../hooks/api';
import { type StepUpReason, setStepUpHandler } from '../../lib/api';
import { type AuthSession, type AuthUser, authClient } from '../../lib/auth-client';
import { AuthRequestError, unwrap } from '../../lib/auth-errors';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { TwoFactorCodeForm } from './TwoFactorCodeForm';

/**
 * Mint (or refresh) the HttpOnly ForwardAuth cookie (`vc-admin-token`) for a
 * super admin: the only credential /api/_internal/verify-role accepts from a
 * browser. Everyone else carries no domain-wide cookie, so this is a no-op
 * for them. Failures are non-fatal: a ForwardAuth 401 routes back through
 * /login, which re-mints before bouncing.
 */
export async function syncAdminCookie(isSuperAdmin: boolean): Promise<void> {
  if (!isSuperAdmin) return;
  try {
    await fetch('/api/v1/admin/forwardauth-cookie', {
      method: 'POST',
      credentials: 'same-origin',
    });
  } catch {
    // non-fatal: the next sign-in (or the /login bounce) retries
  }
}

/** Clear the ForwardAuth cookie. Fire-and-forget: it expires within the hour anyway. */
function clearAdminCookie(): Promise<void> {
  return fetch('/api/v1/admin/forwardauth-cookie', {
    method: 'DELETE',
    credentials: 'same-origin',
  })
    .then(() => undefined)
    .catch(() => undefined);
}

type ImpersonationInfo = {
  userId: string;
  email: string;
  name: string | null;
};

type ProfileFields = { name?: string; image?: string; onboardingCompleted?: boolean };

type AuthContextType = {
  user: AuthUser | null;
  /** The current session (no token: the cookie is HttpOnly). */
  session: AuthSession | null;
  isLoading: boolean;
  /** Display only: the server checks the role on every admin request. */
  isSuperAdmin: boolean;
  /** Whether MFA is required app-wide (set by a super admin) */
  mfaRequired: boolean;
  /** Whether the current user has a confirmed authenticator */
  hasMfaEnabled: boolean;
  /** Whether this session passed a second factor (aal2) */
  isAal2: boolean;
  /** A password sign-in is waiting for its second factor (/mfa-verify) */
  pendingMfaChallenge: boolean;
  isImpersonating: boolean;
  impersonationTarget: ImpersonationInfo | null;
  signIn: {
    /** `requiresMfa`: the password was right; the second factor comes next. */
    email: (email: string, password: string) => Promise<{ requiresMfa: boolean }>;
    google: () => Promise<void>;
    microsoft: () => Promise<void>;
    magicLink: (email: string) => Promise<void>;
  };
  /** `signedIn` is false when the address must be verified first. */
  signUp: (email: string, password: string, name?: string) => Promise<{ signedIn: boolean }>;
  signOut: () => Promise<void>;
  clearMfaChallenge: () => void;
  /** Re-read the session from the server (after a change made elsewhere). */
  refreshSession: () => Promise<AuthUser | null>;
  /** Update the signed-in user's own profile fields. */
  updateUser: (fields: ProfileFields) => Promise<void>;
  /**
   * Ask the user for what the server wants before a sensitive action. Resolves
   * true when the session now passes; the caller retries once.
   */
  stepUp: (reason: StepUpReason) => Promise<boolean>;
  /** Impersonate a user (super admin only) */
  impersonateUser: (userId: string) => Promise<void>;
  /** Stop impersonating and return to the admin session */
  stopImpersonating: () => Promise<void>;
  mfa: {
    /** Second step of a password sign-in. */
    verify: (code: string, kind?: 'totp' | 'backup') => Promise<AuthUser | null>;
    /** Start enrolling: the setup URI (QR) and backup codes. */
    enroll: (password?: string) => Promise<{ totpURI: string; backupCodes: string[] }>;
    /** Finish enrolling with the first code from the app. */
    confirmEnrollment: (code: string) => Promise<void>;
    /** Remove the authenticator (needs aal2; steps up first when asked). */
    disable: (password?: string) => Promise<void>;
    /** Whether the account has a password (it must be given to enroll or disable). */
    hasPassword: () => Promise<boolean>;
  };
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/** Where social and magic-link sign-ins land (pages/AuthCallback.tsx). */
const CALLBACK_PATH = '/auth/callback';

export function AuthProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingMfaChallenge, setPendingMfaChallenge] = useState(false);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const stepUpPending = useRef<{
    promise: Promise<boolean>;
    resolve: (ok: boolean) => void;
  } | null>(null);

  const { mfaRequired } = useMfaRequired();

  const refreshSession = useCallback(async (): Promise<AuthUser | null> => {
    // Uncached: the answer must reflect a change this page just made
    // (onboarding, a verified code, impersonation).
    const { data } = await authClient.getSession({ query: { disableCookieCache: true } });
    const current = (data?.user as AuthUser | undefined) ?? null;
    setUser(current);
    setSession((data?.session as AuthSession | undefined) ?? null);
    return current;
  }, []);

  useEffect(() => {
    refreshSession()
      .catch(() => {
        setUser(null);
        setSession(null);
      })
      .finally(() => setIsLoading(false));
  }, [refreshSession]);

  const isSuperAdmin = user?.role === 'super_admin';
  const hasMfaEnabled = user?.twoFactorEnabled === true;
  const isAal2 = session?.twoFactorVerified === true;
  const impersonationTarget: ImpersonationInfo | null =
    user && session?.impersonatedBy
      ? { userId: user.id, email: user.email, name: user.name || null }
      : null;

  // Keep the ForwardAuth cookie fresh for super admins on every load.
  useEffect(() => {
    if (isSuperAdmin && !impersonationTarget) syncAdminCookie(true);
  }, [isSuperAdmin, impersonationTarget]);

  const pathRef = useRef(location.pathname);
  pathRef.current = `${location.pathname}${location.search}`;

  const stepUp = useCallback(
    async (reason: StepUpReason): Promise<boolean> => {
      if (reason === 'enroll') {
        navigate('/settings/security?setup=required');
        return false;
      }
      if (reason === 'reauth') {
        const redirect = encodeURIComponent(pathRef.current);
        await authClient.signOut().catch(() => undefined);
        setUser(null);
        setSession(null);
        navigate(`/login?reason=reauth&redirect=${redirect}`);
        return false;
      }
      // One prompt at a time: concurrent refusals share it.
      if (stepUpPending.current) return stepUpPending.current.promise;
      let resolve: (ok: boolean) => void = () => {};
      const promise = new Promise<boolean>((r) => {
        resolve = r;
      });
      stepUpPending.current = { promise, resolve };
      setStepUpOpen(true);
      return promise;
    },
    [navigate]
  );

  const finishStepUp = (ok: boolean) => {
    const pending = stepUpPending.current;
    stepUpPending.current = null;
    setStepUpOpen(false);
    pending?.resolve(ok);
  };

  // Every apiFetch/apiJson refusal for the assurance level comes here.
  useEffect(() => setStepUpHandler(stepUp), [stepUp]);

  /**
   * Run an auth API call; when the server answers that it needs a second
   * factor (or a fresh sign-in), ask for it and retry once.
   */
  const withStepUp = useCallback(
    async <T,>(call: () => Promise<T>): Promise<T> => {
      try {
        return await call();
      } catch (err) {
        if (!(err instanceof AuthRequestError) || err.status !== 403) throw err;
        if (err.code === 'REAUTH_REQUIRED') {
          await stepUp('reauth');
          throw err;
        }
        if (err.code !== 'MFA_REQUIRED') throw err;
        if (!(await stepUp(hasMfaEnabled ? 'verify' : 'enroll'))) throw err;
        return call();
      }
    },
    [stepUp, hasMfaEnabled]
  );

  const signIn = {
    email: async (email: string, password: string): Promise<{ requiresMfa: boolean }> => {
      const data = unwrap(await authClient.signIn.email({ email, password }));
      if (data && 'twoFactorRedirect' in data && data.twoFactorRedirect) {
        setPendingMfaChallenge(true);
        return { requiresMfa: true };
      }
      await refreshSession();
      return { requiresMfa: false };
    },
    google: async () => {
      unwrap(
        await authClient.signIn.social({
          provider: 'google',
          callbackURL: CALLBACK_PATH,
          errorCallbackURL: '/login?error=oauth',
        })
      );
    },
    microsoft: async () => {
      unwrap(
        await authClient.signIn.social({
          provider: 'microsoft',
          callbackURL: CALLBACK_PATH,
          errorCallbackURL: '/login?error=oauth',
        })
      );
    },
    magicLink: async (email: string) => {
      unwrap(
        await authClient.signIn.magicLink({
          email,
          callbackURL: CALLBACK_PATH,
          errorCallbackURL: '/login?error=magic_link',
        })
      );
    },
  };

  const signUp = async (email: string, password: string, name?: string) => {
    unwrap(await authClient.signUp.email({ email, password, name: name?.trim() ?? '' }));
    // No session yet when the address must be verified first.
    return { signedIn: (await refreshSession()) !== null };
  };

  const signOut = async () => {
    setPendingMfaChallenge(false);
    if (impersonationTarget) {
      // Back to the admin session first, so signing out ends that one too
      // instead of leaving it parked in the admin plugin's cookie.
      await authClient.admin.stopImpersonating().catch(() => undefined);
    }
    if (isSuperAdmin || impersonationTarget) await clearAdminCookie();
    const result = await authClient.signOut();
    setUser(null);
    setSession(null);
    unwrap(result);
  };

  const updateUser = async (fields: ProfileFields) => {
    unwrap(await authClient.updateUser(fields));
    await refreshSession();
  };

  const impersonateUser = async (userId: string) => {
    await withStepUp(async () => unwrap(await authClient.admin.impersonateUser({ userId })));
    // The admin's own session is parked by the admin plugin in an HttpOnly
    // cookie; it never reaches page JS.
    await clearAdminCookie();
    await refreshSession();
  };

  const stopImpersonating = async () => {
    const { error } = await authClient.admin.stopImpersonating();
    if (error) {
      // Restore failed (session expired, cookie lost): fail closed to a
      // clean sign-out rather than staying in the target's session.
      await authClient.signOut().catch(() => undefined);
      setUser(null);
      setSession(null);
      return;
    }
    await refreshSession();
  };

  const mfa = {
    verify: async (code: string, kind: 'totp' | 'backup' = 'totp') => {
      unwrap(
        kind === 'backup'
          ? await authClient.twoFactor.verifyBackupCode({ code })
          : await authClient.twoFactor.verifyTotp({ code })
      );
      setPendingMfaChallenge(false);
      return refreshSession();
    },
    enroll: async (password?: string) => {
      const data = await withStepUp(async () =>
        unwrap(await authClient.twoFactor.enable(password ? { password } : {}))
      );
      if (!data || !('totpURI' in data) || !data.totpURI) {
        throw new AuthRequestError({ code: 'TOTP_NOT_CONFIGURED' });
      }
      return { totpURI: data.totpURI, backupCodes: data.backupCodes ?? [] };
    },
    confirmEnrollment: async (code: string) => {
      unwrap(await authClient.twoFactor.verifyTotp({ code }));
      await refreshSession();
    },
    disable: async (password?: string) => {
      await withStepUp(async () =>
        unwrap(await authClient.twoFactor.disable(password ? { password } : {}))
      );
      await refreshSession();
    },
    hasPassword: async () => {
      const accounts = unwrap(await authClient.listAccounts());
      return (accounts ?? []).some((a) => a.providerId === 'credential');
    },
  };

  const stepUpVerify = async (code: string, kind: 'totp' | 'backup') => {
    unwrap(
      kind === 'backup'
        ? await authClient.twoFactor.verifyBackupCode({ code })
        : await authClient.twoFactor.verifyTotp({ code })
    );
    await refreshSession();
    finishStepUp(true);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: the action objects are rebuilt each render and read current state; only the listed values change what consumers render
  const value = useMemo(
    () => ({
      user,
      session,
      isLoading,
      isSuperAdmin,
      mfaRequired,
      hasMfaEnabled,
      isAal2,
      pendingMfaChallenge,
      isImpersonating: impersonationTarget !== null,
      impersonationTarget,
      signIn,
      signUp,
      signOut,
      clearMfaChallenge: () => setPendingMfaChallenge(false),
      refreshSession,
      updateUser,
      stepUp,
      impersonateUser,
      stopImpersonating,
      mfa,
    }),
    [
      user,
      session,
      isLoading,
      isSuperAdmin,
      mfaRequired,
      hasMfaEnabled,
      isAal2,
      pendingMfaChallenge,
    ]
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
      <Dialog open={stepUpOpen} onOpenChange={(open) => !open && finishStepUp(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('auth.stepUp.title')}</DialogTitle>
            <DialogDescription>{t('auth.stepUp.description')}</DialogDescription>
          </DialogHeader>
          <TwoFactorCodeForm onSubmit={stepUpVerify} submitLabel={t('auth.stepUp.confirm')} />
        </DialogContent>
      </Dialog>
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
