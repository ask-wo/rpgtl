// Stands in for Ollama's llama-server in LlamaServer.test.ts. The `llama-server` script that
// testUtils/llama.ts writes starts it with its own path first; files next to it change what it
// does: `exit-while-loading` prints its text and exits 1, `vram-below` runs out of VRAM while
// loading with fewer expert layers in RAM than its number, `loading` never finishes loading,
// `exit-on-request` exits 1 on the first chat request, and `chat-answer` holds the message
// content it answers chat requests with, each of which it writes to `chat-request.json`.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

const dir = path.dirname(process.argv[2] ?? "");
const next = (file: string) => path.join(dir, file);
const args = process.argv.slice(3);
// oxlint-disable-next-line no-restricted-properties -- a script the test runs, not server code
const env = process.env;

if (args.includes("--version")) {
  process.stdout.write("version: fake\n");
  process.exit(0);
}

const cgroup = readFileSync("/proc/self/cgroup", "utf8").trim().split(":").pop() ?? "";
const memoryMax = existsSync(`/sys/fs/cgroup${cgroup}/memory.max`)
  ? readFileSync(`/sys/fs/cgroup${cgroup}/memory.max`, "utf8").trim()
  : null;
// Renamed into place, so the test never reads half of it.
writeFileSync(
  next("record.json.tmp"),
  JSON.stringify({
    argv: args,
    pid: process.pid,
    LD_LIBRARY_PATH: env.LD_LIBRARY_PATH,
    GGML_BACKEND_PATH: env.GGML_BACKEND_PATH,
    memoryMax,
  }),
);
renameSync(next("record.json.tmp"), next("record.json"));

if (existsSync(next("exit-while-loading"))) {
  process.stdout.write("load_tensors: loading model\n");
  process.stdout.write(`${readFileSync(next("exit-while-loading"), "utf8")}\n`);
  process.exit(1);
}

const fewestInRam = existsSync(next("vram-below"))
  ? Number(readFileSync(next("vram-below"), "utf8"))
  : 0;
if (Number(args[args.indexOf("--n-cpu-moe") + 1]) < fewestInRam) {
  process.stdout.write("cudaMalloc failed: out of memory\n");
  process.exit(1);
}

process.stdout.write("fake llama-server: listening\n");
const port = Number(args[args.indexOf("--port") + 1]);
const loading = existsSync(next("loading"));
createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(loading ? 503 : 200).end();
    return;
  }
  if (existsSync(next("exit-on-request"))) process.exit(1);
  if (request.method === "POST" && request.url === "/v1/chat/completions") {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      writeFileSync(next("chat-request.json"), body);
      const content = readFileSync(next("chat-answer"), "utf8");
      response.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          id: "fake",
          object: "chat.completion",
          created: 0,
          model: "fake",
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        }),
      );
    });
    return;
  }
  response.writeHead(404).end();
}).listen(port, "127.0.0.1");
