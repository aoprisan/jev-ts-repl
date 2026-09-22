# Plan: compare two pages, write the calibration back, follow a thread (v1)

This is the contract for three additions to `jev eval` and the REPL, written so the Rust twin
(`jev-repl` in `aoprisan/typesafe-ai-rust-sdk`) can be ported from it verbatim. Every decision that
could go two ways has been made here. Where the plan says "exactly", the wording, the number or the
JSON key is part of the contract and a test pins it. Each part landed as one commit on the
TypeScript side, in the order below; port them in the same order, because each builds on the one
before.

1. `jev eval --compare`: two pages over the same cases, with the difference and whether it is real.
2. `@threshold` and `@confidence`: the decision bar written into the page, and `--calibrate` to
   write it from data.
3. `:trend` and `by_turn`: a rubric followed across the turns of a conversation.

## Why

`jev eval` tells you how one page did. The next three questions people ask are: is the new page
better, or did I get lucky; now that I know the threshold, where do I keep it; and when in a
conversation does the rubric notice. Today the answers are `diff` over two JSON reports, a number
copied by hand into code, and re-running `:ask` after every `:turn` while writing the numbers down.

## Conventions (unchanged from `eval-harness-v1.md`)

- No runtime dependencies. Node 18.17 runs the built package.
- `src/repl/evaluate.ts`, `src/repl/sketch.ts`, `src/repl/trend.ts` are pure: no `node:`, no
  `process`. Files, hashes and the environment live in `src/cli.ts` and `src/repl/app.ts`.
- Rates and probabilities print with `toFixed(2)` in text; JSON keeps full precision.
- A value that was never defined prints as `·` in text and is `null` in JSON.
- Numbers written into a page (`@threshold 0.6`) use the shortest representation that reads back
  as the same number: `String(n)` in TypeScript, `format!("{}", n)` for an `f64` in Rust. Both
  print `0.6`, `0.65`, `1` and `0`.
- A signed delta prints as `toFixed(2)` with a `+` in front unless it already starts with `-`,
  and `-0.00` prints as `+0.00`. Rust: `format!("{:+.2}", d)`, then the same `-0.00` fix.

## Part 1: `jev eval --compare`

### Command line

```text
jev eval a.jev --compare b.jev --cases cases.jsonl [options]
```

`a.jev` is the baseline and `b.jev` the candidate; every delta is `b − a`. The CLI keeps its rule
of one bare file, which is why the second page is a flag rather than a second argument.

New flags, both only read by `eval`:

| Flag                   | Meaning                                                                     |
| ---------------------- | --------------------------------------------------------------------------- |
| `--compare <page>`     | the second page: a `.jev` page or a request body, or `-` for stdin          |
| `--fail-on-regression` | exit 1 when `b` is significantly worse than `a` on any question both answer |

