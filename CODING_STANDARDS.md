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

- Test each case at one layer, the lowest one that fails without the change: a domain function, then a service, then an HTTP route. Don't repeat it in a wrapper test or at each caller.
- Extend before you add: when an existing test covers the behaviour, add an assertion or a case to it; write a new test only when none fits.
- A fix for a logic, data or state bug starts with a test that fails before it. A purely visual fix gets before/after screenshots instead.
- Leave out tests of what the types already guarantee, trivial logic, wording, and tests that only repeat which mocks were called.
- A test that runs a command-line tool reads its machine-readable output (`--format json`, exit codes), not the text meant for people: that text can change with the environment, as Oxlint's did between a local run and CI.
- A test of a refusal checks the error's tag or its field naming the kind of problem (such as `problem` on an import error), not the wording of its message.
- A test that stopping something cleans up checks the thing itself: a child process (a fake CLI in its place is fine) has exited, a file is closed. That a signal or abort was sent proves nothing, since the library in between may not pass it on.
