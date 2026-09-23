# Conventions shared by the platteration repositories

This file is identical in every platteration repository. In every repository with code it
is pinned by the conventions test, which fails when this file, `.editorconfig`, the shared
status block in `REVIEW.md` or the repository's shape drifts; tradetrade, which has no code
yet, carries this file and the documents, and gets its CI, its Dependabot configuration
and the test with its first code. The test is one file, identical in every repository
that runs it: `test/conventions.mjs` in every npm repository, and its counterpart
`tests/test_conventions.py` in the Python repository, which carries the same hashes and
reads the workflows the same way. To change a convention: change it in every repository in
one pass, then update the hashes in the test. A check that only one repository needs goes
in that repository's own tests, never into its copy of the shared test; the one exception
is the Python test's pin of the Python repository's own `audit` steps, which stays there
until a second Python repository gives that job a shared form. One convention per concern;
where two answers were equally defensible, the one most repositories already used was
chosen.

The npm test uses `node:test` and Node's built-in modules, and nothing it has to install
for itself. What it reads with TypeScript's own parser, it reads through the `typescript`
package the repository installed (and `expo`, for a config that extends
`expo/tsconfig.base`): in a repository with a TypeScript config it fails until they are
installed, and says what to do, rather than skip, since a skipped check reads as a passed
one. A repository with no TypeScript config needs neither. It lists the repository's files
through git where a work tree is rooted at the repository, and reads them off the disk
otherwise (a `git archive` extract, a downloaded ZIP), leaving out `node_modules` and
dot-directories. Both tests read a workflow as the block YAML these files are written in,
and refuse every other spelling YAML allows (a flow mapping `{ ... }`, a quoted or complex
key, an anchor, alias or tag, a list at its key's own indent, a plain value carried onto a
second line), because a check that reads one spelling is blind to another that GitHub runs
the same.

## Scripts (`package.json`)

