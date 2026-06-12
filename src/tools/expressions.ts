import { z } from "zod";
import { Routes, PermissionFlagsBits } from "discord-api-types/v10";
import type { APIEmoji, APISticker, APISoundboardSound } from "discord-api-types/v10";
import type { REST } from "@discordjs/rest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OmnicordConfig } from "../config.js";
import {
  fetchBinary,
  fetchAudioAsDataUri,
  MAX_STICKER_BYTES,
  MAX_SOUND_BYTES,
  STICKER_TYPES,
} from "../discord/images.js";
import { resolveEmojiInput } from "../discord/emoji.js";
import { resolveOne } from "../discord/resolve.js";
import { gateDestructive } from "../safety.js";
import { ok, fail } from "../envelope.js";
import {
  enter,
  guarded,
  guildParam,
  ToolProblem,
  botPermissions,
  requirePermissions,
} from "./common.js";

// Stickers and soundboard sounds. Two different upload mechanics:
// stickers go up as multipart form files, soundboard sounds as base64
// data URIs, both fetched from URLs and validated against Discord's
// documented limits before anything is sent.

const P = PermissionFlagsBits;

const STICKER_FORMATS: Record<number, string> = {
  1: "png",
  2: "apng",
  3: "lottie",
  4: "gif",
};

function stickerDigest(s: APISticker) {
  return {
    id: s.id,
    name: s.name,
    description: s.description ?? null,
    tags: s.tags,
    format: STICKER_FORMATS[s.format_type] ?? `type ${s.format_type}`,
    available: s.available ?? true,
  };
}

function soundDigest(s: APISoundboardSound) {
  return {
    id: s.sound_id,
    name: s.name,
    volume: s.volume,
    emoji: s.emoji_name ?? s.emoji_id ?? null,
    available: s.available ?? true,
  };
}

async function resolveSticker(
  rest: REST,
  guildId: string,
  query: string
): Promise<APISticker> {
  const stickers = (await rest.get(Routes.guildStickers(guildId))) as APISticker[];
  const resolution = resolveOne(
    query,
    stickers.map((s) => ({ id: s.id, name: s.name, type: "sticker" }))
  );
  if ("match" in resolution) {
    const found = stickers.find((s) => s.id === resolution.match.id);
    if (found) return found;
  }
  const candidates = "candidates" in resolution ? resolution.candidates : [];
  throw new ToolProblem(
    candidates.length === 0
      ? fail(`No sticker matching "${query}" in this server.`)
      : fail(`Multiple stickers match "${query}". Pick one by ID.`, { candidates })
  );
}

async function resolveSound(
  rest: REST,
  guildId: string,
  query: string
): Promise<APISoundboardSound> {
  const result = (await rest.get(Routes.guildSoundboardSounds(guildId))) as {
    items: APISoundboardSound[];
  };
  const sounds = result.items ?? [];
  const resolution = resolveOne(
    query,
    sounds.map((s) => ({ id: s.sound_id, name: s.name, type: "sound" }))
  );
  if ("match" in resolution) {
    const found = sounds.find((s) => s.sound_id === resolution.match.id);
    if (found) return found;
  }
  const candidates = "candidates" in resolution ? resolution.candidates : [];
  throw new ToolProblem(
    candidates.length === 0
      ? fail(`No soundboard sound matching "${query}" in this server.`)
      : fail(`Multiple sounds match "${query}". Pick one by ID.`, { candidates })
  );
}

