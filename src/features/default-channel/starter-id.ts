// Upstream block/buzz desktop derives starter channel ids this way
// (desktop/src-tauri/src/commands/channels.rs, `starter_channel_uuid`), so a
// re-run, or upstream's own starter flow, lands on the same channel.
const STARTER_CHANNEL_NAMESPACE = "3ce33bea-8f09-5f1b-9c85-8a7d2659e6b0";

const uuidBytes = (uuid: string) =>
  Uint8Array.from(uuid.replace(/-/g, "").match(/../g) ?? [], (pair) =>
    Number.parseInt(pair, 16),
  );

const uuidText = (bytes: Uint8Array) => {
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4),
    hex.slice(4, 6),
    hex.slice(6, 8),
    hex.slice(8, 10),
    hex.slice(10, 16),
  ]
    .map((group) => group.join(""))
    .join("-");
};

/** RFC 9562 UUIDv5: SHA-1 over namespace bytes then name bytes. */
export async function uuidV5(namespace: string, name: string) {
  const input = new Uint8Array([
    ...uuidBytes(namespace),
    ...new TextEncoder().encode(name),
  ]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  const bytes = digest.slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return uuidText(bytes);
}

/** `origin` is the community's https origin, which is upstream's relay HTTP base. */
export const starterChannelId = (origin: string, slug: string) =>
  uuidV5(
    STARTER_CHANNEL_NAMESPACE,
    `starter-channel:v1:${origin.trim()}:${slug}`,
  );
