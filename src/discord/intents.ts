// Application flag bits that report gateway intent enablement, taken from
// the application resource docs. Each intent has two bits: the full flag
// (granted after verification, for bots in 100+ servers) and the LIMITED
// flag (set while the bot is under 100 servers). Either one means the
// toggle is on in the Developer Portal, so both are always tested.
export const INTENT_FLAGS = {
  presence: (1 << 12) | (1 << 13),
  members: (1 << 14) | (1 << 15),
  messageContent: (1 << 18) | (1 << 19),
} as const;

export interface IntentStatus {
  presence: boolean;
  members: boolean;
  messageContent: boolean;
}

export function readIntents(flags: number): IntentStatus {
  return {
    presence: (flags & INTENT_FLAGS.presence) !== 0,
    members: (flags & INTENT_FLAGS.members) !== 0,
    messageContent: (flags & INTENT_FLAGS.messageContent) !== 0,
  };
}
