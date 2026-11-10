import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SessionToken from "../auth/SessionToken.ts";
import * as Frontend from "./Frontend.ts";

const services = Frontend.layer.pipe(
  Layer.provide(Layer.succeed(SessionToken.SessionToken, "test-token")),
  Layer.provide(NodeServices.layer),
);

it.effect(
  "the page carries this start's token, and the scripts and styles it names are built with it",
  () =>
    Effect.gen(function* () {
      const { page } = yield* Frontend.Frontend;
      assert.strictEqual(page._tag, "Built");
      if (page._tag !== "Built") return;
      const index = yield* page.file("/index.html");
      assert.isTrue(Option.isSome(index));
      if (Option.isNone(index)) return;
      const html = String(index.value.body);
      assert.include(html, '<meta name="rpgtl-token" content="test-token" />');
      const named = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(([, file]) => file);
      assert.isAbove(named.length, 1);
      for (const file of named) assert.isTrue(Option.isSome(yield* page.file(file ?? "")), file);
      assert.isTrue(Option.isNone(yield* page.file("/assets/missing.js")));
    }).pipe(Effect.provide(services)),
  { timeout: 60_000 },
);

it.effect(
  "each game script is one file with its fonts inside",
  () =>
    Effect.gen(function* () {
      const frontend = yield* Frontend.Frontend;
      for (const script of Frontend.ScriptFile.literals)
        assert.notMatch(yield* frontend.script(script), /^\s*import\s/m, script);
      const fonts = [
        ...(yield* frontend.script("runtime.js")).matchAll(/"data:font\/woff2;base64,([^"]+)"/g),
      ];
      assert.strictEqual(fonts.length, 4);
      for (const [, base64] of fonts)
        assert.strictEqual(
          Buffer.from(base64 ?? "", "base64")
            .subarray(0, 4)
            .toString(),
          "wOF2",
        );
    }).pipe(Effect.provide(services)),
  { timeout: 60_000 },
);

it.effect("a prebuilt folder serves its page with this start's token and its game scripts", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(`${dir}/page/assets`, { recursive: true });
    yield* fs.makeDirectory(`${dir}/game`);
    yield* fs.writeFileString(`${dir}/page/index.html`, '<meta content="__TOKEN__" />');
    yield* fs.writeFileString(`${dir}/page/assets/index.css`, "body {}");
    for (const script of Frontend.ScriptFile.literals)
      yield* fs.writeFileString(`${dir}/game/${script}`, `// ${script}`);
    const { page, script } = yield* Frontend.Frontend.pipe(
      Effect.provide(
        Frontend.layerPrebuilt(dir).pipe(
          Layer.provide(Layer.succeed(SessionToken.SessionToken, "test-token")),
        ),
      ),
    );
    assert.strictEqual(page._tag, "Built");
    if (page._tag !== "Built") return;
    const index = yield* page.file("/index.html");
    assert.strictEqual(Option.getOrUndefined(index)?.body, '<meta content="test-token" />');
    const css = Option.getOrUndefined(yield* page.file("/assets/index.css"));
    assert.strictEqual(css?.contentType, "text/css; charset=utf-8");
    assert.deepStrictEqual(css?.body, new TextEncoder().encode("body {}"));
    assert.isTrue(Option.isNone(yield* page.file("/assets/missing.js")));
    assert.strictEqual(yield* script("map-view.js"), "// map-view.js");
  }).pipe(Effect.provide(NodeServices.layer)),
);
