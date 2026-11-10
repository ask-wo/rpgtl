import { type Catalog, Settings } from "@rpgtl/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { page } from "vite-plus/test/browser";
import { expect, test, vi } from "vite-plus/test";
import { catalogFeed, events, render, serveApi } from "../testUtils/fakeApi.tsx";
import { game, idle } from "../testUtils/game.ts";
import { GameContext } from "../games/GameContext.ts";
import { TranslationActions } from "./TranslationActions.tsx";
import { TranslationCard } from "./TranslationCard.tsx";

const entry = (id: string, file: string, translation: string) => ({
  id,
  file,
  path: ["lines", "0"],
  source: "你好",
  translation: translation ? { user: translation } : {},
});

const defaults = Schema.decodeSync(Settings)({});

/**
 * RPGTL's server with one game's catalog and the shared settings; `settingsSaved` lists the
 * settings the page saved.
 */
const fakeServer = (
  saved: Catalog,
  {
    settings = defaults,
    models = [],
    layers = { blockCount: 0, expertCount: 0 },
    llamaServerUnavailable,
    imageText = null,
    previewWaitsFor,
  }: {
    readonly settings?: Settings;
    readonly models?: ReadonlyArray<string>;
    readonly layers?: { readonly blockCount: number; readonly expertCount: number };
    /** Why llama-server can't run; it can without. */
    readonly llamaServerUnavailable?: string;
    readonly imageText?: unknown;
    /** The import preview answers once this resolves; at once without. */
    readonly previewWaitsFor?: Promise<void>;
  } = {},
) => {
  let current = saved;
  let shared = settings;
  const settingsSaved: Array<Settings> = [];
  const imported: Array<unknown> = [];
  const languagesSet: Array<unknown> = [];
  const stream = events();
  const feed = catalogFeed(() => current);
  const requests = serveApi(async (request) => {
    const { pathname } = new URL(request.url);
    switch (pathname) {
      case "/api/activity":
        return stream.response();
      case "/api/catalog/changes":
        return feed.response();
      case "/api/catalog":
        return Response.json(current);
      case "/api/catalog/translate": {
        const { on } = await request.json();
        current = { ...current, translate: on };
        feed.changed();
        return Response.json(current);
      }
      case "/api/catalog/language": {
        const { language } = await request.json();
        languagesSet.push(language);
        const { language: _old, ...rest } = current;
        current = { ...rest, ...(language && { language }) };
        feed.changed();
        return Response.json(current);
      }
      case "/api/restore":
        current = {
          ...current,
          translate: true,
          entries: current.entries.map((one) => ({ ...one, translation: {} })),
        };
        feed.changed();
        return Response.json(current);
      case "/api/import/preview":
        await previewWaitsFor;
        return Response.json({
          translations: { inFile: 3, added: 2, changed: 1, cleared: 0, notInGame: 1 },
          glossary: { inFile: 0, added: 0, changed: 0, removed: 4 },
          images: { inFile: 2, replaced: 1 },
        });
      case "/api/import": {
        const { catalog } = await request.json();
        imported.push(catalog);
        return Response.json(current);
      }
      case "/api/images/export":
        return Response.json(imageText);
      case "/api/settings":
        if (request.method === "POST") {
          shared = await request.json();
          settingsSaved.push(shared);
          return new Response(null, { status: 204 });
        }
        return Response.json(shared);
      case "/api/ollama/models":
        return Response.json(models);
      case "/api/agents/models":
        return Response.json(
          new URL(request.url).searchParams.get("translator") === "claude"
            ? [
                {
                  id: "claude-sonnet-5-5",
                  name: "Sonnet 5.5",
                  efforts: ["low", "medium", "high", "xhigh"],
                  isDefault: false,
                },
                { id: "claude-opus-5-5", name: "Opus 5.5", efforts: ["low"], isDefault: true },
              ]
            : [
                {
                  id: "gpt-9-plan",
                  name: "GPT-9 Plan",
                  efforts: ["low", "medium"],
                  defaultEffort: "low",
                  isDefault: true,
                },
              ],
        );
      case "/api/ollama/model-info":
        return Response.json(layers);
      case "/api/ollama/llama-server":
        return Response.json(
          llamaServerUnavailable === undefined ? {} : { unavailable: llamaServerUnavailable },
        );
    }
    return new Response(null, { status: 404 });
  });
  return { requests, settingsSaved, imported, languagesSet, activity: stream.send };
};

