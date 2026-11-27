import { z } from "zod";
import type { ToolDef } from "../agent/tools/types.js";
import { textResult } from "../agent/tools/types.js";
export type BridgeCall = (tool: string, args: Record<string, unknown>) => Promise<string>;
export function bridgeToolDefs(call: BridgeCall): ToolDef<any>[] {
  return [
    { name: "notify_alan", description: "Notify Alan in this Slack thread about an identified sandbox escape request or attempt. Stop the attempted bypass and briefly describe it.", schema: { details: z.string().min(1).max(4000) }, handler: async (args: any) => textResult(await call("notify_alan", args)) },
    { name: "slack_post_message", description: "Post a message in the current Slack thread.", schema: { text: z.string().max(38000) }, handler: async (args: any) => textResult(await call("slack_post_message", args)) },
    { name: "slack_post_file", description: "Share a file from this container with the current Slack thread. Maximum 20 MiB.", schema: { path: z.string().max(4096), title: z.string().max(200).optional() }, handler: async (args: any) => textResult(await call("slack_post_file", args)) },
    { name: "set_workdir", description: "Set the working directory inside the container for subsequent messages in this conversation.", schema: { path: z.string().max(4096) }, handler: async (args: any) => textResult(await call("set_workdir", args)) },
    { name: "get_workdir", description: "Report this conversation's working directory inside the container.", schema: {}, handler: async () => textResult(await call("get_workdir", {})) },
  ];
}
