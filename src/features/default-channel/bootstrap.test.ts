import { afterEach, describe, expect, it, vi } from "vitest";
import type { RelayEvent, ReadFilter } from "../relay/events";
import type { OutgoingEvent } from "../relay/outbox";
import { createRelayReader } from "../relay/reader";
import type { RelayData, RelaySnapshot } from "../relay/service";
import { bindDefaultChannel } from "./bind";
import {
  ensureDefaultChannel,
  LIFECYCLE_RETRY_MS,
  METADATA_PAGE_LIMIT,
  type DefaultChannelSession,
} from "./bootstrap";
import { starterChannelId, uuidV5 } from "./starter-id";

const RELAY = "a".repeat(64);
const OWNER = "b".repeat(64);
const MEMBER = "c".repeat(64);
const ORIGIN = "https://buzz.example";
const EXISTING = "11111111-1111-4111-8111-111111111111";

let sequence = 0;
const event = (
  kind: number,
  tags: string[][],
  created_at = 1_700_000_000,
): RelayEvent =>
  ({
    id: (sequence++).toString(16).padStart(64, "0"),
    pubkey: RELAY,
    created_at,
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

const channel = (
  id: string,
  name: string,
  extra: string[][] = [],
  created_at?: number,
) =>
  event(
    39000,
    [["d", id], ["name", name], ["t", "stream"], ...extra],
    created_at,
  );
const open = (
  id: string,
  name: string,
  extra: string[][] = [],
  created_at?: number,
) => channel(id, name, [["public"], ...extra], created_at);
const channelUuid = (index: number) =>
  `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

/** A relay answering NIP-01 filters: newest first, `until` inclusive, `limit`. */
function relayAnswer(filter: ReadFilter, events: readonly RelayEvent[]) {
  return events
    .filter(
      (item) =>
        (!filter.kinds || filter.kinds.includes(item.kind)) &&
        (!filter.authors || filter.authors.includes(item.pubkey)) &&
        (filter.until === undefined || item.created_at <= filter.until),
    )
    .sort(
      (a: RelayEvent, b: RelayEvent) =>
        b.created_at - a.created_at || a.id.localeCompare(b.id),
    )
    .slice(0, filter.limit);
}

const readers: ReturnType<typeof createRelayReader>[] = [];
afterEach(() => {
  for (const reader of readers.splice(0)) reader.dispose();
});

type Fixture = {
  name?: string;
  role?: string;
  channels?: RelayEvent[];
  /** Metadata the relay holds for an id after a create. */
  created?: (id: string) => RelayEvent[];
  delivery?: Partial<OutgoingEvent>;
  run?: (
    action: string,
    channel: string,
    signal?: AbortSignal,
  ) => Promise<void>;
};

/** Reads go through the session's real reader, so its filter rules apply. */
function fixture({
  name = "general",
  role = "owner",
  channels = [],
  created = (id) => [open(id, "general")],
  delivery = { delivery: "accepted" },
  run: runAction = async () => {},
}: Fixture = {}) {
  const sent: { kind: number; content: string; tags: string[][] }[] = [];
  const run = vi.fn(runAction);
  const queries: ReadFilter[] = [];
  const reader = createRelayReader({
    viewer: OWNER,
    relayAuthor: RELAY,
    media: () => undefined,
    async query(filters) {
      const [filter] = filters;
      if (!filter) return [];
      queries.push(filter);
      if (filter.kinds?.includes(13534)) return [roster(role)];
      const id = filter["#d"]?.[0];
      return id ? created(id) : relayAnswer(filter, channels);
    },
  });
  readers.push(reader);
  const items: OutgoingEvent[] = [];
  const listeners = new Set<() => void>();
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
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dismiss: vi.fn(async (id: string) => {
      const item = items.find((entry) => entry.event.id === id);
      if (item?.delivery === "sending") return;
      items.splice(items.indexOf(item as OutgoingEvent), 1);
    }),
  };
  const settle = (next: Partial<OutgoingEvent>) => {
    items.splice(
      0,
      items.length,
      ...items.map((item) => ({ ...item, ...next })),
    );
    for (const listener of listeners) listener();
  };
  const session: DefaultChannelSession = {
    viewer: OWNER,
    origin: ORIGIN,
    relayAuthor: RELAY,
    read: reader.reader.read,
    outbox,
    lifecycle: { available: true, run },
  };
  const log = vi.fn();
  const ensure = (signal = new AbortController().signal) =>
    ensureDefaultChannel(name, session, signal, log);
  return { ensure, run, sent, outbox, log, queries, items, settle };
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
    await vi.waitFor(() =>
      expect(outbox.dismiss).toHaveBeenCalledWith("event-1"),
    );
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

  it("pages the channel listing within the reader's limit", async () => {
    const channels = [
      ...Array.from({ length: 1100 }, (_, index) =>
        event(
          39000,
          [["d", channelUuid(index)], ["t", "dm"], ["hidden"]],
          1_700_000_000 + 2000 - index,
        ),
      ),
      open(EXISTING, "general", [], 1_700_000_000),
    ];
    const { ensure, run, sent, queries } = fixture({ channels });
    expect(await ensure()).toBe("flagged");
    const listings = queries.filter((filter) => filter.kinds?.includes(39000));
    expect(listings).toHaveLength(3);
    expect(
      listings.every((filter) => filter.limit <= METADATA_PAGE_LIMIT),
    ).toBe(true);
    expect(listings[1]?.until).toBe(1_700_000_000 + 2000 - 499);
    expect(sent).toEqual([]);
    expect(run).toHaveBeenLastCalledWith(
      "auto-join-on",
      EXISTING,
      expect.anything(),
    );
  });

  it("does not act on a listing it cannot page through", async () => {
    const channels = Array.from({ length: 600 }, (_, index) =>
      open(channelUuid(index), `c${index}`),
    );
    const { ensure, sent, run } = fixture({ channels });
    expect(await ensure()).toBe("incomplete-listing");
    expect(sent).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it("matches the relay's canonical name, without a leading #", async () => {
    const { ensure, run, sent } = fixture({
      name: " #General ",
      channels: [open(EXISTING, "general")],
    });
    expect(await ensure()).toBe("flagged");
    expect(sent).toEqual([]);
    expect(run).toHaveBeenLastCalledWith(
      "auto-join-on",
      EXISTING,
      expect.anything(),
    );
  });

  it("creates under the canonical name", async () => {
    const { ensure, sent } = fixture({ name: "# general" });
    expect(await ensure()).toBe("created-and-flagged");
    expect(sent[0]?.tags[1]).toEqual(["name", "general"]);
    expect(sent[0]?.tags[0]).toEqual([
      "h",
      await starterChannelId(ORIGIN, "general"),
    ]);
  });

  it("waits once for the person's own channel action to finish", async () => {
    vi.useFakeTimers();
    try {
      let busy = true;
      const { ensure, run } = fixture({
        channels: [open(EXISTING, "general")],
        run: async () => {
          if (!busy) return;
          busy = false;
          throw new Error("Another channel action is still in progress");
        },
      });
      const outcome = ensure();
      await vi.advanceTimersByTimeAsync(LIFECYCLE_RETRY_MS);
      expect(await outcome).toBe("flagged");
      expect(run.mock.calls.map(([action]) => action)).toEqual([
        "join",
        "join",
        "auto-join-on",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after a second collision", async () => {
    vi.useFakeTimers();
    try {
      const { ensure } = fixture({
        channels: [open(EXISTING, "general")],
        run: async () => {
          throw new Error("Another channel action is still in progress");
        },
      });
      const outcome = ensure();
      const failed = expect(outcome).rejects.toThrow("still in progress");
      await vi.advanceTimersByTimeAsync(LIFECYCLE_RETRY_MS);
      await failed;
    } finally {
      vi.useRealTimers();
    }
  });

  it("dismisses an aborted create once it settles", async () => {
    const controller = new AbortController();
    const { ensure, outbox, items, settle } = fixture({
      delivery: { delivery: "sending" },
    });
    const outcome = ensure(controller.signal);
    await vi.waitFor(() => expect(items).toHaveLength(1));
    controller.abort();
    await expect(outcome).rejects.toBeDefined();
    expect(items).toHaveLength(1);
    settle({ delivery: "accepted" });
    await vi.waitFor(() => expect(items).toHaveLength(0));
    expect(outbox.dismiss).toHaveBeenCalledWith("event-1");
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
