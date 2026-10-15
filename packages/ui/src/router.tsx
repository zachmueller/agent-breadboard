/**
 * Code-based route tree ([10] §2 deep links). The router type is intentionally NOT registered
 * (`declare module … Register`), so `to` stays a loose string across independently-built areas.
 *
 * Pages owned by other areas are imported via their `src/areas/<area>/index.ts` and rendered with
 * both props (`uid` / `id`) and router params available, so either convention works.
 */
import { createElement, useEffect, type ComponentType } from 'react';
import { Outlet, createRootRoute, createRoute, createRouter, useNavigate, useParams } from '@tanstack/react-router';
import * as IntakeArea from './areas/intake';
import * as ConfigArea from './areas/config';
import * as KnowledgeArea from './areas/knowledge';
import { Dashboard } from './areas/dashboard/Dashboard';
import { SessionsList, SessionExplorer } from './areas/sessions';
import { ContentInventory, ContentViewer, ReviewQueuePage } from './areas/content';
import { Admin } from './areas/admin/Admin';
import { useAuth } from './lib/auth';
import { stringSearch } from './lib/url';
import { AppShell } from './shell/AppShell';
import { LoginPage } from './shell/LoginPage';
import { ConfigRedirect } from './shell/ConfigRedirect';
import { NotFound } from './shell/NotFound';
import { EmptyState, Loading } from './components/feedback';

type AnyPage = ComponentType<any>;

function areaPage(mod: object, name: string, area: string): AnyPage {
  const C = (mod as Record<string, unknown>)[name];
  if (typeof C === 'function' || (typeof C === 'object' && C !== null)) return C as AnyPage;
  return function MissingAreaPage() {
    return <EmptyState title={`${name} is not available`} description={`The ${area} area does not export ${name} yet.`} className="py-24" />;
  };
}

/** Render a page with route params passed as props too. */
function withParams(Comp: AnyPage) {
  return function RoutedPage() {
    const params = useParams({ strict: false }) as Record<string, string | undefined>;
    return createElement(Comp, { ...params, key: params.uid ?? params.id ?? 'page' });
  };
}

function AuthGate() {
  const { status } = useAuth();
  if (status === 'loading') return <Loading label="Loading Breadboard…" className="h-screen" />;
  if (status !== 'signed-in') return <LoginPage />;
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

function LoginRoute() {
  const { status } = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    if (status === 'signed-in') navigate({ to: '/', replace: true });
  }, [status, navigate]);
  return <LoginPage />;
}

const rootRoute = createRootRoute({ component: Outlet, notFoundComponent: NotFound });
const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: '/login', component: LoginRoute });
const appRoute = createRoute({ getParentRoute: () => rootRoute, id: 'app', component: AuthGate, notFoundComponent: NotFound });

const page = (path: string, component: AnyPage, search = false) =>
  createRoute({ getParentRoute: () => appRoute, path, component: component as never, ...(search ? { validateSearch: stringSearch } : {}) });

const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([
    page('/', Dashboard),
    // Content ([09] §5)
    page('/content', ContentInventory, true),
    page('/content/review', ReviewQueuePage, true),
    page('/n/$uid', withParams(ContentViewer), true),
    // Sessions ([02] §8)
    page('/sessions', SessionsList, true),
    page('/s/$id', withParams(SessionExplorer), true),
    // Config deep link ([10] §2)
    page('/config/$uid', withParams(ConfigRedirect)),
    page('/admin', Admin, true),
    // Intake ([08] §7)
    page('/intake', withParams(areaPage(IntakeArea, 'IntakeConversationsPage', 'Intake')), true),
    page('/intake/$id', withParams(areaPage(IntakeArea, 'IntakeConversationPage', 'Intake')), true),
    page('/tasks', withParams(areaPage(IntakeArea, 'TaskInventoryPage', 'Intake')), true),
    // Config editors ([03] §8, [06] §10, [05] §7)
    page('/circuits', withParams(areaPage(ConfigArea, 'CircuitsInventoryPage', 'Circuits')), true),
    page('/circuits/$uid', withParams(areaPage(ConfigArea, 'CircuitEditorPage', 'Circuits')), true),
    page('/toolbox', withParams(areaPage(ConfigArea, 'ToolboxInventoryPage', 'Toolbox')), true),
    page('/toolbox/$uid', withParams(areaPage(ConfigArea, 'ToolEditorPage', 'Toolbox')), true),
    page('/subagents', withParams(areaPage(ConfigArea, 'SubagentsInventoryPage', 'Subagents')), true),
    page('/subagents/$uid', withParams(areaPage(ConfigArea, 'SubagentEditorPage', 'Subagents')), true),
    // Proposal review ([10] §4 propose-review-commit)
    page('/proposals', withParams(areaPage(ConfigArea, 'ProposalsPage', 'Proposals')), true),
    page('/proposals/$id', withParams(areaPage(ConfigArea, 'ProposalReviewPage', 'Proposals'))),
    // Knowledge ([07] §10)
    page('/knowledge', withParams(areaPage(KnowledgeArea, 'KnowledgeSearchPage', 'Knowledge')), true),
    page('/knowledge/$uid', withParams(areaPage(KnowledgeArea, 'NoteEditorPage', 'Knowledge')), true),
  ]),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  defaultNotFoundComponent: NotFound,
  scrollRestoration: true,
});