const catalogWith = (entries: Catalog["entries"]): Catalog => ({
  version: 1,
  game: { id: game.id, title: game.title, engine: "MV" },
  entries,
  glossary: [],
  translate: true,
});

const showCard = () =>
  render(
    <GameContext value={game}>
      <TranslationCard />
    </GameContext>,
  );

test("the switch turns translation on and shows what the translation holds", async () => {
  fakeServer({
    version: 1,
    game: { id: game.id, title: game.title, engine: "MV" },
    translate: false,
    entries: [
      entry("a", "Map001.json", ""),
      entry("b", "img/pictures/Title", ""),
      entry("c", "img/pictures/Title", ""),
    ],
    glossary: [],
  });
  showCard();
  await expect.element(page.getByText("Switch on to translate or import.")).toBeVisible();

  await page.getByText("Translate this game").click();
  await expect.element(page.getByText("0 of 1 text entries translated")).toBeVisible();
  await expect.element(page.getByText("0 of 2 entries in 1 image translated")).toBeVisible();
  await expect.element(page.getByText("0 glossary terms")).toBeVisible();
});

test("a translated game keeps its translations when switched off", async () => {
  const server = fakeServer({
    version: 1,
    game: { id: game.id, title: game.title, engine: "MV" },
    translate: true,
    entries: [entry("a", "Map001.json", "Hello"), entry("b", "Map001.json", "Bye")],
    glossary: [{ source: "雨", translation: { user: "Rain" }, kind: { guess: { value: "name" } } }],
  });
  showCard();
  await expect.element(page.getByText("2 of 2 text entries translated")).toBeVisible();
  await expect.element(page.getByText("1 glossary term")).toBeVisible();
  await expect.element(page.getByText("entries in", { exact: false })).not.toBeInTheDocument();

  await page.getByText("Translate this game").click();
  await expect
    .element(page.getByText("Off: the game plays its original text. 2 translations are kept."))
    .toBeVisible();
  expect(server.requests).toContain("POST /api/catalog/translate");
});

test("the translator settings save each choice as it is made", async () => {
  const server = fakeServer(catalogWith([entry("a", "Map001.json", "")]), {
    settings: {
      ...defaults,
      translation: {
        ...defaults.translation,
        ollama: { ...defaults.translation.ollama, model: "gemma:9b" },
      },
    },
    models: ["qwen3.6:35b-a3b-q4_K_M"],
  });
  showCard();
  await expect.element(page.getByText("Text stays on this computer.")).toBeVisible();
  await page.getByRole("combobox", { name: "Model", exact: true }).click();
  await expect
    .element(page.getByRole("option", { name: "gemma:9b (not installed)" }))
    .toBeVisible();
  await page.getByRole("option", { name: "qwen3.6:35b-a3b-q4_K_M" }).click();
  await expect
    .poll(() => server.settingsSaved.at(-1)?.translation.ollama.model)
    .toBe("qwen3.6:35b-a3b-q4_K_M");

  const endpoint = page.getByLabelText("Ollama endpoint");
  await endpoint.fill("");
  await page.getByText("Text stays on this computer.").click();
  await expect.element(endpoint).toHaveValue("http://127.0.0.1:11434");
  expect(server.settingsSaved.map((saved) => saved.ollama.endpoint)).toEqual([
    "http://127.0.0.1:11434",
  ]);

  await page.getByRole("combobox", { name: "Translator" }).click();
  await page.getByRole("option", { name: "Claude (your subscription)" }).click();
  await expect
    .element(page.getByText("Sends the game's text to Anthropic", { exact: false }))
    .toBeVisible();
  await page.getByRole("combobox", { name: "Thinking", exact: true }).click();
  await expect.element(page.getByRole("option", { name: "Medium (recommended)" })).toBeVisible();
  await page.getByRole("option", { name: "Extra high" }).click();
  await expect.poll(() => server.settingsSaved.at(-1)?.translation.claude.effort).toBe("xhigh");
  expect(server.settingsSaved.at(-1)?.translation.translator).toBe("claude");
  await expect
    .element(page.getByRole("combobox", { name: "Glossary model" }))
    .toHaveTextContent("Opus 5.5 (recommended)");
  await page.getByRole("combobox", { name: "Glossary thinking" }).click();
  await expect.element(page.getByRole("option", { name: "Low (recommended)" })).toBeVisible();
  await page.getByRole("option", { name: "Low (recommended)" }).click();

  await page.getByRole("combobox", { name: "Translator" }).click();
  await page.getByRole("option", { name: "Codex (your ChatGPT plan)" }).click();
  await expect
    .element(page.getByRole("combobox", { name: "Model", exact: true }))
    .toHaveTextContent("Codex's default (GPT-9 Plan)");
  await page.getByRole("combobox", { name: "Thinking", exact: true }).click();
  await expect.element(page.getByRole("option", { name: "Low (default)" })).toBeVisible();
});

