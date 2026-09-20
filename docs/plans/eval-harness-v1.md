# Plan: `jev eval`, an evaluation harness for a saved rubric (v1)

This is an implementation plan meant to be executed step by step, in order, with a commit after
each step. Every decision that could go two ways has been made here; do not reopen them while
building. Where the plan says "exactly", the wording or number is part of the contract and the
tests should pin it.

## Why

The README tells the reader three times that the hard calls are theirs: the noul threshold, the
confidence bar for automation, the model. Yet `jev run` sends one state at a time and there is no
way to make those calls with data. `jev eval` runs a saved `.jev` page over many labelled states and
reports how the rubric did, so the threshold and the confidence gate can be read off a table instead
of guessed.

## What already exists and must be reused, not rewritten

| Need                        | Reuse                                                            | Where                                    |
| --------------------------- | ---------------------------------------------------------------- | ---------------------------------------- |
| Load a page or request body | `headless.load`, `headless.sendable`                             | `src/repl/headless.ts`                   |
| Send a request              | `Client.systemOne`, retries, `Retry-After`, `AbortSignal`        | `src/typesafe/client.ts`                 |
| Decode a cached body        | `decodeSystemOne`, `makeSystemOneResponse`                       | `src/typesafe/responses.ts`              |
| Offline answers             | `headless.mockAnswers`                                           | `src/repl/headless.ts`                   |
| Predicted values            | `isYes`, `roundedLevel`, `answerConfidence`                      | `src/typesafe/responses.ts`              |
| Cost before sending         | `cost.estimate`, `cost.priceEstimate`, `cost.priceUsage`         | `src/repl/cost.ts`                       |
| Table rendering             | `line`, `span`, `dim`, `bold`, `padEnd`, `padStart` (as in cost) | `src/tui/style.ts`, `src/repl/format.ts` |
| Error text                  | `errorLines` + `linesText`                                       | `src/repl/format.ts`                     |
| CLI flag parsing            | `parseOptions` in `cli.ts` (extend it)                           | `src/cli.ts`                             |
| CLI tests with a fake API   | the `a live call` block, `createServer` on 127.0.0.1             | `test/cli.test.ts`                       |

## Repo conventions to follow

- **No runtime dependencies.** `package.json` has none and that stays so.
- **Node 18.17 must still run the built package.** Do not use `Array.prototype.toSorted`,
  `Object.groupBy`, `Set.prototype.union`, `Promise.withResolvers` or `Array.prototype.findLast`.
  `crypto.createHash`, `structuredClone` and `Array.prototype.at` are fine.
- **`src/repl/evaluate.ts` is pure.** No `node:` imports, no `process`. `test/core.test.ts` walks the
  module graph from `src/core.ts` and fails otherwise. Everything that touches files, hashes or
  the environment lives in `src/cli.ts`.
- **Strict TypeScript** with `noUncheckedIndexedAccess`: index results are `T | undefined`, handle
  them.
- **Doc comments are prose**, one or two sentences saying why, in the voice of the existing files.
  Read `src/repl/headless.ts` and `src/repl/cost.ts` first and match them.
- **Prettier** at 100 columns, double quotes, trailing commas. `npm run lint` checks Markdown too.
- **Do not bump the version.** A test ties `package.json`, `package-lock.json` and
  `src/typesafe/constants.ts` together; releases are a separate step. Add a changelog entry under
  a new `## Unreleased` heading instead.
- **Commit messages** are one sentence in the imperative, no prefix, like the existing history
  ("Let a session be run without a terminal").

## The contract

### Command line

```text
jev eval [page] --cases <file> [options]
```

- `page` is a `.jev` page or a request body, or `-` / nothing for stdin, exactly as the other
  subcommands. Only its questions and `@model` are used; its state is ignored, because the cases
  carry the states.
- `--cases <file>` is required. `-` reads the cases from stdin, which is a usage error (exit 2)
  when the page also comes from stdin, with the message exactly:
  `the page and the cases cannot both come from stdin.`
- New flags: `--cases <file>`, `--concurrency <n>` (integer ≥ 1, default 4),
  `--cache <dir>`, `--max-cost <dollars>` (number > 0), `--min-accuracy <0-1>`.
