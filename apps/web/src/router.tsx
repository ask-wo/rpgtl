import {
  createRootRoute,
  createRoute,
  createRouter,
  type RouterHistory,
} from "@tanstack/react-router";
import { AppShell } from "./app/AppShell.tsx";
import { GameLayout } from "./games/GameLayout.tsx";
import { OpenGamePage } from "./games/OpenGamePage.tsx";
import { GlossaryPage } from "./glossary/GlossaryPage.tsx";
import { ImagesPage } from "./images/ImagesPage.tsx";
import { Overview } from "./games/Overview.tsx";
import { SettingsPage } from "./settings/SettingsPage.tsx";
import { textSearch } from "./text/search.ts";
import { TextPage } from "./text/TextPage.tsx";

const rootRoute = createRootRoute({ component: AppShell });

const openRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: OpenGamePage,
});

const gameRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/games/$gameId",
  component: GameLayout,
});

const overviewRoute = createRoute({
  getParentRoute: () => gameRoute,
  path: "/",
  component: Overview,
});

const glossaryRoute = createRoute({
  getParentRoute: () => gameRoute,
  path: "/glossary",
  component: GlossaryPage,
});

const textRoute = createRoute({
  getParentRoute: () => gameRoute,
  path: "/text",
  validateSearch: textSearch,
  component: TextPage,
});

const imagesRoute = createRoute({
  getParentRoute: () => gameRoute,
  path: "/images",
  component: ImagesPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});

/** The page's router; `history` defaults to the browser's address. */
export const createAppRouter = (history?: RouterHistory) =>
  createRouter({
    ...(history && { history }),
    routeTree: rootRoute.addChildren([
      openRoute,
      gameRoute.addChildren([overviewRoute, glossaryRoute, textRoute, imagesRoute]),
      settingsRoute,
    ]),
    // Search values stay text, as `?q=12` is a search for 12 rather than the number.
    parseSearch: (search) => Object.fromEntries(new URLSearchParams(search)),
    stringifySearch: (search) => {
      const params = new URLSearchParams(
        Object.entries(search).flatMap(([key, value]) =>
          typeof value === "string" ? [[key, value]] : [],
        ),
      ).toString();
      return params ? `?${params}` : "";
    },
  });

export const router = createAppRouter();

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
