import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "../../shared/design-system/ui/Button";
import { setLaunchReady } from "../../app/launch";
import { OnboardingScreen } from "../identity/OnboardingScreen";
import styles from "../identity/IdentitySetup.module.css";
import type { Identity } from "../identity/service";
import { recoveryMessage } from "./CommunitySignIn";
import { LaunchSignIn } from "./LaunchSignIn";
import type { FederatedIdentity } from "./service";

/** Built with `BUZZ_BUILD_KEY_CUSTODY=platform`: the organization holds the key. */
export const platformKeyCustody = () =>
  import.meta.env.VITE_BUZZ_KEY_CUSTODY === "platform";

/**
 * Platform key custody: sign-in comes first, and native installs the
 * account's key with it (`custody.rs`). `children` (first run and the app)
 * mount only once that key is here, so nobody creates or imports one.
 */
export function PlatformKeyCustody({
  identity,
  federatedIdentity,
  children,
}: {
  identity: Identity;
  federatedIdentity: FederatedIdentity;
  children: ReactNode;
}) {
  // No first-run intro: the window shows the sign-in screen at once.
  useEffect(() => {
    if (document.documentElement.dataset.welcomeIntro !== "pending") return;
    delete document.documentElement.dataset.welcomeIntro;
    void invoke("plugin:window|show", { label: "main" }).catch(() => {});
  }, []);
  return (
    <LaunchSignIn identity={federatedIdentity} keyOwner={identity}>
      <PlatformKey identity={identity} federatedIdentity={federatedIdentity}>
        {children}
      </PlatformKey>
    </LaunchSignIn>
  );
}

function PlatformKey({
  identity,
  federatedIdentity,
  children,
}: {
  identity: Identity;
  federatedIdentity: FederatedIdentity;
  children: ReactNode;
}) {
  const key = useSyncExternalStore(identity.subscribe, identity.snapshot);
  const session = useSyncExternalStore(
    federatedIdentity.subscribe,
    federatedIdentity.snapshot,
    federatedIdentity.snapshot,
  );
  const signedIn = session.status === "signed-in";
  // The session whose sign-in installed the key; read it once per session.
  const [read, setRead] = useState<string>();
  useEffect(() => {
    if (!signedIn || key.status !== "missing" || read === session.revision)
      return;
    setRead(session.revision);
    void identity.retry();
  }, [identity, signedIn, key.status, read, session.revision]);
  const [failure, setFailure] = useState("");
  const blocked =
    key.status === "error" || (key.status === "missing" && !key.busy);
  useEffect(() => {
    if (blocked) setLaunchReady(true);
  }, [blocked]);

  if (key.status === "ready") return children;
  const reading =
    key.status === "missing" && signedIn && read !== session.revision;
  if (!blocked || reading) return null;
  const organization = session.authority?.organization ?? "your organization";
  const [title, description, action, run] =
    key.status === "error"
      ? [
          "Couldn’t open your Buzz key",
          key.error,
          "Try again",
          () => identity.retry(),
        ]
      : signedIn
        ? [
            "Your Buzz key isn’t on this device",
            `Sign in again to get it from ${organization}.`,
            "Sign in again",
            () => federatedIdentity.signIn(),
          ]
        : [
            `Sign in to ${organization}`,
            `Buzz gets your key from ${organization} when you sign in.`,
            "Sign in",
            () => federatedIdentity.signIn(),
          ];
  return (
    <OnboardingScreen
      labelledBy="platform-key-title"
      intro={
        <>
          <h1 id="platform-key-title" className="text-heading">
            {title}
          </h1>
          <p className={styles.tagline}>{description}</p>
        </>
      }
    >
      {failure && (
        <p role="alert" className="text-body-sm text-danger">
          {failure}
        </p>
      )}
      <Button
        autoFocus
        size="lg"
        variant="prominent"
        onClick={() => {
          setFailure("");
          void run().catch((error: unknown) =>
            setFailure(
              recoveryMessage(error instanceof Error ? error.message : ""),
            ),
          );
        }}
      >
        {action}
      </Button>
    </OnboardingScreen>
  );
}
