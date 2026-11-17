// Where the Askii preset's key comes from (`askii_key.rs`), and what goose is
// started with because of it. Builds without `BUZZ_BUILD_ASKII_URL` ask native
// for nothing and pass goose nothing.
import { invoke } from "@tauri-apps/api/core";
import type { AcpProcess } from "../../features/agent-harness/acp/process";
import {
  ASKII_PROVIDER,
  type AskiiKey,
  type AskiiPreset,
  askiiEnv,
  compiledPreset,
  resolveAskiiKey,
  toolkitKey,
} from "./askii-preset";

export type AskiiStore = Readonly<{
  toolkitCredentials(): Promise<string | null>;
  pasted(): Promise<string | null>;
  savePasted(key: string): Promise<void>;
  clearPasted(): Promise<void>;
}>;

export const nativeAskiiStore: AskiiStore = {
  toolkitCredentials: () => invoke<string | null>("askii_toolkit_credentials"),
  pasted: () => invoke<string | null>("askii_key_read"),
  savePasted: (key) => invoke("askii_key_save", { key }),
  clearPasted: () => invoke("askii_key_clear"),
};

/** Built with `BUZZ_BUILD_ASKII_URL`, or undefined. */
export const askiiPreset = (): AskiiPreset | undefined =>
  compiledPreset(
    import.meta.env.VITE_BUZZ_ASKII_URL,
    import.meta.env.VITE_BUZZ_ASKII_MODEL,
  );

/** A source that cannot be read counts as absent, so the other still can. */
const orNull = (read: Promise<string | null>) => read.catch(() => null);

const readSources = async (store: AskiiStore) => {
  const [toolkit, pasted] = await Promise.all([
    orNull(store.toolkitCredentials()),
    orNull(store.pasted()),
  ]);
  return { toolkit, pasted };
};

/** The key goose would start with now, or undefined. */
export async function currentAskiiKey(
  preset = askiiPreset(),
  store: AskiiStore = nativeAskiiStore,
  now = Date.now(),
): Promise<AskiiKey | undefined> {
  if (!preset) return undefined;
  return resolveAskiiKey(preset, await readSources(store), now);
}

export type AskiiKeyStatus = Readonly<{
  active?: Pick<AskiiKey, "source" | "expires">;
  pastedSaved: boolean;
  /** Whether the toolkit's key would be used without the pasted one. */
  toolkitUsable: boolean;
}>;

/** Which key goose would use, for the settings, without the key itself. */
export async function askiiKeyStatus(
  preset: AskiiPreset,
  store: AskiiStore = nativeAskiiStore,
  now = Date.now(),
): Promise<AskiiKeyStatus> {
  const sources = await readSources(store);
  const active = resolveAskiiKey(preset, sources, now);
  return {
    ...(active && {
      active: {
        source: active.source,
        ...(active.expires !== undefined && { expires: active.expires }),
      },
    }),
    pastedSaved: sources.pasted !== null,
    toolkitUsable: toolkitKey(sources.toolkit, preset, now) !== undefined,
  };
}

export type AskiiLaunch = Readonly<{
  /** What goose's LiteLLM provider reads from its environment. */
  env: Readonly<Record<string, string>>;
  /** Run once goose has started; see `seedAskiiDefaults`. */
  seed(goose: Pick<AcpProcess, "request">, timeoutMs: number): Promise<void>;
}>;

const NO_LAUNCH: AskiiLaunch = { env: {}, seed: async () => {} };

/** The preset's part of a `goose-acp` about to start: nothing without a
 * preset or a key. */
export async function askiiLaunch(
  preset = askiiPreset(),
  key: () => Promise<AskiiKey | undefined> = () => currentAskiiKey(preset),
): Promise<AskiiLaunch> {
  const resolved = preset && (await key());
  if (!preset || !resolved) return NO_LAUNCH;
  return {
    env: askiiEnv(resolved),
    seed: (goose, timeoutMs) => seedAskiiDefaults(goose, preset, timeoutMs),
  };
}

type Defaults = { providerId?: string | null; modelId?: string | null };

/** Makes the preset goose's default provider and model when goose has none,
 * through goose's own defaults, as the Goose defaults dialog saves them. Any
 * default the person or `goose configure` saved is kept. */
export async function seedAskiiDefaults(
  goose: Pick<AcpProcess, "request">,
  preset: AskiiPreset,
  timeoutMs: number,
): Promise<void> {
  const defaults = (await goose.request(
    "_goose/unstable/defaults/read",
    {},
    timeoutMs,
  )) as Defaults;
  if (defaults.providerId || defaults.modelId) return;
  await goose.request(
    "_goose/unstable/defaults/save",
    { providerId: ASKII_PROVIDER, modelId: preset.model },
    timeoutMs,
  );
}
