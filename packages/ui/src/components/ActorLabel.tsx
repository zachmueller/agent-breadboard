import { Bot, Cog, Server, User } from 'lucide-react';
import { actorLabel, type Actor } from '@breadboard/shared';
import { cn } from './cn';

/** Attribution label for the single actor taxonomy (`user | subagent | code-step | service`). */
export function ActorLabel({ actor, className, icon = true }: { actor: Actor | null | undefined; className?: string; icon?: boolean }) {
  if (!actor) return <span className="text-fg-subtle">—</span>;
  const Icon = actor.kind === 'user' ? User : actor.kind === 'subagent' ? Bot : actor.kind === 'code-step' ? Cog : Server;
  const label = actor.kind === 'user' ? (actor.handle ? `@${actor.handle}` : actorLabel(actor)) : actorLabel(actor);
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1 text-[13px] text-fg-muted', className)} title={actorLabel(actor)}>
      {icon && <Icon size={12} className="shrink-0 text-fg-subtle" aria-hidden />}
      <span className={cn('truncate', actor.kind !== 'user' && 'font-mono text-[12px]')}>{label}</span>
    </span>
  );
}
