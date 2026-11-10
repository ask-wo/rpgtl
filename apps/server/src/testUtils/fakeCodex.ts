// Stands in for the `codex` CLI in the Codex tests. `--model` picks what `codex exec` does: "answer"
// echoes what it got, "fail" fails its turn, "hang" writes its PID to FAKE_CODEX_PID and waits.
import { renameSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
// oxlint-disable-next-line no-restricted-properties -- a script the test runs, not server code
const env = process.env;

if (args[0] === "login") process.exit(env.FAKE_CODEX_LOGGED_OUT ? 1 : 0);

const levelOf = (reasoningEffort: string) => ({ reasoningEffort, description: "" });

if (args[0] === "app-server") {
  // Answers `model/list` with a plan's models, one of them hidden, and keeps running as Codex does.
  process.stdin.on("data", (chunk) => {
    for (const line of String(chunk).split("\n").filter(Boolean)) {
      const request = JSON.parse(line);
      if (request.method !== "model/list") continue;
      const model = (id: string, hidden: boolean, isDefault: boolean) => ({
        id,
        displayName: id.toUpperCase(),
        hidden,
        isDefault,
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: [levelOf("low"), levelOf("medium"), levelOf("ultra")],
      });
      process.stdout.write(
        `${JSON.stringify({
          id: request.id,
          result: {
            data: [model("gpt-9-plan", false, true), model("gpt-9-review", true, false)],
            nextCursor: null,
          },
        })}\n`,
      );
    }
  });
}

const model = args[args.indexOf("--model") + 1];
const instructions = args.find((arg) => arg.startsWith("instructions="));
const effort = args.find((arg) => arg.startsWith("model_reasoning_effort="));
const print = (event: unknown) => process.stdout.write(`${JSON.stringify(event)}\n`);
let stdin = "";
process.stdin.on("data", (chunk) => (stdin += chunk));
if (args[0] !== "app-server")
  process.stdin.on("end", () => {
    process.stdout.write("Reading prompt from stdin...\n");
    if (model === "hang") {
      // Renamed into place, so the test never reads half of it.
      const file = env.FAKE_CODEX_PID ?? "";
      writeFileSync(`${file}.tmp`, String(process.pid));
      renameSync(`${file}.tmp`, file);
      // oxlint-disable-next-line effecttsgo/global-timers -- keeps this plain script running
      setInterval(() => {}, 1000);
      return;
    }
    print({ type: "error", message: "Reconnecting... 1/5" });
    if (model === "fail") {
      print({ type: "turn.failed", error: { message: "You've hit your usage limit." } });
      process.exit(1);
    }
    const answer = JSON.stringify({
      stdin,
      instructions,
      effort,
      home: env.CODEX_HOME,
      key: env.OPENAI_API_KEY,
    });
    print({
      type: "item.completed",
      item: { type: "agent_message", text: "```json\n" + answer + "\n```" },
    });
    print({
      type: "turn.completed",
      usage: { input_tokens: 100, output_tokens: 30, reasoning_output_tokens: 20 },
    });
  });
