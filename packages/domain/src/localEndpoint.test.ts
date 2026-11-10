import { assert, describe, it } from "@effect/vitest";
import * as Result from "effect/Result";
import { localEndpoint } from "./localEndpoint.ts";

describe("localEndpoint", () => {
  it("takes HTTP servers on this computer", () => {
    for (const text of ["http://127.0.0.1:11434", "https://localhost:8080/v1", "http://[::1]:1"])
      assert.deepStrictEqual(
        Result.map(localEndpoint(text), (url) => url.href),
        Result.succeed(new URL(text).href),
      );
  });

  it("names what is wrong with any other endpoint", () => {
    assert.deepStrictEqual(localEndpoint("not a url"), Result.fail("invalid"));
    assert.deepStrictEqual(localEndpoint("ftp://127.0.0.1"), Result.fail("notHttp"));
    assert.deepStrictEqual(localEndpoint("http://example.com:11434"), Result.fail("notLocal"));
    assert.deepStrictEqual(
      localEndpoint("http://user:pw@127.0.0.1:11434"),
      Result.fail("notLocal"),
    );
  });
});
