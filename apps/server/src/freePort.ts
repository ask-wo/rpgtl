import { createServer, type Server } from "node:net";
import * as Effect from "effect/Effect";

export const portOf = (server: Pick<Server, "address">) => {
  const address = server.address();
  return typeof address === "object" && address ? address.port : 0;
};

// Nothing else listens on 127.0.0.1 at the port the system just gave out, unless it gets it first.
export const freePort = Effect.callback<number>((resume) => {
  const server = createServer();
  server.once("error", (error) => resume(Effect.die(error)));
  server.listen(0, "127.0.0.1", () => {
    const port = portOf(server);
    server.close(() => resume(Effect.succeed(port)));
  });
});
