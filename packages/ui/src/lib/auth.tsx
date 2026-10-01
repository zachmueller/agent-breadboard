/**
 * Auth context ([12] §3). On load: `GET /auth/mode` + `GET /me`.
 * Local-dev mode signs in with a static-user token (`POST /auth/login {token}` → `{session_token, user}`);
 * OIDC mode redirects to `/auth/oidc/start`. The session token is kept in `localStorage.bb_token`.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, buildUrl, isApiError, onUnauthorized, post, setToken } from './api';
import { setLiveEnabled } from './live';
import { qk, useAuthMode, useMe } from './queries';
import type { AuthMode, LoginResponse, MeDto } from './types';

export type AuthStatus = 'loading' | 'signed-in' | 'signed-out' | 'unreachable';

export interface AuthContextValue {
  status: AuthStatus;
  mode: AuthMode | null;
  user: MeDto | null;
  isAdmin: boolean;
  teamName: string | null;
  /** Local mode: exchange a static-user token for a session. */
  login(token: string): Promise<MeDto>;
  /** OIDC mode: navigate to the provider. */
  startOidc(returnTo?: string): void;
  logout(): Promise<void>;
  error: unknown;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Capture a session token handed back in the URL fragment (`#session_token=…`) after an OIDC round-trip. */
function captureFragmentToken() {
  if (typeof window === 'undefined' || !window.location.hash) return;
  const params = new URLSearchParams(window.location.hash.slice(1));
  const t = params.get('session_token') ?? params.get('token');
  if (!t) return;
  setToken(t);
  params.delete('session_token');
  params.delete('token');
  const rest = params.toString();
  window.history.replaceState(null, '', window.location.pathname + window.location.search + (rest ? `#${rest}` : ''));
}

captureFragmentToken();

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const modeQ = useAuthMode();
  const meQ = useMe();
  const [signedOut, setSignedOut] = useState(false);

  const meErr = meQ.error;
  const status: AuthStatus = useMemo(() => {
    if (signedOut) return 'signed-out';
    if (meQ.data) return 'signed-in';
    if (meQ.isPending || modeQ.isPending) return 'loading';
    if (isApiError(meErr) && (meErr.isUnauthorized || meErr.isForbidden)) return 'signed-out';
    if (isApiError(meErr) && meErr.code === 'network') return 'unreachable';
    if (meErr) return 'signed-out';
    return 'loading';
  }, [signedOut, meQ.data, meQ.isPending, modeQ.isPending, meErr]);

  useEffect(() => {
    setLiveEnabled(status === 'signed-in');
  }, [status]);

  useEffect(
    () =>
      onUnauthorized(() => {
        if (status === 'signed-in') {
          setToken(null);
          setSignedOut(true);
        }
      }),
    [status],
  );

  const login = useCallback(
    async (token: string) => {
      const r = await post<LoginResponse>('/auth/login', { token: token.trim() });
      if (!r?.session_token) throw new ApiError('unauthorized', 'Login failed: no session token returned', 401);
      setToken(r.session_token);
      setSignedOut(false);
      if (r.user) qc.setQueryData(qk.me, { ...r.user, roles: r.user.roles ?? [] });
      await qc.invalidateQueries({ queryKey: qk.me });
      return r.user;
    },
    [qc],
  );

  const startOidc = useCallback((returnTo?: string) => {
    window.location.assign(buildUrl('/auth/oidc/start', { return_to: returnTo ?? window.location.pathname + window.location.search }));
  }, []);

  const logout = useCallback(async () => {
    try {
      await post('/auth/logout', {});
    } catch {
      /* best effort; the token is dropped client-side regardless */
    }
    setToken(null);
    setSignedOut(true);
    qc.clear();
  }, [qc]);

  const user = status === 'signed-in' ? (meQ.data ?? null) : null;
  const value: AuthContextValue = {
    status,
    mode: modeQ.data?.mode ?? null,
    user,
    isAdmin: !!user?.is_admin,
    teamName: user?.team_name ?? modeQ.data?.team_name ?? null,
    login,
    startOidc,
    logout,
    error: meErr ?? modeQ.error,
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>');
  return v;
}

/** The signed-in user (throws outside an authenticated tree). */
export function useCurrentUser(): MeDto {
  const { user } = useAuth();
  if (!user) throw new Error('useCurrentUser requires a signed-in user');
  return user;
}

export function useAuthModeInfo() {
  return useAuthMode().data ?? null;
}
