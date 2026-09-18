/**
 * A sketch page in the URL: `#p=<base64url of the UTF-8 text>`. The page is all that travels —
 * never the key, never the base URL.
 */

export function encode(page: string): string {
  const bytes = new TextEncoder().encode(page);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decode(param: string): string | undefined {
  try {
    const padded = param.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

/** The page in the current URL's fragment, if there is one. */
export function fromLocation(): string | undefined {
  const match = /[#&]p=([^&]+)/.exec(window.location.hash);
  return match?.[1] === undefined ? undefined : decode(match[1]);
}

export function link(page: string): string {
  const url = new URL(window.location.href);
  url.hash = `p=${encode(page)}`;
  return url.toString();
}
