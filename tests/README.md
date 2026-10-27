# Tests

Start here before adding or changing tests. Group tests by the feature that owns
the behavior, and reuse an existing suite before creating another file.

## Folder structure

```text
tests/
  files/                       # Files feature
    *.test.ts                  # Unit and regression suites
    *.browser.test.ts          # Browser test runners
    *.browser.tsx              # Browser preview entries
    helpers/                   # Files-only test helpers
    fixtures/                  # Files-only sample data and boundary substitutes
    native-permissions/        # Native permission test harness
  tooling/                     # Git hook and test-policy suites
  workspace/                   # Migrated workspace behavior suites
  helpers/                     # Helpers shared across features
  fixtures/                    # Fixtures shared across features
  runAllAgentTests.mjs          # Shared frontend suite runner
```

Use `tests/<feature>/` for other features as they are organized. Create helper or
fixture folders only when needed; keep feature-specific support beside its tests.

## When changing tests

- Put new suites in their owning feature folder. When updating a root-level
  suite, move that suite and its feature-specific support into the feature folder.
  Migrate other suites as they are touched; do not move unrelated tests.
- Write new or expanded JavaScript/TypeScript test logic in `.ts` or `.tsx`.
  Convert a legacy JavaScript suite before adding cases or assertions. Python
  and Rust tests keep their native languages.
- Keep one test implementation. Register typed unit suites directly in
  `runAllAgentTests.mjs`; do not add per-suite JavaScript launchers. Existing
  launchers for unmigrated features may remain.
- Ensure typed sources are included in `../tsconfig.agent-tests.json`. After a
  move, update imports, source paths, runner entries and documented commands.
- Preserve existing cases and assertions, then run compilation and the relevant
  suites. Browser and native checks have separate runtime requirements.

## Commands

Run from the app repository root (`zync/`):

```sh
npm run compile:agent-tests
npm run test:git-hooks
npm run test:files
npm run test:files:browser
npm run test:all-agent
```

Files browser checks use installed Microsoft Edge by default. Focus a browser
mode with, for example, `npm run test:files:browser -- --folder-sizes-only`.
See [contributing](../CONTRIBUTING.md#test-language) for formatting, test-language
checks and browser configuration.