- Existing flags that apply: `--model`, `--threshold` (default 0.5), `--price`, `--timeout`,
  `--mock`, `--json`.
- `--state` is a usage error for `eval`, exactly: `--state does not apply to eval: the cases carry
the states.`
- `--max-cost` without rates (no `--price` and no `JEV_PRICE`) is a usage error, exactly:
  `--max-cost needs rates: pass --price <in>/<out> or set JEV_PRICE.`

Exit status:

| Code | When                                                                                                                                                                                                 |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Every case was answered and every bar was met                                                                                                                                                        |
| 1    | A file could not be read; the page or the cases did not parse; the cost preflight refused; any case errored or came back without an expected answer; any scored question fell below `--min-accuracy` |
| 2    | The command line did not parse                                                                                                                                                                       |

### The cases file

JSON Lines: one JSON object per non-blank line. Blank lines are skipped. Anything else on a line is
an error reported as `cases line N: <message>` and the run exits 1 before anything is sent.

```json
{"id": "t-001", "state": "Stripe has been failing for 3 days, I'm losing sales", "expect": {"is_urgent": true, "department": "technical", "frustration": 2}}
{"state": {"subject": "Invoice question", "body": "Can I get a copy of last month's invoice?"}, "expect": {"department": "billing", "is_urgent": false}}
```

- `state` is required and may be any JSON. An empty string, `null`, `{}` or `[]` is an error
  (`isEmptyValue` from `src/json.ts` decides).
- `expect` is required, an object with at least one key. Every key must name a question on the
  page. A key naming a `raw` question is an error: raw questions cannot be scored.
- `id` is optional and must be a string when present. In reports a case is named `case N` where
  N is its 1-based line in the cases file (the same number the `cases line N:` errors use, so it
  survives blank lines), followed by ` (id)` when it has one. The JSON report's `"case"` field is
  that line number too.
- Expected values, by the question's kind:
  - **noul**: a JSON boolean. Anything else is an error.
  - **choice**: a string that is one of the question's option labels, compared exactly.
  - **score**: an integer from 0 to `levels.length - 1`, or a string equal to one level's text,
    compared as `textOf(level) === value` with `textOf` from `src/json.ts`. Store it as the
    level index. Two levels with the same text is not an error; the first wins.
- Questions on the page that a case does not mention are still asked (the request is the whole
  page) but are not scored for that case.

### Predictions

- noul: `isYes(answer, threshold)`.
- choice: `answer.choice`.
- score: `roundedLevel(answer)`. The weighted `score` is the headline number everywhere else in
  the REPL, so the level it rounds to is what gets scored. Also report "within one" so a rubric
  that is off by a neighbour is visible.

### Metrics

Per noul question, over the cases that expect it:

- A threshold sweep at `0.1, 0.2, …, 0.9`, plus the chosen `--threshold` when it is not one of
  those, sorted ascending. At each threshold: `tp, fp, fn, tn`, accuracy `(tp+tn)/n`, precision
  `tp/(tp+fp)` (undefined when `tp+fp` is 0), recall `tp/(tp+fn)` (undefined when `tp+fn` is 0),
  F1 `2tp/(2tp+fp+fn)` (0 when the denominator is 0).
- **Brier score**: mean of `(p - y)²` with `y` 1 for true and 0 for false.
- **Best threshold**: the sweep row with the highest F1; ties go to the lowest threshold.
- The question's **accuracy** for `--min-accuracy` is its accuracy at the chosen threshold.

Per choice question:

- **Accuracy**: fraction predicted equal to expected.
- **Confusion matrix**: rows expected, columns predicted, both in the page's option order.
  A predicted label not among the options (the model answered something else) gets an extra
  final column `other`.
- **Confidence gate**: at cuts `0, 0.2, 0.4, 0.6, 0.8`, the coverage (fraction of cases with
  `confidence >= cut`) and the accuracy among those (undefined when none).

Per score question:

