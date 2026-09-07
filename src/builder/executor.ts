import { Routes } from "discord-api-types/v10";
import type {
  APIRole,
  RESTPatchAPIGuildRolePositionsJSONBody,
  RESTPostAPIGuildChannelJSONBody,
  RESTPostAPIGuildRoleJSONBody,
} from "discord-api-types/v10";
import type { REST } from "@discordjs/rest";
import type { GuildChannelLite } from "../discord/guildData.js";
import {
  parsePermissionNames,
  PERMISSION_PRESETS,
  type RoleLite,
} from "../discord/preflight.js";
import type { Blueprint } from "./blueprint.js";
import type { PlanStep } from "./planner.js";
import { compileOverwrites, UnknownRoleError } from "./overwrites.js";

// The executor walks a freshly validated plan in dependency order: roles,
// then categories, then channels. It checkpoints as it goes; if a step
// fails, execution stops and the report says exactly what now exists,
// what failed, and what was never attempted. Additive by design: nothing
// is ever deleted or modified, so a failed build can be re-run after the
// fix and every already-created entity is simply reused.

export interface StepResult {
  order: number;
  action: string;
  name: string;
  status: "created" | "reused" | "failed" | "not_attempted";
  id?: string;
  error?: string;
}

export interface BuildReport {
  results: StepResult[];
  created: number;
  reused: number;
  failed: boolean;
  // Things that went imperfectly without stopping the build.
  warnings: string[];
  // How many roles this run created, and whether they were given explicit
  // positions afterward. When not, they share position 1 and the hierarchy
  // is held by creation order alone, which the client honors just the same.
  rolesCreated: number;
  stacked: boolean;
}

// The bulk reposition body for roles the build just created: first role in
// blueprint order goes lowest, at position 1, and the rest stack upward.
// Pure, so the shape is unit tested without a server.
export function stackPositions(
  createdRoleIds: string[]
): RESTPatchAPIGuildRolePositionsJSONBody {
  return createdRoleIds.map((id, i) => ({ id, position: i + 1 }));
}

