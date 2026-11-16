import {
  type Catalog,
  type Entry,
  GameSettings,
  type GlossaryTerm,
  type Text,
} from "@rpgtl/contracts";
import * as Schema from "effect/Schema";
import { type EntryText, textKey } from "../catalog.ts";
import { isImageText } from "../location.ts";

/** An entry joined with its text, as a test writes it; the text is shared by key. */
export type TestEntry = Pick<EntryText, "id" | "location" | "source"> &
  Partial<Omit<EntryText, "id" | "location" | "source" | "textId">>;

/** The game's settings with `settings` in place of their defaults. */
const testSettings = (settings: Partial<GameSettings> = {}): GameSettings => ({
  ...Schema.decodeSync(GameSettings)({}),
  ...settings,
});

/** What a test catalog is made of; what is left out is empty or has its default. */
export interface TestCatalogParts {
  readonly entries?: ReadonlyArray<TestEntry>;
  readonly glossary?: ReadonlyArray<GlossaryTerm>;
  readonly settings?: Partial<GameSettings>;
  readonly operations?: Catalog["operations"];
  readonly engine?: Catalog["game"]["engine"];
  readonly game?: Catalog["game"];
}

/**
 * A catalog of `entries`, whose texts are made from them: entries of one source, speaker and image
 * flag share a text, which takes the values of the first of them.
 */
export function testCatalog({
  entries = [],
  glossary = [],
  settings,
  operations = [],
  engine = "MV",
  game = { id: "test-game", title: "Test Game", engine },
}: TestCatalogParts = {}): Catalog {
  const texts = new Map<string, Text>();
  const placed = entries.map((joined): Entry => {
    const { id, location, builtinTranslation, isLeftUntranslated, ...fields } = joined;
    const text = { ...fields, isInImage: fields.isInImage ?? isImageText(joined) };
    const key = textKey(text);
    const known = texts.get(key) ?? { ...text, id: texts.size + 1 };
    texts.set(key, known);
    return {
      id,
      textId: known.id,
      location,
      ...(builtinTranslation !== undefined && { builtinTranslation }),
      ...(isLeftUntranslated !== undefined && { isLeftUntranslated }),
    };
  });
  return {
    game,
    entries: placed,
    texts: [...texts.values()],
    glossary,
    settings: testSettings(settings),
    operations,
  };
}

let terms = 0;

/** A glossary term the rules sorted as a word, with the fields given. */
export const testTerm = (
  source: string,
  fields: Partial<Omit<GlossaryTerm, "source">> = {},
): GlossaryTerm => ({ id: (terms += 1), source, rulesKind: "word", ...fields });

let textIds = 0;

/** An entry joined with a text of its own, with the fields given. */
export const testEntry = (
  location: EntryText["location"],
  source: string,
  fields: Partial<Omit<EntryText, "location" | "source">> = {},
): EntryText => ({
  id: JSON.stringify([location, source]),
  textId: (textIds += 1),
  location,
  source,
  isInImage: isImageText({ location }),
  ...fields,
});