| Script | Definition | Where |
| --- | --- | --- |
| `test` | the unit suite: no browser, no network; the runner stays per repository | all |
| `typecheck` | `tsc --noEmit` (Next.js: `next typegen && tsc --noEmit`; a workspace root: `npm run typecheck --workspaces`) | every TypeScript repository |
| `lint` | `eslint .` (a workspace root without a config of its own: `npm run lint --workspaces`) | every repository with an ESLint config |
| `test:conventions` | `node --test test/conventions.mjs` | all |
| `check` | `lint && typecheck && test && test:conventions`, omitting what the repository lacks — the local gate before a push (a Python repository's gate is `ruff check .` then `pytest -q`) | all |
| `test:e2e` | the end-to-end suite, self-contained: it builds, serves and drives what it needs (a browser suite everywhere but notenote, whose suite walks the built server over HTTP) | every repository with one |
| `test:all` | `test && test:e2e` plus any other suites the repository has | every repository with `test:e2e` |
| `start` | the dev server (Expo: `expo start`; static apps: the serve script) | Expo, static |
| `dev` / `build` / `start` | `next dev` / `next build` / `next start` | Next.js |
| `android` / `ios` / `web` | `expo start --android` / `--ios` / `--web` (tvsham's app: `expo run:android` / `expo run:ios`, and no web) | Expo |

`check` is exactly the scripts of the set the repository has, as `npm run lint`,
`npm run typecheck`, `npm test` and `npm run test:conventions` joined by `&&`, so the first
failure stops it. No script in the set ends a failure as a success (`|| true`, `|| exit 0`,
a trailing `; true`). npm runs with its own defaults: there is no tracked `.npmrc`, where
`script-shell` or `offline` would make every script, or the audit, pass. An old script
name is kept as a one-line alias (`"e2e": "npm run test:e2e"`) so nothing that names it
breaks. CI runs the individual scripts, never `check`, so a failure is attributed to one
step. Repository-specific scripts keep their names.

## Runtime pinning

`.nvmrc` holds `22` in every npm repository; CI reads it (`node-version-file: .nvmrc`);
`engines.node` is `>=22` (a tighter lower bound is allowed when the code needs it). No
`packageManager` field. Python: `requires-python = ">=3.10"`, `.python-version` holds
`3.12`, CI tests 3.10 and 3.12.

## Lint and format

- No formatter. One `.editorconfig`, identical everywhere: UTF-8, LF, final newline,
  trailing whitespace trimmed (not in Markdown), two-space indent, four for Python.
- ESLint 9 flat config, `eslint .`, warnings visible but not fatal.
  - Expo: `eslint-config-expo/flat` at the SDK-pinned version from
    `expo/bundledNativeModules.json`, the shared `eslint.config.js` (build output
    ignored, Node globals for scripts and plugins, Jest globals for tests, the React
    Compiler readiness rules `react-hooks/refs` and `react-hooks/set-state-in-effect`
    at `warn`, `react/no-unescaped-entities` off).
  - Next.js: the create-next-app composition (`eslint-config-next/core-web-vitals` +
    `typescript`), overrides only for documented exceptions.
  - Node workspaces: `typescript-eslint` recommended, one config per workspace.
  - Static apps and the extension: no ESLint; their notes forbid tooling.
  - Python: `ruff check .` with `select = ["E4", "E7", "E9", "F"]` spelled out in
    `pyproject.toml` (ruff's own default set, pinned so CI and laptops agree) and
    `target-version = "py310"`, and nothing that narrows what it checks: no `exclude`,
    `include`, `ignore` or `extend`, per-file ignores only of whole rule codes in named
    files, and no `ruff.toml`. pytest's configuration is `testpaths = ["tests"]` in the
    same file and nothing else, and there is no `pytest.ini`, `tox.ini` or `setup.cfg`.
- tsconfig: Expo apps extend `expo/tsconfig.base` with `strict: true` and `types` for the
  test runner where it needs them; hand-written configs use `strict`, `target: ES2022`,
  `skipLibCheck`, `esModuleInterop` and `noEmit`, with one exception: a config that a
  `build` script compiles with (`tsc -p`, a Node server building `dist`) emits, so it
  leaves `noEmit` off, and the `typecheck` script runs a `noEmit` config that extends it.
  `noUncheckedIndexedAccess` is on in every TypeScript project, workspaces included: every
  `tsconfig.json` and `tsconfig.<name>.json`, every config a `typecheck` script names, and
  every config those reference, each read the way `tsc` reads it (`extends` and all). An
  index that can miss is handled as one, and a non-null assertion is kept for an index the
  code beside it has already bounded. A flag reaches only the files its project includes,
  so every tracked TypeScript file is a root file of a project that `npm run typecheck`
  runs `tsc` over, and every typecheck script is one the test can follow: `tsc --noEmit`
  with at most one `-p` and no other option (an option on the command line overrides the
  config), `next typegen`, or at a workspace root `npm run typecheck` over `--workspaces`
  or named `--workspace` directories, joined by `&&`. Plain `tsc` does not build the
  projects a solution-style config (`files: []` with `references`) references, so a file
  reached only through one is type-checked by nothing.

## CI

At most two workflow files: `.github/workflows/ci.yml`, `name: CI`, and `pages.yml` where
the repository deploys to GitHub Pages; no other. Triggers: `push` on every branch,
`pull_request`, `workflow_dispatch`, and a weekly `schedule` with one cron,
`"17 6 * * 1"` (Mondays, 06:17 UTC). A `concurrency` group per ref
(`ci-${{ github.ref }}`, `cancel-in-progress: true`) cancels superseded runs; on the
default branch the weekly run shares that group with pushes, and whichever of the two is
cancelled, the other tests the branch's newest commit. In `ci.yml`, `permissions: contents:
read` at the top and nowhere else, so no job holds a write permission. Every action is
pinned to a commit SHA with its tag in a comment, and every job in `ci.yml` states its
`timeout-minutes`.

Nothing lets a job or a step pass red. A job in `ci.yml` has `runs-on`, `timeout-minutes`
and `steps`, and a `name` or a `strategy` where it needs one (the Python repository's
matrix), and nothing else: no `if:`, no `continue-on-error`, no `env:`, no permissions of
its own (a Pages job's keys are below). A step, in any workflow, has its `run` or its
`uses`, and any of `name`, `id`, `with`, `env` and `working-directory`: no `continue-on-error`,
no `shell:`, and no `if:` but `if: failure()` on a step that uploads what a failed run
left behind. There is no `env:` or `defaults:` at the top of a workflow, and a step's
`env:` sets its own variables, never one that changes how npm, Node, Python or the shell
runs (`npm_config_*`, `NODE_OPTIONS`, `PYTHON*`, `PYTEST_*`, `BASH_ENV`, `PATH` and the
like): `npm_config_script_shell` makes every `npm run` pass, `npm_config_offline` makes the
audit report nothing, and `PYTEST_ADDOPTS=--collect-only` makes pytest run nothing.

The schedule is there because nothing else runs CI on a tree nobody pushes to. GitHub runs
a schedule from the default branch's workflow file only, which is `main` once the owner has
created it from this work and made it the default; from then on an advisory published
against an unchanged lockfile turns `audit` red within a week without a push, and so does a
build that rots with no one pushing (an end-to-end walk that has started to flake, a base
image or toolchain that moved). The minute is not `0`: GitHub's documentation says a
scheduled run can be delayed at times of high load, that high load times include the start
of every hour, and that under enough load some queued jobs may be dropped. In a public
repository GitHub disables a schedule after 60 days without repository activity; the
Actions tab turns it back on.

The jobs: `check` in every repository with code; `audit` in every npm repository with a
lockfile and in none without one, and in the Python repository; others only when they need
a different toolchain (Docker, packaging, a network-bound vendor check). The end-to-end
suite is a step of `check`, not a job of its own: it needs no other toolchain.

The `check` job has `timeout-minutes: 20` and starts with exactly these steps, in this
order, each after the two actions a bare `run:`, with nothing between them:

```yaml
- uses: actions/checkout@<sha> # v4
- uses: actions/setup-node@<sha> # v4
  with:
    node-version-file: .nvmrc
    cache: npm            # only with a lockfile
- run: npm ci             # only with a lockfile
- run: npm run lint       # if the script exists
- run: npm run typecheck  # if the script exists
- run: npm test
- run: npm run test:conventions
```

The next step builds or bundles the app: an Expo app's `npx expo export --platform …` for
the platforms it ships to (with `working-directory` where the app is a workspace), a
Next.js app's `npm run build`; a static app has none. After it, in whatever order the
repository needs, come its other suites, a browser install where its end-to-end suite
drives one (`npx playwright install --with-deps chromium`, after, in a repository without
a lockfile, the pinned `npm install --no-save --no-package-lock --ignore-scripts
playwright@<version>`), and `npm run test:e2e` where the script exists, once in the file,
with at most a `name:` and an `env:` beside it. `npm test` is invoked plainly: GitHub sets
`CI=true`, which Jest and the Expo CLI both read. A repository without a lockfile has no
`npm ci` and no cache. The Python repository's `check` runs over a matrix of exactly
`"3.10"` and `"3.12"`, which its setup-python reads, and starts with checkout, setup-python,
the project's install, `ruff check .`, `pytest -q` and `python tests/test_conventions.py`,
with nothing between them; every other setup-python reads `.python-version`. The last runs
the conventions test again on its own, as `npm run test:conventions` does in an npm
repository: under pytest a setting such as `addopts = "--collect-only"` collects the test
and runs none of it, and nothing inside the test can see that from there.

The `audit` job is exactly this, and `npm audit` appears nowhere else in the file:

```yaml
audit:
  runs-on: ubuntu-latest
  timeout-minutes: 10
  steps:
    - uses: actions/checkout@<sha> # v4
    - uses: actions/setup-node@<sha> # v4
      with:
        node-version-file: .nvmrc
    - run: npm audit --omit=dev --audit-level=high
```

No install step, since the audit reads the lockfile; and no `|| true`, no
`continue-on-error`, no `if:`, because a job that cannot go red gates nothing. It is a job
of its own so that an advisory, which is news about a tree that has not changed, turns
`audit` red on the next run (on the default branch, the weekly one at the latest) and
leaves `check` meaning what it always meant. `--omit=dev` audits what a production install
would install: everything reachable from `dependencies`, `optionalDependencies` and
`peerDependencies`, and nothing reachable only through `devDependencies`. That is the line
`package.json` draws, not the line between what ships and what does not: Expo's bundler,
Metro, arrives through `react-native` and is audited, and so is the PostCSS that Next.js
runs, a dependency of `next`; Tailwind, which collectcollect declares as a devDependency
although it builds the stylesheet, is not, and nor are the test runners, the linters and
`typescript`; a library copied into the tree from a package is audited only when that
package is a dependency (simplacad declares `three` one for that reason). Leaving the
development tree out keeps test runners and linters from holding the gate red; it is also
this gate's blind spot, and Dependabot's updates are what move those packages. `high`
because a moderate advisory whose only fix npm can offer is a major downgrade of `expo`
would otherwise hold every Expo repository red with nothing to do. The Python repository's
`audit` job installs a hash-pinned `pip-audit` and audits the declared dependencies twice:
at the newest versions their ranges resolve to, and at the declared floors.

A GitHub Pages deploy is `pages.yml`, triggered by `push` on `main` and by
`workflow_dispatch`, with workflow-level `permissions: contents: read` and two jobs.
`build` has no key but `runs-on`, `timeout-minutes` and `steps`, so no permission of its
own; it checks out with `persist-credentials: false`, sets up Node from `.nvmrc`, runs
`npm ci` (with a lockfile), then `npm test` (or `npm run test:all`), then the export or
assembly, then `upload-pages-artifact`, so a red suite stops the upload. `deploy` needs
`build`, alone holds `pages: write` and `id-token: write`, has no other key but
`runs-on`, `timeout-minutes` and its `environment`, and runs nothing but
`actions/deploy-pages`: the job that can publish executes no code from the repository. A
deploy needs `main` to exist and Pages to be enabled with GitHub Actions as its source,
and GitHub offers the manual run only for a workflow file the default branch carries (from
which it can then run another branch's copy).

## Dependabot

`.github/dependabot.yml`: `npm` (or `pip`) and `github-actions`, weekly,
`open-pull-requests-limit: 5`, a `dev-dependencies` group for minor and patch updates
of development dependencies; one `npm` entry per workspace.

## Documents

Every repository has `README.md`, `LICENSE`, `SECURITY.md`, `REVIEW.md`, `CLAUDE.md`,
`CONVENTIONS.md`, `.gitignore` and `.editorconfig`; every repository with code adds
`.github/dependabot.yml` and `.github/workflows/ci.yml`, an npm repository `.nvmrc`, the
Python repository `.python-version`. `SECURITY-AUDIT.md` records the audit where one ran.
`CLAUDE.md` is the instruction file; where a tool regenerates `AGENTS.md`, `CLAUDE.md`
starts with `@AGENTS.md` and carries the hand-written notes below it, and every
`CLAUDE.md` has a `## Conventions` section pointing here. `CHANGELOG.md` and `PRIVACY.md`
are kept where they exist. No CODEOWNERS, PR or issue templates: one owner.

`REVIEW.md` is each repository's own record, with one shared part: the block from the
line `### Status of the shared items` up to the line `### A hardened workflow to copy`
is the same text in every repository whose review has the shared list, and the
conventions test pins it by hash. A note about one repository goes in that repository's
own status section, not in the shared block.

README skeleton: `# Name`, a one-paragraph pitch, the domain sections, then
`## Running it` (install, start, platform variants, with `### Deploy` or
`### Native builds` beneath), `## Development` (the check commands, the e2e suite, one
sentence on what CI runs) and `## Project layout`. `## License` is optional and spelled
like the file.

`LICENSE` begins `MIT License`; `"license": "MIT"` in `package.json`; `license = "MIT"`
and `license-files = ["LICENSE"]` in `pyproject.toml`.

## .gitignore

The stack's template block (create-expo-app, create-next-app, or `node_modules/`,
`.DS_Store`, `*.log` for static apps), then `# project` lines, then editors
(`.vscode/`, `.idea/`), then `.claude/settings.local.json`, and last, verbatim:

```
# Secrets: ignore every .env variant, but keep the documented template.
.env*
!.env.example
```

## .claude

Every repository that installs dependencies (an npm lockfile, or a Python project) has
`.claude/settings.json` with a `SessionStart` hook, `.claude/hooks/session-start.sh`, that
installs them when the session runs in Claude Code on the web (`CLAUDE_CODE_REMOTE=true`)
and is a no-op elsewhere; the Python form creates or reuses `.venv`.
`.claude/settings.local.json` is ignored.

## Expo native configuration (`app.json`)

`app.json` states every key the config test pins, even at its default, so the file and
the test say the same thing; `__tests__/appConfig` (or the repository's equivalent) runs
`expo config --type introspect` and asserts it.

- Splash through the `expo-splash-screen` plugin; SDK 57 ignores the top-level `splash`.
- `expo-system-ui` installed wherever `userInterfaceStyle` is set (Android needs it).
- On SDK 57, no `newArchEnabled` and no `android.edgeToEdgeEnabled` (both left the
  schema; edge-to-edge is mandatory).
- `android.predictiveBackGestureEnabled: false`, `ios.supportsTablet` and `orientation`
  explicit, `web.bundler: "metro"` wherever there is a `web` block.
- `android.allowBackup` explicit, with the reason in the config test: `false` where data
  must not leave the device or nothing worth restoring is stored, `true` where the store
  is the user's own record.
- Every app blocks the template's `android.permission.SYSTEM_ALERT_WINDOW` (the dev-menu
  overlay; the debug source set re-declares it). An app with no network code also blocks
  `android.permission.INTERNET` and the storage and media permissions no module needs, and
  carries `plugins/withDebugInternet.js` so a development build can still load its bundle.
- `@types/node`, where a test needs it, follows the pinned Node major.
- `eas.json`: `cli.version ">= 16.0.0"`, `appVersionSource: "remote"`, production
  `autoIncrement: true`. Adaptive icon with foreground, background and monochrome
  assets, generated by the repository's icon script where it has one. `scheme` only
  where the app handles a URL.

## User-facing settings

The settings contract: the same decisions, made once, in every app that has a
preference to store. Each app pins its own keys, rows and enum tables in a
`settings-contract` test, so a renamed key or a dropped row fails before it orphans a
user's data.

- **Storage keys** are `<app>.<record>.v<N>`: the app's own established prefix, the
  record, an integer version. A key is renamed only when a defect earns it (a collision,
  no version, no namespace); a prefixed, versioned key with another separator is kept
  and listed in the contract test, because a rename for spelling puts every user through
  a migration for nothing.
- **Migration**, when a key does change: read NEW; if present, delete OLD (on native or
  non-shared storage) and stop; if absent, read OLD, write NEW verbatim, and delete OLD
  only after the write succeeded. Both present means NEW wins. The copy carries bytes,
  not judgement: validation stays at the read boundary, and a record the app cannot
  parse is still the user's only copy. On a shared web origin OLD is never deleted.
- **Validate on read.** One React-Native-free and DOM-free module per app holds the
  enum tables as `Record<Union, true>` (so a missing member fails the type check),
  looks them up by own property only (`has`), and exposes `cleanX(raw, fallback)` per
  stored record with a type-of-default fallback per field; every read site goes through
  it. Its test walks `Object.getOwnPropertyNames(Object.prototype)` as candidate values,
  built with `JSON.parse` so `__proto__` is an own key, and the test must fail when
  `has` is changed to `in`.
- **Theme**: `system | light | dark`; the system value `null` resolves to dark
  (`system === 'light' ? 'light' : 'dark'`). An app with one palette has no theme row
  and pins `userInterfaceStyle` to that palette in its config test. An app whose schemes
  are not a light/dark pair names its own set instead, with no `system` value to resolve,
  and pins that set in its contract test.
- **Sound** and **Vibration**: two independent switches, each only where the app
  produces that feedback; a module-level flag set by the settings provider gates every
  call.
- **Reduce motion**: `system | on | off`; `system` reads the platform
  (`AccessibilityInfo.isReduceMotionEnabled` and its change event; `prefers-reduced-motion`
  on the web). A native call that rejects, or a web page without `matchMedia`, means
  `false`. A row only where the app has decorative motion.
- **Colour-blind assistance** keeps each app's own mechanism; the row's hint reads
  "… for colour-blind players."
- **Confirmations**: an action is confirmed if and only if it destroys data the app
  cannot restore from inside itself. Two buttons, cancel is the safe default, the
  destructive button is named with its verb. React Native apps use one helper that
  calls `window.confirm` on the web and `Alert.alert` elsewhere, because
  react-native-web's `Alert.alert` is a no-op; web apps use `window.confirm`.
- **Reset to defaults**: confirmed; resets the settings record only, never progress,
  stats, purchases or a library, and preserves the onboarding flag.
- **About**: app name, version (from `expo-constants`, `package.json`, a pinned constant
  tested against `package.json`, or the extension manifest), one sentence of what the
  app does, the MIT licence and source link, and one privacy sentence that is true.
- **Onboarding flag** lives inside the settings record.
- **Accessibility floor**: every pressable carries a role, and a label when its content
  is not text; selectable items carry their selected state; switches carry the row's
  label; on the web, icon-only buttons carry `aria-label` and toggles `aria-pressed`.
