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
import { codegen, cost, headless, mock, sketch } from "jev-repl/core";

const page = sketch.parse("A payout failed again.\n---\nis_urgent? The message conveys urgency");
const session = page.toSession();
session.requestJson("jev-latest"); // the exact body
codegen.typescript(session, "jev-latest", 0.5); // the same session as code
mock.answer(session.state, "is_urgent", session.questionsJson()["is_urgent"]); // offline answer
cost.estimate(session, "jev-latest"); // tokens in, tokens out, per question
cost.price(228, 186, { input: 0.2, output: 1 }).total; // dollars, at rates you supply
headless.answersText(headless.mockAnswers(session), 0.5); // what `jev run` prints
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
npm start         # run the REPL from source
```

### Releasing

The first release is published by hand, because npm can only attach a trusted publisher to a
package that already exists:

```sh
npm login && npm publish
```

After that, set the trusted publisher on npmjs.com (the package → Settings → Trusted Publisher →
repository `aoprisan/jev-ts-repl`, workflow `release.yml`). Every release after that is a tag:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

GitHub Actions then authenticates over OIDC — no npm token is stored anywhere — and npm attaches
provenance automatically.

This is a TypeScript port of the `jev-repl` crate in
[aoprisan/typesafe-ai-rust-sdk](https://github.com/aoprisan/typesafe-ai-rust-sdk); the notation,
lessons, presets and simulated answers are the same.

Unofficial. Not affiliated with TypeSafe AI. MIT licensed; source and issues at
[aoprisan/jev-ts-repl](https://github.com/aoprisan/jev-ts-repl).
