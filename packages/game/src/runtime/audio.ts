import { type LoadingAudio, rm } from "./engine.ts";
import { reportMissing } from "./missingFiles.ts";

// A sound that fails to load stays silent instead of stopping the game with a loading error. A
// missing local file stays missing, so the retry screen could never help.
export function hookMissingAudio() {
  const proto = rm.WebAudio?.prototype;
  if (!proto) return;
  // MZ and MV before 1.5 throw from `AudioManager.checkErrors` each frame a sound has an error.
  const { isError } = proto;
  proto.isError = function (this: LoadingAudio) {
    if (isError.call(this)) reportMissing(this._url, "audio");
    return false;
  };
  // MV 1.5 and later retry a failed sound three times and then show the retry screen.
  const load = proto._load;
  if (load)
    proto._load = function (this: LoadingAudio, url: string) {
      if (this._loader)
        this._loader = () => {
          this._hasError = true;
          reportMissing(this._url, "audio");
        };
      load.call(this, url);
    };
}
