import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { LetteringAnswer } from "@rpgtl/domain";
import * as LanguageModel from "effect/ai/LanguageModel";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as LlamaServer from "../localModels/LlamaServer.ts";
import { fakeLlamaLib, fakeLlamaServer } from "../testUtils/llama.ts";
import { httpClientAnswering } from "../testUtils/ollama.ts";
import * as Ollama from "../localModels/Ollama.ts";
import * as VisionModel from "./VisionModel.ts";

it.live(
  "with expert layers in system RAM the backup reader runs in llama-server, in the answer's format",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const lib = yield* fakeLlamaLib();
      const projector = `${lib.dir}/vision.gguf`;
      yield* fs.writeFile(projector, new Uint8Array(1000));
      yield* lib.flag("chat-answer", JSON.stringify({ answer: "drawing" }));
      const unloaded: Array<string> = [];
      const answer = yield* Effect.gen(function* () {
        const vision = yield* VisionModel.VisionModel;
        const { model } = yield* vision.start({
          endpoint: new URL("http://127.0.0.1:11434"),
          model: "qwen-vl",
          expertLayersInRam: 0,
          log: `${lib.dir}/llama.log`,
        });
        return yield* LanguageModel.generateObject({
          prompt: [
            {
              role: "user",
              content: [
                { type: "file", mediaType: "image/png", data: new Uint8Array([1, 2, 3]) },
                { type: "text", text: "Lettering or drawing?" },
              ],
            },
          ],
          schema: LetteringAnswer,
        }).pipe(Effect.provideContext(model));
      }).pipe(
        Effect.scoped,
        Effect.provide(
          VisionModel.layer.pipe(
            Layer.provide(fakeLlamaServer(lib, { projector, expertCount: 0 }, unloaded)),
            // Fresh, so the fake's own Ollama keeps its fake answers.
            Layer.provide(Layer.fresh(Ollama.layer)),
            Layer.provide(FetchHttpClient.layer),
          ),
        ),
        Effect.provideService(LlamaServer.MemoryLimit, () => ["env"]),
      );
      assert.deepStrictEqual(answer.value, { answer: "drawing" });
      assert.deepStrictEqual(unloaded, ["qwen-vl"]);

      const request = JSON.parse(yield* fs.readFileString(`${lib.dir}/chat-request.json`));
      assert.include(request, { model: "qwen-vl", temperature: 0 });
      assert.deepStrictEqual(request.messages[0].content, [
        { type: "image_url", image_url: { url: "data:image/png;base64,AQID", detail: "auto" } },
        { type: "text", text: "Lettering or drawing?" },
      ]);
      assert.strictEqual(request.response_format.type, "json_schema");
      assert.deepStrictEqual(request.response_format.json_schema.schema.properties.answer.enum, [
        "lettering",
        "drawing",
      ]);
      const { argv } = Option.getOrThrow(yield* lib.record);
      assert.includeMembers([...argv], ["--mmproj", projector]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const lettering = (model: Context.Context<LanguageModel.LanguageModel>) =>
  LanguageModel.generateObject({
    prompt: [
      {
        role: "user",
        content: [
          { type: "file", mediaType: "image/png", data: new Uint8Array([1, 2, 3]) },
          { type: "text", text: "Lettering or drawing?" },
        ],
      },
    ],
    schema: LetteringAnswer,
  }).pipe(Effect.provideContext(model));

/** VisionModel over an Ollama that answers as `answer` does. */
const onOllama = (answer: Parameters<typeof httpClientAnswering>[0]) =>
  VisionModel.layer.pipe(
    Layer.provide(
      Layer.succeed(
        LlamaServer.LlamaServer,
        LlamaServer.LlamaServer.of({
          unavailable: Effect.succeedNone,
          serve: () => Effect.die("not used"),
        }),
      ),
    ),
    Layer.provideMerge(Ollama.layer),
    Layer.provide(httpClientAnswering(answer)),
  );

const startOn = Effect.fn("startOn")(function* (model: string) {
  const vision = yield* VisionModel.VisionModel;
  return yield* vision.start({
    endpoint: new URL("http://127.0.0.1:11434"),
    model,
    log: "/nowhere/llama.log",
  });
});

it.effect(
  "without expert layers in system RAM the backup reader runs on Ollama, unloaded after",
  () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make<ReadonlyArray<{ path: string; body: unknown }>>([]);
      const answer = yield* startOn("qwen-vl").pipe(
        Effect.flatMap(({ model }) => lettering(model)),
        Effect.scoped,
        Effect.provide(
          onOllama((url, body) =>
            Ref.update(sent, (all) => [...all, { path: url.pathname, body }]).pipe(
              Effect.as(
                Option.some(
                  url.pathname === "/api/show"
                    ? Response.json({ modelfile: "", capabilities: ["completion", "vision"] })
                    : Response.json({ message: { content: '{"answer":"drawing"}' } }),
                ),
              ),
            ),
          ),
        ),
      );
      assert.deepStrictEqual(answer.value, { answer: "drawing" });
      const requests = yield* Ref.get(sent);
      assert.deepStrictEqual(
        requests.map((request) => request.path),
        ["/api/show", "/api/chat", "/api/chat", "/api/generate"],
      );
      assert.deepInclude(requests[2]?.body, {
        model: "qwen-vl",
        messages: [{ role: "user", content: "Lettering or drawing?", images: ["AQID"] }],
        think: false,
        options: { temperature: 0, num_ctx: 8192 },
      });
      assert.deepInclude(requests[3]?.body, { model: "qwen-vl", keep_alive: 0 });
    }),
);

it.effect("on Ollama a model that can't read images isn't started", () =>
  Effect.gen(function* () {
    const error = yield* startOn("qwen").pipe(
      Effect.scoped,
      Effect.flip,
      Effect.provide(
        onOllama(() =>
          Effect.succeedSome(Response.json({ modelfile: "", capabilities: ["completion"] })),
        ),
      ),
    );
    assert.deepInclude(error, { _tag: "NoVisionError", model: "qwen" });
  }),
);
