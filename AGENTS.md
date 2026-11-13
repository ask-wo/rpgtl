# RPGTL

RPGTL lets players play Chinese RPG Maker MV and MZ games in English. It translates a game's text, including the text in its images, with a translator the player picks, and adds cheats, fast-forward and a map view while they play. It is a local, single-user app: a server on the player's computer, its page, its command-line tools and the scripts it puts into the game.

## What RPGTL never gives up

- **The game's files stay as they are.** Everything RPGTL makes (catalogs, translations, erased images, logs) stays in its state folder, and RPGTL applies it while the game runs. The one exception is unpacking an XP game's archive, which RPGTL does only when the player asks.
- **Translation quality comes first.** Text that reads well and keeps names, pronouns and terms consistent is worth more than a new feature.
- **The player decides where their game's text goes.** With a local model it stays on their computer. With Claude or Codex it goes to Anthropic or OpenAI, through a plan the player already has. RPGTL has no server or account of its own.
- **A game plays the same in the browser and in NW.js, on MV and on MZ.** See Hit every surface.

## General guidelines

- Aim for ambitious features built from simple parts, and software that feels obvious to the player.
- Don't keep complexity only because it is already there, and don't add machinery because it looks well designed. Find the real constraint first, then the smallest model that makes the correct behaviour unsurprising.
- Measure twice, cut once, and YAGNI: build only what is needed now. Do what was asked in the smallest way that really works, and keep the scope from growing.
- This file holds good defaults, not hard rules: what you're asked to do overrides it. When a rule here fights the task, say so plainly and get agreement before you break it. Aside from that, this codebase is yours: what it's for and how it's built are your call, and you'll keep building on it.

## How it works

The words in bold are defined in `docs/glossary.md`.

**Inspecting** a game folder reads its data and plugin files into the game's **catalog**, one **entry** per message, name, setting or other piece of text, kept in the **state folder** and never in the game. A **translation run** sends the untranslated entries to a **translator** (Ollama, llama-server, Claude or Codex) in **batches**: the **glossary pass** first fixes the English of names in the **translation glossary**, then the **text pass** translates the rest with it, and every answer goes through the **checks**. **Image reading** finds the text in a game's images, whose English the **lettering** draws onto an **erased background**. The game plays either in the browser, where the server applies the catalog to the files it serves, or in RPGTL's NW.js, where the **NW.js hook** reads the catalog from disk. In both, the **game scripts** fit the English into the game's windows and add the F8 panel and map view.

## Three ways to do harm

1. **Writing into a real state folder.** One is wherever `RPGTL_DIR` points outside the repo (the git-ignored `.env` may set it; `pnpm start` and `pnpm run dev` read that file). It holds real catalogs, backups and run logs, and the running RPGTL may be using it. Read it, or copy it into a temporary folder for a test. Never start RPGTL or a script against it and never write into it: a new run truncates its logs.
2. **Playing a real game.** Don't play or drive a real game in a browser (Claude in Chrome, DevTools, Playwright or anything else), not even one kept for testing. Checks in a real game aren't yours to make: list what to look at and where, and leave them open in your report. Opening the RPGTL page in a browser is fine, and so is driving a small artificial game made for the test, such as one written by `packages/game/src/testUtils/fixture.ts` or `mvGame.ts`.
3. **Putting a real game into the repo.** The repo is public, and a game's text belongs to its authors. Tests, fixtures, comments, docs and prompts use made-up names, lines, items, places, file names and game ids, never a real game's title or its English from a translation. Names of public plugins and RPG Maker's own defaults are fine. When a real game shows a bug, rebuild its shape with invented text, and before committing the example, check that it doesn't occur in that game.

## Hit every surface

The easiest mistake here is a change that works on the path you tried and is missing on the others. Before calling a change done, go through this list and say which entries applied:

