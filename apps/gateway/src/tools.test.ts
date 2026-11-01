import { describe, it, expect } from "vitest";
import { needsApproval } from "./tools.ts";
import type { Connection, ToolDefinition } from "./entities.ts";
const connection: Connection = {
  id: "test",
  name: "Test",
  kind: "mcp",
  url: "https://example.com/mcp",
  allowReads: true,
  readTools: ["test"],
};
const tool: ToolDefinition = {
  name: "test",
  description: "test",
  parameters: {},
  connectionId: "test",
  remoteName: "test",
  readOnly: false,
  destructive: true,
};
describe("tool authorization", () => {
  it("requires approval for unannotated and destructive MCP tools", () => {
    expect(needsApproval(connection, tool, {})).toBe(true);
    expect(needsApproval(connection, { ...tool, readOnly: true }, {})).toBe(true);
    expect(
      needsApproval(
        { ...connection, readTools: [] },
        { ...tool, readOnly: true, destructive: false },
        {},
      ),
    ).toBe(true);
    expect(needsApproval(connection, { ...tool, readOnly: true, destructive: false }, {})).toBe(
      false,
    );
    expect(
      needsApproval(
        { ...connection, allowReads: false },
        { ...tool, readOnly: true, destructive: false },
        {},
      ),
    ).toBe(true);
  });
  it("only permits HTTP GET/HEAD when the owner allowed reads", () => {
    for (const method of ["POST", "DELETE", "PATCH", "PUT", undefined, "get"])
      expect(needsApproval({ ...connection, kind: "http" }, tool, { method })).toBe(true);
    for (const method of ["GET", "HEAD"])
      expect(needsApproval({ ...connection, kind: "http" }, tool, { method })).toBe(false);
    expect(needsApproval({ ...connection, kind: "ntfy" }, tool, {})).toBe(true);
  });
});
