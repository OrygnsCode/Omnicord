import type { GuildChannelLite } from "../discord/guildData.js";
import {
  parsePermissionNames,
  PERMISSION_PRESETS,
  type RoleLite,
} from "../discord/preflight.js";
import { normalizedChannelName, type Blueprint, type BlueprintChannel } from "./blueprint.js";
import { PermissionFlagsBits } from "discord-api-types/v10";

// Drift detection: how a live server differs from a blueprint. The basis
// for config-as-code workflows: export a design, change things, diff to
// see exactly what moved. Pure, so every comparison rule is unit tested.

const P = PermissionFlagsBits;

export interface DiffChange {
  kind: "role" | "category" | "channel";
  name: string;
  fields: string[];
}

export interface DiffResult {
  in_sync: boolean;
  missing: { roles: string[]; categories: string[]; channels: string[] };
  changed: DiffChange[];
  extra: { roles: string[]; categories: string[]; channels: string[] };
}

function familyOfKind(kind: string | undefined): string {
  return kind === "voice" || kind === "stage" ? "voice" : "text";
}

function familyOfType(type: number): string {
  return type === 2 || type === 13 ? "voice" : "text";
}

function setEquals(a: string[] = [], b: string[] = []): boolean {
  if (a.length !== b.length) return false;
  const lower = new Set(a.map((x) => x.toLowerCase()));
  return b.every((x) => lower.has(x.toLowerCase()));
}

// The sugar a live channel's overwrites express, mirrored from export.ts
// but reduced to what the diff needs.
function liveVisibility(
  channel: GuildChannelLite,
  guildId: string,
  roleNames: Map<string, string>
): { privateTo: string[]; readOnly: boolean; postingRoles: string[] } {
  const overwrites = channel.permission_overwrites ?? [];
  const everyone = overwrites.find((o) => o.type === 0 && o.id === guildId);
  const everyoneDeny = BigInt(everyone?.deny ?? 0);
  const isPrivate = (everyoneDeny & P.ViewChannel) !== 0n;
  const readOnly = (everyoneDeny & P.SendMessages) !== 0n;

  const privateTo: string[] = [];
  const postingRoles: string[] = [];
  for (const ow of overwrites) {
    if (ow.type !== 0 || ow.id === guildId) continue;
    const name = roleNames.get(ow.id);
    if (!name) continue;
    const allow = BigInt(ow.allow);
    if (isPrivate && (allow & P.ViewChannel) !== 0n) privateTo.push(name);
    if (readOnly && (allow & P.SendMessages) !== 0n) postingRoles.push(name);
  }
  return { privateTo, readOnly, postingRoles };
}

