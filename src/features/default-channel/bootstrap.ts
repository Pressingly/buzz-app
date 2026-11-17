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

/** The session reader's largest page (reader.ts); a full page may have more behind it. */
export const METADATA_PAGE_LIMIT = 500;
/** DM groups are 39000 events too, so a busy community spans several pages. */
export const METADATA_MAX_PAGES = 20;
const LIFECYCLE_BUSY = "Another channel action is still in progress";
export const LIFECYCLE_RETRY_MS = 2_000;
const DISMISS_RETRY_MS = [0, 1_000, 5_000];
const DISMISS_DEADLINE_MS = 30_000;
const DELIVERY_SETTLED = new Set(["accepted", "seen", "failed", "unknown"]);
const DUPLICATE_CHANNEL = "channel already exists";

export type DefaultChannelOutcome =
  | "invalid-name"
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

/** The relay's `canonical_channel_name` (buzz-core channel.rs): no leading
 * `#` or whitespace, no trailing whitespace. */
export const canonicalChannelName = (name: string) =>
  name.replace(/^[#\s]+/u, "").trimEnd();

/** The relay's listed-name index compares `lower(name)`. */
const normalizedName = (name: string) =>
  canonicalChannelName(name).toLowerCase();

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

const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });

const isLifecycleBusy = (error: unknown) =>
  error instanceof Error && error.message.includes(LIFECYCLE_BUSY);

/** The lifecycle runs one action at a time and offers no idle check, so a
 * collision with the person's own channel action waits once and tries again. */
async function runLifecycle(
  session: DefaultChannelSession,
  action: "join" | "auto-join-on",
  id: string,
  signal: AbortSignal,
) {
  try {
    await session.lifecycle.run(action, id, signal);
  } catch (error) {
    if (!isLifecycleBusy(error)) throw error;
    await pause(LIFECYCLE_RETRY_MS, signal);
    await session.lifecycle.run(action, id, signal);
  }
}

/** Joining reads the roster first and publishes nothing for a member, so the
 * session also learns the channel before the auto-join edit checks access. */
async function flagDefault(
  session: DefaultChannelSession,
  id: string,
  signal: AbortSignal,
) {
  await runLifecycle(session, "join", id, signal);
  await runLifecycle(session, "auto-join-on", id, signal);
}

/**
 * Every channel metadata record the relay signs, newest first, one page at a
 * time. Each page restarts at the oldest second already seen, so records that
 * share it are not skipped. Undefined means the listing could not be completed.
 */
async function listChannelMetadata(
  session: DefaultChannelSession,
  signal: AbortSignal,
): Promise<RelayEvent[] | undefined> {
  const seen = new Map<string, RelayEvent>();
  let until: number | undefined;
  for (let page = 0; page < METADATA_MAX_PAGES; page++) {
    const events = await session.read(
      [
        {
          kinds: [39000],
          authors: [session.relayAuthor],
          limit: METADATA_PAGE_LIMIT,
          ...(until === undefined ? {} : { until }),
        },
      ],
      { signal, fresh: true },
    );
    const fresh = events.filter((event) => !seen.has(event.id));
    for (const event of fresh) seen.set(event.id, event);
    if (events.length < METADATA_PAGE_LIMIT) return [...seen.values()];
    if (!fresh.length) return undefined;
    until = Math.min(...events.map((event) => event.created_at));
  }
  return undefined;
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

/** The outbox ignores a dismissal while it is still delivering, so wait for
 * the create to settle, even past an aborted run, then retire its record. */
async function dismissWhenSettled(
  outbox: NonNullable<DefaultChannelSession["outbox"]>,
  eventId: string,
) {
  const present = () =>
    outbox.snapshot().some((entry) => entry.event.id === eventId);
  try {
    await settled(outbox, eventId, AbortSignal.timeout(DISMISS_DEADLINE_MS));
    for (const delay of DISMISS_RETRY_MS) {
      await pause(delay);
      if (!present()) return;
      await outbox.dismiss(eventId).catch(() => {});
    }
  } catch {
    // Left for the outbox's own retention; the next run sends nothing new.
  }
}

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
    createTemplate(id, name),
    undefined,
    () => !signal.aborted,
  );
  try {
    const item = await settled(outbox, eventId, signal);
    const refusal = item?.delivery === "failed" ? (item.error ?? "") : "";
    if (refusal && !refusal.toLowerCase().includes(DUPLICATE_CHANNEL)) {
      log(`creating #${name} was refused: ${refusal}`);
      return { outcome: "create-refused" };
    }
  } finally {
    void dismissWhenSettled(outbox, eventId);
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
  requested: string,
  session: DefaultChannelSession,
  signal: AbortSignal,
  log: DefaultChannelLog,
): Promise<DefaultChannelOutcome> {
  const name = canonicalChannelName(requested);
  if (!name) return "invalid-name";
  const owner = await isOwner(session, signal);
  if (owner === undefined) return "no-roster";
  if (!owner) return "not-owner";
  const events = await listChannelMetadata(session, signal);
  if (!events) return "incomplete-listing";
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
    log(`#${name} exists but is private or archived; left unchanged`);
    return "name-unavailable";
  }
  const created = await create(session, name, signal, log);
  if ("outcome" in created) return created.outcome;
  await flagDefault(session, created.id, signal);
  return "created-and-flagged";
}
