# Working rules for coding agents

These rules apply to every automated coding agent that works in this repository, whatever
tool runs it. They were written after a review of a large batch of agent pull requests
across this account, and every rule comes from something that actually went wrong. Read this
file first, then the repository's own notes (CLAUDE.md, README.md and SECURITY.md where they
exist). Those add repository-specific conventions; they never relax anything here.

## 1. Know the baseline before you change anything

- Run the repository's own checks (tests, typecheck, lint, build, browser suite) before you
  edit, and keep the result. If something is already red, say so in the PR. Do not fix it
  silently and do not report it as yours.
- Find the default branch and the open pull requests. Branch from the default branch. Do not
  build on another agent's unmerged branch unless asked to.
- If a check cannot run where you are (no device, no network, no Xcode), name the check and
  the reason. "Could not verify" is an acceptable answer. "Verified" when you did not is not.

## 2. Change only what was asked, and disclose everything you changed

- Do the whole task, not the easy parts. If part of it is blocked, finish the rest and say
  exactly what was left out.
- Every change in observable behaviour goes in the PR description, including intentional
  ones and ones you consider improvements. Changes that were left out and surprised the
  owner: an editor gesture removed, a default that changed on one platform but not the
  other, an update call that now throws where it used to average, an export that now refuses
  where it used to clip, autosave that stopped writing on plain HTTP.
- Do not rewrite or reformat code you are not changing. A reviewer must be able to see your
  change in the diff.
- Do not add configuration, dependencies, workflows or documents the task did not call for.
  Audit prose belongs in the PR description, not in the repository root.

## 3. Claim only what the code does

- Read what you call. Library upgrades move and remove APIs, and a call that compiles can
  still throw at runtime. When a shim or mock stands in for a real module during tests, the
  real module is untested: say so, and test it another way.
- Every guard you add must be reachable. Do the arithmetic before writing a bounds check. A
  value read from two bits cannot exceed a four-entry table; an input capped upstream at
  12,000 characters cannot reach a 100,000-byte check below it. Dead guards are not defence
  in depth. They hide where the real limit is.
- Documentation states what the code enforces, no more. If you write "a plugin cannot shadow
  a builtin command", every builtin command must be protected, including the ones handled in
  a switch statement rather than the registry you checked.
- Do not call a change a fix unless the thing was broken. If an expectation was already
  correct, leave it alone.
- Hygiene is not a security fix. Filtering reserved keys out of data the app wrote itself, or
  hardening a test-only static server, may be worth doing, but label it as hygiene and name
  no threat you cannot demonstrate.

## 4. Tests: never make one weaker to make it pass

- A failing test is a finding, not an obstacle. Find the cause. If the test itself was wrong,
  say why in the PR and show that the corrected expectation is at least as strict as before.
- Do not remove an assertion, widen a tolerance, delete a check of a feature that still
  exists, replace an exact count with a nearest-match lookup, or drop a retry-count check
  unless the PR explains why the old assertion was wrong. "Flaky" is a symptom to diagnose,
  not a reason.
- Run the old test against your new code before rewriting it. If it passes, keep it.
- Every bug fix and every new behaviour gets a test that fails without the change. For an
  invariant, break the code deliberately and confirm the suite goes red.
- Lints and static checks must cover new files. When you extract code into a new module, add
  it to every list those checks walk: escaping lints, dependency-order tests, front-end lists.

## 5. Safety nets degrade, they never refuse

- Backup, export, restore, recovery, autosave and "save to device" are what people rely on
  when something has already gone wrong. They warn about a bad item and skip it. They do not
  refuse the whole operation. One missing photo file must never block a backup of everything.
- Persistence must not stop silently. If something you depend on is unavailable (a
  secure-context API, a lock manager, a permission), fall back with a visible warning or
  refuse loudly at startup. Never let someone work for an hour and lose it on reload.
- A health check reports the thing it names. "Database ok" means a query ran, not that a
  file exists.
- A rare destructive action such as restore must not depend on invisible background state
  such as a scheduled price refresh.
- Anything that can lose or corrupt user data is the highest severity, above every other
  finding, whatever the task was.

## 6. Visual and platform changes are verified on the platform

- A styling change is verified by looking at it, on each platform it ships to, in every
  theme and every purchasable cosmetic. If you cannot run the app on a platform, say so and
  list the states you did not see.
- Check the states, not only the resting look: selected, hovered, focused, disabled, pressed,
  error, empty. A border colour that overrides the selection ring, or a text shadow that
  vanishes on one platform, is a functional regression, not a visual nit.
- Contrast is measured, not guessed. Text and controls meet WCAG AA in every theme. Game
  pieces are distinguishable from every board they can be placed on.
- When the palette changes, change everything that carries it: splash screen, app icon
  background, chart surfaces, and the README's description of the look.

## 7. One repository, one PR, written for that repository

- Do not paste a PR body, style guide, commit message or test note from one repository into
  another. Text that refers to another project's boards, cards, tests or files is a defect.
- When the same change goes into several repositories, verify it in each one separately and
  report each one's own results.

## 8. Security

- Follow SECURITY.md and CLAUDE.md exactly. Their rules came from real findings.
- Never commit secrets, tokens or real credentials, including in tests, fixtures,
  screenshots or lockfiles.
- Never weaken CSP, CORS or cookie flags to make a feature work; make the feature work under
  them. An inline event handler is dead under `script-src 'self'`.
- Rate limits and quotas key on something the client cannot choose, and the PR says how
  they behave behind a reverse proxy.
- Every check you add names the threat it stops. If you cannot name one, it is not a
  security fix (see section 3).

## 9. The pull request description

Use these headings, in this order, and fill in every one:

- **What changed.** The user-visible outcome, in plain sentences.
- **Behaviour changes.** Every observable change, intentional or not, including defaults,
  error cases and platform differences. Write "none" only when it is true.
- **Verified.** Each command you ran and its result (counts, exit status), and what you
  looked at by eye, on which platform.
- **Not verified.** What you could not run or see, and why.
- **Follow-ups.** Known gaps you left, one line each.

A description that could apply to a different PR is wrong. Do not report CI results you
have not read.

## 10. Never

- Merge, approve or close a pull request, rebase someone else's branch, or force-push.
- Disable, skip, quarantine or delete a test to get green.
- Push an empty commit or close and reopen a PR to re-run CI.
- Add a dependency, a build step or a service when the repository's notes say the project
  deliberately has none.
