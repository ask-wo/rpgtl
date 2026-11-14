import type { Catalog, Findings } from "@rpgtl/contracts";
import { RegistryProvider } from "@effect/atom-react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach } from "vite-plus/test";

/** A stream of Server-Sent Events the test sends into one at a time. */
export const events = () => {
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const send = (value: unknown) =>
    void writer.write(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
  const response = () =>
    new Response(readable, { headers: { "content-type": "text/event-stream" } });
  return { send, response };
};

/**
 * The game's catalog as the server streams it: each connection starts with `catalog()` whole, and
 * `changed()` sends it whole again to every connection, as after a write.
 */
export const catalogFeed = (catalog: () => Catalog, findings: () => Findings = () => ({})) => {
  const open = new Set<(value: unknown) => void>();
  const whole = () => ({ _tag: "whole", catalog: catalog(), findings: findings() });
  return {
    response: () => {
      const stream = events();
      stream.send(whole());
      open.add(stream.send);
      return stream.response();
    },
    changed: () => {
      for (const send of open) send(whole());
    },
  };
};

let answer: (request: Request) => Promise<Response> | Response = () =>
  new Response(null, { status: 404 });
const realFetch = globalThis.fetch;
// The page's HTTP client reads `fetch` once, so this stays for the whole test file.
globalThis.fetch = (input, init) => {
  const request = new Request(input, init);
  return new URL(request.url).pathname.startsWith("/api/")
    ? Promise.resolve(answer(request))
    : realFetch(input, init);
};

/**
 * Answers the page's API requests with `server` until the next call; `requests` lists what the
 * page asked for, as `POST /api/launch`.
 */
export const serveApi = (server: (request: Request) => Promise<Response> | Response) => {
  const requests: Array<string> = [];
  answer = (request) => {
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    return server(request);
  };
  return requests;
};

const mounted: Array<() => void> = [];
afterEach(() => {
  for (const unmount of mounted.splice(0)) act(unmount);
  localStorage.clear();
});

/** Renders `element` into `parent` with a fresh atom registry, unmounted after the test. */
export const render = (element: React.ReactNode, parent: HTMLElement = document.body) => {
  const root = createRoot(parent.appendChild(document.createElement("div")));
  act(() => root.render(<RegistryProvider>{element}</RegistryProvider>));
  mounted.push(() => root.unmount());
};
