// Which harness a new agent starts on, a Pressingly fork addition. A build with
// the Askii preset sets goose up with a key and model, so its new agents start
// on Goose; without it, the first registered type, as upstream.
import type { RegisteredAgentType } from "../../features/agents/service";
import { askiiPreset } from "../goose/askii";
import type { AskiiPreset } from "../goose/askii-preset";

export const GOOSE_TYPE_KEY = "buzz.goose/goose";

export const defaultAgentType = <T extends Pick<RegisteredAgentType, "key">>(
  types: readonly T[],
  preset: AskiiPreset | undefined = askiiPreset(),
): T | undefined =>
  (preset && types.find((type) => type.key === GOOSE_TYPE_KEY)) || types[0];
