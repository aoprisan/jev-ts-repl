/** Rubrics: named questions whose answers come back typed, and checked, by name. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, expectTypeOf, it } from "vitest";

import type { Json } from "../src/json.js";
import type { Answer, NoulAnswer, Rubric, ScoreAnswer } from "../src/index.js";
import { Client, ResponseValidationError, choice, noul, raw, rubric, score } from "../src/index.js";

const TRIAGE = rubric({
  is_urgent: noul("The message conveys urgency", { yes: "A deadline", no: "Routine" }),
  department: choice("Which team should handle this", {
    billing: "Payment or subscription issues",
    technical: "Bugs or integration problems",
    sales: null,
  }),
  frustration: score("How frustrated", ["Calm", "Frustrated", "Very angry"]),
});

const BODY = {
  model: "jev-latest",
  usage: { input_tokens: 312, output_tokens: 48 },
  answers: {
    department: {
      type: "choice",
      choice: "technical",
      probabilities: { billing: 0.159, technical: 0.84, sales: 0.001 },
      confidence: 0.596,
    },
    frustration: {
      type: "score",
      score: 1.6,
      legend: { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
      probabilities: { "0": 0.05, "1": 0.3, "2": 0.65 },
      confidence: 0.78,
    },
    is_urgent: { type: "noul", noul: 0.999 },
    future: { type: "span", start: 3 },
  },
} satisfies Json;

function clientAnswering(
  body: Json,
  options: { record?: string; replay?: string } = {},
): { client: Client; sent: Json[] } {
  const sent: Json[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)) as Json);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", "x-typesafe-request-id": "req_1" },
    });
  }) as unknown as typeof globalThis.fetch;
  const client = new Client({
    apiKey: "sk-test",
    baseUrl: "https://api.example.test",
    retry: { maxRetries: 0 },
    fetch,
    ...options,
  });
  return { client, sent };
}

/** `body` with `edit` applied to a deep copy of its answers. */
function withAnswers(edit: (answers: Record<string, Json>) => void): Json {
  const copy = JSON.parse(JSON.stringify(BODY)) as { answers: Record<string, Json> };
  edit(copy.answers);
  return copy as unknown as Json;
}

async function failure(body: Json): Promise<ResponseValidationError> {
  const error = await clientAnswering(body)
    .client.ask("x", TRIAGE)
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ResponseValidationError);
  return error as ResponseValidationError;
}

describe("rubric", () => {
  it("sends its questions and reads the answers back by name", async () => {
    const { client, sent } = clientAnswering(BODY);
    const { answers, response } = await client.ask("The payout failed again.", TRIAGE);
    expect(sent[0]).toEqual({
      state: "The payout failed again.",
      model: "jev-latest",
      questions: {
        is_urgent: {
          type: "noul",
          instructions: "The message conveys urgency",
          criteria: { true: "A deadline", false: "Routine" },
        },
        department: {
          type: "choice",
          instructions: "Which team should handle this",
          criteria: {
            billing: "Payment or subscription issues",
            technical: "Bugs or integration problems",
            sales: null,
          },
        },
        frustration: {
          type: "score",
          instructions: "How frustrated",
          criteria: ["Calm", "Frustrated", "Very angry"],
        },
      },
    });
    expect(answers.is_urgent.noul).toBe(0.999);
    expect(answers.department.choice).toBe("technical");
    expect(answers.department.probabilities.billing).toBe(0.159);
    expect(answers.frustration.score).toBe(1.6);
    expect(answers.frustration.legend.get(2)).toBe("Very angry");
    // Only the rubric's own names; an answer type this version does not know stays in `raw`.
    expect(Object.keys(answers).sort()).toEqual(["department", "frustration", "is_urgent"]);
    expect(response.requestId).toBe("req_1");
    expect(response.usage.inputTokens).toBe(312);
    expect(response.noul("is_urgent")?.noul).toBe(0.999);
  });

  it("takes the state first, the way systemOne and the other SDKs do", () => {
    const { client } = clientAnswering(BODY);
    expectTypeOf(client.ask<typeof TRIAGE.questions>)
      .parameter(1)
      .toEqualTypeOf<Rubric<typeof TRIAGE.questions>>();
    // @ts-expect-error the rubric goes second
    const wrongWayRound = () => client.ask(TRIAGE, "The payout failed again.");
    expect(typeof wrongWayRound).toBe("function");
    // The response it came from narrows its lookups by the rubric's questions.
    type Response = Awaited<ReturnType<typeof client.ask<typeof TRIAGE.questions>>>["response"];
    expectTypeOf<Parameters<Response["choice"]>[0]>().toEqualTypeOf<"department">();
  });

  it("types each answer by its question", () => {
    type Answers = ReturnType<typeof TRIAGE.decode>;
    expectTypeOf<Answers["is_urgent"]>().toEqualTypeOf<NoulAnswer>();
    expectTypeOf<Answers["frustration"]>().toEqualTypeOf<ScoreAnswer>();
    expectTypeOf<Answers["department"]["choice"]>().toEqualTypeOf<
      "billing" | "technical" | "sales"
    >();
    expectTypeOf<Answers["department"]["probabilities"]>().toEqualTypeOf<
      Readonly<Record<"billing" | "technical" | "sales", number>>
    >();
    expectTypeOf<Answers>().not.toHaveProperty("is_urgnet");
    // Labels given as pairs keep their literals too.
    const paired = rubric({
      tone: choice("Tone", [
        ["calm", null],
        ["angry", "Hostile"],
      ]),
    });
    expectTypeOf<ReturnType<typeof paired.decode>["tone"]["choice"]>().toEqualTypeOf<
      "calm" | "angry"
    >();
    // Labels built at run time are only known to be strings.
    const labels: Record<string, Json | null> = { a: null, b: null };
    const dynamic = rubric({ pick: choice("Pick", labels), shape: raw({ type: "span" }) });
    expectTypeOf<ReturnType<typeof dynamic.decode>["pick"]["choice"]>().toEqualTypeOf<string>();
    expectTypeOf<ReturnType<typeof dynamic.decode>["shape"]>().toEqualTypeOf<Answer>();
  });

  it("names a missing answer", async () => {
    const error = await failure(withAnswers((a) => delete a["frustration"]));
    expect(error.fieldPath).toBe("answers.frustration");
    expect(error.detail).toBe("missing a score answer");
    expect(error.requestId).toBe("req_1");
  });

  it("names an answer of the wrong type", async () => {
    const error = await failure(
      withAnswers((a) => {
        a["is_urgent"] = { type: "score", score: 1, confidence: 1, legend: {}, probabilities: {} };
      }),
    );
    expect(error.fieldPath).toBe("answers.is_urgent");
    expect(error.detail).toBe("expected a noul answer, got a score one");
  });

  it("names a label the choice does not have", async () => {
    const error = await failure(
      withAnswers((a) => {
        (a["department"] as Record<string, Json>)["choice"] = "legal";
      }),
    );
    expect(error.fieldPath).toBe("answers.department.choice");
    expect(error.detail).toBe('"legal" is not one of "billing", "technical", "sales"');
  });

  it("decodes a response it did not send", async () => {
    const { client } = clientAnswering(BODY);
    const response = await client.systemOne("x", TRIAGE.questions);
    expect(TRIAGE.decode(response).department.choice).toBe("technical");
  });

  it("replays what it recorded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-rubric-"));
    try {
      await clientAnswering(BODY, { record: dir }).client.ask("state", TRIAGE);
      const replaying = new Client({ replay: dir });
      const { answers } = await replaying.ask("state", TRIAGE);
      expect(answers.is_urgent.noul).toBe(0.999);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