- **Exact**: fraction where the rounded level equals the expected level.
- **Within one**: fraction where `|rounded - expected| <= 1`.
- **MAE**: mean of `|rounded - expected|`.
- **Confidence gate** as for choice, with exact accuracy as the accuracy.
- The question's accuracy for `--min-accuracy` is `exact`.

Rounding for display: the text report prints every rate and probability with `toFixed(2)`; the
JSON report keeps full precision. An undefined precision, recall or gated accuracy prints as `·`
in the text report and is `null` in the JSON report.

Totals:

- `cases`, `answered` (cases that returned every expected answer), `errors` (cases that threw or
  came back missing an expected answer).
- Tokens: when every answered case carried `usage` with both counts, sum them and price them with
  the rates. Otherwise fall back to the summed `cost.estimate` per case and mark the line with `≈`
  and the words `estimated, nothing was counted`, mirroring `headless.usageText`.

### Text report

Written to stdout. Mirror the spacing of `costLines`: two spaces of indent, columns padded. This is
the shape, with the numbers made up; `*` marks the chosen threshold.

```text
  is_urgent    noul    40 cases · Brier 0.11
    threshold   acc   prec   rec    f1
    0.10        0.62  0.55   1.00   0.71
    0.20        0.70  0.61   1.00   0.76
    0.50 *      0.85  0.80   0.89   0.84
    0.60        0.88  0.86   0.89   0.87
    0.90        0.72  1.00   0.44   0.62
    best f1 at 0.60

  department   choice  40 cases · accuracy 0.78
    confidence ≥   coverage  accuracy
    0.00           1.00      0.78
    0.20           0.95      0.79
    0.40           0.80      0.88
    0.60           0.55      0.95
    0.80           0.30      1.00
    confusion, rows expected, columns predicted
                billing  technical  sales
    billing     12       2          0
    technical   3        14         1
    sales       1        2          5

  frustration  score   40 cases · exact 0.65 · within one 0.95 · mae 0.40
    confidence ≥   coverage  exact
    0.00           1.00      0.65
    ...

  case 7 (t-007): Timeout  The request did not complete within 10000 ms.
  case 12: no answer came back for department

  40 cases · 38 answered · 2 errors
  4812 in / 3120 out tokens · $0.0041
```

When `--min-accuracy` is set and a question falls below it, one more line per such question, to
stderr, exactly: `jev eval: <name> accuracy 0.65 is below 0.80.`

In mock mode print, to stderr, the same warning `jev run` prints:
`Simulated answers: deterministic noise, not judgement. Set TYPESAFE_API_KEY for real ones.`

### JSON report (`--json`)

```json
{
  "model": "jev-latest",
  "threshold": 0.5,
  "cases": 40,
  "answered": 38,
  "errors": [{ "case": 7, "id": "t-007", "message": "..." }],
  "questions": {
    "is_urgent": {
      "kind": "noul",
      "cases": 40,
      "brier": 0.112,
      "accuracy": 0.85,
      "best": { "threshold": 0.6, "f1": 0.87 },
      "sweep": [
        {
          "threshold": 0.1,
          "tp": 1,
          "fp": 1,
          "fn": 1,
          "tn": 1,
          "accuracy": 0.5,
          "precision": 0.5,
          "recall": 0.5,
          "f1": 0.5
        }
      ]
    },
    "department": {
      "kind": "choice",
      "cases": 40,
      "accuracy": 0.78,
      "labels": ["billing", "technical", "sales"],
      "confusion": [
        [12, 2, 0],
        [3, 14, 1],
        [1, 2, 5]
      ],
      "gate": [{ "confidence": 0, "coverage": 1, "accuracy": 0.78 }]
    },
    "frustration": {
      "kind": "score",
      "cases": 40,
      "exact": 0.65,
      "withinOne": 0.95,
      "mae": 0.4,
      "gate": [{ "confidence": 0, "coverage": 1, "accuracy": 0.65 }]
    }
  },
  "usage": { "inputTokens": 4812, "outputTokens": 3120, "estimated": false, "cost": 0.0041 }
}
```

Undefined precision, recall and gated accuracy are `null`. `cost` is absent when there are no
rates. When a confusion matrix has an `other` column, `labels` ends with `"other"` and every row has
that extra entry.

