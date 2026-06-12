import { PermissionFlagsBits } from "discord-api-types/v10";

// Permission math, kept pure so it can be unit tested without a network.
// Implements Discord's documented resolution order: base permissions from
// roles, Administrator shortcut, then channel overwrites applied as
// everyone overwrite, aggregated role overwrites, member overwrite.

export const ALL_PERMISSIONS: bigint = Object.values(
  PermissionFlagsBits
).reduce((acc, bit) => acc | bit, 0n);

export interface RoleLite {
  id: string;
  permissions: string;
  position: number;
  managed?: boolean;
  name?: string;
}

export interface OverwriteLite {
  id: string;
  // 0 is a role overwrite, 1 is a member overwrite.
  type: number;
  allow: string;
  deny: string;
}

export function computeGuildPermissions(
  memberRoleIds: string[],
  guildId: string,
  roles: RoleLite[]
): bigint {
  let perms = 0n;
  for (const role of roles) {
    // The @everyone role shares its ID with the guild and applies to all.
    if (role.id === guildId || memberRoleIds.includes(role.id)) {
      perms |= BigInt(role.permissions);
    }
  }
  if ((perms & PermissionFlagsBits.Administrator) !== 0n) {
    return ALL_PERMISSIONS;
  }
  return perms;
}

export function computeChannelPermissions(
  memberId: string,
  memberRoleIds: string[],
  guildId: string,
  roles: RoleLite[],
  overwrites: OverwriteLite[]
): bigint {
  const base = computeGuildPermissions(memberRoleIds, guildId, roles);
  // Administrator bypasses every overwrite.
  if (base === ALL_PERMISSIONS) return ALL_PERMISSIONS;

  let perms = base;

  const everyone = overwrites.find((o) => o.type === 0 && o.id === guildId);
  if (everyone) {
    perms &= ~BigInt(everyone.deny);
    perms |= BigInt(everyone.allow);
  }

  let roleAllow = 0n;
  let roleDeny = 0n;
  for (const o of overwrites) {
    if (o.type === 0 && o.id !== guildId && memberRoleIds.includes(o.id)) {
      roleAllow |= BigInt(o.allow);
      roleDeny |= BigInt(o.deny);
    }
  }
  perms &= ~roleDeny;
  perms |= roleAllow;

  const mine = overwrites.find((o) => o.type === 1 && o.id === memberId);
  if (mine) {
    perms &= ~BigInt(mine.deny);
    perms |= BigInt(mine.allow);
  }

  return perms;
}

export function highestRolePosition(
  memberRoleIds: string[],
  roles: RoleLite[]
): number {
  let highest = 0;
  for (const role of roles) {
    if (memberRoleIds.includes(role.id) && role.position > highest) {
      highest = role.position;
    }
  }
  return highest;
}

// Whether the bot may take a moderation action (kick, ban, timeout)
// against a target member. Pure, so the exact rules are unit tested.
// Discord's rule for moderation is strict hierarchy: the actor's highest
// role must be strictly higher than the target's, the owner is untouchable,
// and nothing moderates itself.
export interface ModerationCheck {
  ok: boolean;
  reason?: string;
}

export function canModerate(input: {
  action: string;
  targetId: string;
  targetTopPosition: number;
  botId: string;
  botTopPosition: number;
  ownerId: string;
}): ModerationCheck {
  if (input.targetId === input.botId) {
    return { ok: false, reason: `The bot cannot ${input.action} itself.` };
  }
  if (input.targetId === input.ownerId) {
    return {
      ok: false,
      reason: `The server owner cannot be ${input.action}ed by anyone.`,
    };
  }
  if (input.targetTopPosition >= input.botTopPosition) {
    return {
      ok: false,
      reason:
        `The target's highest role (position ${input.targetTopPosition}) ` +
        `is not below the bot's (position ${input.botTopPosition}). Discord ` +
        `only allows moderating members with strictly lower roles. Move ` +
        `the bot's role up or the target's down.`,
    };
  }
  return { ok: true };
}

// Permission names. Tools accept human-friendly names like "manage messages"
// or "MANAGE_MESSAGES" and translate them to bits. The canonical public
// spelling is snake_case.

function toSnakeCase(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const nameToBit = new Map<string, bigint>();
const canonicalNames: string[] = [];
for (const [key, bit] of Object.entries(PermissionFlagsBits)) {
  nameToBit.set(normalizeName(key), bit);
  canonicalNames.push(toSnakeCase(key));
}
canonicalNames.sort();

export function listPermissionNames(): string[] {
  return [...canonicalNames];
}

export function parsePermissionNames(names: string[]): {
  bits: bigint;
  unknown: string[];
} {
  let bits = 0n;
  const unknown: string[] = [];
  for (const name of names) {
    const bit = nameToBit.get(normalizeName(name));
    if (bit === undefined) unknown.push(name);
    else bits |= bit;
  }
  return { bits, unknown };
}

export function describePermissions(bits: bigint): string[] {
  const out: string[] = [];
  for (const [key, bit] of Object.entries(PermissionFlagsBits)) {
    if ((bits & bit) !== 0n) out.push(toSnakeCase(key));
  }
  return out;
}

// Vetted permission bundles for create_role. Administrator is deliberately
// in no preset; granting it requires spelling it out in the permissions
// list, so it never happens by reflex.
const P = PermissionFlagsBits;

const MEMBER_PRESET =
  P.ViewChannel |
  P.SendMessages |
  P.SendMessagesInThreads |
  P.CreatePublicThreads |
  P.ReadMessageHistory |
  P.AddReactions |
  P.EmbedLinks |
  P.AttachFiles |
  P.UseExternalEmojis |
  P.UseApplicationCommands |
  P.Connect |
  P.Speak |
  P.Stream |
  P.UseVAD |
  P.ChangeNickname;

const MODERATOR_PRESET =
  MEMBER_PRESET |
  P.ManageMessages |
  P.PinMessages |
  P.ManageThreads |
  P.ModerateMembers |
  P.KickMembers |
  P.MuteMembers |
  P.DeafenMembers |
  P.MoveMembers |
  P.ManageNicknames |
  P.ViewAuditLog;

const ADMIN_PRESET =
  MODERATOR_PRESET |
  P.BanMembers |
  P.ManageChannels |
  P.ManageGuild |
  P.ManageRoles |
  P.ManageWebhooks |
  P.ManageEvents |
  P.ManageGuildExpressions |
  P.CreateInstantInvite;

export const PERMISSION_PRESETS: Record<string, bigint> = {
  none: 0n,
  member: MEMBER_PRESET,
  moderator: MODERATOR_PRESET,
  admin: ADMIN_PRESET,
};
