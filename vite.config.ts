import { recommended as effectRules } from "@effect/tsgo/oxlint-presets";
import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    // In order, so lint reads the formatted file.
    "*": [
      "vp fmt --no-error-on-unmatched-pattern",
      "effect-tsgo --tsrs-lint vp lint --no-error-on-unmatched-pattern",
    ],
    // Knip checks the whole workspace, so it takes no file list.
    "{*.{ts,tsx,mts,js,mjs},package.json,knip.jsonc}": () => "knip --reporter compact",
  },
  fmt: { ignorePatterns: ["**/*.md"] },
  lint: {
    extends: [effectRules],
    ignorePatterns: [".claude/**"],
    plugins: ["typescript", "unicorn", "oxc", "import"],
    jsPlugins: ["./lint/plugin.ts"],
    categories: {
      correctness: "error",
      suspicious: "warn",
    },
    env: {
      builtin: true,
      browser: true,
    },
    rules: {
      // Effect's `effecttsgo/missing-return-yield-star` wants `return yield* Effect.fail(...)` in a
      // generator whose other paths return nothing; this rule flags exactly that.
      "typescript/consistent-return": "off",
      "effecttsgo/unstable-api-usage": "off",
      "effecttsgo/schema-class-missing-brand": "off",
      "import/no-cycle": "error",
      "typescript/no-explicit-any": "error",
      "typescript/no-non-null-assertion": "error",
      "typescript/no-unsafe-type-assertion": "error",
      "unicorn/prefer-add-event-listener": "off",
      "import/no-unassigned-import": ["warn", { allow: ["**/*.css"] }],
      "no-underscore-dangle": [
        "warn",
        {
          allow: [
            "_tag",
            "_latestButton",
            "_wordWrap",
            "_textState",
            "_rpgtlFontSize",
            "_rpgtlMessageLayout",
            "_rpgtlWrap",
            "_rpgtlColumns",
            "_data",
            "_commandWindow",
            "_list",
            "_scene",
            "_app",
            "_renderer",
            "_height",
            "_realScale",
            "_rpgtlHeight",
            "_rpgtlScale",
            "_rpgtlSharpFilters",
            "_rpgtlWidth",
            "_smooth",
            "_updateAllElements",
            "_defaultStretchMode",
            "_stretchEnabled",
            "_width",
            "_com_position",
            "_com_pictures",
            "_com_sprites",
            "_url",
            "_image",
            "_loadingState",
            "_decodeAfterRequest",
            "_loader",
            "_load",
            "_hasError",
            "_isError",
            "_loadListener",
            "_errorListener",
            "_requestImage",
            "_callLoadListeners",
            "_setDirty",
            "_baseTexture",
            "_onLoad",
            "_onError",
            "_ignoreList",
            "_xhrOk",
            "_pageIndex",
            "_erased",
            "_mapId",
            "_type",
          ],
        },
      ],
    },
    overrides: [
      {
        // The verify-rpgtl skill's scripts: loosely typed helpers, run by hand.
        files: [".agents/skills/**"],
        rules: {
          "typescript/no-base-to-string": "off",
          "typescript/no-explicit-any": "off",
          "typescript/no-floating-promises": "off",
          "typescript/no-implied-eval": "off",
          "typescript/no-misused-spread": "off",
          "typescript/no-non-null-assertion": "off",
          "typescript/no-redundant-type-constituents": "off",
          "typescript/no-unnecessary-template-expression": "off",
          "typescript/no-unnecessary-type-assertion": "off",
          "typescript/no-unnecessary-type-conversion": "off",
          "typescript/no-unnecessary-type-parameters": "off",
          "typescript/no-unsafe-type-assertion": "off",
          "typescript/require-array-sort-compare": "off",
          "typescript/no-unsafe-unary-minus": "off",
          "typescript/restrict-template-expressions": "off",
          "typescript/unbound-method": "off",
        },
      },
      {
        // The game scripts patch the engine's untyped classes and globals in place, and the engine
        // passes values its types don't promise (numbers as text), so conversions there are kept.
        files: ["packages/game/**"],
        rules: {
          "typescript/no-base-to-string": "off",
          "typescript/no-explicit-any": "off",
          "typescript/no-non-null-assertion": "off",
          "typescript/no-unnecessary-type-conversion": "off",
          "typescript/no-unnecessary-type-parameters": "off",
          "typescript/no-unsafe-type-assertion": "off",
          "typescript/restrict-template-expressions": "off",
          "typescript/unbound-method": "off",
          "rpgtl/tests-next-to-module": "error",
        },
      },
      {
        // These run the built game scripts against fake globals with `new Function`.
        files: ["packages/game/src/**/*.test.ts", "packages/game/src/testUtils/**"],
        rules: { "typescript/no-implied-eval": "off" },
      },
      {
        // Components copied in from shadcn/ui, kept as shadcn writes them.
        files: ["apps/web/src/components/ui/**"],
        rules: { "no-shadow": "off", "typescript/no-unsafe-type-assertion": "off" },
      },
      {
        // TypeScript checks names in .ts files; these scripts, kept as records, still run on Bun.
        files: ["**/*.mjs"],
        env: { node: true },
        globals: { Bun: "readonly" },
        rules: { "no-undef": "error" },
      },
      {
        files: ["apps/server/**", "packages/contracts/**", "packages/domain/**"],
        rules: {
          "rpgtl/effect-namespace-imports": "error",
          "rpgtl/no-static-layer": "error",
          "rpgtl/tests-next-to-module": "error",
          "rpgtl/no-message-from-cause": "error",
          "rpgtl/prefer-catch-tags": "error",
          "rpgtl/no-catch-all": "error",
          "rpgtl/no-literal-cause": "error",
          "rpgtl/record-keys-are-strings": "error",
          "rpgtl/prefer-effect-fn": "error",
          "rpgtl/service-id-matches-path": "error",
          "rpgtl/service-methods-effect-fn": "error",
          "effecttsgo/unsafe-effect-type-assertion": "error",
          "effecttsgo/extends-native-error": "error",
          "effecttsgo/prefer-schema-tagged-error": "error",
          "effecttsgo/new-promise": "error",
          "effecttsgo/missing-effect-service-dependency": "error",
          "effecttsgo/nested-effect-gen-yield": "error",
          "effecttsgo/service-not-as-class": "error",
          "effecttsgo/crypto-random-uuid": "error",
          "effecttsgo/crypto-random-uuid-in-effect": "error",
          "effecttsgo/global-console": "error",
          "effecttsgo/global-console-in-effect": "error",
          "effecttsgo/global-fetch": "error",
          "effecttsgo/global-fetch-in-effect": "error",
          "effecttsgo/global-random": "error",
          "effecttsgo/global-random-in-effect": "error",
          "effecttsgo/global-timers": "error",
          "effecttsgo/global-timers-in-effect": "error",
        },
      },
      {
        files: ["apps/server/**"],
        rules: {
          "rpgtl/no-async": "error",
          "rpgtl/no-try": "error",
          "rpgtl/no-new-date": "error",
          "no-restricted-properties": [
            "error",
            {
              object: "Date",
              property: "now",
              message: "Read the time from Clock, so tests can use TestClock.",
            },
            {
              object: "process",
              property: "env",
              message: "Read settings through Config.",
            },
          ],
        },
      },
      {
        files: ["apps/server/**/*.test.ts", "packages/**/*.test.ts"],
        rules: {
          "effecttsgo/strict-effect-provide": "off",
          "effecttsgo/global-timers": "off",
          "no-restricted-globals": [
            "error",
            ...["setTimeout", "setInterval"].map((name) => ({
              name,
              message:
                "Wait on a Deferred, a Queue or TestClock.adjust; a test that needs real time is flaky.",
            })),
          ],
        },
      },
    ],
    options: { typeAware: true },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          // Tests that start processes or build the page take several seconds when the pre-commit
          // hook or CI runs every test at once, and CI runs two jobs on one machine.
          testTimeout: 15_000,
          include: [
            "apps/server/src/**/*.test.ts",
            "packages/*/src/**/*.test.ts",
            "lint/*.test.ts",
          ],
          setupFiles: [
            "packages/game/src/testUtils/matchers.ts",
            "packages/game/src/testUtils/userFolders.ts",
          ],
        },
      },
      // The page's components, in headless Chromium.
      "apps/web",
    ],
  },
});
