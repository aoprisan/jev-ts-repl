# Changelog

Notable changes to `jev-repl`. Versions follow [semver](https://semver.org): the package is
pre-1.0, so a minor bump may still move the surface under you.

## Unreleased

### Added

- **Two pages, one set of cases, and whether the difference is real.** `jev eval a.jev --compare
b.jev --cases cases.jsonl` runs both pages over the same labelled states and reports, per
  question they share, the change in Brier, accuracy and F1 (or exact, within one and MAE for a
  score), the cases whose answer flipped — `fixed`, `broke` or `changed` — and an exact McNemar
  test over the cases one page got right and the other wrong, which says "too few" instead of a
  p-value when there are fewer than six. Both runs share one cost estimate, one pool of workers and
  one cache; `--fail-on-regression` exits 1 when the second page is significantly worse, and
  `--json` prints both reports next to the comparison. `jev_eval` over MCP takes `compare` too.
  New `parseCompareCases`, `runCompare`, `compare`, `compareLines`, `compareJson`, `regressions`
  and `mcnemar` on `evaluate`.

- **The threshold lives on the page.** `@threshold 0.6` under a noul and `@confidence 0.65` under a
  choice or a score write down the bar its answer is acted on at. The bar never goes on the wire;
  it wins over `--threshold` and `:threshold` wherever an answer is read — the answer page, the
  eval report's starred row, a comparison — and `jev ts` / `jev rust` gate on it instead of the
  hard-coded 0.5 and 0.6. It round-trips through `:sketch`, `:save` and `:open`, the gutter labels
  it `bar`, a misplaced one is a problem on its line, and the web Build tab has a field for it.
- **`jev eval --calibrate` writes the bars back.** Each noul's best-F1 threshold and the lowest
  confidence bar at which a choice or a score reaches `--target-accuracy` (default 0.9) go into the
  page in place, touching nothing but the bar lines, and the report says what changed and why a
  question was left alone. `jev_eval` over MCP takes `calibrate` and hands back the page. New
  `Session.bars`, `bar` and `thresholdOf`; `sketch.setBars` and `parseBar`; `evaluate.calibrate`,
  `calibrationLines` and `calibrationJson`.
- **`:trend` follows a rubric across a conversation.** Every question is asked again after each
  turn of the thread in the state, and drawn as one line apiece — a spark across the turns, where
  it started and ended, and the turns it changed its mind — with the cost line counting every
  call. New `trend` module on both exports.
- **A conversation can be labelled per turn.** In a cases file, `{"by_turn": 3}` on a noul means
  false before turn 3 and true from it on, and `{"by_turn": null}` means never; such a case is sent
  once per prefix of the conversation and each prefix is scored as a case. The noul's block then
  says when it noticed: how many threads it caught on time, early, late or never, how many false
  alarms, and the mean latency in turns. A case without `by_turn` reads exactly as before.
- **Record and replay.** `TYPESAFE_RECORD=<dir>` (or `new Client({ record: dir })`) writes each
  successful `systemOne` response body to `<dir>/<key>.json`; `TYPESAFE_REPLAY=<dir>` (or
  `{ replay: dir }`) answers from there with no network and no API key. A request with no
  recording throws the new `ReplayMissError`, with the `key` and `path` it looked for, and never
  falls back to a live call. Setting both is a `ConfigError`.
- New `cassetteKey` on both exports: the SHA-256 of a compact request body, in hex. `jev eval
--cache` now uses it too, unchanged, so a cassette directory and an eval cache are
  interchangeable. A test pins the digest of a fixture, for the other SDKs to match.

## 0.6.0

### Added

- **Alt-arrow, in every terminal that sends one.** Alt-← and Alt-→ cross a word on the input line,
  in the sketch editor and in every builder field, and Alt-Backspace deletes the word behind the
  cursor. Terminals disagree about how Alt is spelled, so all of the spellings are read now: the
  modified arrow (`Esc [ 1;3A`), the Meta bit some terminals use for the same keypress
  (`Esc [ 1;9A`), the doubled Esc a terminal sends when Alt means "prefix with Esc", a modified
  SS3 arrow (`Esc O 3 D`), and the readline bindings `Alt-b` / `Alt-f`. Ctrl-←/→ works too.
- **Several questions of the same type, without the extra keystrokes.** After Ctrl-S adds a
  question, builder mode stays open on the type just used instead of falling back to a noul, and
  the form lists what the session already holds, so a rubric of three nouls or two choices is
  named and typed rather than re-selected each time.
- New `isWordLeft`, `isWordRight`, `isDeleteWordLeft`, `wordLeft` and `wordRight` on the exports,
  alongside the key decoder — the bindings and the motion a text field needs to answer Alt-arrow.
- New `seed` and `KINDS` on both exports: a blank question of each kind, filled in enough to be a
  page that parses. `Kind` moves to the same module and is re-exported where it was.

### Fixed

- **A key held back is no longer swallowed.** `Esc Esc` arriving before the rest of its arrow was
  decoded as Alt-Esc and the arrow behind it was lost; a half-arrived sequence now waits for its
  remaining bytes, and is read as the Esc it starts with only when nothing follows.
- **Builder mode asks before replacing.** Ctrl-S on a name the session already holds warns once
  and adds the question only when it is confirmed, so a second question of the same shape does not
  quietly overwrite the first.
- **The web build tab names new questions apart.** Adding a question after removing one picked a
  name that was still in use and replaced that question instead of adding one.
- **"+ choice" no longer breaks the build tab.** It seeded a choice with a single option, and one
  option is not a choice: the page the tab had just written would not parse, so the cards vanished
  behind "The page has problems" and every further add was refused. Seeds now round-trip, which a
  test holds them to.

## 0.5.0

### Added

- **A state can be a conversation.** `:turn <who>: <text>` grows the state into a thread of turns
  instead of replacing it, so the same rubric can be re-read after every reply rather than sampled
  once — the questions stay fixed and only the state gets longer. `:turn list` shows the thread,
  `:turn drop` takes the last one back, and text that was already the state becomes the first turn.
  Nothing new goes on the wire: the `state` is an array of `{who, said}`, which is why a `.jev`
  page can carry one and a `jev eval` case can score one. A transcript written with the keys a chat
  API uses is read as turns too.
- **`jev run --turn "<who>: <text>"`** appends a turn from the command line, and repeats, so a
  thread can be driven from a script. It does not apply to `eval`, where each case carries its own
  state.
- **`:cost` prices the thread, not just the call.** A conversation is sent whole every time it is
  asked about, so the table now counts the turns in the state and adds what a call per turn comes
  to. New `thread` function and `Thread` type on both exports, alongside `Turn`, `turnsOf`,
  `turnsToJson`, `turnText` and `parseTurn`.

## 0.4.0

### Added

- **jev, in a coding agent.** `jev mcp` serves the one-shot commands to an agent over MCP —
  JSON-RPC on stdin and stdout, no dependencies — as `jev_notation`, `jev_check`, `jev_request`,
  `jev_cost`, `jev_ask`, `jev_eval`, `jev_code` and `jev_presets`. Offline answers are stamped as
  simulated in the tool result, the same way the CLI stamps them.
- **`jev install` registers the server and the skill.** One command writes the MCP entry and
  `SKILL.md` for Claude Code, Codex CLI, OpenCode and pi, for this user or for the repository in
  front of you. Entries are merged into whatever is already in the config file, re-running changes
  nothing, `--dry-run` says what it would do, and a SKILL.md that jev did not write is left alone
  until `--force`.
- **The skill itself**, at `skills/jev/SKILL.md`: the sketch notation, what makes a question worth
  asking, and the check-price-run-score loop. `jev_notation` hands over the same text.
- New `mcp`, `install` and `installer` modules on the exports, plus `SKILL_MD` and
  `presets.page()`, which writes a ready-made session out as a page.

## 0.3.0

### Added

- **A rubric can be scored, not guessed at.** `jev eval <page> --cases cases.jsonl` runs a saved
  page over a file of labelled states and reports how it did: a threshold sweep with precision,
  recall and F1 per noul, a Brier score, a confusion matrix and a confidence gate per choice, and
  exact, within-one and MAE per score. The cases are JSON Lines — `state` and `expect`, with a bad
  line named by its line number before anything is sent. `--concurrency` sends a few at a time,
  `--cache <dir>` makes a second run free, `--max-cost` refuses a run that would cost too much,
  `--min-accuracy` fails one that scores too low, and `--json` prints the whole report for `jq`.
  New `evaluate` module on both exports, plus `Case`, `Expectation`, `Outcome` and `Report`.

## 0.2.0

### Added

- **What a call costs, before it is sent.** `:cost` in the REPL and `jev cost` on the command line
  price a session per question and on both sides of the wire — a choice costs what its options
  cost, a score what its labels cost. Rates are yours to supply (`:cost 0.20/1.00`,
  `--price 0.20/1.00`, or `JEV_PRICE`), because nothing here knows what a model charges. A live
  response carries the counted `usage`, and that is priced instead of the estimate. New
  `cost` module on both exports, plus `Cost`, `Estimate`, `QuestionEstimate` and `Rates`.
- **A session can be run without a terminal.** `jev <command> [file]` does one shot and exits:
  `run` sends the request, `json` prints the exact body it would POST, `cost` the token table,
  `ts` and `rust` the session as a program, `check` says what is wrong with the input. The file is
  a `.jev` sketch page or a request body — told apart by the text, not the name — and `-`, or no
  file at all, reads stdin, so `jev json page.jev | jev cost` works. Flags: `--state`, `--model`,
  `--threshold`, `--price`, `--timeout`, `--mock`, `--json`. Exit status is 0 when it worked, 1
  when the call or the file did not, 2 when the command line did not parse. New `headless` module
  on both exports.
- **The web REPL** (`npm run build:web`, published to GitHub Pages): the same notation and the same
  simulated answers, offline and installable, with Sketch, Answers, Request, Cost and Code tabs.
  It is built on the new `jev-repl/core` export — the parts of jev that need no terminal, and so
  run unchanged in a browser.
- **`jev-repl/core`**, a browser-safe entry point: the notation, the session, the offline answers,
  the code generators, the cost estimate and the typed client, with no `node:` imports.

### Changed

- The page serves only what it ships: a strict Content-Security-Policy with per-build hashes, no
  third-party origins, and it refuses to be framed from either side of the wire.
- The page reads on a phone, and hands over to a new service worker as soon as one is published
  instead of waiting for every tab to close.
- The guided track's terminal commands do on the page what they say in the text.

## 0.1.0

First release: the terminal REPL, the sketch notation, the guided lesson track, the presets, the
offline answers, the TypeScript and Rust code generators, and the typed `Client` they drive.
