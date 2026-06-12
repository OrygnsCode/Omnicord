import { z } from "zod";
import { Routes } from "discord-api-types/v10";
import type { APIGuild, APIGuildMember } from "discord-api-types/v10";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OmnicordConfig } from "../config.js";
import { blueprintSchema, type Blueprint } from "../builder/blueprint.js";
import { buildPlan, type LiveState } from "../builder/planner.js";
import { executePlan } from "../builder/executor.js";
import { REFERENCE_LAYOUTS, getLayout } from "../builder/layouts.js";
import { stagePlan, getPlan, planTtlMinutes } from "../builder/store.js";
import {
  getChannels,
  getRoles,
  getBotUser,
  invalidateGuildCaches,
} from "../discord/guildData.js";
import { computeGuildPermissions } from "../discord/preflight.js";
import { ok, fail } from "../envelope.js";
import { enter, guarded, guildParam } from "./common.js";

// Builder tools, part one: reference layouts and plan staging. The AI
// client owns the creative work of turning a conversation into a
// blueprint; these tools own correctness. plan_server_build never changes
// anything, no matter what is in the blueprint.

export function registerBuilderTools(
  server: McpServer,
  config: OmnicordConfig
): void {
  server.registerTool(
    "list_reference_layouts",
    {
      title: "List reference layouts",
      description:
        "Curated server blueprints to start from: vetted structures for " +
        "common server kinds. Fetch one with get_reference_layout, adapt " +
        "names and channels to the user's theme, then stage it with " +
        "plan_server_build.",
      annotations: { readOnlyHint: true },
    },
    async () =>
      ok(
        `${REFERENCE_LAYOUTS.length} reference layouts available.`,
        {
          layouts: REFERENCE_LAYOUTS.map((l) => ({
            id: l.id,
            title: l.title,
            audience: l.audience,
          })),
        }
      )
  );

  server.registerTool(
    "get_reference_layout",
    {
      title: "Get reference layout",
      description:
        "One reference layout in full: the blueprint plus the reasoning " +
        "behind its structure. Adapt it rather than applying it verbatim; " +
        "the user's theme and wording should win.",
      inputSchema: {
        layout_id: z.string().describe("Layout ID from list_reference_layouts."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ layout_id }) => {
      const layout = getLayout(layout_id);
      if (!layout) {
        return fail(`No layout named "${layout_id}".`, {
          available: REFERENCE_LAYOUTS.map((l) => l.id),
        });
      }
      return ok(`Layout ${layout.id}: ${layout.title}.`, layout);
    }
  );

  server.registerTool(
    "plan_server_build",
    {
      title: "Plan server build",
      description:
        "Validate a blueprint against the live server and stage an ordered " +
        "build plan. Checks Discord limits, name collisions, role " +
        "references, feature requirements, and the bot's permissions, and " +
        "reports every problem at once. Changes nothing. Compose the " +
        "blueprint from the user's request, optionally starting from a " +
        "reference layout. Existing channels and roles with matching names " +
        "are reused, never duplicated.",
      inputSchema: {
        guild: guildParam,
        blueprint: blueprintSchema.describe(
          "The desired structure: roles, categories, channels."
        ),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild, blueprint }) => {
      const { rest, guildId } = await enter(config, guild);

      const [channels, roles, botUser, guildData] = await Promise.all([
        getChannels(rest, guildId),
        getRoles(rest, guildId),
        getBotUser(rest),
        rest.get(Routes.guild(guildId)) as Promise<APIGuild>,
      ]);
      const botMember = (await rest.get(
        Routes.guildMember(guildId, botUser.id)
      )) as APIGuildMember;

      const live: LiveState = {
        channels,
        roles,
        guildFeatures: guildData.features as string[],
        botPermissions: computeGuildPermissions(
          botMember.roles,
          guildId,
          roles
        ),
      };

      const result = buildPlan(blueprint, live);

      if (result.errors.length > 0) {
        return fail(
          `The blueprint has ${result.errors.length} problem(s). Nothing ` +
            "was staged. Fix them and plan again.",
          { errors: result.errors, warnings: result.warnings }
        );
      }

      const plan = stagePlan(guildId, blueprint, result.steps, result.warnings);
      const creating = result.steps.filter((s) => !s.exists);
      const reusing = result.steps.filter((s) => s.exists);

      const counts: Record<string, number> = {};
      for (const step of creating) {
        counts[step.action] = (counts[step.action] ?? 0) + 1;
      }
      const countText = Object.entries(counts)
        .map(([action, n]) => `${n} ${action.replace("create_", "")}(s)`)
        .join(", ");

      return ok(
        `Plan ${plan.planId} staged: ${countText || "nothing new"}` +
          (reusing.length > 0
            ? `, reusing ${reusing.length} existing item(s)`
            : "") +
          `. Nothing has been changed yet. Review the steps with the user, ` +
          `then run execute_build_plan with this plan_id. The plan expires ` +
          `in ${planTtlMinutes()} minutes.`,
        {
          plan_id: plan.planId,
          guild_id: guildId,
          steps: result.steps,
          to_create: creating.length,
          reused: reusing.length,
        },
        result.warnings
      );
    })
  );

  server.registerTool(
    "execute_build_plan",
    {
      title: "Execute build plan",
      description:
        "Execute a staged plan by plan_id, or pass a blueprint directly. " +
        "Either way the blueprint is re-validated against the live server " +
        "at this moment, then built in dependency order: roles, then " +
        "categories, then channels, with private_to and read_only compiled " +
        "into permission overwrites at creation. Strictly additive: " +
        "existing entities are reused, nothing is deleted or modified. If " +
        "a step fails, the run stops and the report says exactly what was " +
        "created, what failed, and what was never attempted. Re-running " +
        "after a fix resumes naturally because finished work is reused.",
      inputSchema: {
        guild: guildParam,
        plan_id: z.string().optional()
          .describe("A plan staged by plan_server_build."),
        blueprint: blueprintSchema.optional()
          .describe("Build this blueprint directly, skipping the staging step."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ guild, plan_id, blueprint }) => {
      if (!plan_id && !blueprint) {
        return fail("Pass plan_id (from plan_server_build) or a blueprint.");
      }
      if (plan_id && blueprint) {
        return fail("Pass either plan_id or blueprint, not both.");
      }

      let toBuild: Blueprint;
      let guildArg = guild;
      if (plan_id) {
        const staged = getPlan(plan_id);
        if (!staged) {
          return fail(
            `No staged plan ${plan_id}. Plans expire after ` +
              `${planTtlMinutes()} minutes; stage it again with ` +
              "plan_server_build."
          );
        }
        toBuild = staged.blueprint;
        guildArg = guildArg ?? staged.guildId;
      } else {
        toBuild = blueprint as Blueprint;
      }

      const { rest, guildId } = await enter(config, guildArg);

      // Always re-validate against the server as it is right now. The
      // staged steps may be minutes old; the server may have changed.
      const [channels, roles, botUser, guildData] = await Promise.all([
        getChannels(rest, guildId),
        getRoles(rest, guildId),
        getBotUser(rest),
        rest.get(Routes.guild(guildId)) as Promise<APIGuild>,
      ]);
      const botMember = (await rest.get(
        Routes.guildMember(guildId, botUser.id)
      )) as APIGuildMember;

      const live: LiveState = {
        channels,
        roles,
        guildFeatures: guildData.features as string[],
        botPermissions: computeGuildPermissions(
          botMember.roles,
          guildId,
          roles
        ),
      };
      const validated = buildPlan(toBuild, live);
      if (validated.errors.length > 0) {
        return fail(
          `Validation against the current server state found ` +
            `${validated.errors.length} problem(s). Nothing was built.`,
          { errors: validated.errors, warnings: validated.warnings }
        );
      }

      const report = await executePlan(
        rest,
        guildId,
        botUser.id,
        toBuild,
        validated.steps,
        roles,
        channels
      );
      invalidateGuildCaches(guildId);

      if (report.failed) {
        const failedStep = report.results.find((r) => r.status === "failed");
        const remaining = report.results.filter(
          (r) => r.status === "not_attempted"
        ).length;
        return fail(
          `Build halted at step ${failedStep?.order} ` +
            `(${failedStep?.action} "${failedStep?.name}"): ` +
            `${failedStep?.error} ${report.created} item(s) were created ` +
            `before the failure and remain in place; ${remaining} step(s) ` +
            "were not attempted. Fix the cause and run again; finished " +
            "work will be reused.",
          { report: report.results }
        );
      }

      return ok(
        `Build complete: ${report.created} item(s) created, ` +
          `${report.reused} reused.`,
        { report: report.results, created: report.created, reused: report.reused },
        validated.warnings
      );
    })
  );
}
