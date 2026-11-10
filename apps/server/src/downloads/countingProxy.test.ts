import { assert, it } from "@effect/vitest";
import { createServer, connect } from "node:net";
import * as Effect from "effect/Effect";
import { portOf } from "../freePort.ts";
import { countingProxy } from "./countingProxy.ts";

/** A server on 127.0.0.1 that sends `bytes` to each connection, then closes it. */
const sending = (bytes: number) =>
  Effect.acquireRelease(
    Effect.callback<ReturnType<typeof createServer>>((resume) => {
      const server = createServer((socket) => socket.end(Buffer.alloc(bytes)));
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
  ).pipe(Effect.map(portOf));

/** What a client tunnelling to `port` through the proxy at `proxy` hears, minus the proxy's answer. */
const throughProxy = (proxy: string, port: number) =>
  Effect.callback<string>((resume) => {
    const url = new URL(proxy);
    const socket = connect(Number(url.port), url.hostname, () =>
      socket.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`),
    );
    const heard: Array<Buffer> = [];
    socket.on("data", (chunk: Buffer) => heard.push(chunk));
    socket.on("close", () => resume(Effect.succeed(Buffer.concat(heard).toString("latin1"))));
  });

it.live("passes connections through and counts the bytes the server sends", () =>
  Effect.gen(function* () {
    const port = yield* sending(100_000);
    let received = 0;
    const proxy = yield* countingProxy((bytes) => {
      received += bytes;
    });
    const heard = yield* throughProxy(proxy, port);
    assert.isTrue(heard.startsWith("HTTP/1.1 200 Connection Established\r\n\r\n"));
    assert.strictEqual(
      heard.length - "HTTP/1.1 200 Connection Established\r\n\r\n".length,
      100_000,
    );
    assert.strictEqual(received, 100_000);
  }).pipe(Effect.scoped),
);
