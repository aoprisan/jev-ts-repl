/**
 * A seeded question has to survive the round trip its editor makes of it.
 *
 * The web build tab writes the page and then reads it back, so a seed the notation cannot parse
 * takes the tab down: this is the test that says it must.
 */

import { describe, expect, it } from "vitest";

import { Session } from "../src/repl/session.js";
import { parse, render } from "../src/repl/sketch.js";
import { KINDS, seed } from "../src/repl/seeds.js";

describe("what the build tab adds", () => {
  it("seeds a question the notation reads back", () => {
    for (const kind of KINDS) {
      const session = new Session();
      session.state = "A ticket";
      session.insert("question_1", seed(kind));
      const page = parse(render(session));
      expect(page.problems, `a seeded ${kind} leaves the page unparseable`).toEqual([]);
      expect(page.questions.map(([name, q]) => [name, q.kind])).toEqual([["question_1", kind]]);
    }
  });

  it("adds a second question of the same kind", () => {
    for (const kind of KINDS) {
      const session = new Session();
      session.state = "A ticket";
      session.insert("question_1", seed(kind));
      // The tab re-reads the page before every add, so the round trip is the add.
      const reread = parse(render(session)).toSession();
      reread.insert("question_2", seed(kind));
      const page = parse(render(reread));
      expect(page.problems).toEqual([]);
      expect(page.questions.map(([name]) => name)).toEqual(["question_1", "question_2"]);
    }
  });
});
