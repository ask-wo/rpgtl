export interface CaseFs {
  existsSync(file: string): boolean;
  readdirSync(dir: string): string[];
  join(...parts: string[]): string;
}

/**
 * The path under `base` that `segments` name when letter case is ignored, such as `img/foo.png`
 * for `Img/Foo.PNG`; Windows finds these files, Linux doesn't. An exact name wins over a
 * differently cased one. Undefined when a segment matches nothing.
 */
export function matchCase(base: string, segments: string[], fs: CaseFs) {
  let current = base;
  const found: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    let name = segment;
    if (segment === ".." || !fs.existsSync(fs.join(current, segment))) {
      const lower = segment.toLowerCase();
      let names: string[];
      try {
        names = fs.readdirSync(current);
      } catch {
        return undefined;
      }
      const match = names.find((n) => n.toLowerCase() === lower);
      if (!match) return undefined;
      name = match;
    }
    found.push(name);
    current = fs.join(current, name);
  }
  return found;
}
