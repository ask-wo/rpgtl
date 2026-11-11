# Development

Notes for working on RPGTL that the README, written for players, leaves out.

```sh
pnpm test         # tests (Vitest through Vite+)
pnpm run check    # oxlint, tsrs, oxfmt and knip, each run even when one fails
pnpm run format   # apply oxfmt
pnpm run checks   # all of it, skipped when the same files already passed
```

`pnpm start` and `pnpm run dev` read environment variables from `.env` in the repo root when it exists (git-ignored), such as `RPGTL_DIR` or the Claude proxy variables below; a variable already set in the environment wins over the file. The command-line tools (`pnpm run audit`, `compare`, `llama-server`, `codex`) don't read it.

The server builds the page and each game script with Vite the first time it is asked for. `pnpm run dev` serves the page through Vite's dev server, which updates it as you edit, and builds the scripts again on every request, so edits there show after a reload or the next NW.js start; changes in `apps/server/src/` need a restart. The page's component tests run in headless Chromium, which Playwright keeps in `~/.cache/ms-playwright` (`pnpm exec playwright install chromium-headless-shell` fetches it).

Each translation run writes a log, one JSON object per line, to `RPGTL_DIR/games/<game id>/logs/translation-<start time>.log`: the translator, models, settings and git commit, every request with its answer and rejected entries, the run's warnings, and how it ended. Its start time is the `run` of each entry and glossary term it translated, so the log that made a translation is easy to find. Runs on llama-server also keep its output, as `<game id>-llama-server-<start time>.log`. Read a log to see the exact context, glossary terms and speaker each batch got.

The server binds to `127.0.0.1`, checks the `Host` header, and requires a per-start token for its API. Game file paths can't leave the game folder, including through symlinks. Games run their own scripts in the browser, so only open games you trust.

## Release archives

`pnpm run build-archive --target linux-x64` or `--target win-x64` (which needs `zip` and `unzip`) builds a download into `dist/`. With arguments, an archive's launcher runs the command-line tools: `rpgtl audit`, `rpgtl compare` and the others below that read `pnpm run <tool>`.

## Translation files

**Export** writes the catalog as a translation file, and **Import…** reads one back. Each entry and glossary term keeps its **guess** and **user value** (see [glossary.md](glossary.md)), and the file lists the translation and image reading runs whose guesses are still in use.

Import matches a file entry to the game's entry of the same id, which comes from the entry's file, place and source text. An entry whose id the game doesn't have gives its English to the game's lines of the same source text that the file doesn't name, unless the file gives that text different English; the rest are skipped and counted in the import preview. Reading a game's folder again, and replacing a game with another version of it, carry English over the same way. Entries the file leaves out keep their translation, and the file's glossary replaces the saved one.

## Command-line tools

**Checking a run.** `pnpm run audit <game id>` reads the game's catalog and its newest run log and prints what to look at after a run: the run itself (translator, settings, how it ended, warnings), the entries and terms the player changed since, with the run's answer next to them, and what the checks in `packages/domain/src/checks.ts` flag. [checking-translations.md](checking-translations.md) lists the kinds of problems and what catches each. The checks are hints: an English name may rightly become "you" or "she".

- `--compare` puts the run before's counts next to this run's, to see whether a change helped.
- `--previous` audits the run before, `--log <file>` another run's log, and `--json` prints all of it as JSON.
- `--coverage` lists Chinese, Japanese or Korean text in the game's data and plugin settings that no entry covers. Text the game may show comes first, with examples; after it come only the counts of fields that hold file names or names only the editor shows (pictures, sounds, faces, event and troop names, note text outside tags when the note has no block tag such as `<Help Description>`).
- `--logic` lists translated text that scripts, conditions, notes or plugins also use as a value, where translating it can change what the game does.

**Comparing translators.** `pnpm run compare --game <id> --model <setup>` runs each `--model` setup on a sample of an inspected game as a translation run would, one after another, and writes a side-by-side report to `RPGTL_DIR/games/<id>/reports/compare-<time>.html`, with each run's requests and answers in the `.json` next to it. The report shows for each setup what it gave up on, its retries, what the checks flag, its speed, the most VRAM it took and Claude's cost at API prices.

