import * as Result from "effect/Result";
import { decodeGameFile, extract, type PluginText } from "../index.ts";

export const readGameFile = (file: string, data: unknown) =>
  Result.getOrThrow(decodeGameFile(file, JSON.stringify(data)));

export const extractFrom = (file: string, data: unknown, plugins?: PluginText) =>
  extract(file, readGameFile(file, data), plugins);
