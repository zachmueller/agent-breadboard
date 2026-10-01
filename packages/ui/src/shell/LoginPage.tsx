/** Sign-in ([12] §3): local static-user token form (dev banner) or OIDC redirect. */
import { useState, type FormEvent } from 'react';
import { KeyRound, LogIn, RefreshCw, WifiOff } from 'lucide-react';
import { useAuth, useAuthModeInfo } from '../lib/auth';
import { errorMessage } from '../lib/api';
import { Button } from '../components/Button';
import { Input } from '../components/form';
import { Callout, Loading } from '../components/feedback';
import { DevModeBanner } from './AppShell';

function Frame({ children, banner }: { children: React.ReactNode; banner?: boolean }) {
  return (
    <div className="flex min-h-screen flex-col bg-page text-fg">
      {banner && <DevModeBanner />}
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-[380px]">
          <div className="mb-6 flex items-center gap-2.5">
            <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden>
              <rect x="1.5" y="1.5" width="21" height="21" rx="5" className="fill-accent" />
              <path d="M7 7 L12 12 L17 12 L17 17" className="stroke-accent-fg" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Agent Breadboard</h1>
              <p className="text-[12.5px] text-fg-muted">Design, run and maintain AI circuits</p>
            </div>
          </div>
          <div className="rounded-xl border border-line bg-surface p-6 shadow-sm">{children}</div>
        </div>
      </div>
    </div>
  );
}

export function LoginPage() {
  const { status, mode, login, startOidc, error } = useAuth();
  const info = useAuthModeInfo();
  const [token, setTokenValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (status === 'loading') return <Loading label="Connecting to Breadboard…" className="h-screen" />;

  if (status === 'unreachable')
    return (
      <Frame>
        <div className="flex flex-col items-start gap-3">
          <WifiOff size={20} className="text-danger-fg" aria-hidden />
          <div>
            <h2 className="font-semibold">Server unreachable</h2>
            <p className="mt-1 text-[13px] text-fg-muted">The Breadboard API did not respond. Check that the server is running and reachable from this browser.</p>
            {error ? <p className="mt-2 font-mono text-[12px] text-fg-subtle">{errorMessage(error)}</p> : null}
          </div>
          <Button icon={<RefreshCw size={14} />} onClick={() => window.location.reload()}>
            Retry
          </Button>
        </div>
      </Frame>
    );

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await login(token);
    } catch (x) {
      setErr(errorMessage(x));
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'local')
    return (
      <Frame banner>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div>
            <h2 className="font-semibold">Sign in</h2>
            <p className="mt-1 text-[13px] text-fg-muted">Enter the static-user login token from this deployment's local identity configuration.</p>
          </div>
          <Input label="Login token" type="password" autoFocus autoComplete="current-password" value={token} onChange={(e) => setTokenValue(e.target.value)} leading={<KeyRound size={14} />} error={err ?? undefined} />
          {info?.users?.length ? <p className="text-[12px] text-fg-subtle">Configured users: {info.users.map((u) => '@' + u.handle).join(', ')}</p> : null}
          <Button type="submit" variant="primary" loading={busy} disabled={!token.trim()} icon={<LogIn size={14} />}>
            Sign in
          </Button>
        </form>
      </Frame>
    );

  return (
    <Frame>
      <div className="flex flex-col gap-4">
        <div>
          <h2 className="font-semibold">Sign in</h2>
          <p className="mt-1 text-[13px] text-fg-muted">Use your organization's identity provider{info?.provider ? ` (${info.provider})` : ''}.</p>
        </div>
        {info && info.oidc_enabled === false && <Callout tone="warn">OIDC is selected but not configured on the server. Ask an operator to complete the identity configuration.</Callout>}
        <Button variant="primary" icon={<LogIn size={14} />} onClick={() => startOidc()} disabled={info?.oidc_enabled === false}>
          Sign in{info?.provider ? ` with ${info.provider}` : ''}
        </Button>
      </div>
    </Frame>
  );
}