- A setup is a model's name with options, each after an `@`. A name starting with `claude-` runs on your Claude subscription and `gpt-` with a number (such as `gpt-6-luna`) on your ChatGPT plan, both sending the sample off this computer; any other name is an Ollama model on `--ollama` (`http://127.0.0.1:11434` unless given).
- An Ollama model runs in llama-server as the page's **llama-server** runner does, without its prompt cache, so an answer depends only on its own request. `@experts=<n>` keeps at least `n` expert layers in RAM, and `@ollama` runs it in Ollama itself, which is several times slower for a model larger than the GPU.
- `@qwen` picks **Qwen's settings** for **Sampling**, `@think` lets an Ollama model think (with `@ollama`), `@effort=<level>` sets Claude's or Codex's **Thinking**, `@batch=<n>` sets the entries per request, and `@as=<label>` names the setup in the report.
- The first comparison of a game saves its sample as `RPGTL_DIR/games/<id>/samples.json`, so later ones translate the same text. Edit its groups to add lines a translator got wrong before; English in its `fixed` map, by entry id, is kept instead of translated, such as the earlier lines of a scene.

**Manual llama-server.** `pnpm run llama-server --model <ollama model> --experts <n> [--ctx <n>]` checks the model and memory estimate, unloads it from Ollama, then starts Ollama's bundled llama-server with 4 slots of 4096 tokens unless `--ctx` says otherwise, and prints its local endpoint. Ctrl+C or SIGTERM stops it. Its log is `RPGTL_DIR/logs/manual-llama-server.log`.

## Translators

**Local models.** Runs with `expertLayersInRam` use Ollama's bundled `llama-server`, on Linux only; `RPGTL_OLLAMA_LIB` names its folder if Ollama isn't installed in `/usr/lib/ollama` or `/usr/local/lib/ollama`. A local model translates with the **Sampling** chosen on the page and answers other questions at temperature 0. An answer asked again after it failed its checks would come back the same at temperature 0, so the retry uses Qwen's settings for a Qwen3.6 model, and otherwise the model's own defaults. **Thinking** works in Ollama only: llama-server enforces the answer's JSON shape from the first token, so a model there can't think first.

**Claude** runs the player's own [Claude Code](https://code.claude.com/docs/en/setup) install (`claude` on `PATH`; on Windows, an npm install's `claude.cmd` works too) on its login. A run sends the game's text to Anthropic and counts against the subscription's limits.

- To go through a proxy that holds the subscription logins, set `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` before starting RPGTL. RPGTL drops every other `ANTHROPIC_*` and `CLAUDE_*` variable.
- Claude gets RPGTL's prompt only, with no tools, settings, CLAUDE.md files or MCP servers. Each request is a Claude Code session of its own in `~/.local/state/rpgtl/claude-sessions`.
- Dialogue batches skip the prompt cache: the CLI writes each whole prompt to it at 1.25 times the input price, and these requests never repeat. The glossary pass keeps it, cached for 5 minutes, since running it again soon sends the same requests.
- Each request costs a CLI start and about 900 tokens of the CLI's own text, so requests are large: a scene goes out whole up to 150 entries, and short event lists are packed together.
- Claude always decides itself whether to think: Opus 5.5 can't turn thinking off, and Sonnet 5.5 thinks even when asked not to. In the meaning comparison, low effort left 4 meaning errors in 184 lines against 5 at medium, within chance.

**Codex** runs `codex exec` from the player's own [Codex CLI](https://developers.openai.com/codex/cli) install (`codex` on `PATH`, or npm's `codex.cmd` on Windows) and counts against the ChatGPT plan's Codex limits.

- It uses a Codex home of RPGTL's own, `~/.local/state/rpgtl/codex`, with its own login: `rpgtl codex login` (`--device-auth` without a browser), `rpgtl codex login status` and `rpgtl codex logout`, or `pnpm run codex …` in a checkout. A separate home keeps the player's `AGENTS.md`, skills and settings out of the prompt, and two homes sharing one login file could each refresh its token and log the other out.
- RPGTL drops every `OPENAI_*` and `CODEX_*` variable and allows only the ChatGPT login, so an API key is never used.
- Each request is an unsaved session with RPGTL's prompt as the system prompt and Codex's own prompt, skills, AGENTS.md files, web search and shell turned off. Codex still lists a JavaScript runner, `apply_patch` and a clock, which no setting removes, so a request carries about 2,300 prompt tokens; the read-only sandbox keeps those tools from changing anything.

## Image reader

RPGTL starts the reader on `127.0.0.1` at a free port when a reading run needs it, and stops it before the backup reader and at the end of each run, so it holds no memory while you translate or play. Its output goes to `reader.log` next to it. `IMAGE_TEXT_THREADS` sets its CPU threads (4 by default). To use a reader you started yourself (see [testing.md](testing.md)), set `RPGTL_IMAGE_READER` to its address, such as `http://127.0.0.1:5001`; RPGTL then neither starts nor stops it.

RPGTL sends game images only to a reader on this computer. The **Backup reader** runs where **Local models** says, like the translation model. In llama-server its vision part needs about 1.1 GB more VRAM than translation, so it keeps more expert layers in RAM. When it doesn't fit, the run waits, says why, and carries on once other programs free memory. In Ollama it is unloaded once it is done.
