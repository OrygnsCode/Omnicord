import { PermissionFlagsBits } from "discord-api-types/v10";

// Compiles the blueprint's visibility sugar (private_to, read_only,
// posting_roles) into Discord permission overwrites. Pure, so the exact
// bit math is unit tested without a server.
//
// Rules:
// - private_to denies ViewChannel for everyone and allows it for the
//   listed roles. Voice-like channels and categories also gate Connect,
//   since seeing a voice channel without being able to join it is rarely
//   what anyone means.
// - read_only denies the message-sending family for everyone and allows
//   it back for posting_roles.
// - The bot itself always gets an allow overwrite when any restriction
//   exists, so a build can never lock Omnicord out of what it just made.
// - A channel with no visibility settings of its own inherits its
//   category's private_to, mirroring how Discord's UI syncs child
//   channels to their category.

const P = PermissionFlagsBits;

const SEND_FAMILY =
  P.SendMessages |
  P.SendMessagesInThreads |
  P.CreatePublicThreads |
  P.CreatePrivateThreads;

export interface OverwriteSpec {
  id: string;
  // 0 for role, 1 for member.
  type: 0 | 1;
  allow: string;
  deny: string;
}

export interface VisibilityInput {
  kind: "text" | "voice" | "forum" | "stage" | "announcement" | "category";
  privateTo?: string[];
  readOnly?: boolean;
  postingRoles?: string[];
  inheritedPrivateTo?: string[];
}

export class UnknownRoleError extends Error {
  roleName: string;
  constructor(roleName: string) {
    super(`No role named "${roleName}" exists to build an overwrite for.`);
    this.roleName = roleName;
  }
}

export function compileOverwrites(
  input: VisibilityInput,
  roleIdsByName: Map<string, string>,
  guildId: string,
  botUserId: string
): OverwriteSpec[] {
  const ownPrivate = input.privateTo ?? [];
  const effectivePrivate =
    ownPrivate.length > 0 ? ownPrivate : input.inheritedPrivateTo ?? [];
  const readOnly = input.readOnly ?? false;
  const postingRoles = input.postingRoles ?? [];

  if (effectivePrivate.length === 0 && !readOnly) return [];

  const gateConnect =
    input.kind === "voice" ||
    input.kind === "stage" ||
    input.kind === "category";
  const viewBits = gateConnect ? P.ViewChannel | P.Connect : P.ViewChannel;

  // Accumulate allow and deny bits per target, then emit. A target can
  // appear in both private_to and posting_roles; merging keeps one
  // overwrite per target, which is what Discord requires.
  const allow = new Map<string, bigint>();
  const deny = new Map<string, bigint>();
  const types = new Map<string, 0 | 1>();

  function add(map: Map<string, bigint>, id: string, bits: bigint, type: 0 | 1) {
    map.set(id, (map.get(id) ?? 0n) | bits);
    types.set(id, type);
  }

  function roleId(name: string): string {
    const id = roleIdsByName.get(name.toLowerCase());
    if (!id) throw new UnknownRoleError(name);
    return id;
  }

  if (effectivePrivate.length > 0) {
    add(deny, guildId, viewBits, 0);
    for (const name of effectivePrivate) {
      add(allow, roleId(name), viewBits, 0);
    }
  }

  if (readOnly) {
    add(deny, guildId, SEND_FAMILY, 0);
    for (const name of postingRoles) {
      add(allow, roleId(name), P.SendMessages | P.SendMessagesInThreads, 0);
    }
  }

  // The bot's own escape hatch.
  let botBits = P.ViewChannel;
  if (gateConnect) botBits |= P.Connect;
  if (readOnly) botBits |= P.SendMessages | P.SendMessagesInThreads;
  add(allow, botUserId, botBits, 1);

  // Deterministic order: everyone first, then roles by id, then the bot.
  const targets = new Set([...deny.keys(), ...allow.keys()]);
  const ordered = [...targets].sort((a, b) => {
    if (a === guildId) return -1;
    if (b === guildId) return 1;
    if (a === botUserId) return 1;
    if (b === botUserId) return -1;
    return a < b ? -1 : 1;
  });

  return ordered.map((id) => ({
    id,
    type: types.get(id) ?? 0,
    allow: (allow.get(id) ?? 0n).toString(),
    deny: (deny.get(id) ?? 0n).toString(),
  }));
}