test("the game's language shows the guess from its text until another is chosen, and can go back to it", async () => {
  const korean = { ...entry("a", "Map001.json", ""), source: "하루는 시장에 갔다." };
  const server = fakeServer(catalogWith([korean]));
  showCard();
  const language = page.getByRole("combobox", { name: "Game language" });
  await expect.element(language).toHaveTextContent("Korean (Automatic)");
  await language.click();
  await page.getByRole("option", { name: "Japanese", exact: true }).click();
  await expect.element(language).toHaveTextContent("Japanese");
  await language.click();
  await page.getByRole("option", { name: "Korean (Automatic)" }).click();
  await expect.element(language).toHaveTextContent("Korean (Automatic)");
  expect(server.languagesSet).toEqual(["japanese", null]);
});

test("llama-server offers how many layers' experts stay in system RAM at least", async () => {
  const server = fakeServer(catalogWith([entry("a", "Map001.json", "")]), {
    models: ["qwen3.6:35b-a3b-q4_K_M"],
    layers: { blockCount: 3, expertCount: 8 },
  });
  showCard();
  const layers = page.getByRole("combobox", { name: "Expert layers in system RAM" });
  await expect.element(page.getByRole("combobox", { name: "Runs in" })).toBeVisible();
  await expect.element(layers).not.toBeInTheDocument();
  await page.getByRole("combobox", { name: "Runs in" }).click();
  await page.getByRole("option", { name: /^llama-server/ }).click();
  await expect.poll(() => server.settingsSaved.at(-1)?.ollama.runner).toBe("llama-server");
  // The trigger's text is the choice alone, without its icon's "▼".
  await expect.poll(() => layers.element().textContent).toBe("Automatic (as few as fit)");
  await layers.click();
  await page.getByRole("option", { name: "At least 2", exact: true }).click();
  await expect.poll(() => server.settingsSaved.at(-1)?.ollama.minExpertLayersInRam).toBe(2);
});

test("where RPGTL can't run llama-server, the page says why and keeps it from being chosen", async () => {
  fakeServer(catalogWith([entry("a", "Map001.json", "")]), {
    models: ["qwen3.6:35b-a3b-q4_K_M"],
    llamaServerUnavailable: "RPGTL starts Ollama's bundled llama-server on Linux only.",
  });
  showCard();
  await expect
    .element(page.getByText("RPGTL starts Ollama's bundled llama-server on Linux only."))
    .toBeVisible();
  await page.getByRole("combobox", { name: "Runs in" }).click();
  await expect
    .element(page.getByRole("option", { name: "llama-server (not available here)" }))
    .toHaveAttribute("aria-disabled", "true");
  await expect.element(page.getByRole("combobox", { name: "Backup reader" })).toBeVisible();
});

