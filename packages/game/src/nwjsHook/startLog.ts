/**
 * Writes how far the game's start got, so the log tells a game that doesn't run from a window
 * that doesn't show it: the versions, the window, the graphics card WebGL runs on, and how many
 * frames the page drew (a window Chromium takes for hidden draws none but still plays sound).
 */
export function logStart(
  log: (text: string) => void,
  versions: NodeJS.ProcessVersions,
  system: string,
) {
  log(
    `hook started in NW.js ${versions["nw"]} (Chromium ${versions["chromium"]}) on ${system}, ${windowState()}`,
  );
  document.addEventListener("visibilitychange", () => log(`page ${document.visibilityState}`));
  window.addEventListener("load", () => log(`page loaded, ${graphicsCard()}, ${windowState()}`));
  let frames = 0;
  const count = () => {
    frames++;
    window.requestAnimationFrame(count);
  };
  window.requestAnimationFrame(count);
  for (const seconds of [1, 5, 15, 60])
    window.setTimeout(
      () => log(`after ${seconds} s: ${frames} frames drawn, scene ${scene()}, ${windowState()}`),
      seconds * 1000,
    );
}

const windowState = () =>
  `window ${window.outerWidth}x${window.outerHeight} (page ${window.innerWidth}x${window.innerHeight}) at ${window.screenX},${window.screenY} on a ${window.screen.width}x${window.screen.height} screen at scale ${window.devicePixelRatio}, page ${document.visibilityState}${document.hasFocus() ? " and focused" : ""}`;
const scene = () =>
  (window as unknown as { SceneManager?: { _scene?: object | null } }).SceneManager?._scene
    ?.constructor.name ?? "none yet";

function graphicsCard() {
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    if (!gl) return "no WebGL";
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    return `WebGL on ${info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)}`;
  } catch (error) {
    return `no WebGL: ${String(error)}`;
  }
}
