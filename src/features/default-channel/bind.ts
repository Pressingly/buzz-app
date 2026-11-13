import { getLogger } from "../developer/logging";
import type { RelayData, RelaySnapshot } from "../relay/service";
import {
  canonicalChannelName,
  ensureDefaultChannel,
  type DefaultChannelSession,
} from "./bootstrap";

/** Built with `BUZZ_BUILD_DEFAULT_CHANNEL`; empty keeps upstream behavior. */
export const configuredDefaultChannel = (): string =>
  canonicalChannelName(import.meta.env.VITE_BUZZ_DEFAULT_CHANNEL ?? "");

/** Starts after the app has settled, off the startup path. */
export const DEFAULT_CHANNEL_DELAY_MS = 5_000;
const RUN_DEADLINE_MS = 60_000;

const log = getLogger("default-channel");

type ReadySnapshot = RelaySnapshot & {
  viewer: string;
  origin: string;
};

const isLive = (snapshot: RelaySnapshot): snapshot is ReadySnapshot =>
  snapshot.status === "ready" &&
  !snapshot.cached &&
  !snapshot.restoring &&
  !!snapshot.viewer &&
  !!snapshot.origin &&
  !!snapshot.session.relayAuthor;

function sessionOf(snapshot: ReadySnapshot): DefaultChannelSession {
  const { session } = snapshot;
  return {
    viewer: snapshot.viewer,
    origin: snapshot.origin,
    relayAuthor: session.relayAuthor ?? "",
    read: (filters, settings) => session.readRemote(filters, settings),
    outbox: session.outbox,
    lifecycle: session.channelLifecycle,
  };
}

/**
 * Once per community and viewer each app run, lets the relay owner's app make
 * `name` the community's auto-join channel. Failures are logged, never shown,
 * and wait for the next run; a reconnect that cuts a run short retries once
 * the new connection is ready.
 */
export function bindDefaultChannel(
  relay: RelayData,
  name = configuredDefaultChannel(),
  delayMs = DEFAULT_CHANNEL_DELAY_MS,
): () => void {
  if (!name) return () => {};
  const attempted = new Set<string>();
  let running:
    | { generation: number; key: string; controller: AbortController }
    | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const abandon = () => {
    clearTimeout(timer);
    if (!running) return;
    attempted.delete(running.key);
    running.controller.abort();
    running = undefined;
  };

  const start = (snapshot: ReadySnapshot) => {
    const key = `${snapshot.origin}:${snapshot.viewer}`;
    if (attempted.has(key)) return;
    attempted.add(key);
    const controller = new AbortController();
    const current = { generation: snapshot.generation, key, controller };
    running = current;
    timer = setTimeout(() => {
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(RUN_DEADLINE_MS),
      ]);
      ensureDefaultChannel(name, sessionOf(snapshot), signal, (message) =>
        log.warn(message),
      )
        .then((outcome) => log.info(`#${name}: ${outcome}`))
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          log.warn(`#${name} bootstrap failed`, error);
        })
        .finally(() => {
          if (running === current) running = undefined;
        });
    }, delayMs);
  };

  const check = () => {
    const snapshot = relay.snapshot();
    if (running && running.generation !== snapshot.generation) abandon();
    if (!running && isLive(snapshot)) start(snapshot);
  };

  const stop = relay.subscribe(check);
  check();
  return () => {
    stop();
    abandon();
  };
}
