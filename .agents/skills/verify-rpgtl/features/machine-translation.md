# Machine translation

**Translate**, in the run bar under a game's header while its translation is on, sends untranslated entries to a local Ollama model, Claude or Codex in the background, saving each batch as it finishes. The bar follows the run on every page of the game (one SSE stream per page, `GET /api/activity?id=<id>`, which also carries NW.js and the last start): **Stop**, what the run does and how many entries it translated, a progress bar. Afterwards it says how the run ended, how many entries failed and the run's warnings. While a run goes, the Translation card's switch, **Import…**, **Clear all…** and settings are locked, and its counts grow with each save. **Build glossary** is the bar's run on the Glossary page ([glossary.md](./glossary.md)).

## Sub-features

- `mt-ollama` Ollama run with the model, glossary model and sampling chosen in the Translation card.
- `mt-claude` Claude run on the signed-in Claude subscription, with **Model** and **Glossary model** from `#claude-model` / `#claude-glossary-model`.
- `mt-codex` Codex run on RPGTL's own Codex login (ChatGPT plan), with `#codex-model` / `#codex-glossary-model`; without a login the run fails at once, and the bar says why.
- `mt-progress` the bar (`[aria-label="Runs"]`) reads `Translating · <done> of <total> entries translated` (or the run's step, such as sorting the glossary), and the card's `<n> of <m> text entries translated` grows without a reload.
- `mt-build-glossary` **Build glossary**, the bar's action on the Glossary page, runs the glossary pass only; see [glossary.md](./glossary.md) (`gl-build`).
- `mt-queue` a run that can't start yet, because another game's images are read or wait to be, waits instead: the bar reads `Translation waits · It starts once image reading in <title> has finished.` with **Stop**, and the card stays unlocked. Two runs with Ollama in different games wait for each other the same way. The run reads the saved settings when it is asked for. The sidebar marks each game whose run goes with a spinner and each whose run only waits with an hourglass, and the row's details on hover say what it waits for (`GET /api/activity/runs`). `examples/waiting-runs.ts` shows both without a model.
- `mt-follow` a reload or a second tab of the game shows the running run.
- `mt-lock` while a run goes: `#translate-game` disabled, **Import…** and **Clear all…** disabled, the settings `inert` under "A run is going: stop it to change these settings."
- `mt-stop` **Stop** ends the run with saved batches kept: `Translation stopped. <n> entries translated and saved; …`.
- `mt-failed` failed entries counted in the bar after the run (`<n> entries couldn't be translated; Translate tries them again.`), with **Show the N failed text entries** opening the Text page on Failed when text entries failed.
- `mt-audit` `pnpm run audit <id>` reports on the run afterwards.

## How to get to it (user POV)

- Open the game, switch **Translate this game** on in the overview's Translation card, choose the translator there, then **Translate** in the bar under the header.
- In a terminal after a run: `RPGTL_DIR=$RUN/state pnpm run audit <id>`.

## Driving it with drive.ts

Preconditions:

- `ollama list` shows `qwen3.6:35b-a3b-q4_K_M` (the default model); `ollama ps` shows no other run.
- Fixture game open and its translation switched on. `examples/run-bar.ts` is a complete, passing steps file for an Ollama run with the default settings: idle bar, running bar and locked card, reload during the run, the end, then Clear all and a run stopped at once.

- **Bar text.** `(document.querySelector('[aria-label="Runs"]')?.textContent ?? "")`; Base UI's progress bar adds a hidden `x` at its end.
- **Run.** `page.clickText("Translate")`, then wait for the bar to include `Translation done`, up to ten minutes. The fixture's 28 entries all go to the model, English ones included.
- **Result.** The Chinese lines in `$RUN/state/games/<id>/catalog.json` have English translations; `$RUN/state/games/<id>/logs/translation-<start>.log` starts with a `run` line, has one `request` line per request and ends with an `end` line; `ollama ps` no longer lists the model (it is unloaded at the end).
- **Stop.** `page.clickText("Translate")`, wait for the bar to include `Stop`, then `page.clickText("Stop")`; the bar reads `Translation stopped. …`.
- **Claude.** Choose it in `#translator` (see `translation-card.md` for driving the select). It runs on the `claude` CLI's login and needs no state of the run's own; its sessions go to `$RUN/state-home/rpgtl/claude-sessions`.
- **Codex.** Choose it in `#translator`. It needs a logged-in Codex home in `<XDG_STATE_HOME>/rpgtl/codex`. Never point a run at the real `~/.local/state`; instead, before `launch.sh` or `verify.sh`, make a scratch folder whose `rpgtl/codex/` holds links to `~/.codex/auth.json` and `~/.codex/auth.lock` (the same file under the same lock, so a token refresh can't log anyone out), and set `RPGTL_VERIFY_STATE_HOME` to it. Without it the bar shows `Codex is not logged in…` under **Translate**, which is how to check the refusal.
- **Audit.** Before cleanup: `RPGTL_DIR=$RUN/state pnpm run audit <id> > $RUN/evidence/audit.txt`.
- **Proof.** Screenshots during and after the run, the run log and catalog copied into evidence.

## Gotchas

- The fixture is mostly English, with two Chinese lines, so a run is short but says little about quality. Quality questions belong to `pnpm run compare` and `pnpm run audit` on a real game, run only when asked; don't use those reports as proof that the page works.
- Translation needs the GPU, which something else may be using. Check `ollama ps` first and never run two translation runs at once.
- **Runs in: llama-server** starts Ollama's bundled `llama-server`; it suits a MoE model such as `qwen3.6:35b-a3b-q4_K_M` and about 18 GB of RAM. Don't pick it unless the change is about it.
- Settings live in `$RUN/config`; a run launched without `launch.sh` would write the real `~/.config/rpgtl/settings.json`.
