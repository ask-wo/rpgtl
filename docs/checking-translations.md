# Checking translations

Every tool that finds problems in a game's translations goes through `pnpm run audit <game id>`, and the page shows the same checks as flags. This file lists the known kinds of problems and what catches each one, so a new problem gets a check in the right place.

## Where problems are caught

1. **While a run checks an answer** (`checkAnswer` in `packages/domain/src/answers.ts`). A rejected answer is retried and, if it keeps failing, the entry stays untranslated. Its reason goes into the run log, into the entry's `suggestion` and into the page's failed list. Some slips are fixed silently instead: a speaker name before the line, quotes the source doesn't have, a number left on a last line, em dashes. An accepted answer can get an entry `flag`: line breaks unlike the source, or too long for its image.
2. **On a translation that is already there** (`translationChecks` in `packages/domain/src/checks.ts`). The audit, the page's **Flagged to check** filter and `pnpm run compare` all use these checks, on any translation, whoever wrote it.
3. **In the run log** (`RunLogs` in `apps/server/src/translation/RunLogs.ts`, one file per run in `RPGTL_DIR/games/<game id>/logs/`, its lines described in `packages/contracts/src/runLog.ts`). `pnpm run audit` reads it to show the run's setup, warnings, rejections, the entries changed since the run, and to compare one run with the run before it.

## Known problems

| Problem | Caught by |
| --- | --- |
| Placeholders (control codes) missing, extra or repeated | rejected: `placeholder missing`, `placeholder extra`, `placeholder repeated` |
| Chinese, Japanese or Korean sent back unchanged, or left in the answer | rejected: `unchanged`, `source text left`; in existing text: check `source text left` (credits names a line keeps, a single character the source quotes and the English quotes too, as in 「ァ」と「ア」, and the circle mark 〇 are allowed). |
| The answer holds the answers to other entries | rejected: `other entries included`; in existing text, often check `length unlike the source` |
| The answers moved up one entry, after the model merged two lines | rejected: `answers out of order` |
| Control codes changed in another way | rejected: `validation failed` |
| The model repeats a word until its answer is cut off | rejected: `answer too long` |
| The prompt didn't fit the context | rejected: `context full`, plus a run warning |
| An answer that belongs to another line, or lost most of its own | check `length unlike the source` |
| The model refused | rejected: `refused` when it answered a whole batch in prose instead of JSON, or its safeguards flagged the request (the request's `error` in the log); in accepted answers: check `refusal` (only phrases about the request, since dialogue apologizes too) |
| The speaker's name repeated after the speaker tag | fixed while checking; in existing text: check `speaker name repeated` |
| A speaker's name alone on a message's first line read as part of the sentence (ミナ⏎と、とにかく逃げて → "Mina and… anyway, run") | prevented: a first line that is only a glossary term or the Show Text's speaker is kept on its own line, put into English from the glossary and sent as the speaker; a glossary character's name there also makes the message that character's own line when RPGTL looks for their pronoun; a name the glossary lacks is still joined to the text |
| A number added on a last line | fixed while checking; in existing text: check `number added on a last line` |
| A glossary word capitalised mid-sentence ("the Teacher") | per term in the audit's first list, where a name sorted as a word shows up too |
| A glossary character or name left out or swapped for another | check `glossary name missing` |
| He for 她, or she for 他 | check `pronoun unlike the source` (only where the source has one of the two) |
| The same text translated differently | audit: `Sources with different translations` |
| Text no entry covers | `pnpm run audit --coverage` |
| Translated text that scripts or plugins also use as a value | `pnpm run audit --logic` |

## Not caught by a script

Wrong meaning, a pronoun for the wrong person when several people are in the line, a speaker mistaken for someone they mention, and tone. The person checking often reads no Chinese, so these can't be left to someone reading the source either. `pnpm run compare` compares setups on a sample. The audit's list of the run's guesses the player replaced shows what the player corrected, which is the best record of these mistakes in a real game.

## Adding a check

A check for an accepted translation goes into `translationChecks` with a name in `CheckName` (`packages/contracts/src/checks.ts`); the audit, the page and the comparison then all use it. Before adding one, run it over the inspected games' catalogs (copy the state folder first) and read a sample of what it flags: a check that mostly flags good translations hides the real problems in the filter.
