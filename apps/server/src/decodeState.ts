// oxlint-disable effecttsgo/strict-effect-provide -- a command-line entry point
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Flag from "effect/cli/Flag";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { decodeSettings, decodeStateFolder } from "./state/decodeStateFolder.ts";
import * as StateFolder from "./state/StateFolder.ts";

const command = Command.make(
  "decode-state",
  {
    dir: Argument.Directory("dir", { mustExist: true }),
    settings: Flag.File("settings", { mustExist: true }).pipe(
      Flag.withDescription("Also decode this settings.json"),
      Flag.optional,
    ),
  },
  Effect.fn("decodeState")(function* ({ dir, settings }) {
    const path = yield* Path.Path;
    const settingsDecoded = yield* Effect.transposeOption(
      Option.map(settings, (file) =>
        StateFolder.make(path.dirname(file)).pipe(
          Effect.flatMap((folder) => decodeSettings(folder, path.basename(file))),
        ),
      ),
    );
    const folderDecoded = yield* decodeStateFolder().pipe(
      Effect.provide(
        StateFolder.layer.pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ RPGTL_DIR: dir }))),
        ),
      ),
    );
    const decoded = [...Option.toArray(settingsDecoded), ...folderDecoded];
    for (const { file, problem } of decoded)
      yield* Console.log(problem === undefined ? `ok    ${file}` : `FAIL  ${file}: ${problem}`);
    const count = decoded.filter(({ problem }) => problem !== undefined).length;
    if (count > 0) {
      yield* Console.log(`${count} of ${decoded.length} files don't decode.`);
      yield* Effect.sync(() => {
        process.exitCode = 1;
      });
    }
  }),
).pipe(
  Command.withDescription(
    "Decodes each file of a state folder with the schemas the server reads it with. Only reads.",
  ),
);

command.pipe(
  Command.run({ version: "0.1.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