export function diffBlueprint(
  blueprint: Blueprint,
  channels: GuildChannelLite[],
  roles: RoleLite[],
  guildId: string
): DiffResult {
  const result: DiffResult = {
    in_sync: true,
    missing: { roles: [], categories: [], channels: [] },
    changed: [],
    extra: { roles: [], categories: [], channels: [] },
  };
  const roleNames = new Map(
    roles.filter((r) => r.name).map((r) => [r.id, r.name as string])
  );

  // Roles.
  const liveRolesByName = new Map(
    roles
      .filter((r) => r.id !== guildId && !r.managed && r.name)
      .map((r) => [(r.name as string).toLowerCase(), r])
  );
  const blueprintRoleNames = new Set<string>();
  for (const bpRole of blueprint.roles ?? []) {
    blueprintRoleNames.add(bpRole.name.toLowerCase());
    const live = liveRolesByName.get(bpRole.name.toLowerCase());
    if (!live) {
      result.missing.roles.push(bpRole.name);
      continue;
    }
    const fields: string[] = [];
    let wantBits = PERMISSION_PRESETS[bpRole.preset ?? "none"];
    wantBits |= parsePermissionNames(bpRole.permissions ?? []).bits;
    if (wantBits !== BigInt(live.permissions)) fields.push("permissions");
    const liveExtra = live as RoleLite & {
      color?: number;
      hoist?: boolean;
      mentionable?: boolean;
    };
    const wantColor = bpRole.color
      ? parseInt(bpRole.color.replace(/^#/, ""), 16)
      : 0;
    if (wantColor !== (liveExtra.color ?? 0)) fields.push("color");
    if ((bpRole.hoist ?? false) !== (liveExtra.hoist ?? false)) fields.push("hoist");
    if ((bpRole.mentionable ?? false) !== (liveExtra.mentionable ?? false)) {
      fields.push("mentionable");
    }
    if (fields.length > 0) {
      result.changed.push({ kind: "role", name: bpRole.name, fields });
    }
  }
  for (const [lower, live] of liveRolesByName) {
    if (!blueprintRoleNames.has(lower)) result.extra.roles.push(live.name as string);
  }

  // Categories.
  const liveCategories = new Map(
    channels
      .filter((c) => c.type === 4 && c.name)
      .map((c) => [(c.name as string).toLowerCase(), c])
  );
  const blueprintCategoryNames = new Set<string>();
  const categoryNameById = new Map(
    channels.filter((c) => c.type === 4).map((c) => [c.id, c.name ?? ""])
  );
  for (const bpCat of blueprint.categories ?? []) {
    blueprintCategoryNames.add(bpCat.name.toLowerCase());
    const live = liveCategories.get(bpCat.name.toLowerCase());
    if (!live) {
      result.missing.categories.push(bpCat.name);
      continue;
    }
    const vis = liveVisibility(live, guildId, roleNames);
    if (!setEquals(bpCat.private_to ?? [], vis.privateTo)) {
      result.changed.push({ kind: "category", name: bpCat.name, fields: ["private_to"] });
    }
  }
  for (const [lower, live] of liveCategories) {
    if (!blueprintCategoryNames.has(lower)) {
      result.extra.categories.push(live.name as string);
    }
  }

  // Channels, matched family-aware and globally; a category move shows
  // up as a changed field rather than missing plus extra.
  const liveChannels = channels.filter((c) => c.type !== 4);
  const liveByKey = new Map(
    liveChannels
      .filter((c) => c.name)
      .map((c) => [
        `${familyOfType(c.type)}:${(c.name as string).toLowerCase()}`,
        c,
      ])
  );

  const blueprintChannels: Array<{ channel: BlueprintChannel; category?: string; inheritedPrivacy?: string[] }> = [
    ...(blueprint.channels ?? []).map((c) => ({ channel: c })),
    ...(blueprint.categories ?? []).flatMap((cat) =>
      cat.channels.map((c) => ({
        channel: c,
        category: cat.name,
        inheritedPrivacy: cat.private_to,
      }))
    ),
  ];
  const blueprintKeys = new Set<string>();

  for (const { channel: bp, category, inheritedPrivacy } of blueprintChannels) {
    const key = `${familyOfKind(bp.type)}:${normalizedChannelName(bp.name, bp.type).toLowerCase()}`;
    blueprintKeys.add(key);
    const live = liveByKey.get(key);
    if (!live) {
      result.missing.channels.push(bp.name);
      continue;
    }
    const fields: string[] = [];
    const wantType = bp.type ?? "text";
    const liveTypeName =
      live.type === 2
        ? "voice"
        : live.type === 5
          ? "announcement"
          : live.type === 13
            ? "stage"
            : live.type === 15
              ? "forum"
              : "text";
    if (wantType !== liveTypeName) fields.push("type");

    const liveCategory = live.parent_id
      ? categoryNameById.get(live.parent_id) ?? null
      : null;
    if ((category ?? null)?.toLowerCase() !== (liveCategory ?? "").toLowerCase() && (category ?? liveCategory) !== null) {
      if ((category ?? "").toLowerCase() !== (liveCategory ?? "").toLowerCase()) {
        fields.push("category");
      }
    }

    if (wantType !== "voice" && wantType !== "stage") {
      if ((bp.topic ?? "") !== (live.topic ?? "")) fields.push("topic");
    }
    if ((bp.slowmode_seconds ?? 0) !== (live.rate_limit_per_user ?? 0)) {
      fields.push("slowmode");
    }
    if ((bp.nsfw ?? false) !== (live.nsfw ?? false)) fields.push("nsfw");

    const vis = liveVisibility(live, guildId, roleNames);
    const wantPrivate =
      bp.private_to && bp.private_to.length > 0
        ? bp.private_to
        : inheritedPrivacy ?? [];
    if (!setEquals(wantPrivate, vis.privateTo)) fields.push("private_to");
    if ((bp.read_only ?? false) !== vis.readOnly) fields.push("read_only");
    if ((bp.read_only ?? false) && !setEquals(bp.posting_roles ?? [], vis.postingRoles)) {
      fields.push("posting_roles");
    }

    if (fields.length > 0) {
      result.changed.push({ kind: "channel", name: bp.name, fields });
    }
  }

  for (const [key, live] of liveByKey) {
    if (!blueprintKeys.has(key)) result.extra.channels.push(live.name as string);
  }

  result.in_sync =
    result.missing.roles.length === 0 &&
    result.missing.categories.length === 0 &&
    result.missing.channels.length === 0 &&
    result.changed.length === 0;
  return result;
}