Every other eval flag applies to both pages: `--cases`, `--concurrency` (one pool of workers for
both pages together), `--cache` (the same directory; the key already hashes the whole body),
`--max-cost` (against the sum of both estimates), `--min-accuracy` (checked on each page),
`--threshold`, `--model` (overrides both pages' `@model`), `--price`, `--timeout`, `--mock`,
`--json`.

Usage errors, exit 2, checked after the existing eval checks, exactly:

- `only one of the page, --compare and --cases can come from stdin.` — when `--compare -` and
  the page or the cases are also stdin. (The page-and-cases case keeps its existing message.)
- `--fail-on-regression needs --compare: there is nothing to regress from.`

A page is named in the report by the path given on the command line, or `stdin` for `-`. Call
these the labels.

### Cases against two pages

Each line is read exactly as `parseCases` reads it, with one difference: an `expect` key may name
a question on either page.

- A key on neither page is an error, exactly: `no question named "x" on either page.`
- The value is checked against each page that has the question, with the existing messages. An
  error from a page is prefixed with that page's label: `cases line 3: b.jev: department is a
choice between billing, technical; got "sales".`
- Each page gets its own list of cases holding only the expectations for its questions. A case
  left with no expectation for a page is not sent for that page.

So a choice whose labels changed between the pages can only be compared over labels both pages
accept. That is deliberate: a case one page cannot even express is not a paired observation.

### Running and cost

Both pages go through one pool: page `a`'s cases first, then page `b`'s, `--concurrency` workers
pulling from the combined list. Outcomes come back per page in case order. Each page is asked with
its own model: `--model`, else the page's `@model`, else the client default.

The preflight (live only) prints, to stderr, exactly:

```text
jev eval: 40 + 40 cases over two pages, ≈ 19200 in / 12480 out tokens, ≈ $0.0164 at $0.20/$1.00 per Mtok
```

The counts are each page's number of cases; tokens and money are the sum of both preflights. The
money part is left out without rates. `--max-cost` refuses against that sum, with the existing
refusal line.

### What is compared

A question is **shared** when both pages have a question of that name and the same kind (`noul`,
`choice` or `score`; `raw` is never compared). Otherwise:

- a name on one page only is listed under `only in a` / `only in b`, in page order;
- a name on both with different kinds is listed as `mismatched`;
- a shared question that some case labels, on either page, but that has no paired case is listed
  as `unpaired`. A question no case labels is left out, as eval leaves it out.

A **paired case** for a shared question is a case (same line, and same turn — see part 3) that
expects the question on both pages and was scored on both — it answered every expectation it has
on that page. All paired metrics are computed over the paired cases only, so the two sides are
measured on the same states; the full per-page reports, over everything each page scored, are in
the JSON as `a` and `b`.

For each case, each side has a prediction and a verdict (right or wrong):

| kind   | prediction                                              | right when                   |
| ------ | ------------------------------------------------------- | ---------------------------- |
| noul   | `p >= threshold`, the side's threshold for the question | prediction equals the label  |
| choice | the chosen label                                        | it equals the expected label |
| score  | the rounded level                                       | it equals the expected level |

A case **flipped** when the two predictions differ. A flip is `fixed` when `a` was wrong and `b`
right, `broke` when `a` was right and `b` wrong, and `changed` when both were wrong (a choice or a
score can move from one wrong answer to another; a noul never can).

Metrics per side, over the paired cases:

- noul: `threshold`, `brier`, `accuracy` and `f1` at that side's threshold (same formulas as
  `eval-harness-v1.md`);
- choice: `accuracy`;
- score: `exact`, `withinOne`, `mae`.

`delta` is `b − a` for every metric except `threshold`.

### Significance: the exact McNemar test

The discordant pairs are `fixed + broke = n`. The two-sided exact p-value is

```text
p = min(1, 2 · Σ_{k=0}^{min(fixed, broke)} C(n, k) / 2^n)
```

computed in log space so large `n` does not overflow: `ln C(n, 0) = 0`,
`ln C(n, k) = ln C(n, k−1) + ln(n − k + 1) − ln k`, and each term is `exp(ln C(n, k) − n · ln 2)`.
With `n = 0`, `p = 1`.

The level is 0.05 and not configurable. Below six discordant pairs the smallest possible two-sided
p is `2 / 2^5 = 0.0625`, so no difference can be significant; that is the "too few" rule.

| verdict   | when                                |
| --------- | ----------------------------------- |
| `too few` | `n < 6`                             |
| `better`  | `n >= 6`, `p < 0.05`, fixed > broke |
| `worse`   | `n >= 6`, `p < 0.05`, broke > fixed |
| `same`    | otherwise                           |

A **regression** is a shared question whose verdict is `worse`.

### Text report

Written to stdout. The shape, numbers made up:

```text
  a  triage.jev     jev-latest · 40 cases
  b  triage-v2.jev  jev-latest · 40 cases

  is_urgent    noul    40 paired cases
                  a       b       Δ
    threshold     0.50    0.50
    brier         0.14    0.11    -0.03
    accuracy      0.82    0.88    +0.05
    f1            0.80    0.87    +0.07
    3 fixed · 1 broke · 0 changed
    McNemar: too few discordant pairs to call (4; 6 are needed for p < 0.05)
    case 4 (t-004)   no → yes   fixed
    case 9           yes → no   broke

  department   choice  40 paired cases
                  a       b       Δ
    accuracy      0.78    0.90    +0.12
    9 fixed · 1 broke · 2 changed
    McNemar p 0.021 over 10 discordant pairs: b is significantly better
    case 2           sales → billing       fixed
    ...

  only in a: tone
  only in b: sarcasm
  mismatched: severity is a score in a and a choice in b
  unpaired: urgency_v2 — no case was scored for it on both pages

  a case 7 (t-007): Timeout  The request did not complete within 10000 ms.

  40 cases · a 39 answered, 1 error · b 40 answered, 0 errors
  9624 in / 6240 out tokens · $0.0082
```

Exactly:

- The legend: two spaces, `a` or `b`, two spaces, the label padded to the longer label, two
  spaces, then dim `<model> · <n> case(s)`.
- A question header is the same as the eval header (name padded to the widest shared name, the
  kind padded to 8 in its colour), followed by dim `<n> paired case(s)`.
- The table: a dim header row of four spaces, 14 spaces, then `a`, `b`, `Δ` each padded to 8
  (trailing space trimmed). Each row: four spaces, the metric name padded to 14, then each value
  padded to 8. Row names: `threshold`, `brier`, `accuracy`, `f1` for a noul (threshold has no
  delta); `accuracy` for a choice; `exact`, `within one`, `mae` for a score.
- The counts line: `<fixed> fixed · <broke> broke · <changed> changed`.
- The significance line, exactly one of:
  - `McNemar: no discordant pairs, nothing to test` (n = 0)
  - `McNemar: too few discordant pairs to call (<n>; 6 are needed for p < 0.05)` (0 < n < 6)
  - `McNemar p <p toFixed(3)> over <n> discordant pairs: b is significantly better`
  - `McNemar p <p toFixed(3)> over <n> discordant pairs: b is significantly worse`
  - `McNemar p <p toFixed(3)> over <n> discordant pairs: no significant difference`
- The flips, in case order, at most 10: four spaces, the case name padded to the widest shown,
  three spaces, `<a> → <b>` padded to the widest shown, three spaces, the status. A value is
  `yes`/`no` for a noul, the label for a choice, `level <n>` for a score. The case name is
  `case <line>`, then ` turn <t>` for a per-turn case, then ` (<id>)` when there is one. After
  ten: `    … <k> more flipped; --json lists them all`.
- The lists, each only when not empty: `only in a: <names>`, `only in b: <names>` (joined with
  `, `), one `mismatched: <name> is a <kind> in a and a <kind> in b` per name, and one
  `unpaired: <name> — no case was scored for it on both pages` per name.
- The errors of each page, as eval prints them, prefixed with `a ` or `b `.
- The totals: `<n> case(s)` where n is the number of distinct cases (by line, and turn for a per-turn case) across both pages, then
  ` · a <n> answered, <n> error(s) · b <n> answered, <n> error(s)`, and the usage line of eval over
  both runs together (estimated when either side was).

### JSON report (`--json`)

```json
{
  "a": {
    "page": "triage.jev",
    "model": "jev-latest",
    "threshold": 0.5,
    "cases": 40,
    "...": "the eval report"
  },
  "b": { "page": "triage-v2.jev", "...": "the eval report" },
  "questions": {
    "is_urgent": {
      "kind": "noul",
      "paired": 40,
      "a": { "threshold": 0.5, "brier": 0.14, "accuracy": 0.82, "f1": 0.8 },
      "b": { "threshold": 0.5, "brier": 0.11, "accuracy": 0.88, "f1": 0.87 },
      "delta": { "brier": -0.03, "accuracy": 0.06, "f1": 0.07 },
      "fixed": 3,
      "broke": 1,
      "changed": 0,
      "mcnemar": { "discordant": 4, "p": 0.625, "verdict": "too few" },
      "flips": [
        { "case": 4, "id": "t-004", "expected": true, "a": false, "b": true, "status": "fixed" }
      ]
    },
    "department": {
      "kind": "choice",
      "paired": 40,
      "a": { "accuracy": 0.78 },
      "b": { "accuracy": 0.9 },
      "delta": { "accuracy": 0.12 },
      "...": "as above"
    },
    "frustration": {
      "kind": "score",
      "a": { "exact": 0.6, "withinOne": 0.95, "mae": 0.45 },
      "...": "as above"
    }
  },
  "onlyA": ["tone"],
  "onlyB": ["sarcasm"],
  "mismatched": [{ "name": "severity", "a": "score", "b": "choice" }],
  "unpaired": ["urgency_v2"],
  "regressions": [],
  "usage": { "inputTokens": 9624, "outputTokens": 6240, "estimated": false, "cost": 0.0082 }
}
```

`a` and `b` are each page's `reportJson` with `"page": <label>` as the first key. `questions` holds
the shared, paired questions in page `a`'s order. A flip's `expected`, `a` and `b` are a boolean
for a noul, a label for a choice and a level index for a score; `id` is present only when the case
has one and `turn` only for a per-turn case (it goes after `case`). `cost` in `usage` is absent
without rates, as in eval.

### Exit status and stderr

- The mock warning is printed once, as eval prints it.
- `--min-accuracy` is checked on each page's full report; a miss prints exactly
  `jev eval: <label>: <name> accuracy 0.65 is below 0.80.`
- `--fail-on-regression` prints, per regression, exactly
  `jev eval: <name> is significantly worse in <label b> (McNemar p 0.012).` and exits 1.
- Exit 1 also when either page has a case error, as eval does. Otherwise 0.

### Module

`evaluate.ts` gains, pure:

```ts
export function parseCompareCases(
  text: string,
  a: Session,
  b: Session,
  labels: Labels,
): Parsed<[Case[], Case[]]>;
export function runCompare(a: Leg, b: Leg, concurrency: number): Promise<[Outcome[], Outcome[]]>;
export function compare(
  a: Side,
  b: Side,
  options: { threshold: number; rates: Rates | undefined },
): Comparison;
export function compareLines(comparison: Comparison): Line[];
export function compareJson(comparison: Comparison): Json;
export function mcnemar(
  fixed: number,
  broke: number,
): { discordant: number; p: number; verdict: Verdict };
```

`jev_eval` over MCP takes an optional `compare` (the second page's text); the report is the
comparison, labelled `a` and `b`.

## Part 2: the decision bar, in the page

### Notation

A question's bar is written under it, as an indented directive:

```text
is_urgent? The message conveys urgency
  yes: A deadline, or money being lost right now
  @threshold 0.6

department: Which team should handle this
  billing = Payment or subscription issues
  technical = Bugs or integration problems
  @confidence 0.7
```

- `@threshold <0-1>` is a noul's threshold: the probability from which it reads as yes.
- `@confidence <0-1>` is a choice's or a score's confidence bar: the confidence from which the
  answer is acted on, and below which it goes to a person.
- The directive belongs to the question whose head is the nearest one above it (indentation is
  decoration, as everywhere in the notation). It may sit anywhere in the block; it is rendered as
  the block's last line, indented two spaces.
- The bar is not on the wire: `requestJson` is unchanged, and a request body has nowhere to hold
  one, so `:save x.json` drops it and `:save x.jev` keeps it.
- The line's tag is `bar`, its gutter label `bar`, its colour the accent (`lightBlue`). The editor
  status line for it reads exactly: `a bar — @threshold is where a noul reads as yes; @confidence
is how sure a choice or score must be to act on`.

Problems, on the directive's line, exactly (`N` is 1-based):

| When                                                  | Message                                                                                  |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| the value is missing, not a number, or outside 0 to 1 | `` `@threshold` takes a number from 0 to 1, e.g. `@threshold 0.6` `` (or `@confidence`)  |
| before any question                                   | `` `@threshold` belongs under a question — put it below the `name?` line it sets ``      |
| the same, for `@confidence`                           | `` `@confidence` belongs under a question — put it below the choice or score it gates `` |
| `@confidence` under a noul                            | `` a yes/no question takes `@threshold`, not `@confidence` ``                            |
| `@threshold` under a choice or a score                | `` a choice or a score takes `@confidence`, not `@threshold` ``                          |
| either under a raw question                           | `a raw question takes no bar — jev cannot read its answer`                               |
| a second bar in the same block                        | `` `is_urgent` already has a bar on line N ``                                            |

The unknown-directive message becomes exactly: ``unknown directive `@speed`; there is `@model`,
and `@threshold` or `@confidence` under a question``.

A directive whose question has problems of its own is tagged `bar` and otherwise ignored.

### Where the bar is kept

`Session.bars: Map<string, number>`, name to bar, next to `questions`. `Session.from` takes an
optional `bars`, `clone` copies it, `remove(name)` deletes the entry, and `insert(name, q)` deletes
it when the replacing question is of a different kind. `bar(name)` reads it. `sketch.render` writes
`@threshold` after a noul and `@confidence` after a choice or a score, and nothing for a raw
question even when an entry exists.

`ParsedSketch` gains `bars` (the same map) and `blocks: Map<string, { head, last, bar }>` for every
question that parsed: the 0-based head line, the last line that belongs to the block (its last
part, criterion, option, level, JSON or bar line), and the bar's line when it has one.

### Which threshold is used

One rule everywhere: **a question's own bar wins; the session-wide threshold is the default for
nouls that carry none.** The session-wide threshold is `--threshold` (default 0.5) on the command
line, `:threshold` in the REPL and the threshold setting on the web. A choice with no bar gates at
0.6 in generated code, as before; a score with no bar is not gated, as before.

This applies to: the eval report (the starred sweep row, `accuracy`, `--min-accuracy`, part 1's
comparison, part 3's latency), `jev run`'s answer page, the REPL's answers and sketch preview, the
MCP tools, `jev ts` / `jev rust` and `:ts` / `:rust`, and the web's answers and code tabs.

- The eval JSON gains `"threshold"` on every noul question, after `"brier"`: the one it was scored
  at. The top-level `threshold` stays the default.
- `jev check` names a bar: `is_urgent (noul, @threshold 0.6)`, `department (choice, @confidence
0.7)`; questions without one print as before.

### Generated code

A noul's threshold is printed as `toFixed(2)` when that reads back as the same number and as the
shortest representation otherwise, so existing output is unchanged. A choice's gate is printed with
the shortest representation (`0.6` as before). A score with a bar gets the same gate a choice has:

```ts
const frustration = res.score("frustration");
if (frustration && frustration.confidence >= 0.7) {
  console.log(
    `frustration: ${frustration.score.toFixed(2)} of ${frustration.legend.size - 1} ` +
      `(confidence ${frustration.confidence.toFixed(2)})`,
  );
} else if (frustration) {
  console.log(`frustration: unsure (${frustration.confidence.toFixed(2)}), send to a human`);
}
```

```rust
    let frustration = res.score("frustration").expect("asked");
    if frustration.confidence >= 0.7 {
        println!("frustration: {:.2} of {} (confidence {:.2})", frustration.score, frustration.legend.len() - 1, frustration.confidence);
    } else {
        println!("frustration: unsure ({:.2}), send to a human", frustration.confidence);
    }
```

### `jev eval --calibrate`

```text
jev eval triage.jev --cases cases.jsonl --calibrate [--target-accuracy 0.9]
```

| Flag                      | Meaning                                                           |
| ------------------------- | ----------------------------------------------------------------- |
| `--calibrate`             | write the bars the run supports back into the page, in place      |
| `--target-accuracy <0-1>` | the accuracy a choice's or score's bar has to reach (default 0.9) |

Usage errors, exit 2, exactly:

- `--calibrate and --compare do not mix: calibrate one page at a time.`
- `--calibrate writes the page back, so the page has to be a file, not stdin.`
- `--target-accuracy only applies with --calibrate.`
- `--target-accuracy takes a number from 0 to 1.`

A request body cannot hold a bar. After reading the page and before anything is sent, exit 1 with
exactly `jev eval: --calibrate needs a .jev page: a request body has nowhere to keep a bar.`

The rules, per scored question:

- **noul**: the sweep's best-F1 threshold (ties to the lowest), the `best` the report already has.
  When its F1 is 0 the question is left alone, with the reason `no threshold gives an F1 above 0`.
- **choice** and **score**: the lowest cut `k / 20`, `k = 0 … 19`, whose gated accuracy (exact
  accuracy for a score) over the cases with `confidence >= cut` is at least the target and keeps
  at least one case. When none reaches it the question is left alone, with the reason
  `no confidence bar reaches accuracy 0.90 (best 0.84 at 0.75)` — the highest gated accuracy over
  the same cuts, and the lowest cut that has it.

The cuts are computed as `k / 20`, not by adding `0.05`, so they print as `0.05`, `0.15`, `0.65`.

When any case errored the page is not touched: stderr gets exactly
`jev eval: not calibrating: 2 cases came back with errors, so the numbers are incomplete.` (`1
case came back` for one) and the exit status is 1.

Otherwise the page is rewritten with `sketch.setBars(text, bars)`, which changes only the bar lines:

- A question that already has a bar line gets that line replaced by its leading whitespace, the
  directive for its kind, a space and the number.
- A question without one gets a new line inserted after its block's `last` line: the leading
  whitespace of the block's first body line (two spaces when the block has none), the directive,
  a space and the number.
- Insertions are applied bottom to top so line numbers stay valid. A page with `\r\n` line ends
  gets `\r\n` on the new lines. Nothing else in the text changes, comments and blank lines
  included.

The file is written only when some bar changed. What changed goes to stdout after the report (a
blank line first):

```text
  calibration  target accuracy 0.90
    is_urgent    @threshold 0.6     was none   f1 0.87
    department   @confidence 0.65   was 0.6    accuracy 0.92 over 0.55 of cases
    frustration  left alone         no confidence bar reaches accuracy 0.90 (best 0.84 at 0.75)
  wrote 2 bars to triage.jev
```

Exactly: the heading `calibration` then dim `  target accuracy <toFixed(2)>`; per question four
spaces, the name padded to the widest, two spaces, the new directive padded to 19 (or `left alone`
padded to 19), then `was <old>` padded to 11 (`was none` when there was no bar, `unchanged` when the
bar is the same) and the evidence: `f1 <toFixed(2)>` for a noul, `accuracy <a> over <coverage> of
cases` for a choice or a score, or the reason for a question left alone. The last line is
`wrote <n> bar(s) to <path>` or `nothing to write: <path> already holds these bars`.

With `--json` the report gains a top-level `"calibration"`:

```json
{
  "calibration": {
    "page": "triage.jev",
    "target": 0.9,
    "written": true,
    "questions": {
      "is_urgent": { "kind": "noul", "bar": 0.6, "was": null, "f1": 0.87 },
      "department": {
        "kind": "choice",
        "bar": 0.65,
        "was": 0.6,
        "accuracy": 0.92,
        "coverage": 0.55
      },
      "frustration": {
        "kind": "score",
        "bar": null,
        "was": null,
        "reason": "no confidence bar reaches accuracy 0.90 (best 0.84 at 0.75)"
      }
    }
  }
}
```

The report printed is the run as it was, at the bars the page had; `--min-accuracy` reads that
report too.

`jev_eval` over MCP takes `calibrate` (boolean) and `targetAccuracy`; since it has no file, it
appends the calibrated page to the text result after a line `# the page, calibrated`, and puts it
in `calibration.text` of the JSON one.

### The web build tab

Each noul card gets a `threshold` field and each choice and score card a `confidence bar` field,
blank for none. A value that is not a number from 0 to 1 is refused with the parse message in the
status line and the card is redrawn. Renaming a question keeps its bar.

## Part 3: a rubric across the turns

### `:trend` in the REPL

`:trend` asks every question after each turn of the conversation in the state — the first turn,
the first two, and so on, `n` calls for `n` turns — and draws one line per question:

```text
trend · 4 turns
  is_urgent    noul    ▁▂▅█  0.12 → 0.91            turn 3 yes
  department   choice  ▃▃▆█  technical 0.35 → 0.80  turn 2 technical
  frustration  score   ▁▁▃▆  0.20 → 1.70 of 2       turn 3 level 1 · turn 4 level 2
  ≈ 612 in / 400 out tokens over 4 calls — estimated, since nothing was sent.
```

- Not a conversation: warn exactly
  ``:trend needs a conversation — `:turn <who>: <text>` builds one, a turn at a time.``
  No questions, and a request already in flight, warn as `:ask` does.
- The heading is `trend · <n> turn(s)`.
- The spark: one character per turn from `▁▂▃▄▅▆▇█`, at index `round(clamp(v / top, 0, 1) · 7)`.
  A noul's value is its probability (top 1). A choice's is, at every turn, the probability of the
  label it chose at the last turn (top 1). A score's is the weighted score, top the highest level.
- The summary: `<first> → <last>` with `toFixed(2)`; a choice puts the last turn's label in front
  (`technical 0.35 → 0.80`), a score adds ` of <top>`.
- The changes: the discrete reading at each turn — `yes`/`no` at the question's threshold for a
  noul, the chosen label for a choice, `level <n>` (the rounded level) for a score — listed as
  `turn <t> <reading>` for every turn after the first whose reading differs from the turn before,
  joined with `·`; when nothing changes, `<reading> throughout`.
- Columns: two spaces, the name padded to the widest, two spaces, the kind padded to 8 in its
  colour, the spark, two spaces, the summary padded to the widest summary, two spaces, the changes
  dim.
- A question with no answer (raw, or missing from a live response) prints
  `  <name>  <kind>  no answer to follow`.
- The cost line follows `:ask`'s: in mock mode, estimated over every prefix, exactly
  `≈ <in> in / <out> out tokens[ · $x] over <n> calls — estimated, since nothing was sent.`; live,
  the counted usage summed, `<in> in / <out> out tokens[ · $x] over <n> calls`, falling back to the
  estimated form with `— estimated, nothing was counted.` when any response lacks usage.
- Live mode sends the prefixes one after another, notes `asking after each of <n> turns: <n>
calls` first, and draws the trend when the last one is back. An error on any call is shown the
  way `:ask` shows one and no trend is drawn.

The pure half is `src/repl/trend.ts`, exported as `trend` from both entry points:

```ts
export function prefixes(session: Session): Session[];
export function series(
  session: Session,
  perTurn: ReadonlyArray<readonly Answered[]>,
  threshold: number,
): Series[];
export function sparkline(values: readonly number[], top: number): string;
export function trendLines(series: readonly Series[]): Line[];
```

`prefixes` builds each state with `turnsToJson(turns.slice(0, t))`, the same states `cost.thread`
prices and `by_turn` sends, so a cached eval run and `:trend` share their requests.

### `by_turn` in a cases file

A noul in a case whose state is a conversation may be labelled per turn:

```jsonl
{
  "id": "t-9",
  "state": [
    {
      "who": "customer",
      "said": "Hi"
    },
    {
      "who": "customer",
      "said": "It is down"
    },
    {
      "who": "customer",
      "said": "We lose money every minute"
    }
  ],
  "expect": {
    "is_urgent": {
      "by_turn": 3
    },
    "department": "technical"
  }
}
```

- `{"by_turn": k}` means false for turns `1 … k−1` and true from turn `k` on; `{"by_turn": null}`
  means false at every turn. `k` is a whole number from 1 to the number of turns.
- Such a case is sent once per turn, as the prefix of that many turns, and each prefix is a case of
  its own: its `by_turn` nouls expect `turn >= k`, and the case's plain expectations apply to the
  last turn only. A prefix left with no expectation is not sent.
- A case without `by_turn` is read exactly as before, conversation or not.
- Every metric counts the prefixes as the cases they are: a thread of four turns is four points in
  the sweep and four cases in the totals.

Errors, as `cases line N: <message>`, exactly:

- `is_urgent gives by_turn, but the state is not a conversation of turns.`
- `is_urgent by_turn must be a whole turn from 1 to 4, or null for never; got 7.`
- `is_urgent: a per-turn expectation is {"by_turn": n}, the turn it becomes true, or null for
never; got {"when":3}.` — an object with any other key.
- `by_turn is for a noul, and department is a choice.`

A per-turn case is named `case <line> turn <t>` (then ` (<id>)`); its JSON error carries `"turn"`
after `"case"`.

### Detection latency

For each noul with per-turn labels, over the threads whose every prefix was scored:

- detected turn `d`: the first turn whose probability is at or above the question's threshold, or
  none;
- for `by_turn: k`, latency `d − k`: `on time` when 0, `early` when below, `late` when above,
  `missed` when there is no `d`;
- for `by_turn: null`, a `false alarm` when there is a `d`;
- the mean latency over the threads with both `k` and `d`, undefined when there are none.

One more line in the noul's block, after `best f1 at`, exactly:

```text
    by turn  6 threads · 3 on time · 1 early · 1 late · 1 missed · 0 false alarms · mean latency +0.25 turns
```

`thread`, `false alarm` and `turn` take an `s` unless the count (or the mean, for `turn`, when it
is exactly 1 or -1) is 1; an undefined mean prints `mean latency ·`. In JSON the noul gains:

```json
"latency": {
  "threads": 6, "onTime": 3, "early": 1, "late": 1, "missed": 1, "falseAlarms": 0, "mean": 0.25,
  "cases": [{ "case": 9, "id": "t-9", "expected": 3, "detected": 2, "latency": -1 }]
}
```

`expected` is null for a `by_turn: null` thread, `detected` and `latency` null when nothing was
detected. `latency` is present only when the question has at least one per-turn thread.

## Out of scope, on purpose

- More than two pages in a comparison, and any test other than McNemar's.
- Significance for a noul's Brier score.
- A `:threshold <name>` command in the REPL; the page is where a bar is edited.
- Per-turn labels for a choice or a score, and `:trend` on the web.
- Calibrating a request body; writing anything but the bar lines.