- **Where it's reached.** The page, the command-line tools (`pnpm run audit`, `compare`, `llama-server`, `codex`) and the scripts inside the game. A capability that is a service method reaches them all; one written into a handler doesn't.
- **How a game runs.** In the browser, which RPGTL serves translated data to, and in NW.js, which reads the catalog from disk (see **NW.js** in `docs/architecture.md`).
- **Engines.** MV and MZ differ in file names, script names and window code.
- **Translators.** Ollama, llama-server, Claude and Codex each need a decision, even if it is "not supported here".
- **Routes.** A route that moves or changes its payload is also called by the verify-rpgtl examples and feature map (`.agents/skills/verify-rpgtl/`); run the ones that use it.
- **Ways back.** A way in needs a way out and a way to see it: forgetting a game needs inspecting it again, clearing translations needs the backup.
- **Contracts.** A schema in `packages/contracts` is read by every side; change it and check each one. A schema for a state file or the settings must also read the files players already have. A change that the files in `apps/server/src/state/formats/` no longer decode with needs an upgrade step and a new format (`docs/testing.md`, **State files**). Also run `pnpm run decode-state <copy of a real state folder>`, which decodes each file with the schemas the server uses and writes nothing.

## Where code lives

- `apps/server`: the server and the command-line tools, in Effect. Its areas are folders in `src/`, listed in `docs/architecture.md`.
- `apps/web`: the page, a React app.
- `apps/image-reader`: the image reader, a Python service.
- `packages/contracts`: the schemas and the API, shared by every side.
- `packages/domain`: pure logic (extraction, applying translations, checks, layout, pronouns), used by the server and the game scripts.
- `packages/game`: the scripts that run inside the game (runtime, map view, NW.js hook), in plain TypeScript, which the server builds and serves. The page draws image text with its `lettering.ts` too.
- `e2e/`: Playwright tests of the whole app.
- `lint/plugin.ts`: lint rules for the Effect code, tested by `lint/lint.test.ts`. Effect's own type-aware rules (`effecttsgo/…`, such as an Effect that is never yielded) come from `@effect/tsgo`, which runs Oxlint with them as `effect-tsgo --tsrs-lint vp lint` (what `pnpm run lint` and `lint:list` do; a plain `vp lint` rejects the config). `vite.config.ts` picks which ones run. Each rule is described in `docs/rules/` of the [tsgo repo](https://github.com/Effect-TS/tsgo).
- `.agents/skills/verify-rpgtl/`: runs RPGTL on a fixture game and drives its page.
- `reference-repos.toml`: key dependencies whose source is worth reading at the pinned version before relying on memory or web docs.

## Taste

- Before writing Effect code, run `pnpm run -s effect-docs`: it prints an index of Effect's `LLMS.md` sections and examples. Read the ones for the APIs you use, and prefer their patterns over invented ones.
- A server feature is a service method. An HTTP handler or a command-line tool decodes its input, calls one method and translates the errors.
- Pure logic goes in `packages/domain`, where the game scripts can use it too. The game scripts patch the engine synchronously and do no heavy work while the game starts.
- Let types be inferred where they can be. No `any`, non-null `!` or unchecked `as`; lint enforces it.
- No comment by default. Write one only for what the code can't show and a reader would get wrong without it: a reason, a trap, a constraint from outside. If a workaround needs a paragraph to justify it, fix the code instead.
- Leave text a player reads (the page, messages, the README) to the maintainers. Write only short, common phrases such as button labels yourself.

## Docs

Read a doc before the work it covers:

- `README.md`: for players only: installing, using, where their text goes, and compatibility limits.
- `docs/development.md`: commands, command-line tools, environment variables, run logs, and how the translators and image reader run.
- `docs/architecture.md`: how the server, page and game scripts are built, the conventions the code follows, and the decisions behind them with their reasons. Read the parts for the area you change. If your change contradicts a decision there, say so instead of silently overriding it.
- `docs/glossary.md`: the words the code and these docs are built from.
- `docs/testing.md`: what the tests cover, the slower tests (page components, image reader, real engine, end to end), the hooks, state files, game errors and model runs.
- `docs/checking-translations.md`: the known kinds of translation problems and which check, log or tool catches each. Read it before work on translation quality.
- `CODING_STANDARDS.md`: rules reviewers check that no automated check covers, including what makes a good test.

Where a fact goes:

