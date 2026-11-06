// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { Identity, IdentitySnapshot } from "../identity/service";
import { PlatformKeyCustody } from "./PlatformKeyCustody";
import { federatedFixture } from "./testing";
afterEach(cleanup);

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

function custody(saved: boolean) {
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
    >
      <p>Buzz</p>
    </PlatformKeyCustody>,
  );
  return { session, key };
}

it("signs in first, then reads the key that sign-in installed", async () => {
  const { session, key } = custody(true);
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
  const { session } = custody(true);
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
  const { session, key } = custody(false);
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
  const { session, key } = custody(true);
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

it("names a refused sign-in again instead of blaming the connection", async () => {
  const { session } = custody(false);
  act(() => {
    session.publish({ status: "signed-in", revision: "restored" });
  });
  vi.mocked(session.service.signIn).mockRejectedValueOnce(
    new Error("key-revoked"),
  );
  await act(async () =>
    (await screen.findByRole("button", { name: "Sign in again" })).click(),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Your organization has turned off Buzz for this account.",
  );
});
