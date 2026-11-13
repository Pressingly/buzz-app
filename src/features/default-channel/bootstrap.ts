// Pressingly fork (FOSS-756): the relay owner's app makes sure the community
// has one auto-join channel, so every account lands in a shared channel.
// The relay offers no server-side default; only signed 9007/9002 events.
import { readRoster } from "../communities/roster";
import type { ChannelLifecycleCapability } from "../relay/channel-lifecycle";
import {
  channelTypeTag,
  exactLifecycleTag,
} from "../relay/channel-lifecycle-protocol";
import { openMetadata } from "../relay/discovery";
import { newer, type ReadFilter, type RelayEvent } from "../relay/events";
import type { Outbox, OutgoingEvent } from "../relay/outbox";
import type { ReadOptions } from "../relay/reader";
import { starterChannelId } from "./starter-id";

/** The relay's page cap (buzz-db DEFAULT_MAX_PAGE_LIMIT); a full page may be partial. */
export const METADATA_PAGE_LIMIT = 1000;
const DELIVERY_SETTLED = new Set(["accepted", "seen", "failed", "unknown"]);
const DUPLICATE_CHANNEL = "channel already exists";

export type DefaultChannelOutcome =
  | "no-roster"
  | "not-owner"
  | "incomplete-listing"
  | "already-default"
  | "name-unavailable"
  | "creation-unavailable"
  | "create-refused"
  | "create-unconfirmed"
  | "flagged"
  | "created-and-flagged";

export type DefaultChannelSession = {
  /** Fresh verified relay reads. */
  read(
    filters: readonly ReadFilter[],
    settings?: ReadOptions,
  ): Promise<readonly RelayEvent[]>;
  viewer: string;
  /** The community's https origin. */
  origin: string;
  relayAuthor: string;
  outbox:
    | Pick<
        Outbox,
        "ready" | "supports" | "send" | "snapshot" | "subscribe" | "dismiss"
      >
    | undefined;
  lifecycle: Pick<ChannelLifecycleCapability, "available" | "run">;
};

export type DefaultChannelLog = (message: string) => void;

const normalizedName = (name: string) => name.trim().toLowerCase();

const channelName = (event: RelayEvent) =>
  event.tags.find(([key]) => key === "name")?.[1] ?? "";

const isAutoJoin = (event: RelayEvent) =>
  event.tags.some(([key]) => key === "auto_join");

/** Malformed relay state reads as absent rather than ending the run. */
function wellFormed<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** Only an open, unarchived stream can carry the relay's auto_join flag. */
export const canBeDefault = (event: RelayEvent) =>
  wellFormed(
    () =>
      channelTypeTag(event) === "stream" &&
      openMetadata(event) &&
      exactLifecycleTag(event, "archived") !== "true",
  ) ?? false;

const channelId = (event: RelayEvent) =>
  wellFormed(() => exactLifecycleTag(event, "d"));

function latestMetadata(
  events: readonly RelayEvent[],
  relayAuthor: string,
): RelayEvent[] {
  const byChannel = new Map<string, RelayEvent>();
  for (const event of events) {
    const id =
      event.kind === 39000 && event.pubkey === relayAuthor && channelId(event);
    if (id) byChannel.set(id, newer(byChannel.get(id), event));
  }
  return [...byChannel.values()];
}

async function isOwner(session: DefaultChannelSession, signal: AbortSignal) {
  const members = await readRoster(session, signal);
  if (!members) return undefined;
  return members.some(
    (member) => member.pubkey === session.viewer && member.role === "owner",
  );
}

/** Joining reads the roster first and publishes nothing for a member, so the
 * session also learns the channel before the auto-join edit checks access. */
async function flagDefault(
  session: DefaultChannelSession,
  id: string,
  signal: AbortSignal,
) {
  await session.lifecycle.run("join", id, signal);
  await session.lifecycle.run("auto-join-on", id, signal);
}

