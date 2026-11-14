// oxlint-disable effecttsgo/strict-effect-provide -- a command-line entry point
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { decodeXpFile, scriptsFile } from "@rpgtl/domain";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as GameFolder from "./games/GameFolder.ts";

const command = Command.make(
  "xp-scripts",
  {
    game: Argument.Directory("game", { mustExist: true }),
    out: Argument.Directory("out"),
  },
  Effect.fn("xpScripts")(function* ({ game, out }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const folder = yield* GameFolder.GameFolder;
    const found = yield* folder.inspect(game);
    const bytes = (yield* folder.xpData(found)).get(scriptsFile);
    if (!bytes) return yield* Console.error(`${found.root} has no ${scriptsFile}.`);
    const file = yield* Effect.fromResult(decodeXpFile(scriptsFile, bytes));
    if (file._tag !== "Scripts") return;
    yield* fs.makeDirectory(out, { recursive: true });
    for (const [index, script] of file.data.entries())
      yield* fs.writeFileString(
        path.join(out, `${String(index).padStart(3, "0")}.rb`),
        `# ${script.name}\n${script.code}`,
      );
    yield* Console.log(`Wrote ${file.data.length} scripts of ${found.title} to ${out}.`);
  }),
).pipe(
  Command.withDescription(
    "Writes each script of an XP game, read as RPGTL reads it, to <out>/<index>.rb with its name on the first line.",
  ),
);

command.pipe(
  Command.run({ version: "0.1.0" }),
  Effect.provide(GameFolder.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  NodeRuntime.runMain,
);
