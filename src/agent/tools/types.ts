// Runtime-neutral tool definitions. A ToolDef is the data the harness needs
// to expose a tool to *some* agent runtime; the per-runtime adapter takes
// this shape and wraps it in whichever MCP / tool-registration API the
// runtime expects (Claude SDK's `tool()` + `createSdkMcpServer` today; a
// stdio MCP shim for Codex in a later phase).
//
// We commit to zod for schemas because (a) both runtimes' MCP layers
// consume zod natively or via JSON-Schema conversion (zod v4 ships
// `z.toJSONSchema`), and (b) keeping the def files dependency-light makes
// them easy for a Codex stdio MCP server to import without dragging in any
// Anthropic SDK code.

import type { ZodRawShape } from "zod";

export type ToolResultBlock = { type: "text"; text: string };

export type ToolResult = {
  content: ToolResultBlock[];
  isError?: boolean;
};

/**
 * Map a zod raw shape (e.g. `{ x: z.string() }`) into the inferred argument
 * record (e.g. `{ x: string }`) the handler receives at call time. We mirror
 * the Anthropic SDK's exact computation (reading `_output` directly) rather
 * than the v4 `z.infer` alias — TS structurally compares the *form* of the
 * mapped type, and a syntactic mismatch with the SDK's signature trips
 * assignability checks when wrapping defs via `tool()`.
 */
export type InferToolArgs<S extends ZodRawShape> = {
  [K in keyof S]: S[K] extends { _output: infer O } ? O : never;
};

/**
 * `handler` is written as a method (bivariant) rather than an arrow-type
 * property (strictly contravariant) so collection helpers can hold a
 * heterogeneous `ToolDef[]` without TS rejecting per-def schema narrowness
 * vs. the widened element type.
 */
export type ToolDef<S extends ZodRawShape = ZodRawShape> = {
  name: string;
  description: string;
  schema: S;
  handler(input: InferToolArgs<S>): Promise<ToolResult>;
};

/** Helper to build a text-only success result. */
export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/** Helper to build a text-only error result. */
export function textError(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
