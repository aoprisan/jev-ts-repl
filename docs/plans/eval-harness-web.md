# Plan: the evaluation harness in the web REPL (v1)

This is an implementation plan meant to be executed step by step, in order, with a commit after
each step. Every decision that could go two ways has been made here; do not reopen them while
building. Where the plan says "exactly", the wording is part of the contract.

## Why

`jev eval` answers the question the README asks three times — where to put the threshold, where to
put the confidence gate — and it answers it with a table instead of a guess. Today that answer is
only available to someone who installs Node, saves a page and writes a JSON Lines file. The web
REPL is where most people meet jev, and in mock mode it can run the whole harness offline, with no
key and no money, which is exactly the setting in which someone is trying to learn what a threshold
does.

## Prerequisite

`docs/plans/eval-harness-v1.md` has landed: `evaluate` is exported from `jev-repl/core`, it is
pure, and `npm run build:web` already proves the web bundle can import it. **Do not start this
before that.** Everything below is a view over that module.

## What already exists and must be reused, not rewritten

| Need                    | Reuse                                                          | Where                        |
| ----------------------- | -------------------------------------------------------------- | ---------------------------- |
| Parse and check cases   | `evaluate.parseCases`                                          | `jev-repl/core`              |
| Score, render, gate     | `evaluate.report`, `reportLines`, `reportJson`, `belowBar`     | `jev-repl/core`              |
| Cost before sending     | `evaluate.preflight`, `cost.usd`, `cost.parseRates`            | `jev-repl/core`              |
| Draw styled lines       | `lines(...)` and `h(...)`                                      | `web/src/dom.ts`             |
| The page → a session    | `sketch.parse(...).toSession()`, as `ask()` already does       | `web/src/app.ts`             |
| Live answers            | the `Client` the app already constructs, with `window.fetch`   | `web/src/app.ts`             |
| Offline answers         | `mock.answer`, the same call `ask()` makes per question        | `web/src/app.ts`             |
| Live or not, key, rates | `isLive()`, `state.key`, `state.settings.price` / `.threshold` | `web/src/app.ts`, `store.ts` |
| Status text             | `say(...)`, the footer status line                             | `web/src/app.ts`             |

## Repo conventions to follow

- **No runtime dependencies, no bundler.** The page loads plain ES modules and `jev-repl/core`
  through the import map. Nothing new goes in `<head>`.
- **`web/` is a view.** Nothing here re-implements jev. If a piece of logic wants a unit test, it
  belongs in `src/repl/evaluate.ts`, which has one, and not in `web/src/`.
- **Strict TypeScript** with `noUncheckedIndexedAccess`, checked by `npm run build:web` through
  `tsconfig.web.json`.
- **Prettier** at 100 columns; `npm run lint` checks Markdown and HTML too.
- **Do not bump the version**, and add a changelog entry under `## Unreleased`.
- **Commit messages** are one sentence in the imperative, no prefix.

## Nothing existing changes

This is an addition. The four existing tabs, the preview kinds, the share link, the settings
dialog, the service worker and every existing export behave exactly as before. The one visible
change outside the new panel is the footer's primary button, which becomes the run control while
the eval tab is showing (decision 3) and is untouched on every other tab.

## The contract

### Where it lives

A fifth tab, `Eval`, after `Preview` and before `Learn`, with its own panel. Eval is not a preview
of the page: it has inputs of its own, and it outlives a repaint of the page tab.

The panel, top to bottom:

1. A head row: `cases` label, a `Load file…` button (`<input type="file" accept=".jsonl,.json,.txt">`,
   visually hidden behind the button), `concurrency` (number, 1–6, default 3), `bar` (number,
   0–1, step 0.05, blank for none), and a `Copy JSON` button.
2. A textarea for the cases, one JSON object per line, with the same monospace treatment as the
   page editor.
3. A problems block, hidden when there are none, built exactly like the page's `#problems`.
4. A progress line: `12 / 40 · 2 errors`, and while idle the totals of the last run.
5. The report, drawn with `lines(evaluate.reportLines(report))` into a `.preview`-styled block.

### Running

The footer's primary button reads `Run` on this tab, and `Stop` while a run is in flight. The
`Ask` behaviour it has on the other tabs is unchanged.

A run, in order:

1. Parse the page into a session. No questions, or a page with problems → say what is wrong and
   stop, the way `ask()` does.
2. `evaluate.parseCases(casesText, session)`. A failure fills the problems block with the
   `cases line N:` message and stops; nothing is sent.
3. More than 200 cases → refuse, exactly: `200 cases is as many as this page will run at once.`
4. Live only: show the preflight dialog (below). Mock: skip straight to step 5.
5. Run the cases at `concurrency` at a time, updating the progress line as each finishes.
6. Score with `evaluate.report`, draw with `evaluate.reportLines`, and mark the questions
   `evaluate.belowBar` names when a bar is set.

### The nine decisions that differ from the CLI

1. **Cases come from a textarea, not a file.** The `Load file…` button reads a file with
   `File.text()` and drops it into the textarea, so what runs is always what is visible and
   editable. There is no `-`, no stdin, no path.
2. **No exit codes and no stderr.** Failures are status text and the problems block. `--min-accuracy`
   becomes the `bar` input: when set, each question under it gets its row marked and the status line
   reads exactly `N questions are below the bar.`
3. **Progress and cancel are mandatory**, though the CLI defers them. A run holds one
   `AbortController`; the button becomes `Stop`; the signal is passed as `signal` in the client's
   `CallOptions`, which it already supports. An aborted run keeps the cases that finished and
   reports the rest as not sent. A tab with a run in flight is a tab someone can close, so the run
   lives in module state, not in a closure that a repaint can strand.