export function registerExpressionTools(
  server: McpServer,
  config: OmnicordConfig
): void {
  server.registerTool(
    "list_stickers",
    {
      title: "List stickers",
      description: "Custom stickers in the server.",
      inputSchema: { guild: guildParam },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild }) => {
      const { rest, guildId } = await enter(config, guild);
      const stickers = (await rest.get(Routes.guildStickers(guildId))) as APISticker[];
      return ok(`${stickers.length} custom sticker(s).`, {
        stickers: stickers.map(stickerDigest),
      });
    })
  );

  server.registerTool(
    "create_sticker",
    {
      title: "Create sticker",
      description:
        "Upload a custom sticker from an image URL. Discord requires png, " +
        "apng, or gif at 320x320 pixels and up to 512 KB. Servers start " +
        "with five sticker slots; boosts add more.",
      inputSchema: {
        guild: guildParam,
        name: z.string().min(2).max(30),
        description: z.string().max(100).optional()
          .describe("Empty or 2-100 characters."),
        tags: z.string().min(1).max(200)
          .describe("Comma separated keywords, or one emoji name for autocomplete."),
        image_url: z.string().url(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ guild, name, description, tags, image_url }) => {
      const { rest, guildId } = await enter(config, guild);

      const perms = await botPermissions(rest, guildId);
      requirePermissions(
        perms,
        [[P.CreateGuildExpressions, "Create Expressions"]],
        "in this server"
      );

      const image = await fetchBinary(image_url, MAX_STICKER_BYTES, STICKER_TYPES, "sticker");
      if (!image.ok) return fail(image.error);

      const extension = image.contentType === "image/gif" ? "gif" : "png";
      const sticker = (await rest.post(Routes.guildStickers(guildId), {
        appendToFormData: true,
        body: {
          name,
          description: description ?? "",
          tags,
        },
        files: [
          {
            key: "file",
            name: `sticker.${extension}`,
            contentType: image.contentType,
            data: image.data,
          },
        ],
        reason: "Created via Omnicord",
      })) as APISticker;

      return ok(`Created the sticker "${sticker.name}".`, stickerDigest(sticker));
    })
  );

  server.registerTool(
    "update_sticker",
    {
      title: "Update sticker",
      description: "Rename a sticker or change its description and tags.",
      inputSchema: {
        sticker: z.string().describe("Sticker name or ID."),
        guild: guildParam,
        name: z.string().min(2).max(30).optional(),
        description: z.string().max(100).optional(),
        tags: z.string().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ sticker, guild, name, description, tags }) => {
      const { rest, guildId } = await enter(config, guild);
      if (name === undefined && description === undefined && tags === undefined) {
        return fail("Pass at least one field to change.");
      }
      const found = await resolveSticker(rest, guildId, sticker);

      const perms = await botPermissions(rest, guildId);
      requirePermissions(
        perms,
        [[P.ManageGuildExpressions, "Manage Expressions"]],
        "in this server"
      );

      const updated = (await rest.patch(Routes.guildSticker(guildId, found.id), {
        body: {
          ...(name !== undefined ? { name } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(tags !== undefined ? { tags } : {}),
        },
        reason: "Updated via Omnicord",
      })) as APISticker;
      return ok(`Updated the sticker "${updated.name}".`, stickerDigest(updated));
    })
  );

  server.registerTool(
    "delete_sticker",
    {
      title: "Delete sticker",
      description:
        "Delete a custom sticker. Safe to call directly: the first call " +
        "changes nothing and returns a preview plus a confirm_token; " +
        "repeating the call with the token deletes it.",
      inputSchema: {
        sticker: z.string().describe("Sticker name or ID."),
        guild: guildParam,
        dry_run: z.boolean().optional(),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ sticker, guild, dry_run, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const found = await resolveSticker(rest, guildId, sticker);

      const perms = await botPermissions(rest, guildId);
      requirePermissions(
        perms,
        [[P.ManageGuildExpressions, "Manage Expressions"]],
        "in this server"
      );

      const gate = gateDestructive({
        tool: "delete_sticker",
        args: { sticker: found.id },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary: `Would delete the sticker "${found.name}".`,
        previewDetails: stickerDigest(found),
      });
      if (gate) return gate;

      await rest.delete(Routes.guildSticker(guildId, found.id), {
        reason: "Deleted via Omnicord",
      });
      return ok(`Deleted the sticker "${found.name}".`, {
        deleted: true,
        id: found.id,
      });
    })
  );

  server.registerTool(
    "list_soundboard_sounds",
    {
      title: "List soundboard sounds",
      description: "Custom soundboard sounds in the server.",
      inputSchema: { guild: guildParam },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild }) => {
      const { rest, guildId } = await enter(config, guild);
      const result = (await rest.get(Routes.guildSoundboardSounds(guildId))) as {
        items: APISoundboardSound[];
      };
      const sounds = result.items ?? [];
      return ok(`${sounds.length} soundboard sound(s).`, {
        sounds: sounds.map(soundDigest),
      });
    })
  );

  server.registerTool(
    "create_soundboard_sound",
    {
      title: "Create soundboard sound",
      description:
        "Upload a soundboard sound from an audio URL: mp3 or ogg, up to " +
        "512 KB and 5.2 seconds. Servers start with eight sound slots; " +
        "boosts add more.",
      inputSchema: {
        guild: guildParam,
        name: z.string().min(2).max(32),
        sound_url: z.string().url(),
        volume: z.number().min(0).max(1).optional()
          .describe("Playback volume. Default 1."),
        emoji: z.string().optional()
          .describe("An emoji to show with the sound."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ guild, name, sound_url, volume, emoji }) => {
      const { rest, guildId } = await enter(config, guild);

      const perms = await botPermissions(rest, guildId);
      requirePermissions(
        perms,
        [[P.CreateGuildExpressions, "Create Expressions"]],
        "in this server"
      );

      const audio = await fetchAudioAsDataUri(sound_url, MAX_SOUND_BYTES);
      if (!audio.ok) return fail(audio.error);

      let emojiFields: Record<string, string> = {};
      if (emoji) {
        const guildEmojis = (await rest.get(Routes.guildEmojis(guildId))) as APIEmoji[];
        const resolved = resolveEmojiInput(emoji, guildEmojis);
        if (!resolved.ok) return fail(resolved.reason);
        emojiFields = resolved.custom
          ? { emoji_id: resolved.api.split(":")[1] }
          : { emoji_name: resolved.api };
      }

      const sound = (await rest.post(Routes.guildSoundboardSounds(guildId), {
        body: {
          name,
          sound: audio.dataUri,
          ...(volume !== undefined ? { volume } : {}),
          ...emojiFields,
        },
        reason: "Created via Omnicord",
      })) as APISoundboardSound;

      return ok(`Created the soundboard sound "${sound.name}".`, soundDigest(sound));
    })
  );

  server.registerTool(
    "update_soundboard_sound",
    {
      title: "Update soundboard sound",
      description: "Rename a soundboard sound or change its volume.",
      inputSchema: {
        sound: z.string().describe("Sound name or ID."),
        guild: guildParam,
        name: z.string().min(2).max(32).optional(),
        volume: z.number().min(0).max(1).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ sound, guild, name, volume }) => {
      const { rest, guildId } = await enter(config, guild);
      if (name === undefined && volume === undefined) {
        return fail("Pass name or volume to change.");
      }
      const found = await resolveSound(rest, guildId, sound);

      const perms = await botPermissions(rest, guildId);
      requirePermissions(
        perms,
        [[P.ManageGuildExpressions, "Manage Expressions"]],
        "in this server"
      );

      const updated = (await rest.patch(
        Routes.guildSoundboardSound(guildId, found.sound_id),
        {
          body: {
            ...(name !== undefined ? { name } : {}),
            ...(volume !== undefined ? { volume } : {}),
          },
          reason: "Updated via Omnicord",
        }
      )) as APISoundboardSound;
      return ok(`Updated the sound "${updated.name}".`, soundDigest(updated));
    })
  );

  server.registerTool(
    "delete_soundboard_sound",
    {
      title: "Delete soundboard sound",
      description:
        "Delete a soundboard sound. Safe to call directly: the first call " +
        "changes nothing and returns a preview plus a confirm_token; " +
        "repeating the call with the token deletes it.",
      inputSchema: {
        sound: z.string().describe("Sound name or ID."),
        guild: guildParam,
        dry_run: z.boolean().optional(),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ sound, guild, dry_run, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const found = await resolveSound(rest, guildId, sound);

      const perms = await botPermissions(rest, guildId);
      requirePermissions(
        perms,
        [[P.ManageGuildExpressions, "Manage Expressions"]],
        "in this server"
      );

      const gate = gateDestructive({
        tool: "delete_soundboard_sound",
        args: { sound: found.sound_id },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary: `Would delete the soundboard sound "${found.name}".`,
        previewDetails: soundDigest(found),
      });
      if (gate) return gate;

      await rest.delete(Routes.guildSoundboardSound(guildId, found.sound_id), {
        reason: "Deleted via Omnicord",
      });
      return ok(`Deleted the sound "${found.name}".`, {
        deleted: true,
        id: found.sound_id,
      });
    })
  );
}
