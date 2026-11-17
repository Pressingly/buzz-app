import { describe, expect, it } from "vitest";
import {
  askiiBuildInputs,
  askiiEnv,
  askiiOrigin,
  compiledPreset,
  expiryOf,
  resolveAskiiKey,
  sameAskiiKey,
  toolkitKey,
} from "./askii-preset";

const preset = { url: "https://api.askii.example", model: "gpt-5-mini" };
const now = Date.parse("2026-11-17T12:00:00Z");
const TOOLKIT_KEY = "sk-toolkit-0123456789";
const PASTED_KEY = "sk-pasted-0123456789";
const credentials = (fields: Record<string, unknown>) =>
  JSON.stringify({ api_key: TOOLKIT_KEY, ...fields });

describe("askiiOrigin", () => {
  it("takes an https origin with or without /v1", () => {
    expect(askiiOrigin("https://api.askii.example")).toBe(
      "https://api.askii.example",
    );
    expect(askiiOrigin(" https://api.askii.example/v1/ ")).toBe(
      "https://api.askii.example",
    );
    expect(askiiOrigin("https://host.example/askii/v1")).toBe(
      "https://host.example/askii",
    );
  });

  it("refuses insecure, credentialed and unparseable URLs", () => {
    for (const bad of [
      "http://api.askii.example",
      "https://user:secret@api.askii.example",
      "https://api.askii.example/?key=1",
      "api.askii.example",
      "",
    ])
      expect(askiiOrigin(bad)).toBeUndefined();
  });
});

describe("askiiBuildInputs", () => {
  it("is no preset when the URL is unset", () => {
    expect(askiiBuildInputs({})).toEqual({ url: "", model: "" });
    expect(askiiBuildInputs({ BUZZ_BUILD_ASKII_URL: " " })).toEqual({
      url: "",
      model: "",
    });
  });

  it("defaults the model to gpt-5-mini", () => {
    expect(
      askiiBuildInputs({
        BUZZ_BUILD_ASKII_URL: "https://api.askii.example/v1",
      }),
    ).toEqual(preset);
    expect(
      askiiBuildInputs({
        BUZZ_BUILD_ASKII_URL: "https://api.askii.example",
        BUZZ_BUILD_ASKII_MODEL: "gpt-5",
      }).model,
    ).toBe("gpt-5");
  });

  it("fails the build on invalid input without echoing it", () => {
    expect(() =>
      askiiBuildInputs({ BUZZ_BUILD_ASKII_URL: "https://u:secret@x.example" }),
    ).toThrow(/^BUZZ_BUILD_ASKII_URL must be an https:\/\/ URL/);
    expect(() =>
      askiiBuildInputs({ BUZZ_BUILD_ASKII_MODEL: "gpt-5-mini" }),
    ).toThrow(/needs BUZZ_BUILD_ASKII_URL/);
  });
});

describe("compiledPreset", () => {
  it("is undefined without a compiled URL", () => {
    expect(compiledPreset("", "")).toBeUndefined();
    expect(compiledPreset(undefined, undefined)).toBeUndefined();
    expect(compiledPreset(preset.url, "")).toEqual(preset);
  });
});

describe("expiryOf", () => {
  it("reads no expiry from what mpass-login.sh writes without one", () => {
    for (const none of [undefined, null, "", " ", "None"])
      expect(expiryOf(none)).toBeUndefined();
  });

  it("reads ISO times, as UTC when they name no offset", () => {
    expect(expiryOf("2027-02-15T10:00:00Z")).toBe(
      Date.parse("2027-02-15T10:00:00Z"),
    );
    expect(expiryOf("2027-02-15T10:00:00.123456")).toBe(
      Date.parse("2027-02-15T10:00:00.123Z"),
    );
    expect(expiryOf("2027-02-15T15:00:00+05:00")).toBe(
      Date.parse("2027-02-15T10:00:00Z"),
    );
  });

  it("reads epoch seconds and milliseconds", () => {
    expect(expiryOf(1_800_000_000)).toBe(1_800_000_000_000);
    expect(expiryOf(1_800_000_000_000)).toBe(1_800_000_000_000);
  });

  it("reads an all-digits string as epoch seconds or milliseconds", () => {
    expect(expiryOf("1800000000")).toBe(1_800_000_000_000);
    expect(expiryOf(" 1800000000000 ")).toBe(1_800_000_000_000);
  });

  it("reads a date as valid through the end of that day, UTC", () => {
    expect(expiryOf("2027-02-15")).toBe(Date.parse("2027-02-15T23:59:59.999Z"));
    expect(expiryOf("2027-02-30")).toBeNull();
  });

  it("reads a space-separated time as UTC", () => {
    expect(expiryOf("2027-02-15 10:00:00")).toBe(
      Date.parse("2027-02-15T10:00:00Z"),
    );
  });

  it("marks anything else unreadable", () => {
    for (const bad of [
      "soon",
      "Feb 15 2027",
      "2027-02",
      {},
      [],
      true,
      Number.NaN,
    ])
      expect(expiryOf(bad)).toBeNull();
  });
});

