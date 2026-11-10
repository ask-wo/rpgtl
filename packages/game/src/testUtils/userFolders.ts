import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Code that falls back to ~/.local/state, ~/.config or ~/.cache (Claude sessions, the Codex login,
// settings, NW.js), or a state folder built without the test's own RPGTL_DIR, would otherwise
// write into the user's real folders or the repo's .rpgtl/.
const home = mkdtempSync(path.join(os.tmpdir(), "rpgtl-test-home-"));
process.env.XDG_STATE_HOME = path.join(home, "state");
process.env.XDG_CONFIG_HOME = path.join(home, "config");
process.env.XDG_CACHE_HOME = path.join(home, "cache");
process.env.RPGTL_DIR = path.join(home, "rpgtl");
