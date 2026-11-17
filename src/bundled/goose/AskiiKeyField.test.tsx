// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { AskiiStore } from "./askii";
import { AskiiKeyField } from "./AskiiKeyField";

const preset = { url: "https://api.askii.example", model: "gpt-5-mini" };
const PASTED_KEY = "sk-pasted-0123456789";

afterEach(cleanup);

const memoryStore = (
  toolkit: string | null,
  pasted: string | null,
  refusal?: Error,
) => {
  let saved = pasted;
  const store: AskiiStore = {
    toolkitCredentials: async () => toolkit,
    pasted: async () => saved,
    savePasted: vi.fn(async (key: string) => {
      if (refusal) throw refusal;
      saved = key;
    }),
    clearPasted: vi.fn(async () => {
      saved = null;
    }),
  };
  return store;
};

it("saves a pasted key and tells the caller", async () => {
  const user = userEvent.setup();
  const store = memoryStore(null, null);
  const onChanged = vi.fn();
  render(<AskiiKeyField preset={preset} store={store} onChanged={onChanged} />);
  expect(await screen.findByText(/Paste an Askii API key/)).toBeVisible();
  await user.type(screen.getByLabelText("Askii API key"), PASTED_KEY);
  await user.click(screen.getByRole("button", { name: "Save key" }));
  expect(store.savePasted).toHaveBeenCalledWith(PASTED_KEY);
  expect(onChanged).toHaveBeenCalledExactlyOnceWith(true);
  expect(
    await screen.findByText("Using the key you saved on this computer."),
  ).toBeVisible();
  expect(screen.getByLabelText("Askii API key")).toHaveValue("");
});

it("clears a saved key", async () => {
  const user = userEvent.setup();
  const store = memoryStore(null, PASTED_KEY);
  const onChanged = vi.fn();
  render(<AskiiKeyField preset={preset} store={store} onChanged={onChanged} />);
  await user.click(
    await screen.findByRole("button", { name: "Clear saved key" }),
  );
  expect(store.clearPasted).toHaveBeenCalledOnce();
  expect(onChanged).toHaveBeenCalledExactlyOnceWith(true);
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Clear saved key" }),
    ).not.toBeInTheDocument(),
  );
});

it("names the toolkit's key when it is in use", async () => {
  render(
    <AskiiKeyField
      preset={preset}
      store={memoryStore(
        JSON.stringify({ api_key: "sk-toolkit-012345" }),
        null,
      )}
      onChanged={() => {}}
    />,
  );
  expect(
    await screen.findByText(
      "Using the key from the AI Productivity Toolkit. A key you paste here is used instead.",
    ),
  ).toBeVisible();
});

it("falls back to the toolkit's key once the pasted one is cleared", async () => {
  const user = userEvent.setup();
  const store = memoryStore(
    JSON.stringify({ api_key: "sk-toolkit-012345" }),
    PASTED_KEY,
  );
  render(<AskiiKeyField preset={preset} store={store} onChanged={() => {}} />);
  expect(
    await screen.findByText(
      "Using the key you saved on this computer. Clear it to use the AI Productivity Toolkit's key.",
    ),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Clear saved key" }));
  expect(
    await screen.findByText(/^Using the key from the AI Productivity Toolkit/),
  ).toBeVisible();
});

it("reports no key change when the saved key is saved again", async () => {
  const user = userEvent.setup();
  const store = memoryStore(null, PASTED_KEY);
  const onChanged = vi.fn();
  render(<AskiiKeyField preset={preset} store={store} onChanged={onChanged} />);
  await user.type(await screen.findByLabelText("Askii API key"), PASTED_KEY);
  await user.click(screen.getByRole("button", { name: "Replace key" }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledExactlyOnceWith(false));
});

it("shows a refused save", async () => {
  const user = userEvent.setup();
  const store = memoryStore(null, null, new Error("Cannot save the Askii key"));
  const onChanged = vi.fn();
  render(<AskiiKeyField preset={preset} store={store} onChanged={onChanged} />);
  await user.type(await screen.findByLabelText("Askii API key"), PASTED_KEY);
  await user.click(screen.getByRole("button", { name: "Save key" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Cannot save the Askii key",
  );
  expect(onChanged).not.toHaveBeenCalled();
});
