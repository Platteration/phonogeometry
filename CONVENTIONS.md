# Conventions shared by the platteration repositories

This file is identical in every platteration repository, and pinned by the conventions test,
which fails when this file, `.editorconfig`, the shared status block in `REVIEW.md`, the
working rules in `AGENTS.md`, the audit gate or the repository's shape drifts. The test is one
file, identical in every repository that runs it: `test/conventions.mjs` in every npm
repository, and its counterpart `tests/test_conventions.py` in the Python repository, which
carries the same hashes and reads the workflows the same way. To change a convention: change
it in every repository in one pass, then update the hashes in the test. A check that only one
repository needs goes in that repository's own tests, never into its copy of the shared test;
the one exception is the Python test's pin of the Python repository's own `audit` steps,
which stays there until a second Python repository gives that job a shared form. One
convention per concern; where two answers were equally defensible, the one most repositories
already used was chosen.

The npm test uses `node:test` and Node's built-in modules, and nothing it has to install
for itself. What it reads with TypeScript's own parser, it reads through the `typescript`
package the repository installed (and `expo`, for a config that extends
`expo/tsconfig.base`): in a repository with a TypeScript config it fails until they are
installed, and says what to do, rather than skip, since a skipped check reads as a passed
one. A repository with no TypeScript config needs neither. It lists the repository's files
through git where a work tree is rooted at the repository, and reads them off the disk
otherwise (a `git archive` extract, a downloaded ZIP), leaving out `node_modules` and every
dot-directory but `.github` and `.well-known`, which hold files the tests read. Both tests read
a workflow as the block YAML these files are written in,
and refuse every other spelling YAML allows (a flow mapping `{ ... }`, a quoted or complex
key, an anchor, alias or tag, a list at its key's own indent, a plain value carried onto a
second line), because a check that reads one spelling is blind to another that GitHub runs
the same. The npm test reads `nginx.conf` the same way, as the blocks and directives nginx
reads, and refuses what it cannot read. It also imports the audit gate (below, "CI"), runs
each of its rules over made-up reports, and runs the gate itself against a stand-in npm, offline.

## Scripts (`package.json`)

