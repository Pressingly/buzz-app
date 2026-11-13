import { useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import type { Identity } from "../identity/service";

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

/**
 * Platform key custody's Settings sign-out: the organization holds the key
 * and returns it at the next sign-in, so there is nothing to back up first.
 * A plain sign-out keeps agents and settings for that same key.
 */
export function PlatformSignOut({ identity }: { identity: Identity }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function signOut() {
    setPending(true);
    setError("");
    try {
      await identity.signOut({ wipe: false, removeAgents: false });
    } catch (reason) {
      setError(refusalMessage(reason));
      setPending(false);
    }
  }
  return (
    <>
      <PreferenceRow
        title="Sign out of Buzz"
        subtitle="Signs you out of your organization and removes your Buzz key from this device. Your organization keeps the key and returns it when you sign in again. Also ends Builderlab and hosted community logins."
        trailing={
          <Button
            type="button"
            disabled={pending}
            onClick={() => void signOut()}
          >
            Sign out of Buzz
          </Button>
        }
      />
      {error && (
        <p role="alert" className="text-body-sm text-danger">
          {error}
        </p>
      )}
    </>
  );
}
