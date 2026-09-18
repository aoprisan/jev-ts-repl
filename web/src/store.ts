/**
 * What the browser is allowed to remember. Settings are a convenience; the key is not stored at
 * all unless it is explicitly asked for, and `forgetKey` is one removal away on every screen.
 *
 * Every read and write is guarded: in a private window, or with site data blocked, storage throws
 * or comes back empty and the app has to work anyway.
 */

const SETTINGS = "jev.settings";
const KEY = "jev.key";

export interface Settings {
  page: string;
  model: string;
  baseUrl: string;
  threshold: number;
  remember: boolean;
}

export const DEFAULTS: Settings = {
  page: "",
  model: "",
  baseUrl: "",
  threshold: 0.5,
  remember: false,
};

function read(name: string): string | undefined {
  try {
    return window.localStorage.getItem(name) ?? undefined;
  } catch {
    return undefined;
  }
}

function write(name: string, value: string): void {
  try {
    window.localStorage.setItem(name, value);
  } catch {
    /* storage unavailable — the session simply does not outlive the tab */
  }
}

function drop(name: string): void {
  try {
    window.localStorage.removeItem(name);
  } catch {
    /* as above */
  }
}

export function loadSettings(): Settings {
  const raw = read(SETTINGS);
  if (raw === undefined) return { ...DEFAULTS };
  try {
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      page: typeof parsed.page === "string" ? parsed.page : DEFAULTS.page,
      model: typeof parsed.model === "string" ? parsed.model : DEFAULTS.model,
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : DEFAULTS.baseUrl,
      threshold: typeof parsed.threshold === "number" ? parsed.threshold : DEFAULTS.threshold,
      remember: parsed.remember === true,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: Settings): void {
  write(SETTINGS, JSON.stringify(settings));
}

/** The key, if a previous session was told to keep it on this device. */
export function loadKey(): string | undefined {
  return read(KEY);
}

export function rememberKey(key: string): void {
  write(KEY, key);
}

export function forgetKey(): void {
  drop(KEY);
}
