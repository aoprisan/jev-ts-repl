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

- `:lesson` walks a ten-step track from "what is a noul" to confidence gating.
- `:sketch` (Ctrl-K) opens the whole request as one page of text, with the question types read
  off the punctuation, a gutter that says what each line became, and a live preview of the JSON,
  simulated answers, or the same request as TypeScript:

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
- `:save triage.jev` / `:open triage.jev` keep sessions as sketch pages; other paths use the
  request JSON.

Without `TYPESAFE_API_KEY` it starts in mock mode: answers are simulated locally (deterministic,
not predictive). `:key <api-key>` switches to live calls.

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

## Requirements

Node 18.17 or newer (it uses the built-in `fetch`), and a terminal for the REPL itself.

## Commands

`:help` lists them all inside; `:help concepts` explains noul, choice, score and confidence.
Keys: Ctrl-T try the lesson's command · Ctrl-N next lesson · Ctrl-K sketch · Ctrl-B build ·
PgUp/PgDn scroll · Ctrl-L clear · Ctrl-C quit.

## Development

```sh
npm install
npm test          # vitest
npm run typecheck
npm run build     # dist/, what npm publishes
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