test("the backup reader recommends Qwen3.6", async () => {
  fakeServer(catalogWith([entry("a", "Map001.json", "")]), {
    models: ["gemma:9b", "qwen3.6:35b-a3b-q4_K_M"],
  });
  showCard();
  await page.getByRole("combobox", { name: "Backup reader" }).click();
  await expect
    .element(page.getByRole("option", { name: "qwen3.6:35b-a3b-q4_K_M (recommended)" }))
    .toBeVisible();
  await expect.element(page.getByRole("option", { name: "gemma:9b", exact: true })).toBeVisible();
});

test("the local models' settings show while a local model translates or reads images", async () => {
  const claude = { ...defaults.translation, translator: "claude" as const };
  fakeServer(catalogWith([entry("a", "Map001.json", "")]), {
    settings: { ...defaults, translation: claude, images: { ...defaults.images, model: "qwen" } },
    models: ["qwen"],
  });
  showCard();
  await expect.element(page.getByRole("combobox", { name: "Runs in" })).toBeVisible();
  await page.getByRole("combobox", { name: "Backup reader" }).click();
  await page.getByRole("option", { name: "None" }).click();
  await expect.element(page.getByRole("combobox", { name: "Runs in" })).not.toBeInTheDocument();
  await expect.element(page.getByLabelText("Ollama endpoint")).not.toBeInTheDocument();
});

test("Clear all asks first, and keeps the translations when told to", async () => {
  const server = fakeServer(
    catalogWith([entry("a", "Map001.json", "Hello"), entry("b", "Map001.json", "Bye")]),
  );
  showCard();
  await expect.element(page.getByText("2 of 2 text entries translated")).toBeVisible();
  await page.getByRole("button", { name: "Clear all…" }).click();
  await page.getByRole("button", { name: "Keep them" }).click();
  expect(server.requests).not.toContain("POST /api/restore");

  await page.getByRole("button", { name: "Clear all…" }).click();
  await page.getByRole("button", { name: "Clear all translations" }).click();
  await expect.element(page.getByText("0 of 2 text entries translated")).toBeVisible();
  await expect.element(page.getByText("Cleared all translations", { exact: false })).toBeVisible();
});

test("Import shows what the chosen file changes, sends it once confirmed, and says when it isn't JSON", async () => {
  const server = fakeServer(catalogWith([entry("a", "Map001.json", "")]));
  showCard();
  const picker = page.getByLabelText("Translation file to import");
  await picker.upload(new File(["{ not json"], "broken.json", { type: "application/json" }));
  await expect
    .element(page.getByText("broken.json isn't a translation file: it isn't JSON."))
    .toBeVisible();
  expect(server.requests).not.toContain("POST /api/import");

  const file = { version: 1, game: { id: game.id }, entries: [], glossary: [] };
  await picker.upload(new File([JSON.stringify(file)], "rain.json", { type: "application/json" }));
  await expect.element(page.getByText("Import rain.json?")).toBeVisible();
  await expect.element(page.getByText("3 translations: 2 new, 1 changed.")).toBeVisible();
  await expect
    .element(page.getByText("1 is for a line this game doesn't have and will be skipped."))
    .toBeVisible();
  await expect
    .element(page.getByText("0 glossary terms, in place of the saved glossary: 4 removed."))
    .toBeVisible();
  await expect
    .element(page.getByText("2 images with English, 1 of them in place of images already read."))
    .toBeVisible();
  await page.getByRole("button", { name: "Don't import" }).click();
  expect(server.requests).not.toContain("POST /api/import");

  await picker.upload(new File([JSON.stringify(file)], "rain.json", { type: "application/json" }));
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect
    .element(page.getByText("Imported, after backing up", { exact: false }))
    .toBeVisible();
  expect(server.imported).toEqual([file]);
});

/** Another game's id, which the button below switches the actions to, as opening it does. */
const harbor = "a1b2c3d4e5f60718293a";
function Switching() {
  const [gameId, setGameId] = useState(game.id);
  return (
    <>
      <button onClick={() => setGameId(harbor)}>Open Harbor</button>
      <TranslationActions gameId={gameId} locked={false} />
    </>
  );
}

