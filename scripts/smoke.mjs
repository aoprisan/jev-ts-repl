/**
 * A smoke test for the built package on the oldest Node versions it supports.
 *
 * The test suite cannot run there — vitest needs Node 22.12+ — but the package itself only needs
 * 18.17, so what ships is exercised directly: the library entry point, the wire format, the
 * offline simulator, and a REPL session driven without a terminal.
 *
 * Usage: node scripts/smoke.mjs   (after `npm run build`)
 */

import assert from "node:assert/strict";

const { App, Client, Session, choice, evaluate, mock, noul, questionsToJson, score, sketch } =
  await import("../dist/index.js");

// The wire format, the thing every other SDK has to agree with.
assert.deepEqual(
  questionsToJson({
    department: choice("Which team", { billing: "Payments", technical: null }),
    frustration: score("How frustrated", ["Calm", "Angry"]),
    is_urgent: noul("Urgent?", { yes: "A deadline" }),
  }),
  {
    department: {
      type: "choice",
      instructions: "Which team",
      criteria: { billing: "Payments", technical: null },
    },
    frustration: { type: "score", instructions: "How frustrated", criteria: ["Calm", "Angry"] },
    is_urgent: { type: "noul", instructions: "Urgent?", criteria: { true: "A deadline" } },
  },
);

// The offline simulator is deterministic, and the same numbers on every supported runtime.
const answer = mock.answer("a ticket", "is_urgent", { type: "noul", instructions: "Urgent?" });
assert.equal(answer.type, "noul");
assert.equal(answer.noul, 0.432, "the simulator drifted");

// The sketch notation round-trips.
const parsed = sketch.parse("A ticket.\n---\nis_urgent? Conveys urgency\n  yes: A deadline\n");
assert.deepEqual(parsed.problems, []);
assert.deepEqual(
  parsed.questions.map(([name]) => name),
  ["is_urgent"],
);

// A whole REPL session, driven without a terminal.
const app = new App();
app.mock = true;
app.exec(":preset triage");
app.exec(":ask");
assert.deepEqual(
  app.session.questions.map(([name]) => name),
  ["department", "frustration", "is_urgent"],
);
assert.ok(app.lastRaw, "the session produced no answers");

// A cases file is read against the page it will be scored with.
const graded = sketch.parse("A ticket.\n---\nis_urgent? Conveys urgency\n").toSession();
const cases = evaluate.parseCases(
  '{"state": "a payout failed", "expect": {"is_urgent": true}}',
  graded,
);
assert.equal(cases.ok, true, "the cases file did not parse");
assert.equal(cases.value[0].expect.is_urgent.yes, true);

// The client is constructible, and refuses to be built without a key.
assert.equal(typeof Client.fromEnv, "function");
assert.equal(typeof Session, "function");
assert.throws(() => new Client({ apiKey: "" }), /API key/);

console.log(`smoke: ok on node ${process.version}`);
