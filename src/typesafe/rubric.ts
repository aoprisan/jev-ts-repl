/**
 * Rubrics as types: one object names the questions, and the answers come back typed by it.
 *
 * ```ts
 * const triage = rubric({
 *   is_urgent: noul("The message conveys urgency"),
 *   department: choice("Which team should handle this", {
 *     billing: "Payment or subscription issues",
 *     technical: "Bugs or integration problems",
 *   }),
 *   frustration: score("How frustrated", ["Calm", "Annoyed", "Furious"]),
 * });
 * const { answers } = await client.ask(triage, "The payout failed again.");
 * answers.is_urgent.noul; // number
 * answers.department.choice; // "billing" | "technical"
 * answers.frustration.score; // number
 * ```
 *
 * A misspelled name or reading a choice as a score is a type error, and the response is checked
 * against the same shape when it arrives: a missing answer, an answer of the wrong type, or a
 * label the choice does not have is a {@link ResponseValidationError} naming the field
 * (`answers.department` or `answers.department.choice`). It is the TypeScript counterpart of
 * `response_model` in the Python SDK, and of `#[derive(Rubric)]` in the Rust one.
 */

import { ResponseValidationError } from "./errors.js";
import type { ChoiceQuestion, NoulQuestion, Question, ScoreQuestion } from "./questions.js";
import { questionType } from "./questions.js";
import type {
  Answer,
  ChoiceAnswer,
  NoulAnswer,
  ScoreAnswer,
  SystemOneResponse,
} from "./responses.js";

/** A choice answer whose label, and the keys of its distribution, are the question's labels. */
export interface ChoiceAnswerOf<L extends string> extends Omit<
  ChoiceAnswer,
  "choice" | "probabilities"
> {
  /** The highest-probability option — always one of the question's labels. */
  readonly choice: L;
  /** Every option mapped to its probability, in server order. */
  readonly probabilities: Readonly<Record<L, number>>;
}

/** The answer a question gets back: a noul for a noul, a choice over its labels for a choice. */
export type AnswerTo<Q extends Question> = Q extends NoulQuestion
  ? NoulAnswer
  : Q extends ChoiceQuestion<infer L>
    ? ChoiceAnswerOf<L>
    : Q extends ScoreQuestion
      ? ScoreAnswer
      : Answer;

/** Named questions whose answers are typed by name. */
export type RubricQuestions = Readonly<Record<string, Question>>;

/** Every answer of a rubric, typed by the question it answers. */
export type RubricAnswers<R extends RubricQuestions> = { readonly [K in keyof R]: AnswerTo<R[K]> };

/** A set of named questions that also knows the shape of its answers. */
export interface Rubric<R extends RubricQuestions> {
  /** The questions, as `systemOne` takes them. */
  readonly questions: R;
  /**
   * The answers in `response`, checked against the questions and typed by them. Throws
   * {@link ResponseValidationError} when an answer is missing, is of the wrong type, or names a
   * label its choice does not have.
   */
  decode(response: SystemOneResponse): RubricAnswers<R>;
}

/** What {@link Client.ask} hands back: the typed answers, and the response they came from. */
export interface RubricResponse<R extends RubricQuestions> {
  readonly answers: RubricAnswers<R>;
  readonly response: SystemOneResponse;
}

/** A rubric over `questions`; pass it to `client.ask`, or `decode` a response you already have. */
export function rubric<const R extends RubricQuestions>(questions: R): Rubric<R> {
  return {
    questions,
    decode(response) {
      const answers: Record<string, Answer> = {};
      for (const [name, question] of Object.entries(questions)) {
        answers[name] = check(response, name, question);
      }
      return answers as RubricAnswers<R>;
    },
  };
}

function check(response: SystemOneResponse, name: string, question: Question): Answer {
  const answer = response.answers.get(name);
  const expected = questionType(question);
  if (answer === undefined) {
    throw mismatch(response, `answers.${name}`, `missing ${article(expected)} answer`);
  }
  // A raw question declares its own type, which may be one this SDK version does not know.
  const known = expected === "noul" || expected === "choice" || expected === "score";
  if (known && answer.type !== expected) {
    throw mismatch(
      response,
      `answers.${name}`,
      `expected ${article(expected)} answer, got ${article(answer.type)} one`,
    );
  }
  if (question.kind === "choice" && answer.type === "choice") {
    const labels = question.options.map(([label]) => label);
    if (!labels.includes(answer.choice)) {
      throw mismatch(
        response,
        `answers.${name}.choice`,
        `${JSON.stringify(answer.choice)} is not one of ${labels.map((l) => JSON.stringify(l)).join(", ")}`,
      );
    }
  }
  return answer;
}

function article(type: string): string {
  return `${/^[aeiou]/i.test(type) ? "an" : "a"} ${type}`;
}

function mismatch(
  response: SystemOneResponse,
  fieldPath: string,
  detail: string,
): ResponseValidationError {
  return new ResponseValidationError(
    response.meta.status,
    fieldPath,
    detail,
    response.raw,
    response.meta.headers,
  );
}
