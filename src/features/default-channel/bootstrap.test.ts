import { describe, expect, it, vi } from "vitest";
import type { RelayEvent, ReadFilter } from "../relay/events";
import type { OutgoingEvent } from "../relay/outbox";
import type { RelayData, RelaySnapshot } from "../relay/service";
import { bindDefaultChannel } from "./bind";
import { ensureDefaultChannel, type DefaultChannelSession } from "./bootstrap";
import { starterChannelId, uuidV5 } from "./starter-id";

const RELAY = "a".repeat(64);
const OWNER = "b".repeat(64);
const MEMBER = "c".repeat(64);
const ORIGIN = "https://buzz.example";
const EXISTING = "11111111-1111-4111-8111-111111111111";

let sequence = 0;
const event = (kind: number, tags: string[][]): RelayEvent =>
  ({
    id: (sequence++).toString(16).padStart(64, "0"),
    pubkey: RELAY,
    created_at: 1_700_000_000,
    kind,
    content: "",
    tags,
    sig: "0".repeat(128),
  }) as unknown as RelayEvent;

const roster = (role: string) =>
  event(13534, [
    ["member", OWNER, role],
    ["member", MEMBER, "member"],
  ]);

const channel = (id: string, name: string, extra: string[][] = []) =>
  event(39000, [["d", id], ["name", name], ["t", "stream"], ...extra]);
const open = (id: string, name: string, extra: string[][] = []) =>
  channel(id, name, [["public"], ...extra]);

type Fixture = {
  role?: string;
  channels?: RelayEvent[];
  /** Metadata the relay holds for an id after a create. */
  created?: (id: string) => RelayEvent[];
  delivery?: Partial<OutgoingEvent>;
};

function fixture({
  role = "owner",
  channels = [],
  created = (id) => [open(id, "general")],
  delivery = { delivery: "accepted" },
}: Fixture = {}) {
  const sent: { kind: number; content: string; tags: string[][] }[] = [];
  const run = vi.fn(
    async (_action: string, _channel: string, _signal?: AbortSignal) => {},
  );
  const read = vi.fn(async (filters: readonly ReadFilter[]) => {
    const [filter] = filters;
    if (filter?.kinds?.includes(13534)) return [roster(role)];
    const id = filter?.["#d"]?.[0];
    return id ? created(id) : channels;
  });
  const items: OutgoingEvent[] = [];
  const outbox = {
    ready: vi.fn(async () => {}),
    supports: (kind: number) => kind === 9007,
    send: vi.fn(
      (input: { kind: number; content: string; tags: string[][] }) => {
        sent.push(input);
        const id = `event-${sent.length}`;
        items.push({
          event: { ...input, id, pubkey: OWNER, created_at: 0 },
          delivery: "sending",
          ...delivery,
        } as OutgoingEvent);
        return id;
      },
    ),
    snapshot: () => items,
    subscribe: () => () => {},
    dismiss: vi.fn(async () => {}),
  };
  const session: DefaultChannelSession = {
    viewer: OWNER,
    origin: ORIGIN,
    relayAuthor: RELAY,
    read,
    outbox,
    lifecycle: { available: true, run },
  };
  const log = vi.fn();
  const ensure = () =>
    ensureDefaultChannel("general", session, new AbortController().signal, log);
  return { ensure, run, sent, outbox, log };
}

describe("starter channel id", () => {
  it("matches Python's uuid.uuid5 for upstream's namespace", async () => {
    expect(
      await uuidV5(
        "3ce33bea-8f09-5f1b-9c85-8a7d2659e6b0",
        "starter-channel:v1:https://x.example:general",
      ),
    ).toBe("b4e88e15-9690-58bd-90f2-5f2f9dc9f089");
  });
});

