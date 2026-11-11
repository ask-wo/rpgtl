import { test, expect } from "vite-plus/test";
import { loadRuntime } from "../testUtils/fixture.ts";

const quietly = async (run: (warnings: string[]) => Promise<void>) => {
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (message: string) => warnings.push(message);
  try {
    await run(warnings);
  } finally {
    console.warn = warn;
  }
};

test("runtime leaves a missing sound silent instead of the loading error in MZ", async () => {
  await quietly(async (warnings) => {
    class WebAudio {
      _url = "audio/bgm/Rain%26Thunder.ogg";
      _isError = false;
      isError() {
        return this._isError;
      }
    }
    await loadRuntime("MZ", { WebAudio });
    const audio = new WebAudio();
    expect(audio.isError()).toBe(false);
    audio._isError = true;
    expect(audio.isError()).toBe(false);
    // The engine makes a new sound object each time it plays a sound effect.
    const again = new WebAudio();
    again._isError = true;
    expect(again.isError()).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("audio/bgm/Rain%26Thunder.ogg");
  });
});

test("runtime gives up on a missing sound at once and leaves it silent in MV", async () => {
  await quietly(async (warnings) => {
    const retries: string[] = [];
    class WebAudio {
      _url = "";
      _hasError = false;
      _loader?: () => void = () => retries.push(this._url);
      _load(url: string) {
        this._url = url;
      }
      isError() {
        return this._hasError;
      }
    }
    await loadRuntime("MV", { WebAudio });
    const audio = new WebAudio();
    audio._load("audio/se/Gate.ogg");
    audio._loader?.();
    expect(retries).toEqual([]);
    expect(audio._hasError).toBe(true);
    expect(audio.isError()).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("audio/se/Gate.ogg");
  });
});
