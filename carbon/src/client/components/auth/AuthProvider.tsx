import type {
  AuthMFAChallengeResponse,
  AuthMFAEnrollResponse,
  Factor,
  Session,
  User,
} from '@supabase/supabase-js';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useMfaRequired } from '../../hooks/api';
import { supabase } from '../../lib/supabase';

type MFAChallenge = {
  factorId: string;
  challengeId: string;
};

// Display-only info about who is being impersonated ({userId,email,name}).
// The admin's SESSION is never client-stored: the refresh token is parked in
// the HttpOnly vc-impersonation-restore cookie server-side, and restore is a
// server round-trip (spec 2026-07-24-session-cookie-split).
const IMPERSONATION_TARGET_KEY = 'impersonation_target';

/**
 * Mint (or refresh) the HttpOnly ForwardAuth cookie for super_admins — the
 * only credential /api/_internal/verify-role accepts from browsers. No-op for
 * everyone else, so regular users never carry a domain-wide cookie. Runs on
 * login, token refresh, and mount; failures are non-fatal because ForwardAuth
 * 401s route back through /login, which re-mints before bouncing.
 * See spec 2026-07-24-session-cookie-split.
 */
export async function syncAdminCookie(): Promise<void> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (session?.user?.app_metadata?.role !== 'super_admin') return;
  try {
    await fetch('/api/v1/admin/forwardauth-cookie', {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
  } catch {
    // non-fatal: the next auth event (or the /login bounce) retries
  }
}

type ImpersonationInfo = {
  userId: string;
  email: string;
  name: string | null;
};

type AuthContextType = {
  user: User | null;
  session: Session | null;
  isLoading: boolean;
  /** Super admin can access the Super Admin panel and administrate the entire system */
  isSuperAdmin: boolean;
  /** Whether MFA is required app-wide (set by admin) */
  mfaRequired: boolean;
  /** Whether current user has MFA enabled */
  hasMfaEnabled: boolean;
  /** Pending MFA challenge (set during login when MFA is required) */
  pendingMfaChallenge: MFAChallenge | null;
  /** Whether currently impersonating another user */
  isImpersonating: boolean;
  /** Info about the user being impersonated */
  impersonationTarget: ImpersonationInfo | null;
  signIn: {
    email: (email: string, password: string) => Promise<{ requiresMfa: boolean }>;
    google: () => Promise<void>;
    microsoft: () => Promise<void>;
    github: () => Promise<void>;
    apple: () => Promise<void>;
    discord: () => Promise<void>;
    magicLink: (email: string) => Promise<void>;
  };
  signUp: (email: string, password: string, name?: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Clear pending MFA challenge (e.g., when user cancels) */
  clearMfaChallenge: () => void;
  /** Impersonate a user (super admin only) */
  impersonateUser: (userId: string) => Promise<void>;
  /** Stop impersonating and return to admin session */
  stopImpersonating: () => Promise<void>;
  /** MFA operations */
  mfa: {
    /** Enroll a new TOTP factor */
    enroll: (friendlyName?: string) => Promise<AuthMFAEnrollResponse['data']>;
    /** Create a challenge for an enrolled factor */
    challenge: (factorId: string) => Promise<AuthMFAChallengeResponse['data']>;
    /** Verify a challenge with a TOTP code */
    verify: (factorId: string, challengeId: string, code: string) => Promise<void>;
    /** Combined challenge and verify (convenience method) */
    challengeAndVerify: (factorId: string, code: string) => Promise<void>;
    /** Unenroll a factor */
    unenroll: (factorId: string) => Promise<void>;
    /** List enrolled factors */
    listFactors: () => Promise<Factor[]>;
    /** Get current authenticator assurance level */
    getAAL: () => Promise<{ currentLevel: string | null; nextLevel: string | null }>;
  };
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasMfaEnabled, setHasMfaEnabled] = useState(false);
  const [pendingMfaChallenge, setPendingMfaChallenge] = useState<MFAChallenge | null>(null);
  const [impersonationTarget, setImpersonationTarget] = useState<ImpersonationInfo | null>(() => {
    const saved = localStorage.getItem(IMPERSONATION_TARGET_KEY);
    return saved ? JSON.parse(saved) : null;
  });
  const isImpersonating = impersonationTarget !== null;

  // Use shared hook for MFA requirement (cached via TanStack Query)
  const { mfaRequired } = useMfaRequired();

  // Check if user has MFA enabled
  const checkUserMfa = useCallback(async () => {
    try {
      const { data } = await supabase.auth.mfa.listFactors();
      const verifiedFactors = data?.totp?.filter((f) => f.status === 'verified') || [];
      setHasMfaEnabled(verifiedFactors.length > 0);
    } catch {
      setHasMfaEnabled(false);
    }
  }, []);

  useEffect(() => {
    // Validate session on mount by calling getUser() which checks with the server
    // This handles cases where the database was reset but browser still has cached tokens
    const validateSession = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (session) {
        // Validate the session with the server
        const {
          data: { user },
          error,
        } = await supabase.auth.getUser();

        if (error || !user) {
          // Session is invalid (e.g., user deleted, database reset)
          await supabase.auth.signOut();
          setSession(null);
          setUser(null);
        } else {
          setSession(session);
          setUser(user);
          // Check MFA status for this user
          checkUserMfa();
          // Keep the ForwardAuth cookie fresh for super_admins
          syncAdminCookie();
        }
      } else {
        setSession(null);
        setUser(null);
      }

      setIsLoading(false);
    };

    validateSession();

    // Listen for auth changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
      setIsLoading(false);

      // Update MFA status when user changes
      if (session?.user) {
        checkUserMfa();
      } else {
        setHasMfaEnabled(false);
      }

      // Fresh or refreshed session → re-mint the ForwardAuth cookie so its
      // parked access token never goes stale while an admin browses subdomains
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        syncAdminCookie();
      }
    });

    return () => subscription.unsubscribe();
  }, [checkUserMfa]);

  const signIn = {
    email: async (email: string, password: string): Promise<{ requiresMfa: boolean }> => {
      // Single API call handles lockout check, auth, and lockout recording
      const response = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Login failed');
      }

      // Set the session from server response
      const { error: sessionError } = await supabase.auth.setSession({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
      });

      if (sessionError) {
        throw sessionError;
      }

      // Check if user has MFA factors
      const { data: factors } = await supabase.auth.mfa.listFactors();
      const verifiedFactors = factors?.totp?.filter((f) => f.status === 'verified') || [];

      if (verifiedFactors.length > 0) {
        // User has MFA - create challenge
        const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
          factorId: verifiedFactors[0].id,
        });

        if (challengeError) {
          throw challengeError;
        }

        if (challenge) {
          setPendingMfaChallenge({
            factorId: verifiedFactors[0].id,
            challengeId: challenge.id,
          });
          return { requiresMfa: true };
        }
      }

      return { requiresMfa: false };
    },
    google: async () => {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (error) throw error;
    },
    microsoft: async () => {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'azure',
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
          scopes: 'email',
        },
      });
      if (error) throw error;
    },
    github: async () => {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'github',
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (error) throw error;
    },
    apple: async () => {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'apple',
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (error) throw error;
    },
    discord: async () => {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'discord',
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (error) throw error;
    },
    magicLink: async (email: string) => {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (error) throw error;
    },
  };

  const impersonateUser = async (userId: string) => {
    const {
      data: { session: adminSession },
    } = await supabase.auth.getSession();
    if (!adminSession) throw new Error('No active session');

    // The admin refresh token goes to the server ONCE, over TLS, and comes
    // back only as an HttpOnly path-scoped restore cookie. It is never stored
    // where JS can read it.
    const response = await fetch(`/api/v1/admin/impersonate/${userId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminSession.access_token}`,
      },
      body: JSON.stringify({ refreshToken: adminSession.refresh_token }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Failed to impersonate user');
    }

    const target: ImpersonationInfo = {
      userId: data.user.id,
      email: data.user.email,
      name: data.user.name,
    };

    // Verify the magic link token to get a session as the target user
    const { error } = await supabase.auth.verifyOtp({
      token_hash: data.tokenHash,
      type: 'magiclink',
    });

    if (error) {
      // Roll back the parked restore cookie so a failed switch leaves no state
      await fetch('/api/v1/admin/impersonate/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ discard: true }),
      }).catch(() => {});
      throw error;
    }

    localStorage.setItem(IMPERSONATION_TARGET_KEY, JSON.stringify(target));
    setImpersonationTarget(target);
  };

  const stopImpersonating = async () => {
    localStorage.removeItem(IMPERSONATION_TARGET_KEY);
    setImpersonationTarget(null);

    // Server-side swap: the restore cookie holds the parked admin refresh
    // token; the server refreshes it and hands back a fresh session. Any
    // failure — restore window expired (1h cap), cookie lost, or a network
    // error — fails closed to a clean sign-out rather than leaving the admin
    // silently stranded in the target's session with the banner gone.
    let session: { access_token: string; refresh_token: string } | undefined;
    try {
      const response = await fetch('/api/v1/admin/impersonate/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (response.ok) {
        ({ session } = await response.json());
      }
    } catch {
      // fall through to the fail-closed sign-out below
    }

    if (!session) {
      await supabase.auth.signOut();
      return;
    }
    // Fires SIGNED_IN → syncAdminCookie re-mints the ForwardAuth cookie
    await supabase.auth.setSession(session);
  };

  const signUp = async (email: string, password: string, name?: string) => {
    // Enforce the same minimum GoTrue is configured with
    // (GOTRUE_PASSWORD_MIN_LENGTH=8) and the reset-password page uses, so the
    // rejection is immediate and consistent rather than a raw GoTrue error.
    if (password.length < 8) {
      throw new Error('Password must be at least 8 characters');
    }
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: name,
        },
      },
    });
    if (error) throw error;
  };

  const signOut = async () => {
    setPendingMfaChallenge(null);
    if (impersonationTarget) {
      // Signing out mid-impersonation: discard the parked restore cookie
      // server-side (fire-and-forget — it self-expires within the hour).
      fetch('/api/v1/admin/impersonate/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ discard: true }),
      }).catch(() => {});
    }
    localStorage.removeItem(IMPERSONATION_TARGET_KEY);
    setImpersonationTarget(null);
    // Clear the HttpOnly ForwardAuth cookie (no-op for non-admins);
    // fire-and-forget — it self-expires within the hour anyway.
    fetch('/api/v1/admin/forwardauth-cookie', { method: 'DELETE' }).catch(() => {});
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  };

  const clearMfaChallenge = () => {
    setPendingMfaChallenge(null);
  };

  // MFA operations
  const mfa = {
    enroll: async (friendlyName?: string) => {
      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName,
      });
      if (error) throw error;
      return data;
    },
    challenge: async (factorId: string) => {
      const { data, error } = await supabase.auth.mfa.challenge({ factorId });
      if (error) throw error;
      return data;
    },
    verify: async (factorId: string, challengeId: string, code: string) => {
      const { error } = await supabase.auth.mfa.verify({
        factorId,
        challengeId,
        code,
      });
      if (error) throw error;
      setPendingMfaChallenge(null);
      // Refresh MFA status
      checkUserMfa();
    },
    challengeAndVerify: async (factorId: string, code: string) => {
      const { error } = await supabase.auth.mfa.challengeAndVerify({
        factorId,
        code,
      });
      if (error) throw error;
      setPendingMfaChallenge(null);
      checkUserMfa();
    },
    unenroll: async (factorId: string) => {
      const { error } = await supabase.auth.mfa.unenroll({ factorId });
      if (error) throw error;
      checkUserMfa();
    },
    listFactors: async () => {
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (error) throw error;
      return data?.totp || [];
    },
    getAAL: async () => {
      const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (error) throw error;
      return {
        currentLevel: data?.currentLevel ?? null,
        nextLevel: data?.nextLevel ?? null,
      };
    },
  };

  // Super admin role is stored in app_metadata (set via Supabase admin API)
  const isSuperAdmin = user?.app_metadata?.role === 'super_admin';

  // biome-ignore lint/correctness/useExhaustiveDependencies: signIn/signUp/signOut/mfa/impersonateUser/stopImpersonating/clearMfaChallenge are stable references that don't need to trigger re-renders
  const value = useMemo(
    () => ({
      user,
      session,
      isLoading,
      isSuperAdmin,
      mfaRequired,
      hasMfaEnabled,
      pendingMfaChallenge,
      isImpersonating,
      impersonationTarget,
      signIn,
      signUp,
      signOut,
      clearMfaChallenge,
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
      pendingMfaChallenge,
      isImpersonating,
      impersonationTarget,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
