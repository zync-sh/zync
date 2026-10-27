# Contributing to Zync

Thank you for your interest in contributing to Zync. This document provides guidelines and instructions for contributing.

## Licensing contributions

The desktop application is distributed under [FSL-1.1-ALv2](LICENSE), with
Apache 2.0 rights for each version after two years. By submitting a desktop
contribution, you confirm you have the right to license it for inclusion under
those terms and that it does not contain incompatible third-party code. You
retain copyright in your contribution. The separately licensed plugin SDK and
plugin UI packages remain MIT in their [SDK](https://github.com/zync-sh/plugin-sdk)
and [UI](https://github.com/zync-sh/plugin-ui) repositories.

Do not submit code you cannot license under the applicable terms. If your
employer may own your work, obtain its permission before contributing. Any
separate commercial licensing of contributed code would require additional
rights from its copyright holder; a pull request alone does not grant them.

## Getting Started

1. **Fork** the [repository](https://github.com/zync-sh/zync) on GitHub.

2. **Clone your fork** and add the upstream remote:
   ```bash
   git clone https://github.com/YOUR_USERNAME/zync.git
   cd zync
   git remote add upstream https://github.com/zync-sh/zync.git
   ```

3. Ensure you have the [prerequisites](./README.md#prerequisites) installed (Node.js, Rust, and platform-specific dependencies).

4. Run `npm install` and `npm run tauri dev` to start the development environment.

**Public URLs / analytics hosts:** do not hardcode production API URLs in source. Debug builds may talk to local `zync-share` / `zync-analytics`. Release builds must bake `ZYNC_SHARE_API_BASE`, `ZYNC_SHARE_RELAY_URL`, and `VITE_ANALYTICS_API_URL` from GitHub Actions secrets.

**Staying in sync:** Before starting new work, pull the latest from upstream:
   ```bash
   git fetch upstream
   git checkout main
   git merge upstream/main
   ```

## Development Workflow

1. Create a new branch from `main` for your changes:
   ```bash
   git checkout -b fix/your-fix-name
   # or
   git checkout -b feature/your-feature-name
   ```

2. Make your changes. Follow existing code style and conventions.

3. Run the type checker and ensure the app builds:
   ```bash
   npm run type-check
   npm run tauri build
   ```
   Release Rust uses thin LTO (`src-tauri/Cargo.toml` `[profile.release]`). `tauri dev` is unchanged.

4. Commit with clear, descriptive messages:
   ```bash
   git commit -m "fix: resolve SSH connection timeout on slow networks"
   ```

5. Push to your fork and open a Pull Request against the main repository.

## Code Conventions

- **Frontend**: TypeScript, React functional components, Zustand for state.
- **Backend**: Rust, async/await where appropriate.
- **Naming**: Use descriptive names; prefer `snake_case` in Rust and `camelCase` in TypeScript.

### Formatting and imports

`npm install` installs the local pre-commit check without replacing existing hook
commands. Run `npm run prepare` to reinstall it. CI and source archives skip hook
installation; a custom `core.hooksPath` is left unchanged.
When switching to a checkout without `scripts/pre-commit.mjs`, the managed block
skips that check and continues with the existing hook commands.

The hook uses the pinned Biome version to format and organize staged JavaScript
and TypeScript files. It preserves partially staged edits through lint-staged's
backup and restore workflow. Generated output, dependencies and vendored code
are excluded. Files outside the commit are not reformatted. Existing lines in a
staged file can change because formatting applies to the whole staged file.

Use four spaces, a preferred 100-character width, single JS/TS quotes, double
JSX quotes, semicolons, trailing commas and parentheses around arrow parameters.
Use braces for conditions and loops. Missing braces fail the check; the hook
does not enable unsafe fixes. Separate logical steps, top-level functions and
import groups with one blank line; keep related statements together and comments
adjacent to the code they describe.

Imports are grouped as built-ins, packages, project aliases and relative paths.
Names are sorted and compatible duplicate imports are merged. Bare side-effect
imports keep their order. Run `npm run format:staged` after staging files to run
the same checks before committing. The hook never creates a commit.

### Test language

Read [the test folder guide](tests/README.md) before adding or changing tests.

Write new tests and new assertions in **TypeScript (`.ts` or `.tsx`)**. When adding
cases to a legacy JavaScript test, move that logic into TypeScript first. Include
the typed test in `tsconfig.agent-tests.json` and wire it into the existing runner.
Group suites by feature under `tests/<feature>/`, with feature-specific helpers
and fixtures inside that folder. Files tests use `tests/files/`. Move other
feature suites when working on that feature; a repository-wide migration is
not required. Register typed suites directly in the shared runner without adding
per-suite JavaScript launchers. Existing assertion-free `.mjs` launchers may
remain for unmigrated features.

`npm run check:test-language` checks staged snapshots before formatting. It rejects
new JavaScript test sources and detects common new cases/assertions added to
legacy JavaScript tests. Existing harness maintenance can remain JavaScript. This
syntax check supports the policy; it cannot replace review of arbitrary custom
test frameworks. Run `npm run compile:agent-tests` and the relevant behavioral
tests before committing.

For committed changes, `node scripts/check-test-language.mjs --base REF` compares
`HEAD` with its merge base against `REF`. Fetch enough history for that common
ancestor to exist; the frontend CI checkout fetches full history.

From the app repository, run `npm run test:files` for the Files unit suites, or
`npm run test:all-agent` for all registered frontend suites. Run
`npm run test:files:browser` for the separate real-component browser checks; this
uses installed Microsoft Edge by default. Set `ZYNC_BROWSER_CHANNEL` to another
installed Playwright Chromium channel if needed. Focused browser modes are
forwarded, for example `npm run test:files:browser -- --folder-sizes-only`.
These commands compile the typed tests and prepare their Node imports before
running them. The browser preview is `/tests/files/filesProduction.browser.html`
on the development server.

## Pull Request Guidelines

- Keep PRs focused and reasonably sized.
- Add a clear title and description.
- Reference any related issues.
- Ensure CI passes (if applicable).

## Questions or Ideas?

Open an [Issue](https://github.com/zync-sh/zync/issues) to report bugs, request features, or ask questions.
