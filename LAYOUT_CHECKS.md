# CSS and phone-frame regression checks

Run from the repository root (Node 22+). These packages are development tools;
the deployed site still has no package runtime or build step.

```sh
npm ci
npm run check:css
npm test
npx playwright install chromium
npm run test:browser
python -m pytest -q
```

On Windows PowerShell use `npm.cmd` / `npx.cmd` if execution policy blocks
the PowerShell shims. On Linux CI, install browser system dependencies with
`npx playwright install --with-deps chromium`. Playwright starts and stops its
own static server on 127.0.0.1:4173; leave that port free. Service workers are
blocked in tests so a cached release cannot hide a checkout regression.

## Intentional contract

- At 375, 390 and 430px, the frame fits the viewport. At 768 and 1280px it
  remains centered and 430px wide. Measurements use the border box: the
  global `box-sizing: border-box` includes the two wide-screen borders in
  the 430px cap. Both system light and dark themes are exercised.
- The document does not overflow horizontally; the bottom Primary tab bar
  stays aligned with the frame, visible and clickable. Main content and the
  final footer links can scroll clear of it.
- Plan, Places, Calendar and Clubs open by tab, direct URL and refresh;
  primary form/search/date controls work. Sources, About and Mugar details
  also support direct navigation and refresh. Only local static data is used.
- Fixed-date Mugar tests retain the verified October 25–31 schedule, 2 AM
  overnight boundaries, special overrides and unknown/unpublished dates.
  No hours logic or datasets change as part of these layout checks.

`tools/check-css.mjs` uses PostCSS's strict parser for every `.css` under
`web/` and `tools/`, plus explicit unresolved-conflict-marker detection.
Pass additional file paths to validate fixtures. It intentionally enforces
syntax rather than formatting. `tests/css_validation.test.mjs` creates and
removes temporary fixtures for unclosed comments/blocks, extra closing braces
and all conflict-marker forms; it never damages the application stylesheet.
A parseable comment can still swallow valid CSS, so rendered assertions are
also required. Parsing alone cannot guarantee a usable layout.

## Motion check history

The untracked scratch `drive/dynamic_check.mjs` waited for
`.planner-skyline` and asserted `sky-rise`/`sky-glide`. Commit `a11fe7a`
intentionally replaced that planner SVG with a local Boston photo and kept
the SVG only as an image-error fallback. Commit `a0f4cd7` later repaired the
merge-split comment; `1db4349` was the initial fetched main baseline for this
work, not the earlier reported `8c4c105`. Another session advanced main during
testing; this checkout was then synchronized to `3e1ca2c`, retaining its club
calendar and Liquid Glass changes. That upstream revision had already removed
the stray `=======` marker found by the initial CSS check.

The maintained replacement is `tests/browser/motion.spec.js`: it checks
the current loaded hero and its real error fallback, screen/list entrance
cascades, completion of entrances, Places hover/focus feedback, chart-bar
stagger, playback fill/playing feedback, changed-count cues, activity selection,
scroll reveals and reduced motion. It no longer requires deleted planner
artwork or a hidden desktop nav marker. Do not run the obsolete scratch check
as a release gate. No external scratch file is modified by this branch.

## Diagnose a failed run

```sh
npx playwright show-report
npx playwright show-trace test-results/<failed-test>/trace.zip
```

`test-results/` retains failure screenshots and traces; the HTML report links
them with viewport/theme, measured frame geometry and browser-error JSON.
The CI browser job uploads both directories as `browser-failure-<run>-<attempt>`
for seven days. Expected static-mode API-probe and deployment-only version-file
404s are the only permitted missing resources; unexpected page/console/resource
errors fail the layout checks. Test output directories are gitignored.

## CSS merge checklist

1. Resolve each conflict using the current phone-shell and shared-interaction
   intent; never concatenate both sides or remove a comment terminator blindly.
2. Search for `<<<<<<<`, `=======`, `>>>>>>>` and diff3 ancestor markers.
3. Run `npm run check:css` and `npm test`; do not rely on balanced brace counts
   or on the browser silently recovering from invalid CSS.
4. Run `npm run test:browser`. Inspect the screenshot, trace and measured widths
   when it fails; do not loosen frame assertions to accept a desktop shell.
5. Review the small CSS diff and confirm Mugar tests still pass. Keep the frame
   and bottom navigation at every width, as required by `rule.md`.

## Deployment gate

`tests.yml` is callable as a reusable workflow and still checks pushes/PRs.
`pages.yml` calls it on the same revision; its deploy job `needs: checks`
waits for Python, JS/CSS and Chromium smoke tests. A failed check prevents
deployment, including manual main deployments. Pages retains its normal
permissions and `github-pages` environment. This branch prepares the workflow
only; it does not run CI, publish the site or change repository protections.
