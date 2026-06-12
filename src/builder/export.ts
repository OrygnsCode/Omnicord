import { PermissionFlagsBits } from "discord-api-types/v10";
import type { GuildChannelLite } from "../discord/guildData.js";
import { describePermissions, type RoleLite } from "../discord/preflight.js";
import type { Blueprint, BlueprintChannel } from "./blueprint.js";

// Snapshot a live server into a blueprint: the inverse of the build
// executor. Permission overwrites get decompiled back into the
// blueprint's visibility sugar (private_to, read_only, posting_roles);
// anything the sugar cannot express is captured approximately and
// reported as a warning instead of silently dropped. Pure, so the exact
// inversion rules are unit tested.

const P = PermissionFlagsBits;

const SEND_FAMILY =
  P.SendMessages |
  P.SendMessagesInThreads |
  P.CreatePublicThreads |
  P.CreatePrivateThreads;

const TYPE_NAMES: Record<number, BlueprintChannel["type"]> = {
  0: "text",
  2: "voice",
  5: "announcement",
  13: "stage",
  15: "forum",
};

interface Visibility {
  privateTo: string[];
  readOnly: boolean;
  postingRoles: string[];
  leftovers: boolean;
}

function setEquals(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const lower = new Set(a.map((x) => x.toLowerCase()));
  return b.every((x) => lower.has(x.toLowerCase()));
}

// Decompiles one channel's overwrites into the sugar. The bot's own
// member overwrite is the executor's self-allow and is ignored; other
// member overwrites and unexpected bits flag the leftovers warning.
function readVisibility(
  channel: GuildChannelLite,
  guildId: string,
  roleNames: Map<string, string>,
  botUserId: string | undefined
): Visibility {
  const out: Visibility = {
    privateTo: [],
    readOnly: false,
    postingRoles: [],
    leftovers: false,
  };
  const overwrites = channel.permission_overwrites ?? [];
  const gateBits =
    channel.type === 2 || channel.type === 13 || channel.type === 4
      ? P.ViewChannel | P.Connect
      : P.ViewChannel;

  for (const ow of overwrites) {
    const allow = BigInt(ow.allow);
    const deny = BigInt(ow.deny);

    if (ow.type === 1) {
      if (botUserId && ow.id === botUserId) continue;
      out.leftovers = true;
      continue;
    }

    if (ow.id === guildId) {
      const knownDeny = gateBits | SEND_FAMILY;
      if ((deny & ~knownDeny) !== 0n || allow !== 0n) out.leftovers = true;
      if ((deny & SEND_FAMILY) !== 0n) out.readOnly = true;
      continue;
    }

    const name = roleNames.get(ow.id);
    if (!name) {
      out.leftovers = true;
      continue;
    }
    const knownAllow = gateBits | P.SendMessages | P.SendMessagesInThreads;
    if ((allow & ~knownAllow) !== 0n || deny !== 0n) out.leftovers = true;
    if ((allow & P.ViewChannel) !== 0n) out.privateTo.push(name);
    if ((allow & P.SendMessages) !== 0n) out.postingRoles.push(name);
  }

  // private_to only means something when everyone is actually denied view.
  const everyone = overwrites.find((o) => o.type === 0 && o.id === guildId);
  if (!everyone || (BigInt(everyone.deny) & P.ViewChannel) === 0n) {
    out.privateTo = [];
  }
  if (!out.readOnly) out.postingRoles = [];
  return out;
}

export function exportBlueprint(
  channels: GuildChannelLite[],
  roles: RoleLite[],
  guildId: string,
  options: { botUserId?: string; name?: string } = {}
): { blueprint: Blueprint; warnings: string[] } {
  const warnings: string[] = [];
  const roleNames = new Map(
    roles.filter((r) => r.name).map((r) => [r.id, r.name as string])
  );

  // Roles: everything except @everyone and integration-managed ones,
  // bottom of the hierarchy first so a rebuild stacks them the same way.
  const exportedRoles = roles
    .filter((r) => r.id !== guildId && !r.managed)
    .sort((a, b) => a.position - b.position)
    .map((r) => {
      const extra = r as RoleLite & {
        color?: number;
        hoist?: boolean;
        mentionable?: boolean;
      };
      return {
        name: r.name ?? "unnamed",
        permissions: describePermissions(BigInt(r.permissions)),
        ...(extra.color
          ? { color: `#${extra.color.toString(16).padStart(6, "0")}` }
          : {}),
        ...(extra.hoist ? { hoist: true } : {}),
        ...(extra.mentionable ? { mentionable: true } : {}),
      };
    });

  const byPosition = (a: GuildChannelLite, b: GuildChannelLite) =>
    (a.position ?? 0) - (b.position ?? 0);

  function exportChannel(
    c: GuildChannelLite,
    parentVisibility?: Visibility
  ): BlueprintChannel | null {
    const typeName = TYPE_NAMES[c.type];
    if (!typeName) {
      warnings.push(
        `Channel "${c.name}" has a type the blueprint cannot express ` +
          `(type ${c.type}); skipped.`
      );
      return null;
    }
    const vis = readVisibility(c, guildId, roleNames, options.botUserId);
    if (vis.leftovers) {
      warnings.push(
        `Channel "${c.name}" has permission overwrites beyond the ` +
          "blueprint's visibility model; captured approximately."
      );
    }
    // A child whose privacy matches its category is synced; the
    // blueprint expresses that by leaving the child unmarked.
    const inheritsPrivacy =
      parentVisibility !== undefined &&
      setEquals(vis.privateTo, parentVisibility.privateTo);

    return {
      name: c.name ?? "unnamed",
      ...(typeName !== "text" ? { type: typeName } : {}),
      ...(c.topic && c.type !== 2 && c.type !== 13 ? { topic: c.topic } : {}),
      ...(c.rate_limit_per_user
        ? { slowmode_seconds: c.rate_limit_per_user }
        : {}),
      ...(c.nsfw ? { nsfw: true } : {}),
      ...(vis.privateTo.length > 0 && !inheritsPrivacy
        ? { private_to: vis.privateTo }
        : {}),
      ...(vis.readOnly ? { read_only: true } : {}),
      ...(vis.postingRoles.length > 0 ? { posting_roles: vis.postingRoles } : {}),
    };
  }

  const categories = channels
    .filter((c) => c.type === 4)
    .sort(byPosition)
    .map((cat) => {
      const catVis = readVisibility(cat, guildId, roleNames, options.botUserId);
      if (catVis.leftovers) {
        warnings.push(
          `Category "${cat.name}" has permission overwrites beyond the ` +
            "blueprint's visibility model; captured approximately."
        );
      }
      return {
        name: cat.name ?? "unnamed",
        ...(catVis.privateTo.length > 0 ? { private_to: catVis.privateTo } : {}),
        channels: channels
          .filter((c) => c.parent_id === cat.id)
          .sort(byPosition)
          .map((c) => exportChannel(c, catVis))
          .filter((c): c is BlueprintChannel => c !== null),
      };
    });

  const topLevel = channels
    .filter((c) => c.type !== 4 && !c.parent_id)
    .sort(byPosition)
    .map((c) => exportChannel(c))
    .filter((c): c is BlueprintChannel => c !== null);

  const blueprint: Blueprint = {
    ...(options.name ? { name: options.name } : {}),
    ...(exportedRoles.length > 0 ? { roles: exportedRoles } : {}),
    ...(categories.length > 0 ? { categories } : {}),
    ...(topLevel.length > 0 ? { channels: topLevel } : {}),
  };
  return { blueprint, warnings };
}
