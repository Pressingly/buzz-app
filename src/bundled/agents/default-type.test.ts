import { describe, expect, it } from "vitest";
import { GOOSE_TYPE_KEY, defaultAgentType } from "./default-type";

const preset = { url: "https://api.askii.example", model: "gpt-5-mini" };
const codex = { key: "buzz.codex/codex" };
const goose = { key: GOOSE_TYPE_KEY };

describe("defaultAgentType", () => {
  it("starts new agents on Goose in an Askii build", () => {
    expect(defaultAgentType([codex, goose], preset)).toBe(goose);
  });

  it("keeps the first type without the Askii preset", () => {
    expect(defaultAgentType([codex, goose], undefined)).toBe(codex);
  });

  it("keeps the first type when Goose is not available", () => {
    expect(defaultAgentType([codex], preset)).toBe(codex);
    expect(defaultAgentType([], preset)).toBeUndefined();
  });
});
