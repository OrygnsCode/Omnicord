import { PermissionFlagsBits } from "discord-api-types/v10";
import type { GuildChannelLite } from "../discord/guildData.js";
import {
  parsePermissionNames,
  PERMISSION_PRESETS,
  ALL_PERMISSIONS,
  type RoleLite,
} from "../discord/preflight.js";
import {
  normalizedChannelName,
  type Blueprint,
  type BlueprintChannel,
} from "./blueprint.js";

// The planner. Takes a blueprint plus a snapshot of the live server and
// produces either an ordered, executable plan or a list of everything
// wrong with the request. Pure: no network, no side effects, fully unit
// testable. Every edge case caught here is a Discord 400 that never
// happens and a half-built server that never exists.

// Discord structural limits, from the developer docs. The planner checks
// them against existing counts plus what the blueprint adds.
const MAX_CHANNELS_PER_GUILD = 500;
const MAX_ROLES_PER_GUILD = 250;
const MAX_CHANNELS_PER_CATEGORY = 50;

// Channel types that only work when the guild has the COMMUNITY feature.
// Verified empirically against the live API in June 2026: forum channels
// create fine on a plain server, while announcement and stage channels
// come back 400 (codes 50035 and 50024) until Community is enabled.
const COMMUNITY_ONLY_TYPES = new Set(["announcement", "stage"]);

const TYPE_CODES: Record<string, number> = {
  text: 0,
  voice: 2,
  announcement: 5,
  stage: 13,
  forum: 15,
};

// Channel names only collide within the same family. Discord keeps the
// text and voice namespaces fully separate: a text #general and a voice
// channel named General coexist fine. Treating them as one namespace was
// a real bug caught by the first third-party client test, where a
// blueprint's text general got matched to the server's default voice
// General and was wrongly marked for reuse.
function familyOfKind(kind: string): string {
  return kind === "voice" || kind === "stage" ? "voice" : "text";
}

function familyOfType(type: number): string {
  return type === 2 || type === 13 ? "voice" : "text";
}

export interface PlanStep {
  order: number;
  action: "create_role" | "create_category" | "create_channel";
  name: string;
  // Set when the entity already exists and the step is a no-op.
  exists?: { id: string; note: string };
  details: Record<string, unknown>;
}

export interface LiveState {
  channels: GuildChannelLite[];
  roles: RoleLite[];
  guildFeatures: string[];
  botPermissions: bigint;
}

export interface PlanResult {
  steps: PlanStep[];
  warnings: string[];
  errors: string[];
}