4. **Concurrency defaults to 3, not 4**, and is capped at 6: a browser holds about six connections
   to an origin, and the tab is doing its own drawing between them.
5. **No cache in v1.** There is no directory, a reload would empty it anyway, and IndexedDB is its
   own plan. The last report stays in memory so it can be re-read and copied without re-running.
6. **The cost preflight is a dialog, not a flag.** Live runs open it before the first request:
   the case count, `evaluate.preflight`'s token totals, and the price when the settings carry rates,
   with `Send` and `Cancel`. When rates are set and the estimate is above the `stop above $` field,
   `Send` is disabled and the dialog says exactly `that is above the limit in your settings.`
   The CLI's `--max-cost` needing rates becomes the same rule: the limit field is ignored, and
   greyed, when no price is set.
7. **A CORS failure stops the whole run.** The app already recognises it for a single call; forty
   identical network errors are noise. The first failure matching that test aborts the run and says
   what the single-call path says, once, with the remaining cases marked not sent.
8. **Mock mode is the default and is fully offline.** With no key, every case is answered by
   `mock.answer` exactly as the Ask path answers one, the service worker has already precached
   everything it needs, and nothing is sent. The panel says `simulated · nothing is sent` while in
   that mode.
9. **Cases are never stored and never shared.** They are not written to `localStorage` with the
   page, and `share.link` stays page-only: a cases file is the one thing in this app likely to hold
   real customer messages, and the page is already stored on the device. The panel says so, once,
   under the textarea: `Cases stay in this tab. They are not saved and not put in the share link.`

## Module design

### `web/src/eval.ts` (new)

The run loop and nothing else — no DOM, so the panel stays a view and this stays readable.

```ts
export interface Progress {
  readonly done: number;
  readonly total: number;
  readonly errors: number;
}

export interface Run {
  /** Resolves with the outcomes in case order; never rejects. */
  readonly done: Promise<readonly Outcome[]>;
  readonly stop: () => void;
}

/** Ask every case, at most `concurrency` at a time, reporting progress as they land. */
export function start(options: {
  session: Session;
  cases: readonly Case[];
  ask: (session: Session, signal: AbortSignal) => Promise<Outcome>;
  concurrency: number;
  onProgress: (p: Progress) => void;
}): Run;

/** The live `ask`: the app's client, one clone of the session per case. */
export function liveAsk(
  client: Client,
  model: string,
): (s: Session, signal: AbortSignal) => Promise<Outcome>;

/** The offline `ask`: `mock.answer` per question, resolved immediately. */
export function mockAsk(): (s: Session) => Promise<Outcome>;
```

`start` is the browser's counterpart to `evaluate.run`: the same shared-index pool, plus the
progress callback and the abort the CLI does not need. If it grows a second responsibility, that
responsibility belongs in `src/repl/evaluate.ts` instead.

### `web/src/app.ts`

- `Tab` gains `"eval"`; `show` and the nav loop need no other change.
- `State` gains `evalCases: string`, `evalReport: Report | undefined`, `evalRun: Run | undefined`,
  `evalProgress: Progress | undefined`.
- A `drawEval()` beside `drawPreview()`, called from `paint()`.
- The footer button's label and handler switch on `state.tab === "eval"`.

### `web/index.html`, `web/styles.css`

A `<button data-tab="eval">Eval</button>` in `nav.tabs`, a `<section class="panel"
data-panel="eval">` with the elements above, and the preflight `<dialog id="preflight">`. Styles
reuse `.panel-head`, `.field`, `.row`, `.problems`, `.preview`, `.hint` and `.line`; add only what
the progress line needs. No new origins, so the CSP is untouched and `build-web.mjs` re-stamps the
inline hashes as it already does.

## Steps

Each step ends with `npm run lint && npm run typecheck && npm test && npm run build:web` green and
one commit.

### Step 1: the tab

The nav button, the empty panel, `Tab`, `show`, and the footer button's label switching. Nothing
runs yet.

### Step 2: cases in

The textarea, the file button, the 200-case refusal, `evaluate.parseCases` against the current
page, and the problems block. Still nothing is sent.

### Step 3: the runner

`web/src/eval.ts` with `start`, `mockAsk` and `liveAsk`; the progress line; `Stop`. Mock mode
end to end, offline.

### Step 4: the report

`drawEval` rendering `reportLines`, the `bar` input with `belowBar`, and `Copy JSON` copying
`pretty(reportJson(report))` through the existing copy idiom.

### Step 5: live, and the money guard

The preflight dialog, the limit field, the CORS abort, and the live path through the app's client
with the run's signal.

### Step 6: docs

A paragraph under `## On the web` in `README.md` saying the page runs the harness too, and that
without a key it runs it offline. A `## Unreleased` bullet in `CHANGELOG.md`. The lesson track is
not touched.

## Definition of done

- Six steps committed, CI green, `npm run build:web` clean, and the built `site/` loads with the
  network off and runs a ten-case file in mock mode.
- A live run of four cases against a key sends four requests, shows progress, and `Stop` halfway
  leaves a report over the cases that finished.
- The same page and the same cases file give the same numbers here as `jev eval --mock --json` does
  in the terminal. Both call the same `evaluate.report`; if they disagree, the view is wrong.
- No new dependency, no version bump, no change to `src/` beyond what v1 already exported.

## Out of scope for v1, on purpose

- Any scoring logic in `web/`. It goes in `src/repl/evaluate.ts` or it does not go in.
- A cache, in IndexedDB or anywhere else.
- Sharing or saving a report, comparing two runs, comparing two models.
- Per-case drill-down beyond the error list `reportLines` already prints.
- A DOM test harness. Adding one is a decision of its own, and this plan is written so that it is
  not needed: the logic is in core, and core is tested.
