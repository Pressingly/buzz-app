import { describe, expect, it, vi } from "vitest";
import {
  type AskiiStore,
  askiiKeyStatus,
  askiiLaunch,
  currentAskiiKey,
  seedAskiiDefaults,
} from "./askii";

const preset = { url: "https://api.askii.example", model: "gpt-5-mini" };
const now = Date.parse("2026-11-17T12:00:00Z");
const TOOLKIT_KEY = "sk-toolkit-0123456789";
const PASTED_KEY = "sk-pasted-0123456789";

const store = (
  toolkit: string | null | Error,
  pasted: string | null | Error,
): AskiiStore => {
  const read = (value: string | null | Error) => () =>
    value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  return {
    toolkitCredentials: vi.fn(read(toolkit)),
    pasted: vi.fn(read(pasted)),
    savePasted: vi.fn(async () => {}),
    clearPasted: vi.fn(async () => {}),
  };
};

describe("currentAskiiKey", () => {
  it("asks native for nothing without a preset", async () => {
    const native = store(null, PASTED_KEY);
    expect(await currentAskiiKey(undefined, native, now)).toBeUndefined();
    expect(native.toolkitCredentials).not.toHaveBeenCalled();
    expect(native.pasted).not.toHaveBeenCalled();
  });

  it("uses the pasted key when the toolkit file cannot be read", async () => {
    expect(
      await currentAskiiKey(
        preset,
        store(new Error("denied"), PASTED_KEY),
        now,
      ),
    ).toEqual({ key: PASTED_KEY, url: preset.url, source: "pasted" });
  });

  it("uses the toolkit's key when the keychain cannot be read", async () => {
    expect(
      await currentAskiiKey(
        preset,
        store(JSON.stringify({ api_key: TOOLKIT_KEY }), new Error("locked")),
        now,
      ),
    ).toMatchObject({ key: TOOLKIT_KEY, source: "toolkit" });
  });
});

describe("askiiKeyStatus", () => {
  it("names the key in use without carrying it", async () => {
    const status = await askiiKeyStatus(
      preset,
      store(
        JSON.stringify({
          api_key: TOOLKIT_KEY,
          expires: "2027-01-01T00:00:00Z",
        }),
        PASTED_KEY,
      ),
      now,
    );
    expect(status).toEqual({
      active: { source: "pasted" },
      pastedSaved: true,
      toolkitUsable: true,
    });
    expect(JSON.stringify(status)).not.toContain("sk-");
  });

  it("reports no key", async () => {
    expect(await askiiKeyStatus(preset, store(null, null), now)).toEqual({
      pastedSaved: false,
      toolkitUsable: false,
    });
  });
});

describe("askiiKeyStatus with only the toolkit's key", () => {
  it("names the toolkit and its expiry", async () => {
    expect(
      await askiiKeyStatus(
        preset,
        store(
          JSON.stringify({
            api_key: TOOLKIT_KEY,
            expires: "2027-01-01T00:00:00Z",
          }),
          null,
        ),
        now,
      ),
    ).toEqual({
      active: {
        source: "toolkit",
        expires: Date.parse("2027-01-01T00:00:00Z"),
      },
      pastedSaved: false,
      toolkitUsable: true,
    });
  });
});

describe("askiiLaunch", () => {
  it("passes goose nothing without a preset or a key", async () => {
    const key = vi.fn(async () => undefined);
    expect((await askiiLaunch(undefined, key)).env).toEqual({});
    expect(key).not.toHaveBeenCalled();
    expect((await askiiLaunch(preset, key)).env).toEqual({});
  });

  it("passes goose the key and seeds its defaults", async () => {
    const launch = await askiiLaunch(preset, async () => ({
      key: PASTED_KEY,
      url: preset.url,
      source: "pasted",
    }));
    expect(launch.env).toEqual({
      LITELLM_HOST: preset.url,
      LITELLM_API_KEY: PASTED_KEY,
    });
    const request = vi.fn(async (method: string) =>
      method.endsWith("/read") ? { providerId: null, modelId: null } : {},
    );
    await launch.seed({ request } as never, 1000);
    expect(request).toHaveBeenLastCalledWith(
      "_goose/unstable/defaults/save",
      { providerId: "litellm", modelId: "gpt-5-mini" },
      1000,
    );
  });
});

describe("seedAskiiDefaults", () => {
  it("keeps any default goose already has", async () => {
    for (const saved of [
      { providerId: "anthropic", modelId: null },
      { providerId: null, modelId: "claude" },
    ]) {
      const request = vi.fn(async () => saved);
      await seedAskiiDefaults({ request } as never, preset, 1000);
      expect(request).toHaveBeenCalledTimes(1);
    }
  });
});