### Cost preflight (live mode only)

Before the first request: for every case, clone the session, set its state, and sum
`cost.estimate(clone, model)`. Print one line to stderr:

```text
jev eval: 40 cases, ≈ 9600 in / 6240 out tokens, ≈ $0.0082 at $0.20/$1.00 per Mtok
```

Without rates the line stops after the tokens. With `--max-cost` and a total above it, print to
stderr exactly `jev eval: refusing to send: ≈ $0.0082 is above --max-cost $0.0050.` and exit 1
having sent nothing. Use `cost.usd` for the dollar formatting.

### Response cache (live mode only)

`--cache <dir>` makes a run repeatable without paying twice. The key is the SHA-256 hex of the
compact request body, `compact({ state, model, questions })`, which is what `session.requestJson`
prints minus the whitespace; build it with `compact` from `src/json.ts`, not by hand. The file is
`<dir>/<key>.json` holding the raw response text as it arrived. Create the directory with
`mkdirSync(dir, { recursive: true })`. Read before sending; write only after a successful decode.
A hit is decoded with `decodeSystemOne(text)` and wrapped with `makeSystemOneResponse(model, usage,
answers, raw, { status: 200, headers: {}, attempts: 0 })`. Mock mode never touches the cache.

### Concurrency

`--concurrency <n>` workers pull cases off a shared index. Results are stored by case index so the
report order is the file order whatever finished first. A case that throws records
`linesText(errorLines(e))` trimmed as its error message and the run goes on; no single failure
aborts the run. The client's own retry policy handles 429 and 5xx per call; v1 adds no shared
backoff.

## Module design

### `src/repl/evaluate.ts` (new, pure, exported as `evaluate` from both entry points)

```ts
/** One labelled state: what to judge, and what the rubric should say about it. */
export interface Case {
  /** 1-based line in the cases file, for messages. */
  readonly line: number;
  readonly id?: string;
  readonly state: Json;
  /** Question name → expectation, already checked against the session's questions. */
  readonly expect: Readonly<Record<string, Expectation>>;
}

export type Expectation =
  | { readonly kind: "noul"; readonly yes: boolean }
  | { readonly kind: "choice"; readonly label: string }
  | { readonly kind: "score"; readonly level: number };

/** Parse JSON Lines into cases, checking every expectation against `session`. */
export function parseCases(text: string, session: Session): Parsed<Case[]>;

/** What one case's request came back as. */
export type Outcome =
  | { readonly ok: true; readonly answers: readonly Answered[]; readonly usage?: Usage }
  | { readonly ok: false; readonly error: string };

/** Send every case through `ask`, at most `concurrency` at a time; results are in case order. */
export function run(
  session: Session,
  cases: readonly Case[],
  ask: (session: Session) => Promise<Outcome>,
  concurrency: number,
): Promise<Outcome[]>;

export interface Report { ... } // the JSON report's shape, with numbers unrounded

/** Score the outcomes against the cases. */
export function report(
  session: Session,
  cases: readonly Case[],
  outcomes: readonly Outcome[],
  options: { model: string; threshold: number; rates: Rates | undefined },
): Report;

/** The text report, as lines the terminal and the web can both draw. */
export function reportLines(report: Report): Line[];

/** The JSON report, ready for `pretty`. */
export function reportJson(report: Report): Json;

/** Questions whose accuracy is below `bar`, for --min-accuracy. */
export function belowBar(report: Report, bar: number): Array<[name: string, accuracy: number]>;

/** The preflight estimate: tokens summed over every case, priced when rates are known. */
export function preflight(
  session: Session,
  cases: readonly Case[],
  model: string,
  rates: Rates | undefined,
): { cases: number; inputTokens: number; outputTokens: number; cost: Cost | undefined };
```

`Answered` comes from `headless.ts`. `run` is where the concurrency lives; it uses nothing but
`Promise`. Keep the per-kind metric functions internal but unit-tested through `report`.

### `src/repl/headless.ts`