test("a preview that answers after another game opened asks nothing there", async () => {
  const { promise: answered, resolve: answer } = Promise.withResolvers<void>();
  const server = fakeServer(catalogWith([entry("a", "Map001.json", "")]), {
    previewWaitsFor: answered,
  });
  render(<Switching />);
  const file = { version: 1, game: { id: game.id }, entries: [], glossary: [] };
  await page
    .getByLabelText("Translation file to import")
    .upload(new File([JSON.stringify(file)], "rain.json", { type: "application/json" }));
  await vi.waitFor(() => expect(server.requests).toContain("POST /api/import/preview"));
  await page.getByRole("button", { name: "Open Harbor" }).click();
  answer();
  await expect.element(page.getByRole("button", { name: "Import…" })).toBeEnabled();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await expect.element(page.getByText("Import rain.json?")).not.toBeInTheDocument();
});

test("the import and clear questions close once a run takes the game", async () => {
  const server = fakeServer(catalogWith([entry("a", "Map001.json", "Hello")]));
  showCard();
  server.activity(idle);
  await page.getByRole("button", { name: "Clear all…" }).click();
  await expect.element(page.getByText("Clear all translations?")).toBeVisible();
  server.activity({ ...idle, importing: { done: 0, total: 0 } });
  await expect.element(page.getByText("Clear all translations?")).not.toBeInTheDocument();
  server.activity(idle);
  await expect.element(page.getByRole("button", { name: "Clear all…" })).toBeEnabled();
  await expect.element(page.getByText("Clear all translations?")).not.toBeInTheDocument();
});

test("an import going counts its images on the Import button and holds the other actions, but not the shared settings", async () => {
  const server = fakeServer(catalogWith([entry("a", "Map001.json", "")]));
  showCard();
  server.activity({ ...idle, importing: { done: 3, total: 9 } });
  const button = page.getByRole("button", { name: /Importing images: 3 of 9/ });
  await expect.element(button).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Clear all…" })).toBeDisabled();
  await expect.element(page.getByText("A run is going", { exact: false })).not.toBeInTheDocument();
  server.activity(idle);
  await expect.element(page.getByRole("button", { name: "Import…" })).toBeEnabled();
});

test("Export writes the images' erased backgrounds as base64 patches, as the server sends them, and how many guesses or images each run made", async () => {
  const read = "2026-11-02T00:00:00.000Z";
  const reader = {
    detection: "det",
    recognition: "rec",
    inpainting: "inpaint",
    includeFaint: false,
  };
  const sign = {
    sha256: "s",
    width: 1,
    height: 1,
    lines: [],
    run: read,
    erased: [{ x: 0, y: 0, png: "iVBORw0KGgo=" }],
  };
  const imageText = { images: { "img/pictures/Sign": sign }, runs: { [read]: reader } };
  const run = "2026-11-01T00:00:00.000Z";
  const runs = {
    [run]: { translator: "codex", model: "gpt-6.1-terra", glossaryModel: "gpt-6.1-sol" },
  } as const;
  fakeServer(
    {
      ...catalogWith([
        { ...entry("a", "Map001.json", ""), translation: { guess: { value: "Hello", run } } },
        entry("b", "Map001.json", "Bye"),
      ]),
      runs,
    },
    { imageText },
  );
  const blobs: Array<Blob | MediaSource> = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    blobs.push(blob);
    return "blob:export";
  });
  showCard();
  await page.getByRole("button", { name: "Export" }).click();
  await expect.element(page.getByText("Exported the saved translations.")).toBeVisible();
  const [blob] = blobs;
  if (!(blob instanceof Blob)) throw new Error("Export downloaded nothing");
  const file = JSON.parse(await blob.text());
  expect(file.images).toEqual(imageText.images);
  expect(file.imageRuns).toEqual({ [read]: { ...reader, images: 1 } });
  expect(file.translationRuns).toEqual({ [run]: { ...runs[run], guesses: 1 } });
  expect(file.runs).toBeUndefined();
  expect(file.imageText).toBeUndefined();
  expect(file.entries[0].translation).toEqual({ guess: { value: "Hello", run } });
});
