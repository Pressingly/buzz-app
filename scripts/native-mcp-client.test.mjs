import { randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { startRelay } from "./native-mcp-client.mjs";

// Per-run identifiers, so concurrent runs cannot answer for each other.
const testIdentifier = () =>
  `xyz.moneta.buzz.foundation.nexus-test-${randomBytes(6).toString("hex")}`;
const identifier = testIdentifier();
const other = testIdentifier();
const instance = {
  app: { identifier },
  environment: { debug: true },
  windows: [{ label: "main" }],
};
// Separate workers scan separate ranges.
const start = 30000 + (process.pid % 300) * 100;
const servers = [];

afterEach(() => Promise.all(servers.splice(0).map(close)));

function close(server) {
  for (const socket of server.clients) socket.terminate();
  return new Promise((resolve) => server.close(resolve));
}

function listening(server) {
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once("listening", () => resolve(server.address().port));
    server.once("error", reject);
  });
}

// A fake bridge that reports `state`, or sends it as is when it is a string, and
// answers other commands with its port. `hold` delays the state reply.
async function serveApp(state, from = start, hold) {
  for (let port = from; port < from + 50; port++) {
    const app = new WebSocketServer({ host: "127.0.0.1", port });
    try {
      await listening(app);
    } catch {
      servers.pop();
      continue;
    }
    app.commands = [];
    app.on("connection", (socket) =>
      socket.on("message", async (raw) => {
        const { id, command, args } = JSON.parse(raw);
        const probe = args?.command === "plugin:mcp-bridge|get_backend_state";
        if (!probe) app.commands.push(command);
        if (probe && hold) {
          hold.probed();
          await hold.gate;
        }
        socket.send(
          probe && typeof state === "string"
            ? state
            : JSON.stringify({ id, success: true, data: probe ? state : port }),
        );
      }),
    );
    return { app, port };
  }
  throw new Error(`no free port from ${from}`);
}

async function connect(relay, headers) {
  const port = await listening(relay);
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function send(socket, command) {
  const id = String(Math.random());
  return new Promise((resolve) => {
    socket.on("message", function reply(data) {
      const message = JSON.parse(data);
      if (message.id !== id) return;
      socket.off("message", reply);
      resolve(message);
    });
    socket.send(JSON.stringify({ id, command, args: {} }));
  });
}

it("forwards only to the lowest app reporting this worktree's identifier", async () => {
  const wrong = await serveApp({ ...instance, app: { identifier: other } });
  const ours = await serveApp(instance, wrong.port + 1);
  const higher = await serveApp(instance, ours.port + 1);
  const client = await connect(startRelay(identifier, wrong.port));

  expect(await send(client, "ping")).toEqual({
    id: expect.any(String),
    success: true,
    data: ours.port,
  });
  expect(ours.app.commands).toEqual(["ping"]);
  expect(wrong.app.commands).toEqual([]);
  expect(higher.app.commands).toEqual([]);
});

it.each([
  ["another worktree's app", { ...instance, app: { identifier: other } }],
  ["a release build", { ...instance, environment: { debug: false } }],
  ["an app without a main window", { ...instance, windows: [{ label: "x" }] }],
  ["a malformed state", { ...instance, windows: {} }],
  ["a reply that is not an object", "null"],
])("refuses %s", async (_, state) => {
  const { app, port } = await serveApp(state);
  const client = await connect(startRelay(identifier, port));

  expect(await send(client, "ping")).toMatchObject({
    success: false,
    error: expect.stringContaining(identifier),
  });
  expect(app.commands).toEqual([]);
});

it("finds an app launched later, and again after it restarts", async () => {
  const free = await serveApp(instance);
  await close(servers.pop());
  const client = await connect(startRelay(identifier, free.port));
  expect(await send(client, "ping")).toMatchObject({ success: false });

  const { app } = await serveApp(instance, free.port);
  expect(await send(client, "ping")).toMatchObject({ success: true });

  await close(servers.splice(servers.indexOf(app), 1)[0]);
  const restarted = await serveApp(instance, free.port);
  // A command can still reach the old app before the relay sees it close.
  await expect
    .poll(async () => (await send(client, "ping")).success)
    .toBe(true);
  expect(restarted.app.commands).toContain("ping");
});

it("fails a command in flight when the app quits, and keeps the client", async () => {
  const { app, port } = await serveApp(instance);
  const client = await connect(startRelay(identifier, port));
  expect(await send(client, "ping")).toMatchObject({ success: true });

  // The app quits with a command unanswered, as on a rebuild during a start.
  const [socket] = app.clients;
  socket.removeAllListeners("message");
  const received = new Promise((resolve) => socket.once("message", resolve));
  const reply = send(client, "start");
  await received;
  await close(servers.splice(servers.indexOf(app), 1)[0]);

  expect(await reply).toMatchObject({
    success: false,
    error: expect.stringContaining(identifier),
  });
  expect(client.readyState).toBe(WebSocket.OPEN);
});

it.each([
  { origin: "https://example.com" },
  { "sec-websocket-origin": "https://example.com" },
  { "x-buzz-native-mcp-relay": "1" },
])("refuses a handshake with %o", async (headers) => {
  await expect(connect(startRelay(identifier, start), headers)).rejects.toThrow(
    "401",
  );
});

it("drops a command whose client leaves while the app is being found", async () => {
  const hold = {};
  hold.gate = new Promise((resolve) => {
    hold.release = resolve;
  });
  const probed = new Promise((resolve) => {
    hold.probed = resolve;
  });
  const { app, port } = await serveApp(instance, start, hold);
  const appClosed = new Promise((resolve) =>
    app.once("connection", (socket) => socket.once("close", resolve)),
  );
  const client = await connect(startRelay(identifier, port));

  client.send(JSON.stringify({ id: "1", command: "late", args: {} }));
  await probed;
  const closed = new Promise((resolve) => client.once("close", resolve));
  client.close();
  await closed;
  hold.release();
  await appClosed;
  expect(app.commands).toEqual([]);
});
