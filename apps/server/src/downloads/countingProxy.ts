import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import * as Effect from "effect/Effect";
import { portOf } from "../freePort.ts";

/**
 * Starts a proxy on 127.0.0.1 that passes HTTPS connections through unread and calls `received`
 * with the size of each piece the servers send, until the scope closes. Programs use it when
 * `HTTPS_PROXY` names its address, which this gives.
 */
export const countingProxy = (received: (bytes: number) => void) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly server: ReturnType<typeof createServer>;
      readonly sockets: Set<Socket>;
      readonly url: string;
    }>((resume) => {
      const server = createServer((_, answer) => {
        answer.writeHead(405).end("Only HTTPS goes through this proxy.");
      });
      const sockets = new Set<Socket>();
      const track = (socket: Socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      };
      server.on("connection", track);
      server.on("connect", (request, client: Socket, head: Buffer) => {
        const target = /^\[?([^\]]+)\]?:(\d+)$/.exec(request.url ?? "");
        if (!target) {
          client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
          return;
        }
        const upstream = connect(Number(target[2]), target[1], () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          upstream.write(head);
          upstream.pipe(client);
          client.pipe(upstream);
        });
        track(upstream);
        upstream.on("data", (chunk: Buffer) => received(chunk.length));
        upstream.on("error", () => client.destroy());
        client.on("error", () => upstream.destroy());
        client.on("close", () => upstream.destroy());
      });
      server.once("error", (error) => resume(Effect.die(error)));
      server.listen(0, "127.0.0.1", () => {
        resume(Effect.succeed({ server, sockets, url: `http://127.0.0.1:${portOf(server)}` }));
      });
    }),
    ({ server, sockets }) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
        for (const socket of sockets) socket.destroy();
      }),
  ).pipe(Effect.map(({ url }) => url));
