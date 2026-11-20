import { useRef, useState } from "react";
import type { Agents } from "../agents/service";
import type { PortableAgent } from "../agents/native";
import type { MentionRecipient } from "./mention-draft";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Button } from "../../shared/design-system/ui/Button";
import { Select } from "../../shared/design-system/ui/Select";
import { defaultAgentType } from "../../bundled/agents/default-type";

type Pending = {
  found: readonly PortableAgent[];
  signal: AbortSignal;
  current(): boolean;
  /** null stops the send; otherwise the agents sent to without importing. */
  finish(declined: readonly string[] | null): void;
  busy: boolean;
  error?: string;
  /** What an import that came through still needs the owner to know. */
  notes?: readonly string[];
};

// Agents the owner chose to send to without importing; not asked again this run.
const declined = new Set<string>();

/** Offers to import a mentioned agent that only an earlier Buzz on this
 * machine runs, before the send that would otherwise go unanswered. */
export function useOldAgentMentions(
  agents: Agents | undefined,
  restoreFocus: () => void,
) {
  const [pending, setPending] = useState<Pending>();
  const [type, setType] = useState<string>();
  const importing = useRef(false);
  // Importing gives the agent a key here, so a hosted type cannot take one.
  const types = agents?.types().filter((item) => !item.remote) ?? [];
  const chosen =
    types.find((item) => item.key === type) ?? defaultAgentType(types);
  // The import came through with notes, and only sending is left.
  const imported = !!pending?.notes && !pending.error;
  async function port() {
    if (!agents || !pending || !chosen || importing.current) return;
    importing.current = true;
    // A retry starts clean, without the last attempt's error or notes.
    const { found, signal, current, finish } = pending;
    const request = { found, signal, current, finish };
    setPending({ ...request, busy: true });
    const notes: string[] = [];
    const check = () => {
      request.signal.throwIfAborted();
      if (!request.current())
        throw new Error("The draft changed. Close this dialog and send again.");
    };
    try {
      for (const agent of request.found) {
        check();
        // A retry after a partial failure skips the ones that came over.
        if (agents.find(agent.pubkey)) continue;
        const ported = await agents.port({
          source: agent.source,
          pubkey: agent.pubkey,
          type: chosen.key,
        });
        notes.push(...ported.notes);
      }
      // A send stopped while the last import ran leaves this request behind.
      check();
      // As on the Agents page, what still needs a hand is said before moving on.
      if (notes.length) setPending({ ...request, busy: false, notes });
      else request.finish([]);
    } catch (reason) {
      if (!request.signal.aborted)
        setPending({
          ...request,
          busy: false,
          error: reason instanceof Error ? reason.message : String(reason),
          ...(notes.length ? { notes } : {}),
        });
    } finally {
      importing.current = false;
    }
  }
  return {
    /** The mentioned agents an earlier Buzz on this machine still runs;
     * at once when none can be, so an ordinary send stays synchronous. */
    find(
      people: readonly MentionRecipient[],
    ): readonly PortableAgent[] | Promise<readonly PortableAgent[]> {
      if (!agents || !types.length) return [];
      // Agents already here, and ones the owner declined, are never offered.
      const here = new Set(
        agents.snapshot().agents.map((agent) => agent.pubkey),
      );
      const mentioned = new Set(
        people
          .map((person) => person.pubkey)
          .filter((key) => !declined.has(key) && !here.has(key)),
      );
      if (!mentioned.size) return [];
      // Only the desktop app can read earlier stores; elsewhere none are found.
      return agents.portable().then(
        (result) =>
          result.agents.filter((agent) => mentioned.has(agent.pubkey)),
        () => [],
      );
    },
    /** Resolves null when the owner closed the dialog and the send stops;
     * otherwise the agents to pass to `decline` once the message goes out. */
    ask(
      found: readonly PortableAgent[],
      signal: AbortSignal,
      current: () => boolean,
    ) {
      signal.throwIfAborted();
      return new Promise<readonly string[] | null>((resolve) => {
        const finish = (declined: readonly string[] | null) => {
          signal.removeEventListener("abort", abort);
          setPending(undefined);
          resolve(declined);
        };
        const abort = () => finish(null);
        signal.addEventListener("abort", abort, { once: true });
        setPending({ found, signal, current, finish, busy: false });
      });
    },
    /** Records agents sent to without importing, so this run asks no more.
     * Called only once every step before sending passed, since a send
     * stopped later leaves nothing declined. */
    decline(keys: readonly string[]) {
      for (const key of keys) declined.add(key);
    },
    dialog: (
      <Dialog
        size="compact"
        open={!!pending}
        onOpenChange={(open) => {
          if (!open) pending?.finish(null);
        }}
        title={
          imported
            ? pending.found.length === 1
              ? `${pending.found[0]?.name} was imported`
              : "These agents were imported"
            : pending?.found.length === 1
              ? `Import ${pending.found[0]?.name}?`
              : "Import these agents?"
        }
        description={
          pending &&
          (imported
            ? "Send when you're ready. Closing this keeps your draft."
            : describe(pending.found, !!chosen?.adopt))
        }
        preventClose={!!pending?.busy}
        finalFocus={() => {
          restoreFocus();
          return false;
        }}
        actions={
          // One primary button through every step, so its focus survives.
          <>
            {!imported && (
              <Button
                type="button"
                disabled={pending?.busy}
                onClick={() =>
                  pending?.finish(pending.found.map((agent) => agent.pubkey))
                }
              >
                Just send
              </Button>
            )}
            <Button
              type="button"
              variant="prominent"
              loading={!!pending?.busy}
              disabled={!imported && !chosen}
              onClick={() => (imported ? pending.finish([]) : void port())}
            >
              {imported ? "Send" : "Import and send"}
            </Button>
          </>
        }
      >
        {types.length > 1 && !imported && (
          <div className="flex">
            <Select
              label="Import as"
              value={chosen?.key ?? ""}
              disabled={!!pending?.busy}
              groups={[
                {
                  label: "Agent types",
                  options: types.map((item) => ({
                    value: item.key,
                    label: item.title,
                  })),
                },
              ]}
              onValueChange={setType}
            />
          </div>
        )}
        {pending?.notes?.map((note) => (
          <p key={note}>{note}</p>
        ))}
        {pending?.error ? (
          <p role="alert">
            {pending.error} Your draft is kept. Agents already imported stay
            imported.
          </p>
        ) : null}
      </Dialog>
    ),
  };
}

function describe(found: readonly PortableAgent[], adopts: boolean) {
  const one = found.length === 1;
  const names = found.map((agent) => agent.name).join(", ");
  const kept = one
    ? adopts
      ? "name, avatar, and instructions"
      : "name and avatar"
    : adopts
      ? "names, avatars, and instructions"
      : "names and avatars";
  return `${names} ${one ? "is" : "are"} set up in the preview version of Buzz. Are you ready to import ${
    one ? "it" : "them"
  } to Buzz 1.0? This will keep ${one ? "its" : "their"} ${kept} and start running ${
    one ? "it" : "them"
  } in this app.`;
}
