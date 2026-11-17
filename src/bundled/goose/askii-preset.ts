// The Askii preset for the bundled goose, a Pressingly fork addition: goose's
// LiteLLM provider pointed at the build's Askii platform, with a key from the
// AI Productivity Toolkit's `~/.askii/credentials.json` or one the person
// pasted. Pure rules only; `askii.ts` reads the file and the keychain.

export const DEFAULT_ASKII_MODEL = "gpt-5-mini";
/** goose's provider for an OpenAI-compatible LiteLLM proxy, which Askii is. */
export const ASKII_PROVIDER = "litellm";

export type AskiiPreset = Readonly<{ url: string; model: string }>;
export type AskiiKey = Readonly<{
  key: string;
  url: string;
  source: "toolkit" | "pasted";
  /** Epoch milliseconds, when the toolkit file names an expiry. */
  expires?: number;
}>;

/** An `https://` origin without credentials, query or `/v1` suffix, as goose's
 * `LITELLM_HOST` takes it; undefined for anything else. */
export function askiiOrigin(raw: string): string | undefined {
  const text = raw.trim();
  if (!URL.canParse(text)) return undefined;
  const url = new URL(text);
  if (url.protocol !== "https:" || url.username || url.password)
    return undefined;
  if (url.search || url.hash) return undefined;
  const path = url.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "");
  return `${url.origin}${path}`;
}

/** The build inputs `BUZZ_BUILD_ASKII_URL` and `BUZZ_BUILD_ASKII_MODEL`, as
 * the build compiles them in. An unset URL is no preset; invalid input
 * throws, so the build fails. */
export function askiiBuildInputs(
  env: Readonly<Record<string, string | undefined>>,
): AskiiPreset {
  const rawUrl = env.BUZZ_BUILD_ASKII_URL?.trim() ?? "";
  const rawModel = env.BUZZ_BUILD_ASKII_MODEL?.trim() ?? "";
  if (!rawUrl) {
    if (rawModel)
      throw new Error("BUZZ_BUILD_ASKII_MODEL needs BUZZ_BUILD_ASKII_URL.");
    return { url: "", model: "" };
  }
  const url = askiiOrigin(rawUrl);
  if (!url)
    throw new Error(
      "BUZZ_BUILD_ASKII_URL must be an https:// URL without credentials.",
    );
  return { url, model: rawModel || DEFAULT_ASKII_MODEL };
}

/** The compiled preset, or undefined in builds without one. */
export function compiledPreset(
  url: string | undefined,
  model: string | undefined,
): AskiiPreset | undefined {
  return url ? { url, model: model || DEFAULT_ASKII_MODEL } : undefined;
}

const KEY = /^[\x21-\x7e]{8,512}$/u;

/** A key that can go into goose's environment as is. */
export const validKey = (key: string): boolean => KEY.test(key);

const DIGITS = /^\d+$/u;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/u;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/u;
const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/iu;

/** `expires` as the toolkit's login scripts write it: an ISO time (UTC when it
 * names no offset), a date (valid through that day, UTC), epoch seconds or
 * milliseconds, or `""`/`"None"` when Askii sent none. Undefined means no
 * expiry, null an unreadable one. */
export function expiryOf(value: unknown): number | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number")
    return Number.isFinite(value) ? epochMs(value) : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "" || text === "None") return undefined;
  if (DIGITS.test(text)) return epochMs(Number(text));
  const date = DATE_ONLY.exec(text);
  if (date)
    return endOfDayUtc(Number(date[1]), Number(date[2]), Number(date[3]));
  if (!ISO_TIME.test(text)) return null;
  // The standard's own form (`T`, at most milliseconds), which every engine
  // reads alike; Python writes a space or microseconds.
  const iso = text.replace(" ", "T").replace(/(\.\d{3})\d+/u, "$1");
  const time = Date.parse(HAS_ZONE.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(time) ? null : time;
}

const epochMs = (value: number) => (value < 1e12 ? value * 1000 : value);

/** Built from parts, so every JavaScript engine reads it alike. */
function endOfDayUtc(year: number, month: number, day: number): number | null {
  const start = Date.UTC(year, month - 1, day);
  const parsed = new Date(start);
  const real =
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day;
  return real ? Date.UTC(year, month - 1, day + 1) - 1 : null;
}

/** `platform_url` names an Askii host: the build's own, or one under
 * `askii.ai`, so a stray file cannot send the key elsewhere. */
export function trustedPlatform(
  raw: unknown,
  preset: AskiiPreset,
): string | undefined {
  if (typeof raw !== "string") return undefined;
  const origin = askiiOrigin(raw);
  if (!origin) return undefined;
  const host = new URL(origin).hostname;
  const trusted =
    host === new URL(preset.url).hostname || host.endsWith(".askii.ai");
  return trusted ? origin : undefined;
}

/** The toolkit's key while it is unexpired, with its own platform URL when
 * that is a trusted Askii origin, else the build's. */
export function toolkitKey(
  text: string | null,
  preset: AskiiPreset,
  now: number,
): AskiiKey | undefined {
  const credentials = parsedObject(text);
  const key = credentials?.api_key;
  if (typeof key !== "string" || !validKey(key.trim())) return undefined;
  const expires = expiryOf(credentials?.expires);
  if (expires === null || (expires !== undefined && expires <= now))
    return undefined;
  return {
    key: key.trim(),
    url: trustedPlatform(credentials?.platform_url, preset) ?? preset.url,
    source: "toolkit",
    ...(expires !== undefined && { expires }),
  };
}

function parsedObject(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text.replace(/^\uFEFF/u, ""));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A pasted key always goes to the build's platform, so a file on disk can
 * never redirect it. */
export function pastedKey(
  pasted: string | null,
  preset: AskiiPreset,
): AskiiKey | undefined {
  const key = pasted?.trim() ?? "";
  return validKey(key) ? { key, url: preset.url, source: "pasted" } : undefined;
}

/** A pasted key first, as the person chose it; else the toolkit's. */
export const resolveAskiiKey = (
  preset: AskiiPreset,
  sources: Readonly<{ toolkit: string | null; pasted: string | null }>,
  now: number,
): AskiiKey | undefined =>
  pastedKey(sources.pasted, preset) ?? toolkitKey(sources.toolkit, preset, now);

/** Whether goose would start with another key or host. */
export const sameAskiiKey = (
  a: AskiiKey | undefined,
  b: AskiiKey | undefined,
): boolean => a?.key === b?.key && a?.url === b?.url;

/** What goose's LiteLLM provider reads from its environment. */
export const askiiEnv = (key: AskiiKey): Record<string, string> => ({
  LITELLM_HOST: key.url,
  LITELLM_API_KEY: key.key,
});
