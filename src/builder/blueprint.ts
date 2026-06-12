import { z } from "zod";

// The blueprint is the contract between the AI client and the builder.
// The client AI translates a conversation ("I want a dark fantasy guild
// with mod channels and an LFG role") into this structure; Omnicord
// validates it, plans it, and executes it. The blueprint deliberately
// references roles by name rather than ID so it stays portable across
// servers and across time.

const hexColor = z
  .string()
  .regex(/^#?[0-9a-fA-F]{6}$/, "Use a hex color like #5865f2");

export const blueprintRoleSchema = z.object({
  name: z.string().min(1).max(100),
  preset: z
    .enum(["none", "member", "moderator", "admin"])
    .optional()
    .describe("Vetted permission bundle. Administrator is never included."),
  permissions: z
    .array(z.string())
    .optional()
    .describe("Extra permission names beyond the preset."),
  color: hexColor.optional(),
  hoist: z.boolean().optional()
    .describe("Show members with this role separately in the sidebar."),
  mentionable: z.boolean().optional(),
});

export const blueprintChannelSchema = z.object({
  name: z.string().min(1).max(100),
  type: z
    .enum(["text", "voice", "forum", "stage", "announcement"])
    .optional()
    .describe("Default text."),
  topic: z.string().max(1024).optional(),
  slowmode_seconds: z.number().int().min(0).max(21600).optional(),
  nsfw: z.boolean().optional(),
  private_to: z
    .array(z.string())
    .optional()
    .describe(
      "Role names that can see this channel. Everyone else is denied view."
    ),
  read_only: z.boolean().optional()
    .describe("Deny sending for everyone; for rules and announcements."),
  posting_roles: z
    .array(z.string())
    .optional()
    .describe("With read_only: role names that may still post."),
});

export const blueprintCategorySchema = z.object({
  name: z.string().min(1).max(100),
  private_to: z
    .array(z.string())
    .optional()
    .describe("Role names that can see the whole category."),
  channels: z.array(blueprintChannelSchema).max(50),
});

export const blueprintSchema = z.object({
  name: z.string().max(100).optional()
    .describe("Optional label for saving or referencing this blueprint."),
  theme: z.string().max(500).optional()
    .describe("Freeform note recording the intent and naming style."),
  roles: z.array(blueprintRoleSchema).max(50).optional(),
  categories: z.array(blueprintCategorySchema).max(50).optional(),
  channels: z
    .array(blueprintChannelSchema)
    .max(100)
    .optional()
    .describe("Top-level channels outside any category."),
});

export type Blueprint = z.infer<typeof blueprintSchema>;
export type BlueprintRole = z.infer<typeof blueprintRoleSchema>;
export type BlueprintChannel = z.infer<typeof blueprintChannelSchema>;
export type BlueprintCategory = z.infer<typeof blueprintCategorySchema>;

// Discord rewrites text-like channel names on creation: lowercased, spaces
// become hyphens. Collision detection has to compare what Discord will
// store, not what the blueprint says. Voice, stage, and category names
// keep their spacing and case.
export function normalizedChannelName(name: string, type?: string): string {
  const kind = type ?? "text";
  if (kind === "voice" || kind === "stage") return name.trim();
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}
