import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { createHash } from "node:crypto";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { httpClientAnswering } from "../testUtils/ollama.ts";
import * as Mkxpz from "./Mkxpz.ts";

/** An AppImage that, like a real one, unpacks itself into `squashfs-root` when asked to. */
const appImage = `#!/bin/sh
[ "$1" = --appimage-extract ] || exit 1
mkdir -p squashfs-root && echo "#!/bin/sh" > squashfs-root/mkxp-z.x86_64
`;

it.live("downloads the mkxp-z AppImage and unpacks it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const bytes = new TextEncoder().encode(appImage);
    const layer = Mkxpz.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          httpClientAnswering(() => Effect.succeedSome(new Response(bytes))),
          Layer.succeed(Mkxpz.MkxpzRelease, {
            version: "vtest",
            url: "https://dl.test/mkxpz.AppImage",
            size: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            folder: "squashfs-root",
            program: "mkxp-z.x86_64",
            appImage: true,
          }),
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ XDG_CACHE_HOME: dir, HOME: "/nowhere" }),
          ),
        ),
      ),
    );
    const done = yield* Effect.gen(function* () {
      const mkxpz = yield* Mkxpz.Mkxpz;
      yield* mkxpz.download;
      const status = yield* mkxpz.changes.pipe(
        Stream.filter((now) => now.phase._tag !== "Downloading"),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      return { status, program: yield* mkxpz.program };
    }).pipe(Effect.provide(layer));
    assert.deepInclude(done.status, { name: "mkxp-z", phase: { _tag: "Ready" } });
    assert.strictEqual(done.program, `${dir}/rpgtl/mkxpz/vtest/mkxp-z.x86_64`);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
