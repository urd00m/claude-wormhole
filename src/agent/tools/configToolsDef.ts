// Runtime-neutral tool defs for managing macros and launch aliases from
// chat, so the user never hand-edits data/macros.json or data/aliases.json.
// The agent calls these when asked ("add a macro swd that means …",
// "make an alias custom_claude using opus on high effort").
//
// Stores are injected (default: the singletons) so tests can target a tmp
// file instead of the real data/ files.

import { z } from "zod";
import { getMacroStore, MacroStore } from "../macroStore.js";
import { getAliasStore, AliasStore, type AliasDef } from "../aliasStore.js";
import type { EffortLevel } from "../runtime/types.js";
import { textError, textResult, type ToolDef } from "./types.js";

// ---- macros ----------------------------------------------------------------

export function macroSetDef(store: MacroStore): ToolDef<{ name: z.ZodString; expansion: z.ZodString }> {
  return {
    name: "macro_set",
    description:
      "Define (or overwrite) a text macro. When the user types `name` as a whole token in a message, it expands to `expansion` before you run. Use when the user asks to create/update a shorthand.",
    schema: {
      name: z.string().describe("Macro name — a single token, no whitespace (e.g. 'swd')."),
      expansion: z.string().describe("Text the macro expands to."),
    },
    handler: async ({ name, expansion }) => {
      try {
        store.set(name, expansion);
        return textResult(`Macro \`${name}\` set → ${expansion}`);
      } catch (err) {
        return textError(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

export function macroRemoveDef(store: MacroStore): ToolDef<{ name: z.ZodString }> {
  return {
    name: "macro_remove",
    description: "Delete a text macro by name.",
    schema: { name: z.string().describe("Macro name to remove.") },
    handler: async ({ name }) =>
      store.remove(name) ? textResult(`Removed macro \`${name}\`.`) : textError(`No macro named \`${name}\`.`),
  };
}

// eslint-disable-next-line @typescript-eslint/ban-types
export function macroListDef(store: MacroStore): ToolDef<{}> {
  return {
    name: "macro_list",
    description: "List all defined text macros and their expansions.",
    schema: {},
    handler: async () => {
      const all = store.all();
      const names = Object.keys(all);
      if (names.length === 0) return textResult("No macros defined.");
      return textResult(names.map((n) => `• \`${n}\` → ${all[n]}`).join("\n"));
    },
  };
}

// ---- aliases ---------------------------------------------------------------

type AliasSetArgs = {
  name: string;
  runtime: "claude" | "codex";
  model?: string;
  effort?: EffortLevel;
  codexArgs?: string[];
  claudeArgs?: Record<string, string | null>;
};

export function aliasSetDef(store: AliasStore): ToolDef<z.ZodRawShape> {
  return {
    name: "alias_set",
    description:
      "Define (or overwrite) a launch alias — a named agent config the user starts a thread with via `<name> [workdir] [prompt]`. Use when the user asks to create/update an alias.",
    schema: {
      name: z.string().describe("Alias name — a single token, no whitespace (e.g. 'custom_claude')."),
      runtime: z.enum(["claude", "codex"]).describe("Which runtime the alias launches."),
      model: z.string().optional().describe("Model override (e.g. 'claude-opus-4-7')."),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional().describe("Reasoning effort."),
      codexArgs: z.array(z.string()).optional().describe("Codex only: extra `codex exec` argv tokens."),
      claudeArgs: z
        .record(z.string(), z.union([z.string(), z.null()]))
        .optional()
        .describe("Claude only: SDK extraArgs (flag name without `--` → value, or null for a boolean flag)."),
    },
    handler: async (raw) => {
      const { name, runtime, model, effort, codexArgs, claudeArgs } = raw as unknown as AliasSetArgs;
      const def: AliasDef = { runtime };
      if (model) def.model = model;
      if (effort) def.effort = effort;
      if (codexArgs) def.codexArgs = codexArgs;
      if (claudeArgs) def.claudeArgs = claudeArgs;
      try {
        store.set(name, def);
        return textResult(`Alias \`${name}\` set (runtime: ${runtime}${model ? `, model: ${model}` : ""}${effort ? `, effort: ${effort}` : ""}).`);
      } catch (err) {
        return textError(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

export function aliasRemoveDef(store: AliasStore): ToolDef<{ name: z.ZodString }> {
  return {
    name: "alias_remove",
    description: "Delete a launch alias by name.",
    schema: { name: z.string().describe("Alias name to remove.") },
    handler: async ({ name }) =>
      store.remove(name) ? textResult(`Removed alias \`${name}\`.`) : textError(`No alias named \`${name}\`.`),
  };
}

// eslint-disable-next-line @typescript-eslint/ban-types
export function aliasListDef(store: AliasStore): ToolDef<{}> {
  return {
    name: "alias_list",
    description: "List all launch aliases and their configs.",
    schema: {},
    handler: async () => {
      const all = store.all();
      const names = Object.keys(all);
      if (names.length === 0) return textResult("No aliases defined.");
      return textResult(
        names
          .map((n) => {
            const d = all[n];
            const bits = [`runtime: ${d.runtime}`];
            if (d.model) bits.push(`model: ${d.model}`);
            if (d.effort) bits.push(`effort: ${d.effort}`);
            return `• \`${n}\` — ${bits.join(", ")}`;
          })
          .join("\n"),
      );
    },
  };
}

/** All macro + alias management defs, in stable order. */
export function configToolDefs(opts?: { macros?: MacroStore; aliases?: AliasStore }): ReadonlyArray<ToolDef<z.ZodRawShape>> {
  const macros = opts?.macros ?? getMacroStore();
  const aliases = opts?.aliases ?? getAliasStore();
  return [
    macroSetDef(macros) as ToolDef<z.ZodRawShape>,
    macroRemoveDef(macros) as ToolDef<z.ZodRawShape>,
    macroListDef(macros) as ToolDef<z.ZodRawShape>,
    aliasSetDef(aliases) as ToolDef<z.ZodRawShape>,
    aliasRemoveDef(aliases) as ToolDef<z.ZodRawShape>,
    aliasListDef(aliases) as ToolDef<z.ZodRawShape>,
  ];
}