export async function executePlan(
  rest: REST,
  guildId: string,
  botUserId: string,
  blueprint: Blueprint,
  steps: PlanStep[],
  liveRoles: RoleLite[],
  liveChannels: GuildChannelLite[]
): Promise<BuildReport> {
  const results: StepResult[] = [];
  const warnings: string[] = [];
  // Roles this run created, in blueprint order, for the reposition at the end.
  const createdRoles: string[] = [];

  // Name-to-id maps, seeded from the live server and extended as the
  // build creates things. All keys lowercased.
  const roleIds = new Map<string, string>();
  for (const r of liveRoles) {
    if (r.name) roleIds.set(r.name.toLowerCase(), r.id);
  }
  const categoryIds = new Map<string, string>();
  for (const c of liveChannels) {
    if (c.type === 4 && c.name) categoryIds.set(c.name.toLowerCase(), c.id);
  }

  // Category visibility from the blueprint, for child channel syncing.
  const categoryPrivacy = new Map<string, string[]>();
  for (const cat of blueprint.categories ?? []) {
    categoryPrivacy.set(cat.name.toLowerCase(), cat.private_to ?? []);
  }

  let halted = false;

  for (const step of steps) {
    if (halted) {
      results.push({
        order: step.order,
        action: step.action,
        name: step.name,
        status: "not_attempted",
      });
      continue;
    }

    if (step.exists) {
      results.push({
        order: step.order,
        action: step.action,
        name: step.name,
        status: "reused",
        id: step.exists.id,
      });
      continue;
    }

    try {
      if (step.action === "create_role") {
        const details = step.details as {
          preset: string;
          extra_permissions: string[];
          color: string | null;
          hoist: boolean;
          mentionable: boolean;
        };
        let bits = PERMISSION_PRESETS[details.preset] ?? 0n;
        bits |= parsePermissionNames(details.extra_permissions).bits;
        const body: RESTPostAPIGuildRoleJSONBody = {
          name: step.name,
          permissions: bits.toString(),
          hoist: details.hoist,
          mentionable: details.mentionable,
          ...(details.color
            ? { color: parseInt(details.color.replace(/^#/, ""), 16) }
            : {}),
        };
        const role = (await rest.post(Routes.guildRoles(guildId), {
          body,
          reason: "Omnicord build",
        })) as APIRole;
        roleIds.set(role.name.toLowerCase(), role.id);
        createdRoles.push(role.id);
        results.push({
          order: step.order,
          action: step.action,
          name: step.name,
          status: "created",
          id: role.id,
        });
      } else if (step.action === "create_category") {
        const details = step.details as { private_to: string[] };
        const overwrites = compileOverwrites(
          { kind: "category", privateTo: details.private_to },
          roleIds,
          guildId,
          botUserId
        );
        const body: RESTPostAPIGuildChannelJSONBody = {
          name: step.name,
          type: 4 as never,
          ...(overwrites.length > 0
            ? { permission_overwrites: overwrites as never }
            : {}),
        };
        const created = (await rest.post(Routes.guildChannels(guildId), {
          body,
          reason: "Omnicord build",
        })) as GuildChannelLite;
        categoryIds.set((created.name ?? step.name).toLowerCase(), created.id);
        results.push({
          order: step.order,
          action: step.action,
          name: step.name,
          status: "created",
          id: created.id,
        });
      } else {
        const details = step.details as {
          type: string;
          type_code: number;
          category: string | null;
          topic: string | null;
          slowmode_seconds: number | null;
          nsfw: boolean;
          private_to: string[];
          read_only: boolean;
          posting_roles: string[];
        };
        const parentId = details.category
          ? categoryIds.get(details.category.toLowerCase())
          : undefined;
        if (details.category && !parentId) {
          throw new Error(
            `Parent category "${details.category}" was not created and ` +
              "does not exist."
          );
        }
        const overwrites = compileOverwrites(
          {
            kind: details.type as never,
            privateTo: details.private_to,
            readOnly: details.read_only,
            postingRoles: details.posting_roles,
            inheritedPrivateTo: details.category
              ? categoryPrivacy.get(details.category.toLowerCase())
              : undefined,
          },
          roleIds,
          guildId,
          botUserId
        );
        const body: RESTPostAPIGuildChannelJSONBody = {
          name: step.name,
          type: details.type_code as never,
          ...(parentId ? { parent_id: parentId } : {}),
          ...(details.topic ? { topic: details.topic } : {}),
          ...(details.slowmode_seconds !== null
            ? { rate_limit_per_user: details.slowmode_seconds }
            : {}),
          ...(details.nsfw ? { nsfw: true } : {}),
          ...(overwrites.length > 0
            ? { permission_overwrites: overwrites as never }
            : {}),
        };
        const created = (await rest.post(Routes.guildChannels(guildId), {
          body,
          reason: "Omnicord build",
        })) as GuildChannelLite;
        results.push({
          order: step.order,
          action: step.action,
          name: step.name,
          status: "created",
          id: created.id,
        });
      }
    } catch (err) {
      const message =
        err instanceof UnknownRoleError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      results.push({
        order: step.order,
        action: step.action,
        name: step.name,
        status: "failed",
        error: message,
      });
      halted = true;
    }
  }

  // Discord parks every role created through the API at position 1, so a
  // batch of new roles ties, and the client breaks the tie by id, oldest
  // highest. Blueprints list roles highest first and steps run in that
  // order, so the top role gets the oldest id and the hierarchy is right the
  // moment the roles exist, with no extra permission. This reposition is the
  // finishing touch: distinct positions
  // in the same order, which reads more cleanly in the client and in an
  // export. It needs the bot's own role to sit above every position it
  // assigns, which a fresh server never satisfies, so a refusal is expected
  // there and costs nothing; the report records which way the order is held.
  let stacked = false;
  if (createdRoles.length > 0) {
    try {
      await rest.patch(Routes.guildRoles(guildId), {
        // Created top-down; the body wants lowest first.
        body: stackPositions([...createdRoles].reverse()),
        reason: "Omnicord build",
      });
      stacked = true;
    } catch {
      stacked = false;
    }
  }

  return {
    results,
    created: results.filter((r) => r.status === "created").length,
    reused: results.filter((r) => r.status === "reused").length,
    failed: results.some((r) => r.status === "failed"),
    warnings,
    rolesCreated: createdRoles.length,
    stacked,
  };
}
