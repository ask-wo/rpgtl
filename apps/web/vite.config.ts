import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

const require = createRequire(import.meta.url);
const packageDir = (name: string) => path.dirname(require.resolve(`${name}/package.json`));

/** `<name>/<dir><module>` for each `dist/<dir><module>.js` of a package that exports `./*`. */
const distModules = (name: string, dirs: ReadonlyArray<string>) =>
  dirs.flatMap((dir) =>
    readdirSync(path.join(packageDir(name), "dist", dir))
      .filter((file) => file.endsWith(".js") && file !== "index.js")
      .map((file) => `${name}/${dir}${file.slice(0, -".js".length)}`),
  );

/** Every subpath a package's `exports` names. */
const exportedPaths = (name: string) =>
  Object.keys(require(`${name}/package.json`).exports)
    .filter((key) => key !== "./package.json")
    .map((key) => (key === "." ? name : `${name}${key.slice(1)}`));

export default defineConfig(({ mode }) => ({
  plugins: [react({ compiler: true }), tailwindcss()],
  resolve: { tsconfigPaths: true },
  // A module of these packages that the page or a test imports for the first time would make Vite
  // optimize it mid-run and reload the browser tests, failing the other files, so all are bundled.
  optimizeDeps: {
    include: [
      ...distModules("effect", ["", "http/", "reactivity/"]),
      ...exportedPaths("@base-ui/react"),
    ],
  },
  // The pre-commit hook tests staged files in a worktree under .git/, which Vite's default
  // `server.fs.deny` refuses to serve; the tests' server is the only one that needs it.
  ...(mode === "test" && { server: { fs: { deny: [".env", ".env.*", "*.{crt,pem}"] } } }),
  test: {
    name: "web",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/testSetup.ts"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
      screenshotFailures: false,
    },
  },
}));
