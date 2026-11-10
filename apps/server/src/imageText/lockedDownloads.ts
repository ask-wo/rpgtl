/**
 * What `uv sync` downloads, worked out from a uv lockfile: each package it would install comes as
 * the wheel uv picks for this computer, or as its source archive when no wheel fits.
 */

/** The computer the packages are for. */
export interface Platform {
  readonly os: "linux" | "windows";
  /** CPython's minor version: 12 for 3.12. */
  readonly pythonMinor: number;
  /** The C library's version on Linux, which decides the `manylinux` wheels that fit. */
  readonly glibc: readonly [major: number, minor: number];
}

/**
 * A file a lockfile names, with its size in bytes unless its index didn't say, as PyTorch's
 * doesn't.
 */
export interface LockedFile {
  readonly url: string;
  readonly size: number | undefined;
}

const lockedFile = /\{ url = "([^"]+)", hash = "[^"]+"(?:, size = (\d+))?/g;

/** Every wheel and source archive a uv lockfile names. */
export const lockedFiles = (lock: string): ReadonlyArray<LockedFile> =>
  Array.from(lock.matchAll(lockedFile), ([, url = "", size]) => ({
    url,
    size: size === undefined ? undefined : Number(size),
  }));

/** A package name as Python compares them: `Pillow`, `pillow` and `pillow_` are one. */
const normalized = (name: string) => name.toLowerCase().replaceAll(/[-_.]+/g, "-");

const wheelName = /^(.+?)-([^-]+)(?:-\d[^-]*)?-([^-]+)-([^-]+)-([^-]+)\.whl$/;
const sdistName = /^(.+)-([^-]+)\.(?:tar\.gz|zip)$/;

const legacyManylinux = new Map([
  ["manylinux1", [2, 5]],
  ["manylinux2010", [2, 12]],
  ["manylinux2014", [2, 17]],
]);

/**
 * How well a wheel's platform tag fits, smaller is better, or `undefined` when it doesn't. Newer
 * `manylinux` tags come first, as uv prefers them.
 */
const platformRank = (tag: string, platform: Platform): number | undefined => {
  if (tag === "any") return 100_000;
  if (platform.os === "windows") return tag === "win_amd64" ? 0 : undefined;
  if (tag === "linux_x86_64") return 99_999;
  const manylinux = /^(manylinux\d*)(?:_(\d+)_(\d+))?_x86_64$/.exec(tag);
  if (!manylinux) return undefined;
  const [, family = "", major, minor] = manylinux;
  const [needsMajor = 0, needsMinor = 0] =
    major === undefined ? (legacyManylinux.get(family) ?? []) : [Number(major), Number(minor)];
  if (needsMajor === 0) return undefined;
  const [hasMajor, hasMinor] = platform.glibc;
  if (needsMajor > hasMajor || (needsMajor === hasMajor && needsMinor > hasMinor)) return undefined;
  return 10_000 - needsMajor * 100 - needsMinor;
};

/** How well a wheel's Python and ABI tags fit, smaller is better, or `undefined` when they don't. */
const pythonRank = (python: string, abi: string, platform: Platform): number | undefined => {
  const minor = /^(cp|py)3(\d*)$/.exec(python);
  if (!minor) return undefined;
  const [, kind, digits = ""] = minor;
  const version = digits === "" ? undefined : Number(digits);
  if (version !== undefined && version > platform.pythonMinor) return undefined;
  if (kind === "cp") {
    if (abi === `cp3${platform.pythonMinor}` && version === platform.pythonMinor) return 0;
    if (abi === "abi3") return 1 + (platform.pythonMinor - (version ?? 0));
    if (abi === "none" && version === platform.pythonMinor) return 20;
    return undefined;
  }
  return abi === "none" ? 30 + (platform.pythonMinor - (version ?? 0)) : undefined;
};

/** How well a wheel's file name fits, smaller is better, or `undefined` when it doesn't. */
const wheelRank = (tags: ReadonlyArray<string>, platform: Platform) => {
  const [pythons = "", abis = "", platforms = ""] = tags;
  let best: number | undefined;
  for (const python of pythons.split("."))
    for (const abi of abis.split("."))
      for (const tag of platforms.split(".")) {
        const first = pythonRank(python, abi, platform);
        const second = platformRank(tag, platform);
        if (first === undefined || second === undefined) continue;
        const rank = first * 1_000_000 + second;
        if (best === undefined || rank < best) best = rank;
      }
  return best;
};

/** A package uv would install, as `uv sync --dry-run` lists it: `name==version`. */
export interface Planned {
  readonly name: string;
  readonly version: string;
}

/**
 * The file uv downloads for each package, from the files of `lock` that are this package's, or
 * none for a package the lockfile has no file for, such as the project itself.
 */
export const plannedFiles = (
  lock: ReadonlyArray<LockedFile>,
  planned: ReadonlyArray<Planned>,
  platform: Platform,
): ReadonlyArray<LockedFile> => {
  const wheels = new Map<string, Array<{ file: LockedFile; rank: number }>>();
  const sdists = new Map<string, LockedFile>();
  for (const file of lock) {
    const name = decodeURIComponent(file.url.slice(file.url.lastIndexOf("/") + 1));
    const wheel = wheelName.exec(name);
    if (wheel) {
      const [, dist = "", version = "", ...tags] = wheel;
      const rank = wheelRank(tags, platform);
      if (rank === undefined) continue;
      const key = `${normalized(dist)}==${version}`;
      wheels.set(key, [...(wheels.get(key) ?? []), { file, rank }]);
      continue;
    }
    const sdist = sdistName.exec(name);
    if (sdist) sdists.set(`${normalized(sdist[1] ?? "")}==${sdist[2] ?? ""}`, file);
  }
  return planned.flatMap(({ name, version }) => {
    const key = `${normalized(name)}==${version}`;
    const best = wheels.get(key)?.toSorted((a, b) => a.rank - b.rank)[0]?.file ?? sdists.get(key);
    return best === undefined ? [] : [best];
  });
};

const plannedLine = /^\s*\+ (\S+)==(\S+)/;

/** What `uv sync --dry-run` says it would install. */
export const dryRunPlan = (lines: ReadonlyArray<string>) =>
  lines.flatMap((line): Array<Planned> => {
    const install = plannedLine.exec(line);
    return install ? [{ name: install[1] ?? "", version: install[2] ?? "" }] : [];
  });

const lockedPython = /^requires-python = "==3\.(\d+)\.\*"$/m;

/** The minor version of the one Python a lockfile allows, such as 12 for `==3.12.*`. */
export const lockedPythonMinor = (lock: string) => {
  const minor = lockedPython.exec(lock)?.[1];
  return minor === undefined ? undefined : Number(minor);
};
