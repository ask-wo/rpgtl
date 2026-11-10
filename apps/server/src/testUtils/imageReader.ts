import { Box, type ImageLine } from "@rpgtl/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as ImageReader from "../imageText/ImageReader.ts";

/** The models the fake reader names. */
export const readerModels = {
  detection: "test-det",
  recognition: "test-rec",
  inpainting: "test-inpaint",
};

/** The Korean recognizer the fake reader names once it has one. */
export const koreanRecognition = "test-korean-rec";

/** Where the fake reader says its output goes. */
const readerLog = "/cache/rpgtl/image-reader/reader.log";

const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];

/** A PNG as far as RPGTL can tell, whose bytes after the signature are its name. */
export const testImage = (name: string) =>
  new Uint8Array([...pngSignature, ...new TextEncoder().encode(name)]);

export const nameOf = (image: Uint8Array) => new TextDecoder().decode(image.subarray(8));

/** The image's file as the game stores it, encrypted with `key`. */
export function encryptedImage(image: Uint8Array, key: string) {
  const header = new Uint8Array(16);
  header.set(new TextEncoder().encode("RPGMV"));
  const payload = image.slice();
  for (let index = 0; index < 16; index++)
    payload[index] =
      (payload[index] ?? 0) ^ Number.parseInt(key.slice(2 * index, 2 * index + 2), 16);
  return new Uint8Array([...header, ...payload]);
}

/** A line as the reader gives it, with its contrast measured. */
export const line = (
  text: string,
  box: Box = [100, 100, 400, 130],
  { score = 0.99, contrast = 255 } = {},
): Omit<ImageLine, "reader"> => ({
  text,
  score,
  contrast,
  box,
  polygon: [
    [box[0], box[1]],
    [box[2], box[1]],
    [box[2], box[3]],
    [box[0], box[3]],
  ],
});

/**
 * A read of the image named `image`, at `scale` times its size, or of `crop` of it, with the
 * recognizer for `language`.
 */
export interface ReadRequest {
  readonly image: string;
  readonly language: string;
  readonly scale: number;
  readonly crop?: Box;
}

/** What the fake reader finds for a request. */
export interface ReaderAnswer {
  readonly width: number;
  readonly height: number;
  readonly lines: ReadonlyArray<Omit<ImageLine, "reader">>;
}

/** The fake image reader's answers and what it was asked. */
export class FakeReader extends Context.Service<
  FakeReader,
  {
    readonly reads: Ref.Ref<(request: ReadRequest) => Effect.Effect<ReaderAnswer>>;
    /** Whether it starts and answers at all. */
    readonly up: Ref.Ref<boolean>;
    /** Whether it has the Korean recognizer. */
    readonly korean: Ref.Ref<boolean>;
    /** Each request, such as `read Notice 1`, `read Notice 2 0,0,10,10` or `stop`. */
    readonly asked: Ref.Ref<ReadonlyArray<string>>;
  }
>()("@rpgtl/server/testUtils/FakeReader") {}

const ContrastRequest = Schema.Struct({
  image: Schema.String,
  areas: Schema.Array(Schema.Unknown),
});
const PrepareRequest = Schema.Struct({
  image: Schema.String,
  lines: Schema.Array(
    Schema.Struct({
      box: Box,
      polygon: Schema.Array(Schema.Tuple([Schema.Finite, Schema.Finite])),
    }),
  ),
  blocks: Schema.Array(Schema.Array(Schema.Int)),
});

const decodeContrast = Schema.decodeEffect(Schema.fromJsonString(ContrastRequest));
const decodePrepare = Schema.decodeEffect(Schema.fromJsonString(PrepareRequest));
const imageOf = (base64: string) => nameOf(Result.getOrThrow(Base64.decode(base64)));

/**
 * The image reader over a fake one: each read answers as `FakeReader.reads` says, contrasts are
 * 200, a flattened image is the image itself (its crop named after the box), and preparing a
 * block erases it into `erased <image>`.
 */