describe("ensureDefaultChannel", () => {
  it("does nothing for a member who is not the relay owner", async () => {
    const { ensure, run, sent } = fixture({ role: "member" });
    expect(await ensure()).toBe("not-owner");
    expect(sent).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it("leaves bootstrapping to the owner when the viewer is an admin", async () => {
    const { ensure, run, sent } = fixture({ role: "admin" });
    expect(await ensure()).toBe("not-owner");
    expect(sent).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it("creates the channel at the deterministic id, then flags it", async () => {
    const { ensure, run, sent, outbox } = fixture();
    const id = await starterChannelId(ORIGIN, "general");
    expect(await ensure()).toBe("created-and-flagged");
    expect(sent).toEqual([
      {
        kind: 9007,
        content: "",
        tags: [
          ["h", id],
          ["name", "general"],
          ["visibility", "open"],
          ["channel_type", "stream"],
        ],
      },
    ]);
    expect(
      run.mock.calls.map(([action, channel]) => [action, channel]),
    ).toEqual([
      ["join", id],
      ["auto-join-on", id],
    ]);
    expect(outbox.dismiss).toHaveBeenCalledWith("event-1");
  });

  it("joins and flags an existing open stream with the name, creating nothing", async () => {
    const { ensure, run, sent } = fixture({
      channels: [open(EXISTING, "General")],
    });
    expect(await ensure()).toBe("flagged");
    expect(sent).toEqual([]);
    expect(
      run.mock.calls.map(([action, channel]) => [action, channel]),
    ).toEqual([
      ["join", EXISTING],
      ["auto-join-on", EXISTING],
    ]);
  });

  it("does nothing when a channel already auto-joins new members", async () => {
    const { ensure, run, sent } = fixture({
      channels: [open(EXISTING, "lobby", [["auto_join"]])],
    });
    expect(await ensure()).toBe("already-default");
    expect(sent).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ["private", channel(EXISTING, "general", [["private"]])],
    ["archived", open(EXISTING, "general", [["archived", "true"]])],
  ])("leaves a %s channel holding the name alone", async (_, clash) => {
    const { ensure, run, sent, log } = fixture({ channels: [clash] });
    expect(await ensure()).toBe("name-unavailable");
    expect(sent).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  });

  it("treats a duplicate-channel refusal as an existing channel", async () => {
    const { ensure, run } = fixture({
      delivery: {
        delivery: "failed",
        refused: true,
        error: "Channel already exists",
      },
    });
    const id = await starterChannelId(ORIGIN, "general");
    expect(await ensure()).toBe("created-and-flagged");
    expect(run).toHaveBeenLastCalledWith("auto-join-on", id, expect.anything());
  });

  it("stops when the relay refuses the create for another reason", async () => {
    const { ensure, run, log } = fixture({
      delivery: {
        delivery: "failed",
        refused: true,
        error: 'An open channel named "general" already exists',
      },
    });
    expect(await ensure()).toBe("create-refused");
    expect(run).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  });

  it("does not flag a deterministic id the relay holds as archived", async () => {
    const { ensure, run } = fixture({
      delivery: { delivery: "failed", error: "channel already exists" },
      created: (id) => [open(id, "general", [["archived", "true"]])],
    });
    expect(await ensure()).toBe("create-unconfirmed");
    expect(run).not.toHaveBeenCalled();
  });

  it("does not act on a listing the relay may have cut short", async () => {
    const channels = Array.from({ length: 1000 }, (_, index) =>
      open(
        `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        `c${index}`,
      ),
    );
    const { ensure, sent, run } = fixture({ channels });
    expect(await ensure()).toBe("incomplete-listing");
    expect(sent).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("bindDefaultChannel", () => {
  const relayWith = (snapshot: Partial<RelaySnapshot>) => {
    const read = vi.fn(async () => []);
    const relay = {
      snapshot: () =>
        ({
          status: "ready",
          generation: 1,
          viewer: OWNER,
          origin: ORIGIN,
          session: { relayAuthor: RELAY, readRemote: read },
          ...snapshot,
        }) as unknown as RelaySnapshot,
      subscribe: () => () => {},
    } as unknown as RelayData;
    return { relay, read };
  };

  it("is off when no default channel is configured", () => {
    vi.useFakeTimers();
    try {
      const { relay, read } = relayWith({});
      const dispose = bindDefaultChannel(relay, "", 0);
      vi.runAllTimers();
      expect(read).not.toHaveBeenCalled();
      dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for a live connection and runs once per community", async () => {
    vi.useFakeTimers();
    try {
      const cached = relayWith({ cached: true });
      bindDefaultChannel(cached.relay, "general", 0)();
      await vi.runAllTimersAsync();
      expect(cached.read).not.toHaveBeenCalled();

      let listener = () => {};
      const live = relayWith({});
      const relay = {
        ...live.relay,
        subscribe: (next: () => void) => {
          listener = next;
          return () => {};
        },
      };
      const dispose = bindDefaultChannel(relay, "general", 0);
      await vi.runAllTimersAsync();
      listener();
      await vi.runAllTimersAsync();
      expect(live.read).toHaveBeenCalledTimes(1);
      dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
