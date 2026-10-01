import { Activity, Bot, BookOpen, FileText, Inbox, LayoutDashboard, Shield, Workflow, Wrench, type LucideIcon } from 'lucide-react';

export interface NavArea {
  key: string;
  label: string;
  to: string;
  icon: LucideIcon;
  /** `g` + this key jumps here. */
  jump: string;
  match: (path: string) => boolean;
  adminOnly?: boolean;
  description: string;
}

const starts = (...prefixes: string[]) => (p: string) => prefixes.some((x) => p === x || p.startsWith(x + '/'));

/** The seven areas + dashboard ([10] §1–§2), plus Admin. */
export const NAV_AREAS: NavArea[] = [
  { key: 'dashboard', label: 'Dashboard', to: '/', icon: LayoutDashboard, jump: 'd', match: (p) => p === '/', description: 'Breadboard health metrics' },
  { key: 'intake', label: 'Intake', to: '/intake', icon: Inbox, jump: 'i', match: starts('/intake', '/tasks'), description: 'Idea shaping and the task queue' },
  { key: 'circuits', label: 'Circuits', to: '/circuits', icon: Workflow, jump: 'c', match: starts('/circuits'), description: 'Designed AI flows' },
  { key: 'knowledge', label: 'Knowledge', to: '/knowledge', icon: BookOpen, jump: 'k', match: starts('/knowledge'), description: 'Curated notes and domains' },
  { key: 'toolbox', label: 'Toolbox', to: '/toolbox', icon: Wrench, jump: 't', match: starts('/toolbox'), description: 'Tool extensions and MCP servers' },
  { key: 'subagents', label: 'Subagents', to: '/subagents', icon: Bot, jump: 'e', match: starts('/subagents'), description: 'Narrowly-scoped AI experts' },
  { key: 'content', label: 'Content', to: '/content', icon: FileText, jump: 'n', match: starts('/content', '/n'), description: 'Artifacts, review queue, viewer' },
  { key: 'sessions', label: 'Sessions', to: '/sessions', icon: Activity, jump: 's', match: starts('/sessions', '/s'), description: 'Execution history and explorer' },
  { key: 'admin', label: 'Admin', to: '/admin', icon: Shield, jump: 'a', match: starts('/admin'), adminOnly: true, description: 'Users, roles, tokens, broker, health' },
];

export const EXTRA_JUMPS: Array<{ jump: string; label: string; to: string }> = [
  { jump: 'r', label: 'Review queue', to: '/content/review' },
  { jump: 'q', label: 'Task inventory', to: '/tasks' },
];
