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
  nativeAskiiStore,
} from "./askii";
import type { AskiiPreset } from "./askii-preset";

const CREATE_STEPS =
  "Create one in Askii under Connectors & Apps > Workspace Apps > API keys.";

export function statusText(status: AskiiKeyStatus): string {
  const { active } = status;
  if (active?.source === "toolkit")
    return active.expires === undefined
      ? "Using the key from the AI Productivity Toolkit."
      : `Using the key from the AI Productivity Toolkit, valid until ${new Date(active.expires).toLocaleDateString()}.`;
  if (active?.source === "pasted")
    return "Using the key you saved on this computer.";
  return `Paste an Askii API key. ${CREATE_STEPS}`;
}

export function AskiiKeyField({
  preset,
  onChanged,
  disabled = false,
  store = nativeAskiiStore,
}: Readonly<{
  preset: AskiiPreset;
  onChanged(): void;
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
      await write();
      setDraft("");
      setRound((value) => value + 1);
      onChanged();
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
