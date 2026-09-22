# Conventions shared by the platteration repositories

This file is identical in every platteration repository and is pinned by the
conventions test (`test/conventions.mjs`, or `tests/test_conventions.py` in a Python
repository), which fails when the file, `.editorconfig` or the repository's shape drifts.
To change a convention: change it in every repository in one pass, then update the
hashes in the test. One convention per concern; where two answers were equally
defensible, the one most repositories already used was chosen.

## Scripts (`package.json`)

| Script | Definition | Where |
| --- | --- | --- |
| `test` | the unit suite: no browser, no network; the runner stays per repository | all |
| `typecheck` | `tsc --noEmit` (Next.js: `next typegen && tsc --noEmit`) | every TypeScript repository |
| `lint` | `eslint .` | every repository with an ESLint config |
| `test:conventions` | `node --test test/conventions.mjs` | all |
| `check` | `lint && typecheck && test && test:conventions`, omitting what the repository lacks — the local gate before a push (a Python repository's gate is `ruff check .` then `pytest -q`) | all |
| `test:e2e` | the browser suite, self-contained: it builds and serves what it needs | every repository with one |
| `test:all` | `test && test:e2e` plus any other suites the repository has | every repository with `test:e2e` |
| `start` | the dev server (Expo: `expo start`; static apps: the serve script) | Expo, static |
| `dev` / `build` / `start` | `next dev` / `next build` / `next start` | Next.js |
| `android` / `ios` / `web` | `expo start --android` / `--ios` / `--web` | Expo |

An old script name is kept as a one-line alias (`"e2e": "npm run test:e2e"`) so nothing
that names it breaks. CI runs the individual scripts, never `check`, so a failure is
attributed to one step. Repository-specific scripts keep their names.

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
    `target-version = "py310"`.
- tsconfig: Expo apps extend `expo/tsconfig.base` with `strict: true` and `types` for the
  test runner where it needs them; hand-written configs use `strict`, `target: ES2022`,
  `skipLibCheck`, `esModuleInterop`, `noEmit`. `noUncheckedIndexedAccess` is opt-in per
  repository.

## CI

One workflow, `.github/workflows/ci.yml`, `name: CI`; other workflows only for deploys.
Triggers: `push` on every branch, `pull_request`, `workflow_dispatch`. A `concurrency`
group per ref cancels superseded runs. `permissions: contents: read` at the top.
One job, `check`, `timeout-minutes: 20`, steps in this order, each a bare `run:`:

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
- <build or bundle step>  # Expo: expo export for the platforms the app ships to
                          # Next.js: npm run build; static: none
- run: npx playwright install --with-deps chromium   # repositories with test:e2e
- run: npm run test:e2e
```

Actions are pinned to a commit SHA with the tag in a comment. `npm test` is invoked
plainly: GitHub sets `CI=true`, which Jest and the Expo CLI both read. A repository
without a lockfile has no install step and no cache. A second job only when it needs
a different toolchain (Docker, packaging, a network-bound vendor check).

A GitHub Pages deploy is a separate `pages.yml`: `push` on `main` plus
`workflow_dispatch`; workflow-level `permissions: contents: read`; a `build` job
(`persist-credentials: false`, `npm ci`, `npm test`, the export, `upload-pages-artifact`)
and a `deploy` job that alone holds `pages: write` and `id-token: write`.

## Dependabot

`.github/dependabot.yml`: `npm` (or `pip`) and `github-actions`, weekly,
`open-pull-requests-limit: 5`, a `dev-dependencies` group for minor and patch updates
of development dependencies; one `npm` entry per workspace.

## Documents

Every repository has `README.md`, `LICENSE`, `SECURITY.md`, `REVIEW.md`, `CLAUDE.md`,
`CONVENTIONS.md`, `.gitignore`, `.editorconfig`, `.github/dependabot.yml` and
`.github/workflows/ci.yml`; npm repositories add `.nvmrc`, Python adds
`.python-version`; `SECURITY-AUDIT.md` records the audit where one ran. `CLAUDE.md` is
the instruction file; where a tool regenerates `AGENTS.md`, `CLAUDE.md` starts with
`@AGENTS.md` and carries the hand-written notes below it, and every `CLAUDE.md` has a
`## Conventions` section pointing here. `CHANGELOG.md` and `PRIVACY.md` are kept where
they exist. No CODEOWNERS, PR or issue templates: one owner.

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
  and pins `userInterfaceStyle` to that palette in its config test.
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
