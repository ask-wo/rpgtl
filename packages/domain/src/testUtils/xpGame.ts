import { dump, RubyHash, RubyObject } from "@hyrious/marshal";
import { zlibSync } from "fflate";
import { writeArchive } from "../engines/xp/archive.ts";

/** A Ruby object of `className` with an instance variable per field, as RGSS dumps it. */
export function rubyObject(className: string, fields: Record<string, unknown>) {
  const object = new RubyObject(Symbol.for(className));
  for (const [name, value] of Object.entries(fields))
    Reflect.set(object, Symbol.for(`@${name}`), value);
  return object;
}

/** An event command; text commands hold their text as the first parameter. */
export const command = (code: number, ...parameters: unknown[]) =>
  rubyObject("RPG::EventCommand", { code, indent: 0, parameters });

/** A map whose events each have one page with the commands given. */
export const xpMap = (events: Record<number, ReadonlyArray<RubyObject>>) =>
  rubyObject("RPG::Map", {
    events: new RubyHash(
      Object.entries(events).map(([id, list]) => [
        Number(id),
        rubyObject("RPG::Event", {
          id: Number(id),
          name: `EV${id}`,
          pages: [rubyObject("RPG::Event::Page", { list: [...list, command(0)] })],
        }),
      ]),
    ),
  });

/** A data file as RGSS writes it, such as `Map001.rxdata`. */
export const xpFile = (data: unknown) => dump(data);

/** An archive (`Game.rgssad`) of the data files given by name below `Data/`, dumped. */
export const xpArchive = (files: Record<string, unknown>) =>
  writeArchive(
    new Map(Object.entries(files).map(([name, data]) => [`Data/${name}`, xpFile(data)])),
  );

/** `Scripts.rxdata`'s content for the scripts given by name, before it is dumped. */
export const xpScripts = (scripts: Record<string, string>) =>
  Object.entries(scripts).map(([name, code], at) => [
    at + 1,
    new TextEncoder().encode(name),
    zlibSync(new TextEncoder().encode(code)),
  ]);
