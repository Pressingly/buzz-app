import { expect, it } from "vitest";
import { nativeMcpInstance } from "./desktop-config.mjs";

it("gives each worktree one native MCP instance that native_mcp.rs accepts", () => {
  const instance = nativeMcpInstance("/work/a/");
  expect(instance.identifier).toMatch(
    /^xyz\.moneta\.buzz\.foundation\.nexus-test-[0-9a-f]{12}$/,
  );
  // The bridge scans base..base+99; bases 100 apart keep worktrees' scans apart.
  expect(instance.port % 100).toBe(0);
  expect(instance.port).toBeGreaterThanOrEqual(20000);
  expect(instance.port + 99).toBeLessThanOrEqual(65535);
  expect(nativeMcpInstance("/work/a/")).toEqual(instance);
  expect(nativeMcpInstance("/work/b/").identifier).not.toBe(
    instance.identifier,
  );
});
