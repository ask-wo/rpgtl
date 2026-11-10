import type { EndpointProblem } from "@rpgtl/contracts";
import * as Result from "effect/Result";

const localHosts = ["127.0.0.1", "localhost", "[::1]"];

/** The endpoint as a URL, if it is an HTTP server on this computer, so no text leaves it. */
export function localEndpoint(text: string): Result.Result<URL, EndpointProblem> {
  const url = URL.parse(text);
  if (!url) return Result.fail("invalid");
  if (url.protocol !== "http:" && url.protocol !== "https:") return Result.fail("notHttp");
  if (!localHosts.includes(url.hostname) || url.username || url.password)
    return Result.fail("notLocal");
  return Result.succeed(url);
}
