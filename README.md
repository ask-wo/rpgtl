# RPGTL

Play Chinese/Korean/Japanese RPG Maker MV and MZ games in English. RPGTL translates a game with a local ollama model or your own Claude or ChatGPT plan, including text in images. It also adds cheats and QoL-features, such as an optional map (F7) or a fast-forward button (F9) while you play. The original game's files are never changed.

## Features

- **Machine translation** of dialogue, choices, menus, item and skill names and plugin text.
- **Text in images** (title screens, signs, menus) is read, erased and redrawn in English.
- **A Glossary** that keeps character names and pronouns consistent between translations.
- **Text positioning**: Long English lines are rewrapped to the game's windows. Font size is automatically adjusted to reasonable levels.
- **Edit anything** the translator got wrong, line by line, and import, export, or share a translation as a file.
- **Map view** (F7): Allows you to see every event on the current map and teleport between tiles or maps.
- **Fast-forward** (F9) through dialogue and cutscenes until the next choice.
- **Cheats (WIP)** (F8): gold, items, actors, switches, battles, movement and saving anywhere. Very basic and unfinished.
- Plays in **NW.js** with your existing saves, or in the **browser**. Linux and Windows.

## Install

Download the archive for your system from the [latest release](https://github.com/ask-wo/rpgtl/releases/latest) (`rpgtl-<version>-linux-x64.tar.gz` or `rpgtl-<version>-win-x64.zip`), unpack it anywhere and start `rpgtl` (Linux) or `rpgtl.cmd` (Windows). Node.js is included. The page opens in your browser.

From a checkout instead, with [Node.js](https://nodejs.org) 26+ and [pnpm](https://pnpm.io) 12:

```sh
git clone https://github.com/ask-wo/rpgtl.git
cd rpgtl
pnpm install
pnpm start
```

then open http://127.0.0.1:47831.

## Limitations

- **Image text.** Erasing sometimes leaves smudges, especially on glossy speech bubbles and shaded banners. Drawings are sometimes taken for text, big decorative logos don't erase cleanly, and tilesets aren't read at all.
- **Translations may have mistakes.** The most common are names, perspective and game-specific words. A wrong name in the glossary repeats in every line that uses it, so look over the **Glossary** before translating the text. Claude makes far fewer mistakes than the local model.
- **The local model is slower and less accurate.** RPGTL is tuned for Qwen3.6 35B-A3B (`qwen3.6:35b-a3b-q4_K_M`, a 23 GB download). On a GPU with 8 GB, most of it runs from system RAM, and a big game can take an hour or more. On the same 184 test lines it got the meaning wrong 20 times, Claude Sonnet 5.5 only 5 times. Codex's quality hasn't been measured.
- **Chinese is what RPGTL is tested on.** Korean and Japanese games use the same setup, but their translation quality hasn't been checked as extensively.
- **Standard MV and MZ games work best.** Text in a plugin's settings is translated, but text written into the plugin's own code may stay untranslated, and some plugin settings may be missed.
- **Long descriptions.** English item and skill descriptions are often longer than the box the game made for the original. They're wrapped and shrunk to fit, which can make them small.
- **Saves made before translating** keep the original text the game stored in them, such as character names.
- **Windows** has had less testing than Linux.

## Open a game

Choose **Open a game…** and pick an unpacked MV or MZ game folder (or paste the path to the folder, its executable or its `index.html`). The game's overview lists anything that needs attention, such as missing images, and the keys RPGTL adds in the game.

If you open a new version of a game you've already translated, RPGTL offers to replace the old one. The translation carries over, except for lines that changed.

- **Play** starts the game in NW.js. The first time, RPGTL asks before downloading NW.js (about 200 MB). Saves go to the game's own `save/` folder, so existing saves carry over, and RPGTL doesn't need to keep running.
- **Play in browser** opens the game in a new tab, served by RPGTL, so keep RPGTL running while you play. Browser saves are kept by the browser, apart from NW.js saves; clearing the browser's site data deletes them.

After changing translations, press **F5** in the game to load them.

## Translate

Turn on **Translate this game** on the overview, pick a translator, and press **Translate**. The run continues in the background; **Stop** keeps what was done, and running again translates only the rest.

| Translator | What you need | Where your text goes |
| --- | --- | --- |
| **Ollama** | [Ollama](https://ollama.com) and a model, e.g. `ollama pull qwen3.6:35b-a3b-q4_K_M` (23 GB download, about 18 GB RAM) | Stays on this computer |
| **Claude** | [Claude Code](https://code.claude.com/docs/en/setup) installed and signed in (`claude`) | Sent to Anthropic, counts against your Claude subscription |
| **Codex** | [Codex CLI](https://developers.openai.com/codex/cli) installed, then `rpgtl codex login` | Sent to OpenAI, counts against your ChatGPT plan |

The pages under the game in the sidebar let you fix the result:

- **Glossary**: the English names of characters, places and terms, and each character's pronoun. **Build glossary** fills it in first so you can correct names before the dialogue is translated.
- **Text**: every line with its translation. Edit any line; filter for untranslated or failed ones.
- **Images**: text found in the game's images, with its English drawn in.

**Export** and **Import…** on the overview move a translation to another computer or another version of the game, or let you edit it as JSON. **Import…** shows what the file would change before it changes anything. RPGTL backs up the translation before every change, and **Clear all…** and **Import…** can be undone by importing a backup.

## Image text

**Read new images** on the **Images** page finds Chinese, Japanese, or Korean text in the game's pictures, erases it and draws the English in its place. The first time, it asks to download the reader (about 1 GB, or 2.6 GB to use an NVIDIA GPU), which runs on this computer only. **Settings** can remove it again.

The reader's models are fixed: PaddleOCR's PP-OCRv6 medium detector and recognizer read the text (Korean games use `korean_PP-OCRv5_mobile_rec`), and big-lama erases it. Only the **Backup reader**, which checks doubtful lines, can be changed; it defaults to Qwen3.6.

**Read all again** next to it, or **Read again** in an image's dialog, reads images again from scratch, for example after an RPGTL update reads them better. Each text keeps its English; where it reads differently now, the English is flagged for a look.

Where the reader got a character wrong, the pencil next to a text in the image's dialog lets you correct it. Saving the correction clears English a translation run gave for the old text, so the next **Translate** translates the corrected one; English you typed yourself stays. Reading the image again keeps the correction as long as the text reads as before, and **Use it** under a corrected text goes back to what the reader read.

## Where things are kept

Translations, image text, backups and logs are kept per game in `~/.local/share/rpgtl` (Windows: `%LOCALAPPDATA%\rpgtl\data`; from a checkout: `.rpgtl/`). Set `RPGTL_DIR` to use another folder, and `PORT` for another port.

## License

RPGTL is free software under the [MIT License](LICENSE).
