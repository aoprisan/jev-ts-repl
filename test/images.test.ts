/** Jev 1.14's danger zone: images, box questions and long context, each behind its header. */

import { describe, expect, it } from "vitest";

import type { Json } from "../src/json.js";
import {
  Client,
  InvalidRequestError,
  box,
  image,
  imageBase64,
  noul,
  rubric,
  type Questions,
} from "../src/index.js";

/** The JPEG magic bytes and nothing else: enough to be read as an image without being one. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

const BOX_BODY = {
  model: "jev-1.14.0",
  answers: {
    door: {
      type: "box",
      box: { top: 0.25, bottom: 0.82, left: 0.44, right: 0.84 },
      confidence: 0.92,
    },
    open: { type: "noul", noul: 0.2 },
  },
  usage: { input_tokens: 290, output_tokens: 21 },
} satisfies Json;

interface Sent {
  headers: Record<string, string>;
  body: Record<string, Json>;
}

function client(options: { longContext?: boolean } = {}): { client: Client; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetch = (async (_url: string, init: RequestInit = {}) => {
    sent.push({
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, Json>,
    });
    return new Response(JSON.stringify(BOX_BODY), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return {
    client: new Client({
      apiKey: "sk-test",
      baseUrl: "https://api.example.test",
      fetch,
      ...options,
    }),
    sent,
  };
}

const QUESTIONS = {
  door: box("the front door in photo"),
  open: noul("the door in photo is open"),
} satisfies Questions;

describe("images and box questions", () => {
  it("sends the image under its reference, opts in, and decodes the box", async () => {
    const { client: c, sent } = client();
    const res = await c.systemOne({ photo: "photo" }, QUESTIONS, {
      model: "jev-1.14.0",
      assets: { photo: image(JPEG) },
    });
    expect(sent[0]?.headers["typesafe-danger-zone-images"]).toBe("true");
    expect(sent[0]?.headers["typesafe-danger-zone-long-context"]).toBeUndefined();
    expect(sent[0]?.body).toEqual({
      state: { photo: "photo" },
      model: "jev-1.14.0",
      questions: {
        door: { type: "box", instructions: "the front door in photo" },
        open: { type: "noul", instructions: "the door in photo is open" },
      },
      assets: { photo: { type: "image", data_base64: "/9j/4A==", format: "jpeg" } },
    });
    const door = res.box("door");
    expect(door?.box).toEqual({ top: 0.25, bottom: 0.82, left: 0.44, right: 0.84 });
    expect(door?.confidence).toBe(0.92);
    // @ts-expect-error open is a noul
    expect(res.box("open")).toBeUndefined();
  });

  it("opts in for a box question even when the image comes another way", async () => {
    const { client: c, sent } = client();
    await c.systemOne("photo", QUESTIONS, {
      extraBody: { assets: { photo: { type: "image", data_base64: "x", format: "png" } } },
    });
    await c.systemOne("photo", { door: box("the door") });
    expect(sent.map((s) => s.headers["typesafe-danger-zone-images"])).toEqual(["true", "true"]);
  });

  it("does not opt in a call with neither", async () => {
    const { client: c, sent } = client();
    await c.systemOne("text", { open: noul("open") });
    expect(sent[0]?.headers["typesafe-danger-zone-images"]).toBeUndefined();
    expect(sent[0]?.body["assets"]).toBeUndefined();
  });

  it("types a rubric's box answer", async () => {
    const { client: c } = client();
    const { answers } = await c.ask({ photo: "photo" }, rubric(QUESTIONS), {
      assets: { photo: imageBase64("/9j/4A==", "jpeg") },
    });
    const right: number = answers.door.box.right;
    expect(right).toBe(0.84);
    expect(answers.open.noul).toBe(0.2);
  });

  it("refuses what is not a PNG or a JPEG, and an image nothing refers to", async () => {
    expect(() => image(new TextEncoder().encode("GIF89a"))).toThrow(InvalidRequestError);
    expect(image(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).format).toBe(
      "png",
    );
    const { client: c, sent } = client();
    await expect(
      c.systemOne("nothing named here", QUESTIONS, { assets: { picture: image(JPEG) } }),
    ).rejects.toThrow(/"picture" is not referenced/);
    expect(sent).toEqual([]);
  });
});

describe("long context", () => {
  it("is opt-in per client, and a call can say otherwise", async () => {
    const plain = client();
    await plain.client.systemOne("x", { open: noul("open") });
    await plain.client.systemOne("x", { open: noul("open") }, { longContext: true });
    const long = client({ longContext: true });
    await long.client.systemOne("x", { open: noul("open") });
    await long.client.systemOne("x", { open: noul("open") }, { longContext: false });
    const header = (s: Sent) => s.headers["typesafe-danger-zone-long-context"];
    expect([...plain.sent, ...long.sent].map(header)).toEqual([
      undefined,
      "true",
      "true",
      undefined,
    ]);
  });
});