describe("toolkitKey", () => {
  it("uses a valid file's key with its own platform URL", () => {
    expect(
      toolkitKey(
        credentials({
          platform_url: "https://api.sandbox.askii.ai/v1",
          expires: "2027-02-15T10:00:00Z",
          user_id: "u",
        }),
        preset,
        now,
      ),
    ).toEqual({
      key: TOOLKIT_KEY,
      url: "https://api.sandbox.askii.ai",
      source: "toolkit",
      expires: Date.parse("2027-02-15T10:00:00Z"),
    });
  });

  it("accepts a platform_url on the build's host", () => {
    expect(
      toolkitKey(
        credentials({ platform_url: "https://api.askii.example/v1" }),
        preset,
        now,
      )?.url,
    ).toBe("https://api.askii.example");
  });

  it("falls back to the build's URL when platform_url is absent, unsafe or not Askii's", () => {
    for (const platform_url of [
      undefined,
      "",
      "http://localhost:4000",
      "http://api.askii.ai",
      "https://evil.example",
      "https://notaskii.ai",
      "https://askii.ai.evil.example",
      "https://evilaskii.ai",
      42,
    ])
      expect(toolkitKey(credentials({ platform_url }), preset, now)?.url).toBe(
        preset.url,
      );
  });

  it("refuses an expired key", () => {
    expect(
      toolkitKey(credentials({ expires: "2026-11-17T12:00:00Z" }), preset, now),
    ).toBeUndefined();
    expect(
      toolkitKey(credentials({ expires: "2026-01-01T00:00:00" }), preset, now),
    ).toBeUndefined();
  });

  it("reads a file saved with a byte order mark", () => {
    expect(toolkitKey(`\uFEFF${credentials({})}`, preset, now)?.key).toBe(
      TOOLKIT_KEY,
    );
  });

  it("keeps a key whose expiry Askii did not send", () => {
    expect(
      toolkitKey(credentials({ expires: "None" }), preset, now),
    ).toMatchObject({ key: TOOLKIT_KEY, source: "toolkit" });
  });

  it("refuses a missing or malformed file", () => {
    for (const text of [
      null,
      "",
      "{",
      "[]",
      '"sk-toolkit-0123456789"',
      JSON.stringify({ platform_url: preset.url }),
      JSON.stringify({ api_key: "" }),
      JSON.stringify({ api_key: 42 }),
      JSON.stringify({ api_key: "sk with spaces 123" }),
      credentials({ expires: "next quarter" }),
    ])
      expect(toolkitKey(text, preset, now)).toBeUndefined();
  });
});

describe("resolveAskiiKey", () => {
  it("prefers a pasted key to the toolkit's", () => {
    expect(
      resolveAskiiKey(
        preset,
        { toolkit: credentials({}), pasted: PASTED_KEY },
        now,
      )?.source,
    ).toBe("pasted");
  });

  it("falls back to the toolkit's key without a pasted one", () => {
    for (const pasted of [null, "short"])
      expect(
        resolveAskiiKey(preset, { toolkit: credentials({}), pasted }, now),
      ).toMatchObject({ key: TOOLKIT_KEY, source: "toolkit" });
  });

  it("sends a pasted key to the build's URL, whatever the file names", () => {
    for (const toolkit of [
      null,
      "not json",
      credentials({ platform_url: "https://api.sandbox.askii.ai" }),
    ])
      expect(
        resolveAskiiKey(preset, { toolkit, pasted: ` ${PASTED_KEY} ` }, now),
      ).toEqual({ key: PASTED_KEY, url: preset.url, source: "pasted" });
  });

  it("is undefined with neither", () => {
    expect(
      resolveAskiiKey(preset, { toolkit: null, pasted: null }, now),
    ).toBeUndefined();
    expect(
      resolveAskiiKey(preset, { toolkit: null, pasted: "short" }, now),
    ).toBeUndefined();
  });
});

describe("sameAskiiKey", () => {
  it("compares the key and host goose starts with", () => {
    const pasted = {
      key: PASTED_KEY,
      url: preset.url,
      source: "pasted",
    } as const;
    expect(sameAskiiKey(pasted, { ...pasted, source: "toolkit" })).toBe(true);
    expect(sameAskiiKey(undefined, undefined)).toBe(true);
    expect(sameAskiiKey(pasted, undefined)).toBe(false);
    expect(sameAskiiKey(pasted, { ...pasted, key: TOOLKIT_KEY })).toBe(false);
    expect(sameAskiiKey(pasted, { ...pasted, url: "https://x.askii.ai" })).toBe(
      false,
    );
  });
});

describe("askiiEnv", () => {
  it("configures goose's LiteLLM provider", () => {
    expect(
      askiiEnv({ key: PASTED_KEY, url: preset.url, source: "pasted" }),
    ).toEqual({ LITELLM_HOST: preset.url, LITELLM_API_KEY: PASTED_KEY });
  });
});
