import {
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';

import { AppShell, SessionPage } from './App.js';
import { EvalCasePage } from './EvalCasePage.js';
import { EvalsPage } from './EvalsPage.js';
import { SessionsPage } from './SessionsPage.js';

const rootRoute = createRootRoute({
  component: AppShell,
  notFoundComponent: () => (
    <main id="main-content" className="page-error">
      <strong>That local case file does not exist.</strong>
      <p>Return to the archive and choose an available session.</p>
    </main>
  ),
});

const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: SessionsPage,
});

const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions/$sessionId',
  component: SessionPage,
});

const evalsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/evals',
  component: EvalsPage,
});

const evalCaseRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/evals/$caseId',
  component: EvalCasePage,
});

const routeTree = rootRoute.addChildren([
  sessionsRoute,
  sessionRoute,
  evalsRoute,
  evalCaseRoute,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  scrollRestoration: true,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