Add `["eval", "run a page over a file of labelled cases and score the answers"]` to `COMMANDS`
and `"eval"` to `Command`. Nothing else changes here; the eval logic lives in `evaluate.ts` so that
`headless.ts` stays about one shot.

### `src/cli.ts`

- Extend `Options` with `cases?: string; concurrency: number; cache?: string; maxCost?: number;
minAccuracy?: number`. Extend `FLAGS_WITH_VALUES` and `parseOptions` for the new flags, with
  the validation messages in the contract.
- In `runCommand`, after `loaded`, branch on `command === "eval"` into a new `runEval` function
  in `cli.ts`. Keep `runEval` under about a hundred lines by pushing logic into `evaluate.ts`.
- `runEval` order: validate flags that only make sense together (`--state`, `--max-cost`) → read
  and parse cases → build `ask` (mock, or live with optional cache) → preflight (live only) →
  `run` → `report` → print → decide exit code.
- The live `ask`: clone the session, set the state, look in the cache, else
  `client.systemOne(state, questions, { model, timeoutMs })`, then `headless.liveAnswers` and
  `response.usage`. Wrap in try/catch and return `{ ok: false, error }`.
- The mock `ask`: `{ ok: true, answers: headless.mockAnswers(clone) }`, no usage.

### `src/core.ts` and `src/index.ts`

`export * as evaluate from "./repl/evaluate.js";` and the types `Case`, `Expectation`,
`Outcome`, `Report`. The namespace is `evaluate`, not `eval`, because `import { eval }` is a
syntax error in strict-mode modules even though `export * as eval` is legal; the subcommand is
still `jev eval`.

### `web/`

Out of scope for v1. Do not touch it.

## Steps

Each step ends with `npm run lint && npm run typecheck && npm test` green and one commit.

### Step 1: cases

1. Create `src/repl/evaluate.ts` with `Case`, `Expectation`, `parseCases`.
2. Tests in a new `test/evaluate.test.ts`, with a fixture page holding one noul, one choice with
   options `billing`, `technical`, `sales`, and one score with three levels:
   - parses two well-formed lines, one with an object state and one with an `id`;
   - skips blank lines and numbers `line` by the file line, not the case count;
   - rejects: a line that is not JSON; a line that is not an object; a missing `state`; an
     empty state; a missing or empty `expect`; an unknown question; a raw question; a
     non-boolean for a noul; an unknown label for a choice; a score outside the range; a score
     string matching no level. Each error message starts with `cases line N:`.
   - accepts a score given as the level's text and stores the index.

### Step 2: metrics

1. Add `Outcome`, `Report`, `report`, `belowBar`.
2. Tests, each with hand-computed numbers written into the assertion:
   - noul: four cases with probabilities `0.9, 0.7, 0.3, 0.1` expected `true, true, false, true`
     at threshold 0.5 give `tp 2, fp 0, fn 1, tn 1`, accuracy 0.75, precision 1, recall 2/3, F1
     0.8; Brier `(0.01 + 0.09 + 0.09 + 0.81) / 4`. The sweep contains 0.5 exactly once when it
     is the chosen threshold and contains 0.55 when that is chosen instead.
   - noul: precision is `undefined` when nothing was predicted positive.
   - noul: best threshold picks the lowest on an F1 tie.
   - choice: the confusion matrix orders labels as the page does; an unexpected predicted label
     lands in `other`.
   - choice and score: the gate's coverage drops as the cut rises and its accuracy is
     `undefined` when no case passes.
   - score: exact, within one and MAE from three cases; a score answer whose rounded level is
     off by one counts for within one and not for exact.
   - a case whose outcome is an error, or lacks an expected answer, is listed in `errors` and
     excluded from every metric; `answered` counts the rest.
   - usage is summed when complete and marked estimated when one case lacks it.
   - `belowBar(report, 0.8)` names the questions under the bar with their accuracy.

### Step 3: runner

1. Add `run`.
2. Tests:
   - with concurrency 2 and an `ask` that resolves after a short `setTimeout`, the number of
     in-flight calls never exceeds 2 (count in the fake) and every case is asked once;
   - results come back in case order even when later cases finish first;
   - an `ask` that rejects becomes an `{ ok: false }` outcome and does not stop the others;
   - concurrency larger than the number of cases is fine.

