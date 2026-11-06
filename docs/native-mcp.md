# Native webview automation

The optional `native-mcp` Cargo feature connects the real Buzz webview to the
standard [Hypothesi Tauri MCP tools](https://github.com/hypothesi/mcp-server-tauri).
The bridge is available only in macOS debug builds. Normal builds and launches
do not register it. Release builds and other platforms refuse an explicit opt-in.
This bridge is separate from the MCP servers that Buzz plugins can serve.

## Choose the identity it runs as

The bridge can execute JavaScript and native commands with the app's authority.
A test instance signs with the shared debug Keychain identity, the same key
`bin/just desktop` and `bin/just web` use. A different app identifier, port or
`BUZZODZ_PROFILE` does **not** isolate it, so whatever an agent does through
the bridge, it does as that key, in that key's communities. Do not replace a
developer's active identity. See [identity custody](identity.md).

For automation you do not supervise, use a disposable macOS account or VM with
generated test keys and a local test relay. To let an agent test against a live
community as yourself:

- Writes such as messages, reactions and joins publish as the signed-in key.
  Tell the agent where it may write, such as a scratch channel. A join also adds
  the community to the account's list, which syncs to your other devices and
  is not removed by sync ([known communities](communities.md#known-communities)).
- Do not let an agent sign out. Sign out deletes the shared debug identity for
  every debug build and removes saved organization sign-ins for every profile.
- A person completes any organization sign-in in the browser. The bridge never
  receives the session token.

Each test instance keeps its app data under its identifier; nothing removes it.
An opt-in launch also refuses a non-empty `BUZZ_DEV_VIEWER` legacy broker pin.

Build and launch with all of these settings:

- Cargo feature: `native-mcp`.
- Tauri config overlay: `src-tauri/tauri.native-mcp.conf.json`.
- A separate identifier overlay: `xyz.moneta.buzz.foundation.nexus-test-` followed
  by 12 lowercase hexadecimal digits unique to the test instance.
- Launch environment: `BUZZ_NATIVE_MCP_PORT`, an integer from `1024` through
  `65436`. Unset means off. Invalid settings fail before identity startup.

From the repository root:

```sh
bin/node scripts/desktop-mcp.mjs
```

It applies all of the settings above, with an identifier suffix and bridge base
port derived from the worktree path, and prints both; `--print` prints them
without launching. Each worktree owns one test instance, and relaunches keep its
app data. It also sets `BUZZODZ_PROFILE` to `native-mcp-` and the identifier
suffix unless the environment sets one. Other arguments pass to `just desktop`,
such as `--port` for Vite. A manual launch looks like this:

```sh
BUZZ_DEV_VIEWER= BUZZ_NATIVE_MCP_PORT=19423 BUZZODZ_PROFILE=native-mcp-012345abcdef \
  bin/just desktop --features native-mcp \
  --config src-tauri/tauri.native-mcp.conf.json \
  --config '{"identifier":"xyz.moneta.buzz.foundation.nexus-test-012345abcdef"}'
```

Replace the example identifier suffix for each owned test instance. Keep `BUZZ_DEV_VIEWER` explicitly empty to disable any inherited legacy broker pin.
The repository's `buzz-native` client accepts only the instance the launcher
derives for this worktree, so it refuses one launched with another identifier
or port.
Do not add
this configuration to ordinary desktop or release recipes. A helper that uses
`TAURI_CONFIG` must merge the test overlay and its identifier into that JSON
before compilation. Preserve the ordinary app settings and capability IDs.

The overlay enables `withGlobalTauri` and adds only these local `main` webview
callbacks: `mcp-bridge:allow-script-result`,
`mcp-bridge:allow-request-script-injection`, and
`mcp-bridge:allow-report-ipc-event`. It preserves `main-window`, `desktop-window`,
and `huddle-window`. It is outside the auto-loaded `capabilities/` directory.
It grants neither the bridge's default permission set nor `execute-command`.
The existing signed host commands and plugin sandbox still apply.

## Connect

The bridge binds only to `127.0.0.1` and takes the first free port of the 100
from its base port. The repository's `.mcp.json` registers
`@hypothesi/tauri-mcp-server@0.13.1` as `buzz-native`, through
`scripts/native-mcp-client.mjs`. MCP clients that read project configuration,
such as Claude Code, offer its tools after approval.

Two worktrees can share a port range, and the client connects to whichever app
answers, so the script points it at a loopback relay. The relay forwards commands
only to an app that reports this worktree's identifier, a debug build and a
`main` window. Whenever it has no open connection to one, it looks again on the
next command, and fails that command if none answers. When the app quits,
commands it has not answered fail and the session stays connected, so it reaches
the app again after a rebuild or relaunch. Start `driver_session` without a
port: a port passed there bypasses the relay.

The pinned bridge revision is
`1d5105e72835b28ca05a75bcd612b9127c12fe94` from
[upstream PR 38](https://github.com/hypothesi/mcp-server-tauri/pull/38).
It rejects both `Origin` and `Sec-WebSocket-Origin` at the WebSocket handshake.
Loopback clients without those headers still have full automation authority;
this is a local test interface, not an authenticated service.

The client is a pinned devDependency. The bridge reports version `0.12.0` and
omits plugin-version metadata, so the
standard client can show an upgrade warning. Do not replace the pinned revision
with a release that lacks the Origin check to remove that warning.

The bridge listens before the app has rendered its shell, so wait for the target
element with `webview_wait_for` before the first action. Its `detached` state
times out rather than resolving; check absence with `webview_execute_js`. The
tools reach only the `main` window's web content: native dialogs and prompts,
the Browser panel's website view, the huddle window and deep links need other
automation.

A community that requires organization sign-in needs the launch environment to
carry `BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG` (see
[configuration](configuration.md#federated-identity-build-input)). Saved
sign-ins are keyed by `BUZZODZ_PROFILE`, not the app identifier; the launcher's
profile keeps a test instance from restoring another debug build's session.

Verify session start, a DOM snapshot, an interaction, its resulting DOM state,
and session stop against the real native app. Check that a browser-origin
handshake is rejected. Stop the app after testing and verify that its listener
has closed. Remove any temporary local relay CA trust through its owning helper.
Native acceptance is macOS-only; Windows and Linux bridge support is outside
this feature.

## Focused source checks

The default Linux CI run checks the launch input policy. On macOS, also run the
feature and generated permission checks before native acceptance:

```sh
bin/cargo test --locked -p Buzz --features native-mcp native_mcp
bin/cargo test --locked -p Buzz --features native-mcp browser_permissions_tests
bin/cargo-deny --locked --features native-mcp check
```

The permission test uses Tauri's real access-control resolver with an inert
plugin handler. It proves local `main` callbacks and rejects remote, guest,
huddle, and extra bridge commands. It does not start the bridge or prove native
webview interaction. Keep that native check separate from these source checks.