export function buildPlan(blueprint: Blueprint, live: LiveState): PlanResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const steps: PlanStep[] = [];
  let order = 1;

  const roles = blueprint.roles ?? [];
  const categories = blueprint.categories ?? [];
  const topLevel = blueprint.channels ?? [];
  const allChannels: Array<{ channel: BlueprintChannel; category?: string }> =
    [
      ...topLevel.map((c) => ({ channel: c })),
      ...categories.flatMap((cat) =>
        cat.channels.map((c) => ({ channel: c, category: cat.name }))
      ),
    ];

  if (roles.length === 0 && categories.length === 0 && topLevel.length === 0) {
    return {
      steps: [],
      warnings: [],
      errors: ["The blueprint is empty. Provide roles, categories, or channels."],
    };
  }

  // Known role names: blueprint roles plus live roles. private_to and
  // posting_roles may reference either.
  const liveRolesByName = new Map(
    live.roles.map((r) => [r.name?.toLowerCase() ?? "", r])
  );
  const blueprintRoleNames = new Set(roles.map((r) => r.name.toLowerCase()));

  function checkRoleRefs(refs: string[] | undefined, where: string): void {
    for (const ref of refs ?? []) {
      const lower = ref.toLowerCase();
      if (!blueprintRoleNames.has(lower) && !liveRolesByName.has(lower)) {
        errors.push(
          `${where} references role "${ref}", which is neither in the ` +
            "blueprint nor on the server. Add the role or fix the name."
        );
      }
    }
  }

  // Permission preflight: what the whole plan needs from the bot.
  const isAdmin = live.botPermissions === ALL_PERMISSIONS;
  const needsRoles =
    roles.length > 0 ||
    allChannels.some(
      (c) => c.channel.private_to || c.channel.read_only
    ) ||
    categories.some((c) => c.private_to);
  if (!isAdmin) {
    if (
      allChannels.length > 0 || categories.length > 0
    ) {
      if ((live.botPermissions & PermissionFlagsBits.ManageChannels) === 0n) {
        errors.push(
          "The bot lacks Manage Channels, which this blueprint needs for " +
            "creating channels and categories."
        );
      }
    }
    if (
      needsRoles &&
      (live.botPermissions & PermissionFlagsBits.ManageRoles) === 0n
    ) {
      errors.push(
        "The bot lacks Manage Roles, which this blueprint needs for " +
          "creating roles and setting channel visibility."
      );
    }
  }

  // Roles: duplicates inside the blueprint, collisions with live roles,
  // permission validity.
  const seenRoleNames = new Set<string>();
  for (const role of roles) {
    const lower = role.name.toLowerCase();
    if (seenRoleNames.has(lower)) {
      errors.push(`The blueprint defines the role "${role.name}" twice.`);
      continue;
    }
    seenRoleNames.add(lower);

    let bits = PERMISSION_PRESETS[role.preset ?? "none"];
    if (role.permissions && role.permissions.length > 0) {
      const parsed = parsePermissionNames(role.permissions);
      if (parsed.unknown.length > 0) {
        errors.push(
          `Role "${role.name}" uses unknown permission name(s): ` +
            parsed.unknown.join(", ") +
            "."
        );
      }
      bits |= parsed.bits;
    }
    if (!isAdmin) {
      const beyond = bits & ~live.botPermissions;
      if (beyond !== 0n) {
        errors.push(
          `Role "${role.name}" would grant permissions the bot itself ` +
            "lacks, which Discord rejects."
        );
      }
    }

    const existing = liveRolesByName.get(lower);
    steps.push({
      order: order++,
      action: "create_role",
      name: role.name,
      ...(existing
        ? {
            exists: {
              id: existing.id,
              note: "A role with this name already exists; it will be reused, not recreated.",
            },
          }
        : {}),
      details: {
        preset: role.preset ?? "none",
        extra_permissions: role.permissions ?? [],
        color: role.color ?? null,
        hoist: role.hoist ?? false,
        mentionable: role.mentionable ?? false,
      },
    });
  }

  // Role count limit, counting only roles that will actually be created.
  const newRoleCount = steps.filter(
    (s) => s.action === "create_role" && !s.exists
  ).length;
  if (live.roles.length + newRoleCount > MAX_ROLES_PER_GUILD) {
    errors.push(
      `This plan would put the server over Discord's ${MAX_ROLES_PER_GUILD} ` +
        "role limit."
    );
  }

  // Categories: duplicates, collisions, channel-per-category limit.
  const liveCategoriesByName = new Map(
    live.channels
      .filter((c) => c.type === 4)
      .map((c) => [(c.name ?? "").toLowerCase(), c])
  );
  const seenCategoryNames = new Set<string>();
  for (const cat of categories) {
    const lower = cat.name.toLowerCase();
    if (seenCategoryNames.has(lower)) {
      errors.push(`The blueprint defines the category "${cat.name}" twice.`);
      continue;
    }
    seenCategoryNames.add(lower);
    checkRoleRefs(cat.private_to, `Category "${cat.name}"`);

    if (cat.channels.length > MAX_CHANNELS_PER_CATEGORY) {
      errors.push(
        `Category "${cat.name}" holds ${cat.channels.length} channels; ` +
          `Discord allows ${MAX_CHANNELS_PER_CATEGORY} per category.`
      );
    }
    const existing = liveCategoriesByName.get(lower);
    if (existing) {
      const existingChildren = live.channels.filter(
        (c) => c.parent_id === existing.id
      ).length;
      if (
        existingChildren + cat.channels.length >
        MAX_CHANNELS_PER_CATEGORY
      ) {
        errors.push(
          `Category "${cat.name}" exists with ${existingChildren} channels; ` +
            `adding ${cat.channels.length} more would pass the ` +
            `${MAX_CHANNELS_PER_CATEGORY} per category limit.`
        );
      }
    }

    steps.push({
      order: order++,
      action: "create_category",
      name: cat.name,
      ...(existing
        ? {
            exists: {
              id: existing.id,
              note: "A category with this name already exists; new channels will be placed inside it.",
            },
          }
        : {}),
      details: { private_to: cat.private_to ?? [] },
    });
  }

  // Channels: normalized-name duplicates inside the blueprint, collisions
  // with live channels, type and feature checks, option sanity.
  const liveChannelNames = new Map(
    live.channels
      .filter((c) => c.type !== 4)
      .map((c) => [
        `${familyOfType(c.type)}:${(c.name ?? "").toLowerCase()}`,
        c,
      ])
  );
  const seenChannelNames = new Set<string>();
  for (const { channel, category } of allChannels) {
    const kind = channel.type ?? "text";
    const normalized = normalizedChannelName(channel.name, kind);
    const family = familyOfKind(kind);
    const collisionKey = `${family}:${normalized.toLowerCase()}`;

    if (seenChannelNames.has(collisionKey)) {
      errors.push(
        `Two blueprint ${family} channels collapse to the same name ` +
          `"${normalized}" after Discord's renaming rules. Rename one of them.`
      );
      continue;
    }
    seenChannelNames.add(collisionKey);

    if (COMMUNITY_ONLY_TYPES.has(kind) && !live.guildFeatures.includes("COMMUNITY")) {
      errors.push(
        `Channel "${channel.name}" is a ${kind} channel, which needs the ` +
          "server to have Community enabled (Server Settings, Enable " +
          "Community). Enable it or use a text channel."
      );
    }

    if (channel.topic && (kind === "voice" || kind === "stage")) {
      warnings.push(
        `Channel "${channel.name}" is ${kind}; Discord has no topics ` +
          "there, so the topic will be dropped."
      );
    }
    if (channel.posting_roles && !channel.read_only) {
      errors.push(
        `Channel "${channel.name}" sets posting_roles without read_only. ` +
          "posting_roles only makes sense for read_only channels."
      );
    }
    checkRoleRefs(channel.private_to, `Channel "${channel.name}"`);
    checkRoleRefs(channel.posting_roles, `Channel "${channel.name}"`);

    const existing = liveChannelNames.get(collisionKey);
    steps.push({
      order: order++,
      action: "create_channel",
      name: normalized,
      ...(existing
        ? {
            exists: {
              id: existing.id,
              note: "A channel with this name already exists and will be left untouched.",
            },
          }
        : {}),
      details: {
        type: kind,
        type_code: TYPE_CODES[kind],
        category: category ?? null,
        topic:
          kind === "voice" || kind === "stage" ? null : channel.topic ?? null,
        slowmode_seconds: channel.slowmode_seconds ?? null,
        nsfw: channel.nsfw ?? false,
        private_to: channel.private_to ?? [],
        read_only: channel.read_only ?? false,
        posting_roles: channel.posting_roles ?? [],
      },
    });
  }

  // Total channel limit: live channels plus everything actually new.
  const newChannelCount = steps.filter(
    (s) =>
      (s.action === "create_channel" || s.action === "create_category") &&
      !s.exists
  ).length;
  if (live.channels.length + newChannelCount > MAX_CHANNELS_PER_GUILD) {
    errors.push(
      `This plan would put the server over Discord's ` +
        `${MAX_CHANNELS_PER_GUILD} channel limit.`
    );
  }

  return { steps, warnings, errors };
}
