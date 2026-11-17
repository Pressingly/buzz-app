import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { worktreeIcon } from "./worktree-icon.mjs";

// The environment a launcher gives Tauri: the process plus every `BUZZ_` value
// in repository-root `.env.local`. Like the native build, it skips Vite's mode
// files; unlike it, values are always literal (no `$VAR` expansion, quoted or
// not), as in the frontend's Builderlab URL reader. Process values win,
// including an explicit empty one. Names without the `BUZZ_` prefix stay out:
// the file can hold unrelated settings and credentials. Updater inputs stay
// release-only, from the process environment.
export function launchEnvironment(root) {
  let text = "";
  try {
    text = readFileSync(join(root, ".env.local"), "utf8");
  } catch (error) {
    // Never echo the file: it can contain unrelated local credentials.
    if (error?.code !== "ENOENT") throw new Error("Could not read .env.local");
  }
  const local = Object.entries(parseEnv(text.replace(/^\uFEFF/, ""))).filter(
    ([name]) => name.startsWith("BUZZ_") && !name.startsWith("BUZZ_UPDATER_"),
  );
  return { ...Object.fromEntries(local), ...process.env };
}

// Pull `--<name> <value>` and `--<name>=<value>` out of a launcher's arguments.
// Scanning stops at `--`, after which everything belongs to Tauri's runner, and the
// last occurrence wins, as it does for Tauri's own repeated flags. A named option
// with no value yields "", which every caller rejects rather than silently deriving.
export function options(args, names) {
  const values = {};
  const forwarded = [];
  let index = 0;
  for (; index < args.length && args[index] !== "--"; index++) {
    const arg = args[index];
    const name = names.find(
      (candidate) =>
        arg === `--${candidate}` || arg.startsWith(`--${candidate}=`),
    );
    if (name === undefined) forwarded.push(arg);
    else
      values[name] =
        arg === `--${name}`
          ? (args[++index] ?? "")
          : arg.slice(name.length + 3);
  }
  return { values, forwarded, rest: args.slice(index) };
}

// Development launches keep their own app storage, copied once from the
// installed app's, so they never take or block it, but share its Agents folder
// (see `src-tauri/src/sign_out/legacy_identifier.rs`).
const DEV_IDENTIFIER = "xyz.moneta.buzz.desktop.dev";

export function desktopOverlay(root) {
  const config = { identifier: DEV_IDENTIFIER };
  const icon = worktreeIcon(root);
  if (icon) config.bundle = { icon: [icon] };
  return config;
}

// Each worktree owns one native MCP test instance (docs/native-mcp.md), so
// relaunches keep its app data and its client finds it rather than another
// worktree's. The bridge scans 100 ports up from its base, so bases are 100
// apart, in [20000, 59900]. native_mcp.rs checks the identifier shape and
// that the base is within 1024-65436.
export function nativeMcpInstance(root) {
  const digest = createHash("sha256").update(root, "utf8").digest("hex");
  return {
    identifier: `xyz.moneta.buzz.foundation.nexus-test-${digest.slice(0, 12)}`,
    port: 20000 + Number(BigInt(`0x${digest}`) % 400n) * 100,
  };
}
