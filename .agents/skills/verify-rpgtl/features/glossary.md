# Glossary

The glossary holds fixed English names and terms that translators get with each batch and that speaker tags use. The Glossary page lists them by kind; the player corrects a term's original, English, kind and a character's pronoun (each saved shortly after typing stops), adds and removes terms, and clears the translations that don't use a term. **Build glossary** in the run bar fills the glossary from the game's names.

## Sub-features

- `gl-list` the list in sections (Characters, Names, Words), each row with the original, the English and a character's pronoun; the "Filter terms" box.
- `gl-edit` a selected term's Original, English (saved once typing pauses or the field loses focus), Kind and Pronoun (saved at once); where each came from; **Confirm** for a model's pronoun the text argues against; the entries that use the term.
- `gl-save-status` the header reads "Saving…", then "All changes saved", or why a save failed.
- `gl-rename` a changed English renames the entries that are exactly that term.
- `gl-add` **Add term**: a new term, saved once it has an original.
- `gl-remove` the `×` over a term's pronoun tag in the list (`[aria-label="Remove <original> from the glossary"]`) and **Remove glossary…** both ask first; the lines keep their translations.
- `gl-clear` **Clear wrong text** on a term and **Clear all wrong text** for every character, which clear lines that miss the English, and **Clear all text…** on a term, which asks first and clears every line with it: save pending edits, back up, clear, and say how many.
- `gl-build` **Build glossary** in the bar on this page: a run of the glossary pass only; the bar reads `Building the glossary · <done> of <total> names translated`, the page is locked while it goes, and the bar ends with `Glossary built: …`.

## How to get to it (user POV)

- **Glossary** under the open game in the sidebar, shown while the open game's translation is on, with how many names have English as `<done>/<all>` until all do, then the number of terms; or `/games/<id>/glossary`.

## Driving it with drive.ts

Preconditions:

- Fixture game open and its translation switched on. `examples/glossary.ts` is a complete, passing steps file for everything above except `gl-build`, which `examples/build-glossary.ts` covers with the real Ollama model.

- **Fields.** `#term-source`, `#term-translation`; the Kind and Pronoun selects are Base UI comboboxes `#term-kind`, `#term-pronoun`: click one, wait for `[role="option"]`, and click the option by its text through `page.eval`.
- **Saves.** Wait on `$RUN/state/games/<id>/catalog.json` rather than the header's text, which reads "All changes saved" before the first edit too.
- **Terms to clear.** The fixture has no glossary and no translations; import a translation file first (as `examples/translation-card.ts` does) with the term and a line that doesn't use its English.

## Gotchas

- A term without an original isn't saved; a reload drops it.
- Glossary saves write the catalog without a backup; clearing backs up first.
- A one-character term is used for speaker tags and exact matches only, not sent with batches.
