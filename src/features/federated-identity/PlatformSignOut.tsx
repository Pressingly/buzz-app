import { useEffect, useState } from "react";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { Input } from "../../shared/design-system/ui/Input";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import type { Identity } from "../identity/service";
import { WIPE_PHRASE } from "../identity/SignOut";

type SignOutChoices = Parameters<Identity["signOut"]>[0];

/** Native refusals carry `{ message }`; anything else is a plain error. */
function refusalMessage(reason: unknown) {
  if (
    typeof reason === "object" &&
    reason !== null &&
    "message" in reason &&
    typeof reason.message === "string"
  )
    return reason.message;
  return String(reason);
}

/** Runs one native sign-out at a time; success relaunches, so only a refusal settles. */
function useSignOut(identity: Identity) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function run(choices: SignOutChoices) {
    setPending(true);
    setError("");
    try {
      await identity.signOut(choices);
    } catch (reason) {
      setError(refusalMessage(reason));
      setPending(false);
    }
  }
  return { pending, error, run };
}

function Refusal({ error }: { error: string }) {
  if (!error) return null;
  return (
    <span role="alert" className="block text-body-sm text-danger">
      {error}
    </span>
  );
}

/**
 * Platform key custody's Settings sign-out. The organization holds the key
 * and returns it at the next sign-in, so signing out is one click with no
 * key to save; erasing the device stays a separate, confirmed choice.
 */
export function PlatformSignOut({ identity }: { identity: Identity }) {
  const signOut = useSignOut(identity);
  const [erasing, setErasing] = useState(false);
  return (
    <>
      <PreferenceRow
        title="Sign out of Buzz"
        subtitle={
          <>
            Removes your Buzz key and session from this device. Your
            organization keeps the key and gives it back when you sign in again.
            If others use this computer, also sign out of mPass in your browser.
            <Refusal error={signOut.error} />
          </>
        }
        trailing={
          <Button
            type="button"
            disabled={signOut.pending}
            onClick={() =>
              void signOut.run({ wipe: false, removeAgents: false })
            }
          >
            Sign out of Buzz
          </Button>
        }
      />
      <PreferenceRow
        title="Sign out and erase this device"
        subtitle="Also erases everything else Buzz stores on this device, such as settings, caches and plugin storage."
        trailing={
          <Button
            type="button"
            disabled={signOut.pending}
            onClick={() => setErasing(true)}
          >
            Sign out and erase
          </Button>
        }
      />
      {erasing && (
        <PlatformEraseDialog
          identity={identity}
          onClose={() => setErasing(false)}
        />
      )}
    </>
  );
}

function useWipeRefusal(identity: Identity) {
  // Asked of the native side, which enforces it; erase stays off until it answers.
  const [refusal, setRefusal] = useState<string | null>();
  useEffect(() => {
    let current = true;
    identity
      .wipeRefusal()
      .catch(() => "Couldn’t check whether erasing is available")
      .then((reason) => {
        if (current) setRefusal(reason ?? null);
      });
    return () => {
      current = false;
    };
  }, [identity]);
  return refusal;
}

/** Upstream's erase confirmation, without the key reveal: there is no key to save. */
function PlatformEraseDialog({
  identity,
  onClose,
}: {
  identity: Identity;
  onClose(): void;
}) {
  const erase = useSignOut(identity);
  const refusal = useWipeRefusal(identity);
  const [removeAgents, setRemoveAgents] = useState(false);
  const [phrase, setPhrase] = useState("");
  const ready = refusal === null && phrase.trim() === WIPE_PHRASE;
  return (
    <AlertDialog
      title="Sign out and erase this device?"
      description="Your organization keeps your Buzz key and gives it back when you sign in again. Everything else Buzz stores on this device is erased."
      onClose={onClose}
      pending={erase.pending}
      actions={
        <>
          <Button type="button" disabled={erase.pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!ready || erase.pending}
            onClick={() => void erase.run({ wipe: true, removeAgents })}
          >
            Sign out and erase
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {refusal && <p className="text-body-sm text-muted">{refusal}.</p>}
        <Checkbox
          label="Also remove my agents"
          checked={removeAgents}
          disabled={erase.pending || refusal !== null}
          onCheckedChange={setRemoveAgents}
        />
        <label className="block text-label-sm" htmlFor="platform-erase-phrase">
          Type “{WIPE_PHRASE}” to confirm
        </label>
        <Input
          id="platform-erase-phrase"
          autoComplete="off"
          value={phrase}
          disabled={erase.pending || refusal !== null}
          onChange={(event) => setPhrase(event.currentTarget.value)}
        />
        <p className="text-body-sm text-muted">
          Erasing clears this app’s data, local storage, caches and plugin
          storage on this device only. It can’t reach your clipboard or relay
          data; your npub and its history stay on the relays.
          {!removeAgents &&
            " Kept agents keep their names, types and keys; their settings on this device are erased."}
        </p>
      </div>
      {erase.error && <p role="alert">{erase.error}</p>}
    </AlertDialog>
  );
}
