import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { join } from "node:path";
import * as Frontend from "./frontend/Frontend.ts";
import * as ImageReaderSetup from "./imageText/ImageReaderSetup.ts";
import * as XpImages from "./imageText/XpImages.ts";
import { serve } from "./server.ts";

// The server of the portable download, bundled into `app/server.mjs` with the page and game scripts
// built next to it.
const font = (name: string) => join(import.meta.dirname, "fonts", `${name}.woff2`);

const main = Layer.unwrap(
  Effect.map(Config.String("RPGTL_OPEN_PAGE").pipe(Config.withDefault("1")), (open) =>
    serve(Frontend.layerPrebuilt(import.meta.dirname), { openPage: open !== "0" }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ImageReaderSetup.ReaderSources, join(import.meta.dirname, "image-reader")),
          Layer.succeed(XpImages.LetteringFontFiles, {
            sans: [font("noto-sans-latin-400-normal"), font("noto-sans-latin-700-normal")],
            serif: [font("noto-serif-latin-400-normal"), font("noto-serif-latin-700-normal")],
          }),
        ),
      ),
    ),
  ),
);

Layer.launch(main).pipe(NodeRuntime.runMain);
