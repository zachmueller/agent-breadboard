/**
 * The single system-wide actor taxonomy ([11] §2): every write is attributed to one of these.
 * `service` is reserved for server-internal writes (connector syncs, orchestrator bookkeeping).
 */
export type ActorKind = 'user' | 'subagent' | 'code-step' | 'service';

export interface Actor {
  kind: ActorKind;
  /** user_id for users; subagent config UID for subagents; tool UID for code steps; component name for services. */
  id: string;
  /** Session the actor is acting within, when applicable (subagent/code-step always; user when in a conversation). */
  session_id?: string;
  /** Step within the session, when applicable. */
  step_id?: string;
  /** Display handle for users (denormalized for logs/attribution). */
  handle?: string;
}

export const SERVICE_ACTOR = (component: string): Actor => ({ kind: 'service', id: component });

export function actorLabel(a: Actor): string {
  switch (a.kind) {
    case 'user':
      return a.handle ? `@${a.handle}` : `user:${a.id}`;
    case 'subagent':
      return `subagent:${a.id}`;
    case 'code-step':
      return `tool:${a.id}`;
    case 'service':
      return `service:${a.id}`;
  }
}