### Step 4: rendering

1. Add `reportLines`, `reportJson`, `preflight`.
2. Tests: the text of `linesText(reportLines(r))` contains the header line for each kind
   (`noul`, `choice`, `score`), the `*` on the chosen threshold, the `best f1 at` line, the
   `confusion` heading, the totals line and the `≈` marker when estimated. `reportJson` matches
   the schema above with `toMatchObject`, and `JSON.stringify` of it round-trips.

### Step 5: exports

1. Export from `src/core.ts` and `src/index.ts`.
2. `test/core.test.ts` must still pass unchanged: it proves `evaluate.ts` pulled in nothing from
   `node:`.
3. Add one assertion to `scripts/smoke.mjs`: `parseCases` on one good line returns `ok: true`.

### Step 6: the command

1. `headless.COMMANDS`, `Command`, `Options`, `parseOptions`, `runEval` as designed above.
2. Tests in `test/cli.test.ts`, mock side, using `--mock` and a temp cases file:
   - `jev eval page.jev --cases cases.jsonl --mock` exits 0, prints all three question headers
     and the totals line, and warns about simulated answers on stderr;
   - `--json` prints a JSON document with `questions` and `cases`;
   - a cases file with a bad line exits 1 with `cases line N:` on stderr;
   - `--state` exits 2 with the exact message; `--max-cost 1` without rates exits 2;
     `--concurrency 0` exits 2; `--cases -` with the page on stdin exits 2;
   - `--min-accuracy 1` exits 1 and names a question on stderr. Mock answers are deterministic,
     so build the case's expectation from `mock.answer` first and expect the opposite.
3. Tests in the `a live call` block, replacing the fixed-body server with one that reads the
   request body and answers `is_urgent` at `0.9` when the state contains `urgent` and `0.1`
   otherwise, `usage` `{ input_tokens: 10, output_tokens: 5 }`:
   - four cases, two of each, all expected correctly: exit 0, `accuracy 1.00`, `40 in / 20 out
tokens`, one request per case (count them in the server);
   - the same run with `--cache <tmpdir>` twice: the second run makes zero requests and prints
     the same report;
   - `--max-cost 0.000001 --price 0.20/1.00` exits 1 with `refusing to send` and the server saw
     no requests;
   - a server that returns 400 for one state (400 is not retried, so the test does not wait out
     the client's backoff): that case appears under errors, exit 1, the other cases are still
     scored.
4. `--help` lists `eval` and the new flags.

### Step 7: docs

1. README: a subsection under "Outside" titled `Scoring a rubric` with the command, the cases
   format, the three kinds of expectation, the exit codes, and one example report of about ten
   lines. Add `eval` to the list of subcommands in the `jev run` code block. Add a line to the
   `jev-repl/core` example: `evaluate.parseCases(text, session)`.
2. `CHANGELOG.md`: a `## Unreleased` section above `## 0.2.0` with one `### Added` bullet in the
   voice of the existing entries.
3. Do not add a lesson to the track in v1.

### Step 8: finish

`npm run lint`, `npm run typecheck`, `npm test`, `node scripts/smoke.mjs` after `npm run build`,
and `npm run build:web` to prove the web bundle still builds with the new core export. Then push
the branch. Do not open a pull request unless asked.

## Out of scope for v1, on purpose

- Expectations inside the sketch notation. The notation is shared with the Rust REPL; the cases
  file keeps it untouched.
- Shared rate limiting across workers, progress output, resuming an interrupted run.
- Comparing two models in one run. `--model` twice with `--json` and `diff` covers it for now.
- The web REPL.
- Any metric not listed above.

## Definition of done

- All eight steps committed on the branch, CI green on Node 22 and 24, the runtime smoke green.
- `jev eval` on the `triage` preset saved as a page and a ten-line cases file prints the report
  in mock mode with no key set, and the same command with `--json | jq .questions.is_urgent.best`
  prints a threshold.
- `test/core.test.ts` unchanged and passing.
- No new dependency, no version bump, no change under `web/`.
