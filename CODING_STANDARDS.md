# Coding standards

Rules for reviewing changes that no automated check covers.

## Docs

- A claim in a design doc, plan or research note about engine behaviour, a library, a model or external data names where it was checked (a file in the game or engine, a test, a URL, a measured run). A claim that wasn't checked says so.

## Effect code

`docs/architecture.md` describes the conventions; lint checks the mechanical ones (`lint/plugin.ts` and the `effecttsgo` rules from `@effect/tsgo`). Reviewers check these:

- An HTTP handler calls one service method and translates its errors. Work on the result, even a pure function from `packages/domain`, goes in a service method.
- Each service has its own `<Service>.test.ts` that tests it through its layer.
- Each service method has a caller outside tests. A test waits for a result through the method its callers use (polling `status` the way the page does, say), not through a method added for it.
- A service method that writes several files or state entries that only make sense together runs them in `Effect.uninterruptible`: the HTTP server interrupts a handler when its client disconnects, and a half-finished import leaves read results and catalog out of step.
- A service method takes decoded types, not `unknown`. The caller decodes: the handler, the command-line tool, or the code that reads the file.

## Replacing code

- A change that replaces existing code keeps each of its guards and the state it carries over, or the pull request names the one it drops and why. Compare with the replaced code: timeouts, refusing addresses on other computers, which saved fields a result keeps when it is prepared again.

## Extraction and applying translations

- A change to what is extracted or how a translation is applied says what else reads that text: game logic that compares or looks it up (scripts, conditions, notes, plugin keys, file names) and saves that still hold the original. Translating a sound's file name broke its loading, script comparisons need every copy translated the same, and older saves keep untranslated actor names and variable values. `pnpm run audit <id> --logic` lists logic that uses translated text in an inspected game.

## Tests

### What deserves a test

Behaviour that can break in a way a player would pay for:

- Extracting text from game data and applying translations to it, with entry ids that stay the same.
- State file formats and their upgrade steps.
- Reading what a translator answers, and the checks on it.
- Fitting text into the game's windows, and the other patches the game scripts make.
- Parsing outside formats: plugin files, encrypted images, model output.
- Runs that stop, fail or overlap.
- The logic a bug fix changed.

### How to test it

- Test each case at one layer, the lowest one that fails without the change: a domain function, then a service, then an HTTP route. Don't repeat it in a wrapper test or at each caller.
- Extend before you add: when an existing test covers the behaviour, add an assertion or a case to it; write a new test only when none fits.
- A fix for a logic, data or state bug starts with the fewest tests that fail before it, for that reason. A purely visual fix gets before/after screenshots instead.
- A page component test is for what needs the page rendered: layout, focus, keys and pointer, or a component wired to the page's state and requests. Logic a component calls goes in a function with a test of its own, or in `packages/domain` when other parts use it too.
- A test that runs a command-line tool reads its machine-readable output (`--format json`, exit codes), not the text meant for people: that text can change with the environment, as Oxlint's did between a local run and CI.
- A test of a refusal checks the error's tag or its field naming the kind of problem (such as `problem` on an import error), not the wording of its message.
- A test that stopping something cleans up checks the thing itself: a child process (a fake CLI in its place is fine) has exited, a file is closed. That a signal or abort was sent proves nothing, since the library in between may not pass it on.

### Leave out

- What the types already guarantee: a schema decoding a field it declares, a `switch` the compiler checks for every case.
- Trivial logic: a constant, a field read, a one-line mapping.
- Wording: labels, messages and other text a player reads.
- Smoke tests that only check that something renders, starts or runs without an error.
- Tests that repeat which mocks were called, or that a callback reaches its handler.
- Props rendered to static markup.
- One case per constant, label or `switch` case, when one case shows the rule.
- A case already tested at a lower layer, again in a wrapper, at each caller, or in both the page and the game scripts.

### Reviewing tests

- Ask for a missing test only when it would catch a real regression: in the areas above, or in the logic the change adds.
- Flag a new test that breaks these rules, and name the fix: fold it into an existing case or table, delete it, keep one layer, or move a component test whose assertions pass without rendering into a test of the function.
