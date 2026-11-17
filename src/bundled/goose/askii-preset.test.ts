import { describe, expect, it } from "vitest";
import {
  askiiBuildInputs,
  askiiEnv,
  askiiOrigin,
  compiledPreset,
  expiryOf,
  resolveAskiiKey,
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

  it("marks anything else unreadable", () => {
    for (const bad of ["soon", {}, [], true, Number.NaN])
      expect(expiryOf(bad)).toBeNull();
  });
});

describe("toolkitKey", () => {
  it("uses a valid file's key with its own platform URL", () => {
    expect(
      toolkitKey(
        credentials({
          platform_url: "https://api.sandbox.askii.example",
          expires: "2027-02-15T10:00:00Z",
          user_id: "u",
        }),
        preset,
        now,
      ),
    ).toEqual({
      key: TOOLKIT_KEY,
      url: "https://api.sandbox.askii.example",
      source: "toolkit",
      expires: Date.parse("2027-02-15T10:00:00Z"),
    });
  });

  it("falls back to the build's URL when platform_url is absent or unsafe", () => {
    for (const platform_url of [undefined, "", "http://localhost:4000", 42])
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
  it("prefers the toolkit's key to a pasted one", () => {
    expect(
      resolveAskiiKey(
        preset,
        { toolkit: credentials({}), pasted: PASTED_KEY },
        now,
      )?.source,
    ).toBe("toolkit");
  });

  it("uses the pasted key, at the build's URL, when the file is unusable", () => {
    for (const toolkit of [
      null,
      "not json",
      credentials({
        expires: "2020-01-01T00:00:00Z",
        platform_url: "https://elsewhere.example",
      }),
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

describe("askiiEnv", () => {
  it("configures goose's LiteLLM provider", () => {
    expect(
      askiiEnv({ key: PASTED_KEY, url: preset.url, source: "pasted" }),
    ).toEqual({ LITELLM_HOST: preset.url, LITELLM_API_KEY: PASTED_KEY });
  });
});
