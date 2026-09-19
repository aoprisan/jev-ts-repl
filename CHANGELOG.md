# Changelog

Notable changes to `jev-repl`. Versions follow [semver](https://semver.org): the package is
pre-1.0, so a minor bump may still move the surface under you.

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
