# jev

A terminal REPL for shaping [TypeSafe AI](https://typesafe.ai) System One requests before you
write any code: send a `state` plus named, typed questions and read the typed answers back.

```sh
npx jev-repl          # or: npm i -g jev-repl && jev
```

With `TYPESAFE_API_KEY` set you get live answers; without it, answers are simulated locally so the
shapes can be learned offline.

| Question | Answer                                                                  |
| -------- | ----------------------------------------------------------------------- |
| `noul`   | probability of "yes" (0–1)                                              |
| `choice` | selected label, per-label probabilities, confidence                     |
| `score`  | probability-weighted level, legend, per-level probabilities, confidence |

## Inside

```text
:preset triage                                   # a ready-made session to poke at
:state The payout failed again, third time.      # bare text works too
:noul is_urgent The message conveys urgency | yes: A deadline | no: Routine
:choice department Which team | billing=Payments | technical=Bugs
:score frustration How frustrated | Calm | Annoyed | Furious
<Enter>                                          # send; answers come back with their distributions
```

- `:lesson` walks an eleven-step track from "what is a noul" to what a call costs.
- `:sketch` (Ctrl-K) opens the whole request as one page of text, with the question types read
  off the punctuation, a gutter that says what each line became, and a live preview of the JSON,
  simulated answers, the same request as TypeScript, or what a call would cost:

  ```text
  The payout failed again, third time this month.
  ---
  is_urgent? The message conveys urgency
    yes: A deadline or a threat to leave
  department: Which team should handle this
    billing = Payment or subscription issues
    technical = Bugs or integration problems
  frustration: How frustrated the customer appears
    Calm < Frustrated but civil < Very angry
  ```

- `:build` opens a form for one question; `:json` shows the exact request body, `:last` the raw
  response, `:ts` the session as a program against this package (and `:rust` the same session
  against [`typesafe-ai-sdk`](https://crates.io/crates/typesafe-ai-sdk)).
- `:cost` says what a call is about to cost, per question and on both sides of the wire — a choice
  over eight labels comes back with eight probabilities, a score echoes its whole legend:

  ```text
                          in   out
  department   choice     74    58
  frustration  score      60    93
  is_urgent    noul       32    19
  state                   40     ·
  envelope                22    16
  total                  228   186   414 tokens per call
    $0.000232 per call   ·   $0.2316 per 1,000 calls
    at $0.20/$1.00 per Mtok
  ```

  Rates are yours to supply, because nothing here knows what a model charges: `:cost 0.20/1.00` is
  dollars per million tokens, input then output, and `JEV_PRICE=0.20/1.00` sets the same at
  startup. Without them the table counts tokens and stops there. Tokens are estimated from the
  body — roughly four characters a token — so they are a shape, not an invoice; a live answer
  carries the counted `usage`, and the REPL prices that instead.

- `:save triage.jev` / `:open triage.jev` keep sessions as sketch pages; other paths use the
  request JSON.

Without `TYPESAFE_API_KEY` it starts in mock mode: answers are simulated locally (deterministic,
not predictive). `:key <api-key>` switches to live calls.

## Outside

A session shaped in the REPL and saved with `:save` is something a script can run. With a
subcommand `jev` never opens a terminal: it reads a page (or stdin), prints one thing, and says
with its exit status whether it worked — 0 when it did, 1 when the call or the file did not, 2 when
the command line did not parse.

```sh
jev run triage.jev                       # send it; the answers, with their distributions
jev run triage.jev --json | jq .answers  # the raw response body instead
jev eval triage.jev --cases cases.jsonl  # score the rubric over states you have labelled
jev json triage.jev                      # the exact request body it would POST
jev cost triage.jev --price 0.20/1.00    # the token table, priced
jev ts triage.jev                        # the session as a program; `jev rust` for the other one
jev check triage.jev                     # parse only: every problem, with line numbers
```

The file is a `.jev` page or a request body, and which one it is comes from the text rather than
the name, so a body piped back in works the same: `jev json page.jev | jev cost`. `-`, or no file
at all, reads stdin.

```sh
jev run triage.jev --state "$(cat ticket.txt)" --json | jq '.answers.is_urgent.noul'
```

`--state <text>` sets or replaces the state, `--model <name>` picks the model, `--threshold <0-1>`
says what counts as a yes for a noul, `--price <in>/<out>` prices the table, `--timeout <seconds>`
bounds a live attempt, and `--mock` stays offline even with a key set. Without a key `jev run`
simulates the answers and says so on stderr, so the stdout of a mock run is still the answer page.

### Scoring a rubric

One call tells you what the model said about one ticket. It does not tell you where to put the
threshold, or how sure a choice has to be before a script may act on it — and this README leaves
both calls to you three times over. `jev eval` is how you make them with data: it runs a saved page
over states you have already labelled and reports what the rubric got right.

```sh
jev eval triage.jev --cases cases.jsonl --price 0.20/1.00
jev eval triage.jev --cases cases.jsonl --json | jq .questions.is_urgent.best
```

The cases are JSON Lines, one labelled state per line. `state` is what to judge — a string or any
JSON — and `expect` names the questions on the page it is labelled for; questions it leaves out are
still asked and simply not scored. An `id` is optional and shows up in the report.

```jsonl
{"id": "t-001", "state": "Stripe has been failing for 3 days, I'm losing sales", "expect": {"is_urgent": true, "department": "technical", "frustration": 2}}
{"state": {"subject": "Invoice question", "body": "Can I get a copy of last month's invoice?"}, "expect": {"department": "billing", "is_urgent": false}}
```

An expectation is written the way its question is answered: a noul takes `true` or `false`, a
choice takes one of its option labels, and a score takes a level index or the text of one of its
levels. A bad line stops the run before anything is sent, named by its line in the file.

```text
  is_urgent    noul    40 cases · Brier 0.11
    threshold   acc   prec   rec    f1
    0.40        0.82  0.74   0.94   0.83
    0.50 *      0.85  0.80   0.89   0.84
    0.60        0.88  0.86   0.89   0.87
    best f1 at 0.60

  department   choice  40 cases · accuracy 0.78
    confidence ≥   coverage  accuracy
    0.00           1.00      0.78
    0.60           0.55      0.95
    confusion, rows expected, columns predicted
                billing  technical  sales
    billing     12       2          0

  40 cases · 40 answered · 0 errors
  4812 in / 3120 out tokens · $0.0041
```

That is the whole point of the table: the sweep says what a threshold buys, and the gate says what
a confidence bar buys — 0.95 accuracy over 55% of the tickets, with the rest going to a person.

`--cases <file>` is the only new flag that is required; `-` reads them from stdin, which the page
cannot also do. `--concurrency <n>` sends that many at a time (default 4), `--cache <dir>` keeps
each response so a second run sends nothing, `--max-cost <dollars>` refuses a run whose estimate is
above it (rates required), and `--min-accuracy <0-1>` exits 1 when a question scores below it. A
live run prints its estimate on stderr before sending anything. `--state` does not apply: the cases
carry the states. Exit status is 0 when every case answered and every bar was met, 1 when a case
errored or a bar was missed, 2 when the command line did not parse.

## As a library

The same package ships the typed client the REPL drives, so the code `:ts` generates runs as it is.

```ts
import { Client, choice, noul, score } from "jev-repl";

const client = Client.fromEnv(); // TYPESAFE_API_KEY

const res = await client.systemOne(
  "Hi, I've been trying to connect my Stripe account for 3 days. I'm losing sales. Please help ASAP.",
  {
    department: choice("Which team should handle this", {
      billing: "Payment or subscription issues",
      technical: "Bugs or integration problems",
    }),
    frustration: score("How frustrated the customer appears", ["Calm", "Frustrated", "Very angry"]),
    is_urgent: noul("The message conveys urgency", { yes: "A deadline, or money being lost now" }),
  },
  { model: "jev-latest" },
);

const department = res.choice("department");
if (department && department.confidence >= 0.6) {
  console.log(department.choice);
}
console.log(res.noul("is_urgent")?.noul); // a probability, not a boolean — you pick the threshold
```

A noul answers with a probability, so the threshold is a product decision, not the model's:
`answer.noul >= 0.8` is a different call from `>= 0.5`. Choice and score answers carry a
`confidence` over the distribution — gate automation on it and route the rest to a human.

Errors mirror the other TypeSafe SDKs: `ConfigError` and `InvalidRequestError` are thrown before
anything is sent, `ApiError` covers a non-2xx response, `ConnectionError` and `TimeoutError` cover
requests that never produced one, and `ResponseValidationError` covers a 2xx body missing required
data (with `fieldPath` pointing at it). Retries are on by default: 2 retries, exponential backoff
with jitter, a 30 s budget, and `Retry-After` is honoured.

```ts
const client = new Client({
  apiKey: process.env.TYPESAFE_API_KEY,
  timeoutMs: 5_000,
  retry: { maxRetries: 4, budgetMs: 60_000 },
});
```

The REPL's own pieces are exported too (`App`, `Session`, `sketch`, `codegen`, `mock`, the terminal
buffer), so a session can be driven, rendered or snapshot-tested without a terminal.

`jev-repl/core` is the same thing minus the terminal — no `node:` imports, no `process`, no stdin —
so it also runs in a browser or a worker:

```ts
import { codegen, cost, evaluate, headless, mock, sketch } from "jev-repl/core";

const page = sketch.parse("A payout failed again.\n---\nis_urgent? The message conveys urgency");
const session = page.toSession();
session.requestJson("jev-latest"); // the exact body
codegen.typescript(session, "jev-latest", 0.5); // the same session as code
mock.answer(session.state, "is_urgent", session.questionsJson()["is_urgent"]); // offline answer
cost.estimate(session, "jev-latest"); // tokens in, tokens out, per question
cost.price(228, 186, { input: 0.2, output: 1 }).total; // dollars, at rates you supply
headless.answersText(headless.mockAnswers(session), 0.5); // what `jev run` prints
evaluate.parseCases(text, session); // labelled states, checked against these questions
```

## On the web

The same REPL runs as an installable page, built from that core: `npm run build:web` writes a
static `site/` with no server behind it.

```sh
npm run build:web
npx --yes http-server site -p 8080   # or any static server
```

- **Offline is the default.** A service worker precaches the shell, so after one load the page
  works with the network off — the notation, the lesson track, the generated code and the
  simulated answers need nothing but the device.
- **The key is optional, and stays yours.** Without one, answers are simulated the way `jev` does
  in a terminal. With one, requests go straight from the browser to the API; the key lives in
  memory unless you ask for it to be kept, and `Forget key` removes it. There is no backend to
  send it to. A browser can only reach an API that allows its origin, so if a live call fails with
  a network error that is CORS — point the base URL at a proxy you control.
- **A phone gets a form, a desktop gets the page.** Sketch notation is punctuation-heavy, which a
  soft keyboard is bad at, so the Build tab edits the same request as fields; both write the same
  page, because both go through the same parser.
- **The Cost tab prices the page.** The same estimate the terminal prints, over whatever is on the
  page right now; the rate pair lives beside the key, and stays on the device like the rest of the
  settings.
- **Share is a link.** `Share` puts the page in the URL fragment — the notation travels, the key
  never does.
- **Nothing third-party runs on the page.** It ships a Content-Security-Policy that allows scripts,
  styles and images from its own origin only; the one inline script is the import map, named by a
  SHA-256 the build computes from it. Change the map without rebuilding and the browser refuses to
  run it.
- **It will not run in a frame.** `frame-ancestors` cannot travel in a `<meta>` policy, so it is
  handled twice: `site/_headers` sends `frame-ancestors 'none'`, `X-Frame-Options: DENY` and
  friends on hosts that read that file (Cloudflare Pages, Netlify), and the page itself refuses to
  build the app when `window.top !== window.self`, which covers hosts that send no headers —
  GitHub Pages among them. A framer that also turns scripts off in the frame gets the static shell
  with nothing wired to it. On a host you control, send the headers:

  ```nginx
  add_header Content-Security-Policy "frame-ancestors 'none'" always;
  add_header X-Frame-Options DENY always;
  ```

`web/` holds the sources, `site/` is the build output, and the PWA is deployed to GitHub Pages by
`.github/workflows/pages.yml` on every push to `main`.

## In a coding agent

`jev` is also an MCP server and a skill, so an agent can shape and send a page without you
pasting one in. One command registers both with whichever agents you have:

```sh
jev install                      # every agent found under your home directory
jev install --client codex       # or name one: claude-code, codex, opencode, pi
jev install mcp --scope project  # just the server, into the repository in front of you
jev install --list               # the agents, and the file each one gets
```

The MCP server is the one-shot commands again, offered as tools: `jev_notation` (the notation
itself, for when a page will not parse), `jev_check`, `jev_request`, `jev_cost`, `jev_ask`,
`jev_eval`, `jev_code` and `jev_presets`. It speaks JSON-RPC over stdin and stdout —
`jev mcp` runs it by hand — and it holds no key of its own: the agent starts it, so it inherits
the agent's environment, or you write one in with `--env TYPESAFE_API_KEY=…`.

The skill is [`skills/jev/SKILL.md`](skills/jev/SKILL.md): the notation, what makes a question
worth asking, and the check-price-run-score loop. It is the SKILL.md format every one of these
agents reads, so it works the same in all four.

| Agent       | MCP entry                                       | Skill                            |
| ----------- | ----------------------------------------------- | -------------------------------- |
| Claude Code | `~/.claude.json`, or `.mcp.json` in the project | `~/.claude/skills/jev/`          |
| Codex CLI   | `~/.codex/config.toml`                          | `~/.codex/skills/jev/`           |
| OpenCode    | `~/.config/opencode/opencode.json`              | `~/.config/opencode/skills/jev/` |
| pi          | `~/.pi/agent/mcp.json`                          | `~/.pi/agent/skills/jev/`        |

Nothing else in those files is touched — the entry is merged in, and a config that cannot be
parsed is reported rather than rewritten. pi has no MCP client of its own yet, so its entry is
written in the shape its MCP extensions read; the skill works there as it is.

## Requirements

Node 18.17 or newer (it uses the built-in `fetch`), and a terminal for the REPL itself.

## Commands

`:help` lists them all inside; `:help concepts` explains noul, choice, score and confidence, and
`:cost` what a call spends.
Keys: Ctrl-T try the lesson's command · Ctrl-N next lesson · Ctrl-K sketch · Ctrl-B build ·
PgUp/PgDn scroll · Ctrl-L clear · Ctrl-C quit.

## Development

```sh
npm install
npm test          # vitest
npm run typecheck
npm run build     # dist/, what npm publishes
npm run build:web # site/, the installable web REPL
npm run icons     # regenerate the app icons
npm run skill     # regenerate src/agent/skill.ts from skills/jev/SKILL.md
npm start         # run the REPL from source
```

### Releasing

The first release is published by hand, because npm can only attach a trusted publisher to a
package that already exists:

```sh
npm login && npm publish
```

After that, set the trusted publisher on npmjs.com (the package → Settings → Trusted Publisher →
repository `aoprisan/jev-ts-repl`, workflow `release.yml`). Every release after that is a tag.

A release is prepared on a branch first: bump the version in `package.json`, `package-lock.json`
and `src/typesafe/constants.ts` — a test fails when those disagree — write what changed in
`CHANGELOG.md`, and land it on `main`. Then tag the merge commit:

```sh
git tag v0.2.0 && git push origin v0.2.0
```

The workflow refuses a tag that does not match the version in the manifest, and lints, typechecks,
tests and builds before it publishes.

GitHub Actions then authenticates over OIDC — no npm token is stored anywhere — and npm attaches
provenance automatically.

This is a TypeScript port of the `jev-repl` crate in
[aoprisan/typesafe-ai-rust-sdk](https://github.com/aoprisan/typesafe-ai-rust-sdk); the notation,
lessons, presets and simulated answers are the same.

Unofficial. Not affiliated with TypeSafe AI. MIT licensed; source and issues at
[aoprisan/jev-ts-repl](https://github.com/aoprisan/jev-ts-repl).