- A word the code is built from goes in the glossary, and a decision with its reason, or a constraint across several parts, in `docs/architecture.md`.
- A reason that only one place in the code needs goes in a short comment there.
- What the code, its types or its tests already show goes nowhere. Don't list features, fields or files, and don't retell what a pull request did.
- Docs describe how things are now. When a decision changes, rewrite or remove its text instead of adding the new account after it.

## Testing

- Run `pnpm run checks` once a change is finished, before committing it. It formats, lints, typechecks and runs `pnpm test`, and skips all of it when the same files already passed.
- While iterating, run only the test file or test you're working on (`pnpm test packages/game/src/runtime/textWrapping.test.ts -t "<name>"`), and `pnpm run -s lint:list <paths>` on the files you wrote. It prints lint findings one per line, then Knip's unused exports and files in the whole workspace, in seconds where `pnpm run checks` takes minutes.
- The formatter and linter are oxfmt and oxlint through Vite+, never Prettier. `pnpm exec vp fmt <paths>` formats files.
- Committing formats and lints the staged files and runs Knip. The pre-push hook runs the checks on each commit pushed, without formatting. Rebasing runs no hook, so a commit that a rebase rewrote without formatting fails the push until it is amended with the formatted files. `docs/testing.md` says more about the hooks.
- `pnpm run e2e` runs the Playwright tests in `e2e/`, about a minute: each worker starts RPGTL on a temporary state folder, and each test opens a fixture game in it. CI runs them after the checks; `pnpm run checks` and the pre-push hook don't.
- A test that plays MV's real engine presses keys with `key` from `e2e/realMv.ts` and waits for what the game does, never for a fixed time. `docs/testing.md` says why.
- A throwaway script that imports workspace packages goes in that package's `scratch/` folder (git-ignored), since a folder outside the packages can't resolve them.
- `RPGTL_DIR` (default `.rpgtl/` in the repo) holds the state of inspected games and `logs/`.

## Tasks

- Labels:
  - One `area/…`, named like the commit scope of the pull request that would finish it where one fits: `rewrite` (the Effect server, page, CLIs, contracts), `translation` (runs and quality: prompts, context, names, pronouns, models, checks, speed), `runtime` (text and layout inside the game), `image-text`, `nwjs` (launching games in NW.js), `game-controls` (features that work without translations too: map view, F8 panel, inventory, switches), `testing` (fixtures, verify-rpgtl, end-to-end tests), `publishing`.
  - `bug` when something RPGTL does is broken, `performance` when it's too slow or uses too much memory.
  - `work/high|mid|low`, your estimate from the code it touches. Priority isn't yours to set; ask when it isn't clear.
  - `idea` while its `Revisit when:` or `Decide first:` line is unmet; remove the label once it is met.
  - `needs-human` for a check in a real game or a decision that isn't yours to make.
- A task dropped without doing it is closed with the reason in a comment.
- Bigger work gets a tracking task with a checklist of its steps, in the order to do them. A step is a checklist item with its details as sub-bullets until someone starts it or it needs its own discussion; then it becomes its own task under the tracking task, linked from its item. Tick a step's box when it is done or dropped, with the result in a comment.
- Every few weeks, or when asked for a triage, go through the open tasks against the code: close what no longer applies, fix outdated paths and claims, and remove `idea` where its condition is met.

## Changes

The repo lives on GitHub (`origin`), whose CI runs `.github/workflows`. Changes go through pull requests there. Open one only when asked: a public pull request reaches everyone who watches the repo. Merge one only once you're told to. Merge by squash (the repo's default), so each pull request lands on `main` as one commit. Its title becomes that commit's message and a line of the release notes, so write it as a Conventional Commit.

Write pull request titles, descriptions and comments for anyone who reads the repo later, not to whoever asked for the change: no "Left for you:" or "as you asked", and checks only a person can do go under a plain heading such as "Not checked". Link public things freely (`Closes #12` for an issue the change fixes, docs, upstream issues, other pull requests), but keep out what only some readers can open: keys or links of privately kept tasks, git-ignored notes, private repos and the conversation that led to the change.
