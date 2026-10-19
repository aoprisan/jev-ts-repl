/**
 * Images, for Jev 1.13 and later. Experimental: TypeSafe calls them a danger-zone feature, not
 * production-ready, and the client sends `TypeSafe-Danger-Zone-Images: true` for any call that
 * carries one.
 *
 * Each image goes once into the call's `assets`, under a reference string of your choosing, and
 * the model sees it wherever that reference is written — in the state, an instruction or a
 * criterion. Every reference must be used somewhere.
 *
 * ```ts
 * const res = await client.systemOne(
 *   { photo: "photo", caption: "Our new office" },
 *   { has_people: noul("photo shows at least one person"), door: box("the front door in photo") },
 *   { model: "jev-1.14.0", assets: { photo: image(await readFile("office.jpg")) } },
 * );
 * ```
 */

import type { Json, JsonObject } from "../json.js";
import { InvalidRequestError } from "./errors.js";

/** The image formats the API reads. */
export type ImageFormat = "png" | "jpeg" | "jpg";

/** An image, base64-encoded, as it goes into `assets`. */
export interface ImageAsset {
  readonly type: "image";
  readonly format: ImageFormat;
  /** The file's bytes, base64-encoded (`data_base64` on the wire). */
  readonly dataBase64: string;
}

/** Anything that can go into `assets`. Images are the only kind so far. */
export type Asset = ImageAsset;

/** Assets by the reference string that stands for them in the request. */
export type Assets = Readonly<Record<string, Asset>>;

const FORMATS: readonly string[] = ["png", "jpeg", "jpg"];

/**
 * An image from its bytes. The format is read from the bytes when it is not given; anything but a
 * PNG or a JPEG is an {@link InvalidRequestError}. Size limits (256 to 1568 pixels a side) are
 * left to the API.
 */
export function image(data: Uint8Array | ArrayBuffer, format?: ImageFormat): ImageAsset {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const sniffed = sniff(bytes);
  if (sniffed === undefined) {
    throw new InvalidRequestError("An image must be a PNG or a JPEG.");
  }
  return { type: "image", format: format ?? sniffed, dataBase64: toBase64(bytes) };
}

/** An image already base64-encoded, e.g. read from a data URL. */
export function imageBase64(dataBase64: string, format: ImageFormat): ImageAsset {
  if (!FORMATS.includes(format)) {
    throw new InvalidRequestError(`An image's format must be png, jpeg or jpg, got ${format}.`);
  }
  return { type: "image", format, dataBase64 };
}

function sniff(bytes: Uint8Array): ImageFormat | undefined {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((b, i) => bytes[i] === b)) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  return undefined;
}

function toBase64(bytes: Uint8Array): string {
  const buffer = (
    globalThis as { Buffer?: { from(b: Uint8Array): { toString(e: string): string } } }
  ).Buffer;
  if (buffer !== undefined) return buffer.from(bytes).toString("base64");
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** The `assets` object of the request body. */
export function assetsToJson(assets: Assets): JsonObject {
  const out: JsonObject = {};
  for (const [ref, asset] of Object.entries(assets)) {
    out[ref] = { type: asset.type, data_base64: asset.dataBase64, format: asset.format };
  }
  return out;
}

/**
 * Reject what the API would: an empty reference, or one that the state and the questions never
 * mention, which the model would never see.
 */
export function validateAssets(assets: Assets, state: Json, questions: Json): void {
  const text = JSON.stringify([state, questions]);
  for (const ref of Object.keys(assets)) {
    if (ref === "") throw new InvalidRequestError("An asset's reference must not be empty.");
    if (!text.includes(JSON.stringify(ref).slice(1, -1))) {
      throw new InvalidRequestError(
        `Asset "${ref}" is not referenced; write "${ref}" in the state, an instruction or a criterion.`,
      );
    }
  }
}
