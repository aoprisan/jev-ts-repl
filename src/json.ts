/** The JSON values that instructions, criteria and state are made of. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type JsonObject = { [key: string]: Json };

export function isObject(v: Json | undefined): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Pretty-print the way `serde_json::to_string_pretty` does: two spaces, keys in insertion order. */
export function pretty(v: Json): string {
  return JSON.stringify(v, null, 2) ?? "null";
}

/** Compact JSON, the way `Value::to_string` renders it. */
export function compact(v: Json): string {
  return JSON.stringify(v) ?? "null";
}

/** JSON strings read better unquoted; everything else stays JSON. */
export function textOf(v: Json | undefined): string {
  if (v === undefined) return "";
  return typeof v === "string" ? v : compact(v);
}

/** Parse, returning `undefined` rather than throwing. */
export function tryParse(text: string): Json | undefined {
  try {
    return JSON.parse(text) as Json;
  } catch {
    return undefined;
  }
}

/** The message a `JSON.parse` failure carries, without the engine's prefix noise. */
export function parseError(text: string): string {
  try {
    JSON.parse(text);
    return "";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Is this state empty enough that there is nothing to judge? */
export function isEmptyValue(v: Json): boolean {
  if (v === null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (isObject(v)) return Object.keys(v).length === 0;
  return false;
}
