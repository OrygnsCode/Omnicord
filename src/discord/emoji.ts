// Emoji input handling for reaction and poll endpoints. The API wants
// unicode emoji as raw characters and custom emoji as name:id, both URL
// encoded in the route. People say "thumbsup", ":party_blob:", paste the
// character itself, or paste a full <a:name:id> mention; this resolves
// all of them against the guild's emoji list. Pure, so it is unit tested.

export interface GuildEmojiLite {
  id: string | null;
  name: string | null;
  animated?: boolean;
}

export type EmojiResolution =
  | { ok: true; api: string; display: string; custom: boolean }
  | { ok: false; reason: string; candidates?: string[] };

const MENTION = /^<(a?):([A-Za-z0-9_]+):(\d{17,20})>$/;

function looksLikeUnicodeEmoji(value: string): boolean {
  for (const ch of value) {
    if ((ch.codePointAt(0) ?? 0) > 0xff) return true;
  }
  return false;
}

export function resolveEmojiInput(
  input: string,
  guildEmojis: GuildEmojiLite[]
): EmojiResolution {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "Empty emoji." };
  }

  const mention = MENTION.exec(trimmed);
  if (mention) {
    return {
      ok: true,
      api: `${mention[2]}:${mention[3]}`,
      display: `:${mention[2]}:`,
      custom: true,
    };
  }

  if (looksLikeUnicodeEmoji(trimmed)) {
    return { ok: true, api: trimmed, display: trimmed, custom: false };
  }

  // A name, with or without colons: look it up in the guild.
  const name = trimmed.replace(/^:|:$/g, "").toLowerCase();
  const matches = guildEmojis.filter(
    (e) => e.id && e.name && e.name.toLowerCase() === name
  );
  if (matches.length === 1) {
    const e = matches[0];
    return {
      ok: true,
      api: `${e.name}:${e.id}`,
      display: `:${e.name}:`,
      custom: true,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: `Multiple emojis are named "${name}".`,
      candidates: matches.map((e) => `${e.name}:${e.id}`),
    };
  }
  const partial = guildEmojis.filter(
    (e) => e.id && e.name && e.name.toLowerCase().includes(name)
  );
  return {
    ok: false,
    reason: `No emoji named "${name}" in this server.`,
    ...(partial.length > 0
      ? { candidates: partial.slice(0, 5).map((e) => `${e.name}`) }
      : {}),
  };
}