function settled(
  outbox: NonNullable<DefaultChannelSession["outbox"]>,
  eventId: string,
  signal: AbortSignal,
): Promise<OutgoingEvent | undefined> {
  return new Promise((resolve, reject) => {
    const finish = (item: OutgoingEvent | undefined) => {
      stop();
      signal.removeEventListener("abort", abort);
      resolve(item);
    };
    const abort = () => {
      stop();
      reject(signal.reason);
    };
    const check = () => {
      const item = outbox
        .snapshot()
        .find((entry) => entry.event.id === eventId);
      if (!item || DELIVERY_SETTLED.has(item.delivery)) finish(item);
    };
    const stop = outbox.subscribe(check);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else check();
  });
}

const createTemplate = (id: string, name: string) => ({
  kind: 9007,
  content: "",
  // The native creation signer accepts exactly this leading tag order.
  tags: [
    ["h", id],
    ["name", name],
    ["visibility", "open"],
    ["channel_type", "stream"],
  ],
});

async function create(
  session: DefaultChannelSession,
  name: string,
  signal: AbortSignal,
  log: DefaultChannelLog,
): Promise<{ id: string } | { outcome: DefaultChannelOutcome }> {
  const outbox = session.outbox;
  if (!outbox?.supports(9007)) return { outcome: "creation-unavailable" };
  const id = await starterChannelId(session.origin, normalizedName(name));
  await outbox.ready();
  signal.throwIfAborted();
  const eventId = outbox.send(
    createTemplate(id, name.trim()),
    undefined,
    () => !signal.aborted,
  );
  try {
    const item = await settled(outbox, eventId, signal);
    const refusal = item?.delivery === "failed" ? (item.error ?? "") : "";
    if (refusal && !refusal.toLowerCase().includes(DUPLICATE_CHANNEL)) {
      log(`creating #${name.trim()} was refused: ${refusal}`);
      return { outcome: "create-refused" };
    }
  } finally {
    void outbox.dismiss(eventId).catch(() => {});
  }
  const readback = await session.read(
    [{ kinds: [39000, 39002], "#d": [id], limit: 2, consistency: "strong" }],
    { signal, fresh: true },
  );
  const metadata = latestMetadata(readback, session.relayAuthor)[0];
  return metadata && canBeDefault(metadata)
    ? { id }
    : { outcome: "create-unconfirmed" };
}

/**
 * Makes `name` the community's auto-join channel when the viewer is its relay
 * owner and no auto-join channel exists. Publishes nothing otherwise, and
 * never replaces a private or archived channel holding the name.
 */
export async function ensureDefaultChannel(
  name: string,
  session: DefaultChannelSession,
  signal: AbortSignal,
  log: DefaultChannelLog,
): Promise<DefaultChannelOutcome> {
  const owner = await isOwner(session, signal);
  if (owner === undefined) return "no-roster";
  if (!owner) return "not-owner";
  const events = await session.read(
    [
      {
        kinds: [39000],
        authors: [session.relayAuthor],
        limit: METADATA_PAGE_LIMIT,
      },
    ],
    { signal, fresh: true },
  );
  if (events.length >= METADATA_PAGE_LIMIT) return "incomplete-listing";
  const channels = latestMetadata(events, session.relayAuthor);
  if (channels.some(isAutoJoin)) return "already-default";
  const wanted = normalizedName(name);
  const named = channels.filter(
    (event) => normalizedName(channelName(event)) === wanted,
  );
  const usableId = named.filter(canBeDefault).map(channelId).find(Boolean);
  if (usableId) {
    await flagDefault(session, usableId, signal);
    return "flagged";
  }
  if (named.length) {
    log(`#${name.trim()} exists but is private or archived; left unchanged`);
    return "name-unavailable";
  }
  const created = await create(session, name, signal, log);
  if ("outcome" in created) return created.outcome;
  await flagDefault(session, created.id, signal);
  return "created-and-flagged";
}
