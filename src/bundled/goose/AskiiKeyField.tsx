// The Askii preset's key, in place of goose's own LiteLLM fields: which key is
// in use, and a pasted one saved to, replaced in or cleared from the keychain.
import { useEffect, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import {
  type AskiiKeyStatus,
  type AskiiStore,
  askiiKeyStatus,
  currentAskiiKey,
  nativeAskiiStore,
} from "./askii";
import { type AskiiPreset, sameAskiiKey } from "./askii-preset";

const CREATE_STEPS =
  "Create one in Askii under Connectors & Apps > Workspace Apps > API keys.";

export function statusText(status: AskiiKeyStatus): string {
  const { active } = status;
  if (active?.source === "pasted")
    return status.toolkitUsable
      ? "Using the key you saved on this computer. Clear it to use the AI Productivity Toolkit's key."
      : "Using the key you saved on this computer.";
  if (active?.source === "toolkit")
    return active.expires === undefined
      ? "Using the key from the AI Productivity Toolkit. A key you paste here is used instead."
      : `Using the key from the AI Productivity Toolkit, valid until ${new Date(active.expires).toLocaleDateString()}. A key you paste here is used instead.`;
  return `Paste an Askii API key. ${CREATE_STEPS}`;
}

export function AskiiKeyField({
  preset,
  onChanged,
  disabled = false,
  store = nativeAskiiStore,
}: Readonly<{
  preset: AskiiPreset;
  /** `keyChanged` says whether goose would now start with another key. */
  onChanged(keyChanged: boolean): void;
  disabled?: boolean;
  store?: AskiiStore;
}>) {
  const [status, setStatus] = useState<AskiiKeyStatus>();
  const [round, setRound] = useState(0);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` rereads after a change.
  useEffect(() => {
    let current = true;
    void askiiKeyStatus(preset, store).then(
      (read) => current && setStatus(read),
    );
    return () => {
      current = false;
    };
  }, [preset, store, round]);

  const change = async (write: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      const before = await currentAskiiKey(preset, store);
      await write();
      const after = await currentAskiiKey(preset, store);
      setDraft("");
      setRound((value) => value + 1);
      onChanged(!sameAskiiKey(before, after));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const save = () => change(() => store.savePasted(draft.trim()));
  const locked = disabled || busy || !status;
  const canSave = !locked && draft.trim() !== "";

  return (
    <>
      <Field
        label="Askii API key"
        description={status ? statusText(status) : "Checking the Askii key…"}
      >
        <Input
          type="password"
          autoComplete="off"
          value={draft}
          disabled={locked}
          placeholder={
            status?.pastedSaved
              ? "Saved. Paste a new key to replace it."
              : undefined
          }
          onValueChange={setDraft}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            if (canSave) void save();
          }}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={!canSave} loading={busy} onClick={save}>
          {status?.pastedSaved ? "Replace key" : "Save key"}
        </Button>
        {status?.pastedSaved && (
          <Button
            disabled={locked}
            onClick={() => change(() => store.clearPasted())}
          >
            Clear saved key
          </Button>
        )}
        {error && (
          <p role="alert" className="buzz-field-error m-0">
            {error}
          </p>
        )}
      </div>
    </>
  );
}