| Script | Definition | Where |
| --- | --- | --- |
| `test` | the unit suite: no browser, and no network beyond loopback (the kit's self-test and the API's tests open loopback sockets); the runner stays per repository | all |
| `typecheck` | `tsc --noEmit` (Next.js: `next typegen && tsc --noEmit`; a workspace root: `npm run typecheck --workspaces`; a second `tsc --noEmit -p <config>` joined by `&&` where a config checks the kit's or another copied JavaScript with `checkJs`) | every TypeScript repository |
| `lint` | `eslint .` (a workspace root without a config of its own: `npm run lint --workspaces`) | every repository with an ESLint config |
| `test:conventions` | `node --test test/conventions.mjs` | all |
| `check` | `lint && typecheck && test && test:conventions`, omitting what the repository lacks — the local gate before a push (a Python repository's gate is `ruff check .` then `pytest -q`) | all |
| `test:e2e` | the end-to-end suites of the app, the built website and the host configs, self-contained, joined by `&&`: it builds, serves and drives what it needs in a browser — the app, the built website under its headers, and the host configs in real servers where the repository runs them (notenote's walks the built server over HTTP first; the Python repository's is `pytest -q e2e`, outside `testpaths`). A browser suite of another kind keeps a script of its own and runs in `test:all` and CI (simplacad's `test:offline`, abientnoiser's `test:musical` and `test:textures`) | every repository with one |
| `test:all` | `test && test:e2e` plus any other suites the repository has | every repository with `test:e2e` |
| `build:web` | `node scripts/build-web.mjs`, in the Expo app's own package | Expo |
| `start` | the dev server (Expo: `expo start`; static apps: the serve script) | Expo, static |
| `dev` / `build` / `start` | `next dev` / `next build` / `next start` | Next.js |
| `android` / `ios` / `web` | `expo start --android` / `--ios` / `--web` (tvsham's app: `expo run:android` / `expo run:ios`, and no `web`; its website is `npm run build:web --workspace apps/mobile`) | Expo |

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
    ignored, every folder the native and website builds write among it, Node globals for
    scripts and plugins, Jest globals for tests, the React Compiler readiness rules
    `react-hooks/refs` and `react-hooks/set-state-in-effect` at `warn`,
    `react/no-unescaped-entities` off).
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
  - Shared JavaScript a repository carries (the kit, the audit gate) lints under every
    stack's configuration unchanged: it reaches host globals through `globalThis`.
- tsconfig: Expo apps extend `expo/tsconfig.base` with `strict: true` and `types` for the
  test runner where it needs them; hand-written configs use `strict`, `target: ES2022`,
  `skipLibCheck`, `esModuleInterop` and `noEmit`, with one exception: a config that a
  `build` script compiles with (`tsc -p`, a Node server building `dist`) emits, so it
  leaves `noEmit` off, and the `typecheck` script runs a `noEmit` config that extends it.
  `skipLibCheck` holds in every project, Expo's included (its base sets it).
  `noUncheckedIndexedAccess` is on in every TypeScript project, workspaces included: every
  `tsconfig.json` and `tsconfig.<name>.json`, every config a `typecheck` script names, and
  every config those reference, each read the way `tsc` reads it (`extends` and all). An
  index that can miss is handled as one, and a non-null assertion is kept for an index the
  code beside it has already bounded. A flag reaches only the files its project includes,
  so every tracked TypeScript source is a root file of a project that `npm run typecheck`
  runs `tsc` over, and every typecheck script is one the test can follow: `tsc --noEmit`
  with at most one `-p` and no other option (an option on the command line overrides the
  config), `next typegen`, or at a workspace root `npm run typecheck` over `--workspaces`
  or named `--workspace` directories, joined by `&&`. Plain `tsc` does not build the
  projects a solution-style config (`files: []` with `references`) references, so a file
  reached only through one is type-checked by nothing. A declaration file (`*.d.ts`) is not
  a source for this rule: under `skipLibCheck` tsc checks nothing in one, so it is held to
  nothing, and a repository with no TypeScript of its own carries the kit's declarations
  without installing TypeScript.

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

Every job of every workflow runs on one named image, `runs-on: ubuntu-24.04`, written as
that plain value: not `ubuntu-latest`, which GitHub moves to a new release on a date of its
own (Ubuntu 26.04 from 2026-10-19, where Playwright 1.56 has no Chromium build and
`npx playwright install --with-deps chromium` fails), and not a list, a matrix value or an
expression, which the test could not read. The image is `RUNNER` in the test. Moving it is
one change, in every workflow of every repository in one pass: before it, each repository
asks its own Playwright whether it has a build for the new release (`npx playwright install
--dry-run chromium` with `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE` set to it), raises Playwright
where not, and measures its policy's Permissions-Policy again under the newer Chromium.

Every official action is at a major whose runtime is Node 24 (`runs.using` in its
`action.yml` at the tag, or for a composite action that of the actions it runs; GitHub is
retiring Node 20): `actions/checkout` v5 or later, `setup-node` v5, `setup-python` v6,
`upload-artifact` v6, `upload-pages-artifact` v5 and `deploy-pages` v5; an official action the
test does not list fails until its floor is added, in every repository. The test reads the
major from the tag comment, which Dependabot writes with the SHA: an offline test cannot ask
GitHub which tag a SHA is, so it also refuses every commit a tag of a Node 20 major points at
(`NODE20_SHAS`, read with `git ls-remote`), whatever its comment says. The owner and the name
are read in any case, as GitHub reads them. A third-party action follows the same rule, applied
by hand, since the test lists no floor for it (collectcollect's `docker/setup-buildx-action` v4
and `docker/build-push-action` v7 are the Node 24 majors). Dependabot proposes the newer pins; a
repository takes them like any other update, and the tag comment says which release a SHA is.

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
- uses: actions/checkout@<sha> # v5 or later
- uses: actions/setup-node@<sha> # v5 or later
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
the platforms it ships to (with `working-directory` where the app is a workspace; the
website is either among them or built by `npm run test:e2e`, which builds the site it
drives), a Next.js app's `npm run build`; a static app has none. After it, in whatever
order the repository needs, come its other suites, a browser install where its end-to-end
suite drives one, and `npm run test:e2e` where the script exists, once in the file, with at
most a `name:` and an `env:` beside it. The browser install is exactly `npx playwright
install --with-deps chromium` (in a repository without a lockfile, after the pinned `npm
install --no-save --no-package-lock --ignore-scripts playwright@<version>`; in the Python
repository, `python -m playwright install --with-deps chromium`), in no other form: a version
after `playwright`, another flag or a second space is another form, and fails. `npm
test` is invoked plainly: GitHub sets `CI=true`, which Jest and the Expo CLI both read. A
repository without a lockfile has no `npm ci` and no cache. The Python repository's `check`
runs over a matrix of exactly `"3.10"` and `"3.12"`, which its setup-python reads, and
starts with checkout, setup-python, the project's install, `ruff check .`, `pytest -q` and
`python tests/test_conventions.py`, with nothing between them; every other setup-python
reads `.python-version`. The last runs the conventions test again on its own, as `npm run
test:conventions` does in an npm repository: under pytest a setting such as `addopts =
"--collect-only"` collects the test and runs none of it, and nothing inside the test can see
that from there.

The `audit` job is exactly this, and no workflow runs `npm audit` of its own:

```yaml
audit:
  runs-on: ubuntu-24.04
  timeout-minutes: 10
  steps:
    - uses: actions/checkout@<sha> # v5 or later
    - uses: actions/setup-node@<sha> # v5 or later
      with:
        node-version-file: .nvmrc
    - run: node .github/audit/npm-audit.mjs
```

`.github/audit/npm-audit.mjs` is the audit gate: one file, identical in every npm repository
with a lockfile and pinned by hash in the conventions test, that uses Node's built-in modules
and npm and installs nothing. It runs `npm audit --omit=dev --json`, which reads the lockfile,
and fails the job on every advisory at `high` or `critical` (or of a severity it does not
know) that `.github/audit/accepted.json` does not accept: what `--audit-level=high` failed on,
less what the list accepts. The list is the repository's own and optional (absent, it accepts
nothing); in an npm repository `.github/audit/` holds the gate and the list and nothing else
(the Python repository keeps its own audit's files there). Each entry accepts one advisory for
one package and has exactly these fields:

```json
{
  "advisory": "GHSA-vfj7-8cjw-p6xm",
  "package": "braces",
  "severity": "high",
  "paths": [
    "expo > @expo/metro > metro-file-map > micromatch > braces",
    "react-native > @react-native/community-cli-plugin > metro > metro-file-map > micromatch > braces"
  ],
  "reason": "why it is accepted: what it is, why there is no fix to take, why it does not reach what ships",
  "expires": "2027-01-11"
}
```

`severity` is the one npm rated it when it was accepted (`high` or `critical`). A route is the
names a dependent declares, from a direct dependency of the root or of a workspace to a copy
npm reports, joined by ` > `; its last name is the package, or the alias a dependent installs it
under. The routes are not examples: every direct dependency from which the lockfile reaches a
reported copy starts one, so the reason is written for each way the package arrives. An entry
stops accepting, and the job goes red, once its date has come; when its date is more than 90
days away (so an acceptance is reviewed at least once a quarter, never parked); when npm rates
the advisory above the severity the entry names (the reason was written for a lesser one); when
the package has a release outside the advisory's range that an installed copy's dependents can
take — newer than that copy, in its major as a caret range reads it (a fix exists: take it, with
an update or an `overrides` entry, then remove the entry); when a route it names is not a chain
of production dependencies in the lockfile that ends at a copy npm reports; when npm reports a
copy no route reaches; when a direct dependency reaches a reported copy and no route starts
there (a new way in, which the reason was not written for); and when npm no longer reports what
it accepts. A release outside the range on a newer major only, which no dependent takes without
moving to that major, is named in the log and holds the entry until it expires, when it is
reviewed with the rest; so does a fix that would come by updating a parent (npm's
`fixAvailable`), which the gate does not read. Routes are checked against the lockfile rather
than npm's report, because which dependents npm marks vulnerable changes from run to run while
the lockfile does not. Anything the gate cannot read (a report, a lockfile, a range, a list of
releases) fails the job rather than passing it, and the log names every acceptance that held.
It is the one way a high advisory is let through, and it lets through only one with no release
outside its range in an installed copy's major: the Expo repositories accept braces (`<=3.0.3`,
GHSA-vfj7-8cjw-p6xm), which arrives through micromatch in build and test tooling (Metro's and
Expo's file maps, and Jest's where React Native's optional Jest preset installs it), and
node-forge (`<=1.4.0`, GHSA-86w9-cpqp-85rv), which arrives through `@expo/cli`'s code signing
(expo-updates manifests, and the signing identities `expo run:ios` reads); neither had a patched
release when they were listed, and neither is in an app bundle or a website.

No install step, since the audit reads the lockfile; and no `|| true`, no
`continue-on-error`, no `if:`, because a job that cannot go red gates nothing. It is a job
of its own so that an advisory, which is news about a tree that has not changed, turns
`audit` red on the next run (on the default branch, the weekly one at the latest) and
leaves `check` meaning what it always meant; for the same reason an entry's expiry and a
newly published fix are checked there, not in `check`. `--omit=dev` audits what a production
install would install: everything reachable from `dependencies`, `optionalDependencies` and
`peerDependencies`, and nothing reachable only through `devDependencies`. That is the line
`package.json` draws, not the line between what ships and what does not: Expo's bundler,
Metro, arrives through `react-native` and is audited, and so is what npm marks
`devOptional` (react-native's optional peer `@react-native/jest-preset` brings `babel-jest`
and its tree into the audit), and the PostCSS that Next.js runs, a dependency of `next`;
Tailwind, which collectcollect declares as a devDependency although it builds the
stylesheet, is not, and nor are the test runners and linters declared as devDependencies, or
`typescript`; a library copied into the tree from a package is audited only when that
package is a dependency (simplacad declares `three` one for that reason). Leaving the
development tree out keeps test runners and linters from holding the gate red; it is also
this gate's blind spot, and Dependabot's updates are what move those packages. `high`
because a moderate advisory whose only fix npm can offer is a major downgrade of `expo`
would otherwise hold every Expo repository red with nothing to do; a high one with no fix at
all is what the accepted list is for. The Python repository's `audit` job installs a
hash-pinned `pip-audit` and audits the declared dependencies twice: at the newest versions
their ranges resolve to, and at the declared floors.

A GitHub Pages deploy is `pages.yml`, triggered by `push` on `main` and by
`workflow_dispatch`, with workflow-level `permissions: contents: read` and two jobs.
`build` has no key but `runs-on`, `timeout-minutes` and `steps`, so no permission of its
own; it checks out with `persist-credentials: false`, sets up Node from `.nvmrc`, runs
`npm ci` (with a lockfile), then `npm test` (or `npm run test:all`), then the export or
assembly, then `upload-pages-artifact` with `include-hidden-files: true` (from v4 the action
leaves out every path that starts with a dot, the site's `.well-known/security.txt` with it),
so a red suite stops the upload. `deploy` needs `build`, alone holds `pages: write` and
`id-token: write`, has no other key but `runs-on`, `timeout-minutes` and its `environment`,
and runs nothing but `actions/deploy-pages`: the job that can publish executes no code from
the repository. A deploy needs `main` to exist and Pages to be enabled with GitHub Actions as
its source, and GitHub offers the manual run only for a workflow file the default branch
carries (from which it can then run another branch's copy). A repository whose default
branch is not yet `main` deploys nothing by itself until the owner creates `main` from this
work (REVIEW.md, item 10); the trigger stays `main`.

## Dependabot

`.github/dependabot.yml`: `npm` (or `pip`) and `github-actions`, weekly,
`open-pull-requests-limit: 5`, a `dev-dependencies` group for minor and patch updates
of development dependencies; in a workspace, one `npm` entry for the root and one for each
workspace.

## Documents

Every repository has `README.md`, `LICENSE`, `SECURITY.md`, `REVIEW.md`, `CLAUDE.md`,
`AGENTS.md`, `CONVENTIONS.md`, `.gitignore` and `.editorconfig`; every repository with code
adds `.github/dependabot.yml` and `.github/workflows/ci.yml`, an npm repository `.nvmrc`, the
Python repository `.python-version`. `SECURITY-AUDIT.md` records the audit where one ran.
`CHANGELOG.md` and `PRIVACY.md` are kept where they exist. No CODEOWNERS, PR or issue
templates: one owner.

`AGENTS.md` holds the working rules every coding agent follows, whatever tool runs it: the
block from the line `# Working rules for coding agents` to the end of its section
`## 10. Never` (which ends at the next heading of level one or two, at a line that opens an
HTML comment, or at the end of the file) is the same text in every repository, and the
conventions test pins it by hash. A tool that writes its own block into `AGENTS.md` (`next
dev` does) keeps it outside that one. `CLAUDE.md` is the instruction file: it starts with
`@AGENTS.md`, or says "Read AGENTS.md first." in its first lines, then carries the
repository's own notes, and every `CLAUDE.md` has a `## Conventions` section pointing here.

`REVIEW.md` is each repository's own record, with one shared part: the block from the
line `### Status of the shared items` up to the line `### A hardened workflow to copy`
is the same text in every repository whose review has the shared list, and the
conventions test pins it by hash. A note about one repository goes in that repository's
own status section, not in the shared block.

README skeleton: `# Name`, a one-paragraph pitch, the domain sections, then
`## Running it` (install, start, platform variants, with `### Deploy` or `### Native builds`
beneath; the website, its hosts and what each needs from its operator go under `### Deploy`, or
under the website section a repository already has: selfreportle's `### The website`, tvsham's
`### Run it as a website`, notenote's `## The website: headers and hosting`),
`## Development` (the check commands, the e2e suite, one sentence on what CI runs) and
`## Project layout`. `## License` is optional and spelled like the file.

`LICENSE` begins `MIT License`; `"license": "MIT"` in `package.json`; `license = "MIT"`
and `license-files = ["LICENSE"]` in `pyproject.toml`.

## .gitignore

The stack's template block (create-expo-app, create-next-app, or `node_modules/`,
`.DS_Store`, `*.log` for static apps), then `# project` lines (the folder the website build
writes among them: `dist-web/`, `/dist/`, `/site/` and the like), then editors (`.vscode/`,
`.idea/`), then `.claude/settings.local.json`, and last, verbatim:

```
# Secrets: ignore every .env variant, but keep the documented template.
.env*
!.env.example
```

## .claude

Every repository that installs dependencies (an npm lockfile, or a Python project) has
`.claude/settings.json` with a `SessionStart` hook, `.claude/hooks/session-start.sh`, that
installs them when the session runs in Claude Code on the web (`CLAUDE_CODE_REMOTE=true`)
and is a no-op elsewhere; the Python form creates or reuses `.venv` and installs `.[dev]`
through it (the browser walk's `.[e2e]` is installed by hand where it is wanted).
`.claude/settings.local.json` is ignored.

## Expo native configuration (`app.json`)

`app.json` states every key the config test pins, even at its default, so the file and
the test say the same thing; `__tests__/appConfig` (or the repository's equivalent) runs
`expo config --type introspect` and asserts it. An `app.config.js` exists only to pass
values the website build needs (`WEB_BASE_URL` into `experiments.baseUrl`, and the like) and
returns app.json's config untouched when none is set, so the introspection sees app.json as
written.

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
  A `*.web.ts(x)` module that Metro bundles into the website alone, beside an inert native
  twin of the same name (the account client of "Integrations"), is not network code of the
  app's: its no-network scan sets aside exactly those modules, holds the twin inert, and the
  INTERNET block stays.
- `@types/node`, where a test needs it, follows the pinned Node major.
- `eas.json`: `cli.version ">= 16.0.0"`, `appVersionSource: "remote"`, production
  `autoIncrement: true`. Adaptive icon with foreground, background and monochrome
  assets, generated by the repository's icon script where it has one. `scheme` only
  where the app handles a URL.

## Website

Every app is also a website, on one model: everything the app does happens in the
visitor's browser (or, for an app that is its own server, in that server), and the host does
the hosting — the headers, the cache lifetimes, the not-found page, and refusing every file
that is not part of the site. tradetrade became a Next.js app after this layer was built: it
sets its headers in code and gains its security.txt with v7; the README's machine-read block,
the safety net and the rest come with its next change.

| Stack | Where the hosting layer lives | What is published |
| --- | --- | --- |
| Expo (battleshiple, chesscheatser, drawdraw, multidcheckers, multidconnect4, sudokuoku, tvsham's `apps/mobile`) | `public/`: `index.html` (the page template, with no policy in it), `guard.js`, `404.html`, `robots.txt`, `.well-known/security.txt`, `_headers`, `_redirects`, `.htaccess`, all of which SDK 57's export copies, dotfiles included; `deploy/nginx.conf` beside it, never published | what `npm run build:web` writes: the export, the policy `<meta>` written into the built pages from `_headers`, the base path prefixed, and every host's configuration, or with `--host` only that host's (battleshiple, chesscheatser, drawdraw, multidconnect4) |
| Static (abientnoiser, phonogeometry, simplacad) and the extension's website (selfreportle, in `web/`) | the repository root (or `web/`): the same files, and `deploy/nginx.conf` | the site's own list of files, copied into a folder by the repository's site script or assembled by `pages.yml`, and nothing else of the checkout |
| Its own server (notenote, collectcollect's two apps, tradetrade: Next.js; randostats: FastAPI) | the code that puts the headers on every response, the not-found page and refusals included, and the README's machine-read block of them | the server, at the root of its own origin |

What every site holds, each in its own tests:

- **One policy, measured.** The Content-Security-Policy and the other headers are one set of
  values, written in every place a host reads them (`_headers`, `.htaccess`,
  `deploy/nginx.conf`, the pages' `<meta>`, which leaves out `frame-ancestors` — a `<meta>`
  cannot carry it — and `upgrade-insecure-requests` where a page can be served over plain
  http, which it would send to an https address nothing answers), or, for an app that is its
  own host, set once in code and printed in the README; a test reads every copy and fails
  when they differ, so a change to one is a change to all. Every source was measured: the
  browser suite serves the built site under the policy sent as a header and fails on any
  violation, page error, console error or request outside the site, and a source is added only
  when that suite shows something real needs it, with the reason in the repository's notes.
  `connect-src` is `'self'` for the site's own `api/` (below) and the origins the app talks
  to, nothing more; Google and Stripe are top-level navigations, which the policy does not
  govern. On Expo the policy is not in `public/index.html`, because `expo start --web`
  serves that template too and its reload socket and error overlay need what the policy
  refuses; react-native-web's own `<style>` needs only the empty string's hash, since it fills
  it through `insertRule`. A static site is served at a sub-path in the suite, as GitHub Pages
  serves a project site; an app that is its own host, at the root of its origin.
- **The site and nothing else.** Where the site ships host configs, nginx and Apache serve
  an allow-list of the site's own paths and answer everything else with the not-found page
  (an app that is its own host refuses in its own code), and a test runs every
  `git ls-files` path through each host's rules. Netlify, which cannot allow-list, refuses by
  name, with `404!` (a rule without `!` does not apply where a file exists), what its published
  folder can hold that is not the site: the host configurations a build did not leave out (and
  `metadata.json`, which a plain `npx expo export` writes), and, in a static app whose `_redirects`
  sits at the repository root and so is read if the checkout itself is published (abientnoiser,
  phonogeometry, simplacad), the repository's own entries; which paths each file names is the
  repository's own decision, held by its own test. Each path's `Cache-Control` comes from one
  `_headers` rule: Netlify and Cloudflare Pages join the values of two rules that match. A
  build script that empties its output folder (the Expo export does) refuses the checkout and
  any folder that holds it, and inside the checkout writes only to the build folders
  `.gitignore` names (battleshiple, chesscheatser, multidcheckers, multidconnect4, sudokuoku) or
  to a folder that is absent, empty or an earlier build of the site (drawdraw); its tests run it
  against a stand-in exporter in a temporary folder.
- **Host configs that load.** The npm conventions test reads every `nginx.conf` and
  `.htaccess` the repository tracks (the Python repository tracks neither; its own host is
  its code) and holds what each was found to need on a real server (nginx 1.24 and Apache
  2.4.58, what Ubuntu 24.04 and its runner ship). nginx: a configuration is named `nginx.conf`
  and includes nothing, so what the test reads is what nginx loads (a header a location takes
  from an included file drops the server block's there, unseen); it asks for HTTP/2 on its
  `listen … 443 ssl http2` lines, never with `http2 on;` (1.25.1 and later; 1.24 refuses the
  whole file); every `server` block sets `server_tokens off`, the port-80 redirect's
  included, so no answer names the version; the TLS server sends
  `Strict-Transport-Security` with `always`; and no `location` adds a header — one that did
  would drop every header of the server block — but `location ^~ /api/`, whose one
  `add_header` repeats the server block's HSTS line and leaves every other header to the
  API. Apache: nothing is wrapped in a section that skips what it holds on a condition of the
  server's configuration (`<IfModule>`, `<IfDirective>`, `<IfDefine>`, `<IfSection>`,
  `<IfFile>`, `<IfVersion>`: a stock Debian or Ubuntu Apache loads neither `mod_rewrite` nor
  `mod_headers`, and a wrapped rule is then skipped without a word, so the folder is served
  with no headers and no allow-list; unwrapped, it is a 500 and a log line), and
  `Strict-Transport-Security` is sent unconditionally, outside every section (`env=HTTPS` is
  set by mod_ssl alone, and `<If "%{HTTPS} == 'on'">` reads the same flag, so behind a proxy
  that ends TLS it was never sent; a browser ignores the header over plain http). The README
  says what the server configuration must give the folder, which no `.htaccess` can set:
  `AllowOverride FileInfo Options`, plus `Indexes` where the file sets `DirectoryIndex` (or
  `AllowOverride All`; without `Indexes` that line is a 500, measured on 2.4.58), the modules
  (`mod_rewrite` and `mod_headers`: `a2enmod rewrite headers`), and `ServerTokens Prod`.
  Reading a file is not running it: where a repository can, its suite loads both into the
  nginx and Apache the runner has and reads every site file and a planted checkout file back.
- **security.txt**, at `/.well-known/security.txt` (in an npm repository the file sits in a
  `.well-known/` folder; the Python repository serves its own from code), tested here: the
  repository's issues page as a `Contact` in every case, listed last, and before it, where the
  repository lists one, its private advisory form (`/security/advisories/new`), both at the
  repository the `Policy` names; an `Expires` that has not passed and is at most a year away
  (the test fails once it lapses: renew it a year at a time); and a `Policy` that is SECURITY.md
  on `main`, the branch the site is published from (`blob/HEAD` follows the default branch,
  which may not carry it). No file states the repository's own name (three package names differ
  from it), so each repository's own website test pins its own addresses. Private vulnerability
  reporting is a repository setting the owner turns on; until it is on, the form reaches
  nothing, and where SECURITY.md asks for a private report it says to open an issue that says
  only that there is a report and how to reach the reporter.
- **The safety net.** A small script the page loads before the app shows a note in place
  of it when one of the site's own files fails to load or the app's script throws before
  the app has reported that it started, and steps back once it has; a `<noscript>` note
  covers a browser with no JavaScript. Whether the note hides the controls (a `no-js`
  class) or covers them (an overlay), and whether it also waits for a first draw, follows
  from whether the page has anything to show without script, and each repository's notes
  say which.

## Integrations

Sign in with Google, a shop through Stripe Checkout and its signed webhook are the
website's, web first: the native iOS and Android builds keep their no-network posture and
their own store seam. Everything is off until the owner sets the variables: with none, and on
a host that runs no function (GitHub Pages), every app looks and behaves as it did before,
and no page draws a Sign-in or Buy control. Where an app sells nothing (collectcollect,
randostats: personal tools with one owner), sign-in is a way past its gate and there is no
shop or webhook.

- **One kit, never edited in place.** Every repository that carries the shared kit carries
  the canonical copy, byte for byte, its `.d.ts` files included, at `server/kit/`, or where
  its stack needs it and says so in CLAUDE.md: tvsham at `apps/server/kit/` (inside the
  server workspace its image, lint, type check and tests walk), collectcollect at
  `packages/core/src/kit/` (the apps reach it only through `packages/core`, which Next
  transpiles). A change is made to the canonical copy and copied to every carrier in one
  pass. The conventions test holds the copy to one hash over its files (`kitHash`: the
  sha256 of every file's `sha256sum` line, in path order — `cd <kit> && find . -type f | sed
  's|^\./||' | LC_ALL=C sort | xargs sha256sum | sha256sum`), refuses a second copy (any
  other `selftest.mjs`, or a folder elsewhere holding three of the kit's modules by name), and
  requires the package that holds the kit to run its self-test from its own `npm test`, reached
  from the root's, as `node --test` and the files it runs with no option beside them (one such as
  `--test-skip-pattern` can run none of its cases and exit 0). The kit is plain ES
  modules with JSDoc and `// @ts-check` and no dependencies; it lints and type-checks under
  each repository's own configuration unchanged. A repository whose stack is not JavaScript
  ports what it needs instead (randostats, Python: the Google part alone) and says so.
- **Same origin.** The API answers under the site's own `api/`: a Cloudflare Pages Function
  (`functions/api/[[path]].js`, with `_routes.json` sending it `/api/*` alone), the kit's Node
  adapter on loopback behind nginx's `location ^~ /api/` (or an Apache virtual host's
  `ProxyPass`, which no `.htaccess` can do), or, for an app with a server of its own, that
  server. `connect-src 'self'` is all the page's policy gains for it.
- **The page.** Where a page talks to the kit, one module makes the requests, to the
  site's own `api/` alone, and leaves only for `api/auth/google/start` or an address that
  starts `https://checkout.stripe.com/`; everything the server says is read field by field
  and drawn as text; a 404, a network error or a body that is not the kit's means nothing is
  drawn, stored or asked again. Only Stripe's signed webhook grants a purchase, and the page
  learns of it from `api/me`. A service worker answers nothing under `api/` and caches none
  of it, navigations included.
- **Tests.** The kit's self-test runs in `npm test`; the app's own API tests (its catalogue
  and entry points, where it sells) run against a fake Google and Stripe handed in as the
  `fetch` the code calls, never a variable that points it at another host; the repository's
  browser suite plays what it offers (sign-in, and where it sells, the purchase, the signed
  webhook, sign-out and deletion) under the site's real policy. `server/kit/README.md` is the
  owner's setup guide.

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
  react-native-web's `Alert.alert` is a no-op, and send a one-button message the person
  must see through the same module (`window.alert` on the web), never through
  `Alert.alert` alone; web apps use `window.confirm`.
- **Reset to defaults**: confirmed; resets the settings record only, never progress,
  stats, purchases or a library, and preserves the onboarding flag.
- **About**: app name, version (from `expo-constants`, `package.json`, a pinned constant
  tested against `package.json`, or the extension manifest), one sentence of what the
  app does, the MIT licence and source link, and one privacy sentence that is true.
- **Onboarding flag** lives inside the settings record.
- **Accessibility floor**: every pressable carries a role, and a label when its content
  is not text; selectable items carry their selected state; switches carry the row's
  label; on the web, icon-only buttons carry `aria-label` and toggles `aria-pressed`.

## What v7 changed, and why nothing is weaker than v6

Every v6 assertion of the conventions tests stands, or is replaced by a stricter one:

- The audit job's step was `npm audit --omit=dev --audit-level=high`; it is now the pinned
  gate, which runs the same audit and fails on the same advisories, less only the ones its
  list accepts, each at the severity npm rated it, with a reason, a route from every direct
  dependency that reaches it, no release outside its range in an installed copy's major, and at
  most 90 days to run; v6 let nothing through and so held seven repositories red with nothing
  to do. The test still allows `npm audit` nowhere else (now: in no workflow step at all, however
  it is spaced) and pins the job step for step.
- `runs-on` was any single runner name; it is now `ubuntu-24.04` exactly, in every job.
- Action pins were any SHA with a tag comment; they are that, at least a Node 24 major by
  the comment, and no commit of a Node 20 major whatever the comment says.
- "Every TypeScript file is type-checked" leaves out declaration files, which `skipLibCheck`
  (now required of every project, Expo's included) already left unchecked.
- Read off the disk (an archive, a ZIP), the npm test listed nothing in a dot-directory; it
  now lists `.github` and `.well-known`, so every rule that reads them holds there too.
- Added: the working rules of AGENTS.md pinned by hash, CLAUDE.md's pointer to them, the
  kit pinned by hash with its self-test in `npm test` (no option beside it, no second copy),
  the browser install's one form, `include-hidden-files` on the Pages upload, `build:web` in
  Expo apps, security.txt, and the nginx and Apache rules above.
