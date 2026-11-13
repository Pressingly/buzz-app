// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { Identity, IdentitySnapshot } from "../identity/service";
import { PlatformKeyCustody } from "./PlatformKeyCustody";
import { federatedFixture } from "./testing";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke,
}));
afterEach(() => {
  cleanup();
  invoke.mockReset();
});

/** Native's answer to `platform_key_sign_in_paused`. */
function nativePaused(answer: () => Promise<boolean>) {
  invoke.mockImplementation(async (command: string) =>
    command === "platform_key_sign_in_paused" ? answer() : undefined,
  );
}

/** The key owner as custody sees it: native installs, `retry` reads. */
function keyFixture(saved: boolean) {
  let state: IdentitySnapshot = { status: "missing", busy: false };
  const listeners = new Set<() => void>();
  const publish = (next: IdentitySnapshot) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const owner = {
    snapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retry: vi.fn(async () =>
      publish(
        saved
          ? { status: "ready", viewer: "a".repeat(64) }
          : { status: "missing", busy: false },
      ),
    ),
  };
  return { owner, publish, identity: owner as unknown as Identity };
}

/** `"native"` asks native, as the app does; a boolean answers directly. */
async function custody(saved: boolean, paused: boolean | "native" = false) {
  const session = federatedFixture();
  const authority = session.service.snapshot().authority;
  if (!authority) throw new Error("Fixture authority required");
  session.publish({
    status: "restoring",
    authority: { ...authority, signIn: "at-launch", organization: "Moneta" },
  });
  // Native moves to signing-in and stays there until the browser returns.
  vi.mocked(session.service.signIn).mockImplementation(async () =>
    session.publish({ status: "signing-in" }),
  );
  const key = keyFixture(saved);
  render(
    <PlatformKeyCustody
      identity={key.identity}
      federatedIdentity={session.service}
      {...(paused === "native" ? {} : { launchPaused: async () => paused })}
    >
      <p>Buzz</p>
    </PlatformKeyCustody>,
  );
  await act(async () => {});
  return { session, key };
}

it("signs in first, then reads the key that sign-in installed", async () => {
  const { session, key } = await custody(true);
  act(() => {
    session.publish({ status: "signed-out" });
  });
  expect(session.service.signIn).toHaveBeenCalledOnce();
  act(() => {
    session.publish({ status: "signed-out", failure: "sign-in-canceled" });
  });
  expect(
    await screen.findByRole("button", { name: "Sign in with Moneta" }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();
  expect(key.owner.retry).not.toHaveBeenCalled();
  act(() => {
    session.publish({ status: "signed-in", failure: null, revision: "new" });
  });
  expect(key.owner.retry).toHaveBeenCalledOnce();
  expect(screen.getByText("Buzz")).toBeVisible();
});

it("offers Sign out of Buzz when the device holds another key", async () => {
  const { session } = await custody(true);
  act(() => {
    session.publish({ status: "signed-out" });
  });
  act(() => {
    session.publish({ status: "signed-out", failure: "local-key-differs" });
  });
  expect(
    await screen.findByRole("button", { name: "Sign out of Buzz" }),
  ).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "This device already has a different Buzz key.",
  );
});

it("asks to sign in again when a saved session has no key here", async () => {
  const { session, key } = await custody(false);
  act(() => {
    session.publish({ status: "signed-in", revision: "restored" });
  });
  expect(
    await screen.findByRole("button", { name: "Sign in again" }),
  ).toBeVisible();
  expect(key.owner.retry).toHaveBeenCalledOnce();
  expect(screen.queryByText("Buzz")).toBeNull();
});

it("offers Try again when the saved key can't be read", async () => {
  const { session, key } = await custody(true);
  act(() => {
    key.publish({ status: "error", error: "Secure storage is locked" });
    session.publish({ status: "signed-in", revision: "restored" });
  });
  expect(
    await screen.findByRole("heading", { name: "Couldn’t open your Buzz key" }),
  ).toBeVisible();
  expect(screen.getByText("Secure storage is locked")).toBeVisible();
  expect(key.owner.retry).not.toHaveBeenCalled();
});

it("signs in again from signed out, so the launch screen can reopen or cancel", async () => {
  const { session } = await custody(false);
  act(() => {
    session.publish({ status: "signed-in", revision: "restored" });
  });
  vi.mocked(session.service.signIn).mockImplementationOnce(async () => {
    session.publish({ status: "signed-out", failure: "key-revoked" });
    throw new Error("key-revoked");
  });
  await act(async () =>
    (await screen.findByRole("button", { name: "Sign in again" })).click(),
  );
  expect(session.service.signOut).toHaveBeenCalledWith({
    revision: "restored",
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Your organization has turned off Buzz for this account.",
  );
  expect(
    screen.getByRole("button", { name: "Sign in with Moneta" }),
  ).toBeVisible();
});

it("waits for Sign in at a launch that follows a sign-out", async () => {
  const { session } = await custody(false, true);
  act(() => {
    session.publish({ status: "signed-out" });
  });
  const signIn = await screen.findByRole("button", {
    name: "Sign in with Moneta",
  });
  expect(signIn).toBeEnabled();
  expect(session.service.signIn).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();
  await act(async () => signIn.click());
  expect(session.service.signIn).toHaveBeenCalledOnce();
});

it("asks native whether this launch follows a sign-out", async () => {
  nativePaused(async () => true);
  const { session } = await custody(false, "native");
  act(() => {
    session.publish({ status: "signed-out" });
  });
  expect(invoke).toHaveBeenCalledWith("platform_key_sign_in_paused");
  expect(
    await screen.findByRole("button", { name: "Sign in with Moneta" }),
  ).toBeVisible();
  expect(session.service.signIn).not.toHaveBeenCalled();
});

it("opens the browser sign-in when native can't say", async () => {
  nativePaused(() => Promise.reject(new Error("not allowed")));
  const { session } = await custody(false, "native");
  act(() => {
    session.publish({ status: "signed-out" });
  });
  expect(invoke).toHaveBeenCalledWith("platform_key_sign_in_paused");
  expect(session.service.signIn).toHaveBeenCalledOnce();
});

it("opens the browser sign-in at a first launch", async () => {
  const { session } = await custody(false);
  act(() => {
    session.publish({ status: "signed-out" });
  });
  expect(session.service.signIn).toHaveBeenCalledOnce();
});