export const fakeReader = Layer.unwrap(
  Effect.gen(function* () {
    const reads = yield* Ref.make<(request: ReadRequest) => Effect.Effect<ReaderAnswer>>(() =>
      Effect.succeed({ width: 1120, height: 630, lines: [] }),
    );
    const up = yield* Ref.make(true);
    const korean = yield* Ref.make(false);
    const asked = yield* Ref.make<ReadonlyArray<string>>([]);
    const ask = (request: string) => Ref.update(asked, (all) => [...all, request]);
    const client = HttpClient.make((request, url) =>
      Effect.gen(function* () {
        if (!(yield* Ref.get(up)))
          return yield* new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, description: "refused" }),
          });
        const body = request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array();
        const text = new TextDecoder().decode(body);
        const crop = url.searchParams.get("crop") ?? undefined;
        const [left = 0, top = 0, right = 0, bottom = 0] = crop?.split(",").map(Number) ?? [];
        const answer = (value: unknown) =>
          HttpClientResponse.fromWeb(request, Response.json(value));
        switch (url.pathname) {
          case "/health":
            return answer({
              ocr: {
                detection: readerModels.detection,
                recognizers: {
                  general: readerModels.recognition,
                  ...((yield* Ref.get(korean)) && { korean: koreanRecognition }),
                },
              },
              inpaint: readerModels.inpainting,
            });
          case "/read": {
            const scale = Number(url.searchParams.get("scale") ?? 1);
            const language = url.searchParams.get("language") ?? "";
            if (language === "korean" && !(yield* Ref.get(korean)))
              return HttpClientResponse.fromWeb(request, new Response("", { status: 400 }));
            yield* ask(["read", nameOf(body), scale, ...(crop ? [crop] : [])].join(" "));
            const found = yield* (yield* Ref.get(reads))({
              image: nameOf(body),
              language,
              scale,
              ...(crop && { crop: [left, top, right, bottom] satisfies Box }),
            });
            return answer(found);
          }
          case "/contrast": {
            const { image, areas } = yield* decodeContrast(text).pipe(Effect.orDie);
            yield* ask(`contrast ${imageOf(image)}`);
            return answer({ contrasts: areas.map(() => 200) });
          }
          case "/flatten":
            yield* ask(["flatten", nameOf(body), ...(crop ? [crop] : [])].join(" "));
            return HttpClientResponse.fromWeb(
              request,
              new Response(crop ? testImage(`${nameOf(body)} ${crop}`) : body),
            );
          case "/prepare": {
            const { image, lines, blocks } = yield* decodePrepare(text).pipe(Effect.orDie);
            yield* ask(`prepare ${imageOf(image)}`);
            return answer({
              erased: Base64.encode(testImage(`erased ${imageOf(image)}`)),
              blocks: blocks.map((block, group) => {
                const boxes = block.map((index) => lines[index]?.box ?? [0, 0, 0, 0]);
                const area = [0, 1, 2, 3].map((side) =>
                  (side < 2 ? Math.min : Math.max)(...boxes.map((box) => box[side] ?? 0)),
                );
                return {
                  polygons: block.map((index) => lines[index]?.polygon ?? []),
                  area,
                  lineHeight: 30,
                  space: area,
                  fill: "#ffffff",
                  outline: null,
                  stroke: 0,
                  weight: 0.12,
                  bold: false,
                  align: "centre",
                  group,
                };
              }),
            });
          }
          default:
            return HttpClientResponse.fromWeb(request, new Response("", { status: 404 }));
        }
      }),
    );
    const process = ImageReader.ReaderProcess.of({
      start: Effect.gen(function* () {
        if (!(yield* Ref.get(up)))
          return yield* new ImageReader.ImageReaderError({
            operation: "start",
            problem: "stopped",
            output: readerLog,
          });
        yield* Effect.addFinalizer(() => ask("stop"));
        return { base: new URL("http://127.0.0.1:5001"), output: readerLog };
      }),
    });
    return ImageReader.clientLayer.pipe(
      Layer.provideMerge(Layer.succeed(FakeReader, FakeReader.of({ reads, up, korean, asked }))),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
      Layer.provide(Layer.succeed(ImageReader.ReaderProcess, process)),
    );
  }),
);
