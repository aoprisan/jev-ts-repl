/**
 * A small TypeSafe AI System One client: typed questions in, typed answers out.
 *
 * This is the public surface, named one by one. Decoders, retry arithmetic, wire paths and header
 * names stay in their modules, so they can change without breaking a caller.
 */

// Configuration users set, and the version the client reports.
export {
  API_KEY_ENV,
  BASE_URL_ENV,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_MODEL_ENV,
  DEFAULT_TIMEOUT_MS,
  RECORD_ENV,
  REPLAY_ENV,
  VERSION,
} from "./constants.js";

// Errors: one class per failure, and a check that works across copies of the SDK.
export {
  ApiError,
  AuthenticationError,
  BadRequestError,
  ConfigError,
  ConnectionError,
  InternalServerError,
  InvalidRequestError,
  isTypeSafeError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  ResponseValidationError,
  TimeoutError,
  TypeSafeError,
  UnprocessableEntityError,
  UserAbortError,
} from "./errors.js";
export type { ApiErrorKind, ResponseHeaders } from "./errors.js";

// Questions and their wire form.
export {
  choice,
  noul,
  questionFromJson,
  questionsToJson,
  questionToJson,
  raw,
  score,
  withOption,
} from "./questions.js";
export type {
  ChoiceOption,
  ChoiceQuestion,
  NoulCriteria,
  NoulQuestion,
  Question,
  Questions,
  RawQuestion,
  ScoreQuestion,
} from "./questions.js";

// Answers and the responses that carry them.
export { answerConfidence, isYes, mostLikelyLevel, ranked, roundedLevel } from "./responses.js";
export type {
  Answer,
  AnswerNames,
  AnswerNamesOf,
  ChoiceAnswer,
  ListModelsResponse,
  ModelMetadata,
  NoulAnswer,
  QuestionName,
  ResponseMeta,
  ScoreAnswer,
  SystemOneResponse,
  Usage,
} from "./responses.js";

// Retries.
export { defaultRetryPolicy, noRetries } from "./retry.js";
export type { RetryPolicy } from "./retry.js";

// Rubrics: questions named once, answers typed by them.
export { rubric } from "./rubric.js";
export type {
  AnswerTo,
  ChoiceAnswerOf,
  Rubric,
  RubricAnswers,
  RubricQuestions,
  RubricResponse,
} from "./rubric.js";

// Record and replay.
export { cassetteKey, ReplayMissError } from "./cassette.js";

// The client.
export { Client } from "./client.js";
export type { CallOptions, ClientOptions, FromEnvOptions, ModelsResource } from "./client.js";
