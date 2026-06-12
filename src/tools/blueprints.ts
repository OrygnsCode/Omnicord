import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OmnicordConfig } from "../config.js";
import { getChannels, getRoles, getBotUser } from "../discord/guildData.js";
import { blueprintSchema, type Blueprint } from "../builder/blueprint.js";
import { exportBlueprint } from "../builder/export.js";
import { diffBlueprint } from "../builder/diff.js";
import {
  listBlueprints,
  findBlueprint,
  saveBlueprint,
  deleteBlueprint,
} from "../builder/blueprintStore.js";
import { gateDestructive } from "../safety.js";
import { ok, fail } from "../envelope.js";
import { enter, guarded, guildParam } from "./common.js";

// The blueprint store: save designs, snapshot live servers into
// blueprints, and detect drift between a design and reality.

function blueprintCounts(blueprint: Blueprint) {
  const channels =
    (blueprint.channels?.length ?? 0) +
    (blueprint.categories ?? []).reduce((sum, c) => sum + c.channels.length, 0);
  return {
    roles: blueprint.roles?.length ?? 0,
    categories: blueprint.categories?.length ?? 0,
    channels,
  };
}

export function registerBlueprintTools(
  server: McpServer,
  config: OmnicordConfig
): void {
  server.registerTool(
    "save_blueprint",
    {
      title: "Save blueprint",
      description:
        "Save a blueprint to the local store for reuse: apply it to other " +
        "servers with execute_build_plan or track drift with " +
        "diff_blueprint. Names are unique.",
      inputSchema: {
        name: z.string().min(1).max(100),
        description: z.string().max(300).optional(),
        blueprint: blueprintSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ name, description, blueprint }) => {
      const saved = saveBlueprint(name, blueprint as Blueprint, description);
      if ("error" in saved) return fail(saved.error);
      return ok(
        `Saved the blueprint "${saved.name}" (${saved.id}).`,
        {
          id: saved.id,
          name: saved.name,
          counts: blueprintCounts(saved.blueprint),
        }
      );
    })
  );

  server.registerTool(
    "list_blueprints",
    {
      title: "List blueprints",
      description: "Saved blueprints in the local store.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const all = listBlueprints();
      return ok(`${all.length} saved blueprint(s).`, {
        blueprints: all.map((b) => ({
          id: b.id,
          name: b.name,
          description: b.description,
          created_at: b.created_at,
          counts: blueprintCounts(b.blueprint),
        })),
      });
    }
  );

  server.registerTool(
    "get_blueprint",
    {
      title: "Get blueprint",
      description: "One saved blueprint in full, by name or ID.",
      inputSchema: {
        blueprint: z.string().describe("Blueprint name or ID."),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ blueprint }) => {
      const found = findBlueprint(blueprint);
      if (!found) {
        return fail(`No saved blueprint matching "${blueprint}".`, {
          available: listBlueprints().map((b) => b.name),
        });
      }
      return ok(`Blueprint "${found.name}" (${found.id}).`, found);
    })
  );

  server.registerTool(
    "delete_blueprint",
    {
      title: "Delete blueprint",
      description:
        "Delete a saved blueprint from the local store. Safe to call " +
        "directly: the first call changes nothing and returns a preview " +
        "plus a confirm_token; repeating the call with the token deletes " +
        "it. Servers built from it are untouched.",
      inputSchema: {
        blueprint: z.string().describe("Blueprint name or ID."),
        dry_run: z.boolean().optional(),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ blueprint, dry_run, confirm_token }) => {
      const found = findBlueprint(blueprint);
      if (!found) return fail(`No saved blueprint matching "${blueprint}".`);

      const gate = gateDestructive({
        tool: "delete_blueprint",
        args: { blueprint: found.id },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary:
          `Would delete the saved blueprint "${found.name}". Servers ` +
          "built from it are untouched; only the stored design goes.",
        previewDetails: { id: found.id, name: found.name },
      });
      if (gate) return gate;

      deleteBlueprint(found.id);
      return ok(`Deleted the blueprint "${found.name}".`, {
        deleted: true,
        id: found.id,
      });
    })
  );

  server.registerTool(
    "export_server_blueprint",
    {
      title: "Export server blueprint",
      description:
        "Snapshot a live server's structure into a blueprint: roles, " +
        "categories, channels, and their visibility, with permission " +
        "overwrites decompiled back into private_to and read_only where " +
        "they fit and warnings where they do not. Optionally save the " +
        "result straight to the store with save_as.",
      inputSchema: {
        guild: guildParam,
        save_as: z.string().min(1).max(100).optional()
          .describe("Save the export under this blueprint name."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ guild, save_as }) => {
      const { rest, guildId } = await enter(config, guild);
      const [channels, roles, botUser] = await Promise.all([
        getChannels(rest, guildId),
        getRoles(rest, guildId),
        getBotUser(rest),
      ]);

      const { blueprint, warnings } = exportBlueprint(channels, roles, guildId, {
        botUserId: botUser.id,
        ...(save_as ? { name: save_as } : {}),
      });

      // The export must always be a valid blueprint; a parse failure here
      // is an Omnicord bug, not a user mistake.
      const parsed = blueprintSchema.safeParse(blueprint);
      if (!parsed.success) {
        return fail(
          "The exported structure failed blueprint validation, which is a " +
            "bug worth reporting.",
          { issues: parsed.error.issues.slice(0, 5) }
        );
      }

      let savedId: string | null = null;
      if (save_as) {
        const saved = saveBlueprint(save_as, blueprint);
        if ("error" in saved) return fail(saved.error);
        savedId = saved.id;
      }

      const counts = blueprintCounts(blueprint);
      return ok(
        `Exported the server: ${counts.roles} role(s), ` +
          `${counts.categories} categor(ies), ${counts.channels} channel(s)` +
          (savedId ? `, saved as "${save_as}" (${savedId})` : "") +
          ".",
        { blueprint, ...(savedId ? { saved_id: savedId } : {}) },
        warnings
      );
    })
  );

  server.registerTool(
    "diff_blueprint",
    {
      title: "Diff blueprint",
      description:
        "Compare a saved blueprint against the live server: what the " +
        "blueprint expects but the server lacks (missing), what exists " +
        "but differs (changed, with the fields), and what the server has " +
        "that the blueprint never mentioned (extra, informational). The " +
        "drift detector for config-as-code workflows.",
      inputSchema: {
        blueprint: z.string().describe("Saved blueprint name or ID."),
        guild: guildParam,
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ blueprint, guild }) => {
      const found = findBlueprint(blueprint);
      if (!found) {
        return fail(`No saved blueprint matching "${blueprint}".`, {
          available: listBlueprints().map((b) => b.name),
        });
      }
      const { rest, guildId } = await enter(config, guild);
      const [channels, roles] = await Promise.all([
        getChannels(rest, guildId),
        getRoles(rest, guildId),
      ]);

      const diff = diffBlueprint(found.blueprint, channels, roles, guildId);
      const missingCount =
        diff.missing.roles.length +
        diff.missing.categories.length +
        diff.missing.channels.length;
      const extraCount =
        diff.extra.roles.length +
        diff.extra.categories.length +
        diff.extra.channels.length;

      return ok(
        diff.in_sync
          ? `The server matches "${found.name}"` +
              (extraCount > 0
                ? `, with ${extraCount} extra item(s) the blueprint does not mention.`
                : " exactly.")
          : `Drift from "${found.name}": ${missingCount} missing, ` +
              `${diff.changed.length} changed, ${extraCount} extra.`,
        diff
      );
    })
  );
}
