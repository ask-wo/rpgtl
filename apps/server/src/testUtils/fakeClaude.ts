// Stands in for the `claude` CLI that the Agent SDK starts, in Claude.test.ts. It writes `started`
// to FAKE_AGENT_DIR and waits; when stopped it writes `stopped` and exits.
import { renameSync, writeFileSync } from "node:fs";

// oxlint-disable-next-line no-restricted-properties -- a script the test runs, not server code
const dir = process.env.FAKE_AGENT_DIR ?? "";
// Renamed into place, so the test never reads half of a file.
const mark = (name: string) => {
  writeFileSync(`${dir}/${name}.tmp`, String(process.pid));
  renameSync(`${dir}/${name}.tmp`, `${dir}/${name}`);
};
// The SDK stops its CLI by closing its stdin, and kills it only if it is still running later.
const stop = () => {
  mark("stopped");
  process.exit(0);
};
process.stdin.on("end", stop);
process.on("SIGTERM", stop);
process.stdin.resume();
mark("started");
