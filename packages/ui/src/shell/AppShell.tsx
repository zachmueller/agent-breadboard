/** App shell ([10] §2): left rail (seven areas + dashboard + admin), top bar (search, review badge, user menu). */
import { useState, type ReactNode } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { AlertTriangle, ChevronDown, ClipboardCheck, Keyboard, LogOut, Search, User } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { useGlobalLiveInvalidation, useReviewCount } from '../lib/queries';
import { useLiveConnected } from '../lib/live';
import { cn } from '../components/cn';
import { Kbd, modKey } from '../components/Kbd';
import { Menu } from '../components/Menu';
import { Tooltip } from '../components/Tooltip';
import { NAV_AREAS } from './nav';
import { useKeyboardShortcuts } from './keyboard';
import { CommandPalette } from './CommandPalette';
import { ShortcutsHelp } from './ShortcutsHelp';
import { Toaster } from './Toaster';

function BrandMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden className="shrink-0">
      <rect x="1.5" y="1.5" width="21" height="21" rx="5" className="fill-accent" />
      <g className="fill-accent-fg">
        {[7, 12, 17].map((x) => [7, 12, 17].map((y) => <circle key={`${x}-${y}`} cx={x} cy={y} r={1.35} />))}
      </g>
      <path d="M7 7 L12 12 L17 12 L17 17" className="stroke-accent-fg" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Rail({ path, isAdmin, teamName }: { path: string; isAdmin: boolean; teamName: string | null }) {
  return (
    <nav aria-label="Primary" className="flex w-[208px] shrink-0 flex-col border-r border-line bg-surface">
      <Link to="/" className="flex h-12 items-center gap-2.5 border-b border-line px-4 focus-visible:outline-offset-[-2px]">
        <BrandMark />
        <span className="min-w-0 leading-tight">
          <span className="block text-[13.5px] font-semibold tracking-tight">Breadboard</span>
          {teamName && <span className="block truncate text-[11px] text-fg-subtle">{teamName}</span>}
        </span>
      </Link>
      <ul className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2">
        {NAV_AREAS.filter((a) => !a.adminOnly || isAdmin).map((a) => {
          const active = a.match(path);
          const Icon = a.icon;
          return (
            <li key={a.key} className={cn(a.adminOnly && 'mt-auto')}>
              {a.key === 'intake' && <div className="mx-2 mb-1 mt-2 h-px bg-line" aria-hidden />}
              <Link
                to={a.to}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'group flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] transition-colors',
                  active ? 'bg-accent-soft font-medium text-accent-text' : 'text-fg-muted hover:bg-hover hover:text-fg',
                )}
              >
                <Icon size={16} aria-hidden className={cn('shrink-0', active ? 'text-accent-text' : 'text-fg-subtle group-hover:text-fg-muted')} />
                <span className="flex-1 truncate">{a.label}</span>
                <span className="hidden font-mono text-[10.5px] text-fg-subtle group-hover:inline" aria-hidden>
                  g {a.jump}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function ReviewBadge() {
  const { data } = useReviewCount();
  const count = data?.count ?? 0;
  const gated = data?.gated ?? 0;
  return (
    <Tooltip content={count ? `${count} open review request${count === 1 ? '' : 's'}${gated ? ` · ${gated} gated` : ''}` : 'Your review queue is empty'}>
      <Link
        to="/content/review"
        aria-label={`Review queue: ${count} open`}
        className={cn(
          'inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[13px] transition-colors',
          count ? 'border-warn/40 bg-warn-soft text-warn-fg hover:bg-warn-soft/70' : 'border-line text-fg-muted hover:bg-hover hover:text-fg',
        )}
      >
        <ClipboardCheck size={15} aria-hidden />
        <span className="hidden sm:inline">Review</span>
        <span className={cn('tabular min-w-[1.25rem] rounded px-1 text-center text-[12px] font-semibold', count ? 'bg-warn text-white' : 'bg-raised text-fg-muted')}>{count}</span>
      </Link>
    </Tooltip>
  );
}

function LiveDot() {
  const connected = useLiveConnected();
  return (
    <Tooltip content={connected ? 'Live updates connected' : 'Live updates disconnected — reconnecting'}>
      <span className="inline-flex h-8 items-center gap-1.5 px-1.5 text-[12px] text-fg-subtle" role="status" aria-label={connected ? 'Live' : 'Offline'}>
        <span className={cn('h-2 w-2 rounded-full', connected ? 'bg-ok' : 'bg-fg-subtle/50')} />
        <span className="hidden lg:inline">{connected ? 'Live' : 'Offline'}</span>
      </span>
    </Tooltip>
  );
}

export function DevModeBanner({ className }: { className?: string }) {
  return (
    <div role="note" className={cn('flex items-center justify-center gap-2 border-b border-warn/40 bg-warn-soft px-4 py-1 text-[12px] text-warn-fg', className)}>
      <AlertTriangle size={13} aria-hidden />
      <span>
        <strong className="font-semibold">Local development mode</strong> — static users, no real authentication. Do not expose this deployment.
      </span>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user, isAdmin, mode, logout, teamName } = useAuth();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  useGlobalLiveInvalidation(true);
  useKeyboardShortcuts({ openPalette: () => setPaletteOpen(true), openHelp: () => setHelpOpen(true), isAdmin });

  return (
    <div className="flex h-screen flex-col bg-page text-fg">
      {mode === 'local' && <DevModeBanner />}
      <div className="flex min-h-0 flex-1">
        <Rail path={path} isAdmin={isAdmin} teamName={teamName} />
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-4">
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              className="flex h-8 w-full max-w-[420px] items-center gap-2 rounded-md border border-line bg-sunken px-2.5 text-[13px] text-fg-subtle transition-colors hover:border-line-strong hover:text-fg-muted"
            >
              <Search size={15} aria-hidden />
              <span className="flex-1 text-left">Search Breadboard…</span>
              <Kbd>{modKey}</Kbd>
              <Kbd>K</Kbd>
            </button>
            <div className="ml-auto flex items-center gap-1.5">
              <LiveDot />
              <ReviewBadge />
              <Menu
                align="end"
                label="User menu"
                items={[
                  { key: 'who', label: <span className="text-fg-subtle">Signed in as @{user?.handle}</span>, disabled: true },
                  { key: 'keys', label: 'Keyboard shortcuts', icon: <Keyboard size={14} />, hint: '?', onSelect: () => setHelpOpen(true), separator: true },
                  { key: 'logout', label: 'Sign out', icon: <LogOut size={14} />, onSelect: () => void logout(), separator: true },
                ]}
                trigger={(p) => (
                  <button
                    type="button"
                    {...p}
                    className="inline-flex h-8 items-center gap-2 rounded-md px-2 text-[13px] text-fg-muted hover:bg-hover hover:text-fg"
                  >
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-raised text-[11px] font-semibold text-fg">
                      {user?.display_name?.[0]?.toUpperCase() ?? <User size={13} />}
                    </span>
                    <span className="hidden max-w-[140px] truncate md:inline">{user?.display_name ?? user?.handle}</span>
                    <ChevronDown size={13} aria-hidden />
                  </button>
                )}
              />
            </div>
          </header>
          <main id="bb-main" className="min-h-0 flex-1 overflow-y-auto">
            {children}
          </main>
        </div>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <ShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} isAdmin={isAdmin} />
      <Toaster />
    </div>
  );
}
