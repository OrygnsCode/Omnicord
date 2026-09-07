import { z } from "zod";
import {
  ButtonStyle,
  ComponentType,
  SeparatorSpacingSize,
} from "discord-api-types/v10";
import type {
  APIComponentInContainer,
  APIMessageTopLevelComponent,
  APISectionAccessoryComponent,
} from "discord-api-types/v10";

// Components V2: the display half.
//
// Discord's component system covers layout (text, sections, galleries,
// separators, containers) and interactivity (custom_id buttons, select
// menus). Omnicord ships the layout half plus link buttons, and nothing
// that fires an interaction. That is a deliberate line, not a gap: an
// interaction has to be answered on the gateway within three seconds by a
// process that is listening for it, and Omnicord answers MCP calls, not
// Discord interactions. A custom_id button posted from here would render
// correctly and then fail for every person who clicked it. A link button
// carries a URL and never calls back, so it works with nothing listening.
//
// File components are left out for a different reason: they accept only
// attachment:// references, and there is no upload path here to produce
// one. Galleries and thumbnails take ordinary URLs, so they stay.
//
// The message flag is one way. Once a message carries it, content and
// embeds stop rendering on that message for good, so the callers refuse to
// mix the two rather than quietly dropping text someone expected to see.
//
// Pure, so the layout and limit rules are unit tested without a server.

export const COMPONENTS_V2_FLAG = 1 << 15; // 32768

// Discord: "Messages allow up to 40 total components", counted over the
// whole tree rather than the top level.
export const MAX_TOTAL_COMPONENTS = 40;
const MAX_IN_CONTAINER = 10;

const mediaSchema = z.object({
  url: z.string().url().describe("Public image URL."),
  description: z.string().max(1024).optional().describe("Alt text."),
  spoiler: z.boolean().optional().describe("Blur until clicked."),
});

const buttonSchema = z.object({
  label: z.string().min(1).max(80).describe("Button text."),
  url: z.string().url().max(512).describe("Where the button leads."),
  disabled: z.boolean().optional(),
});

// One flat shape for every block, discriminated by type, rather than a
// union per block. Union input schemas are the corner of JSON Schema that
// MCP clients disagree about most, and these combinations are cheap to
// check in code, where the error can name the offending field.
const blockFields = {
  type: z
    .enum(["text", "section", "gallery", "separator", "buttons", "container"])
    .describe(
      "text: a paragraph of markdown. section: text with a thumbnail or " +
        "link button beside it. gallery: 1-10 images. separator: vertical " +
        "space, optionally a rule. buttons: a row of link buttons. " +
        "container: a bordered group with a colored edge."
    ),
  text: z
    .string()
    .min(1)
    .max(4000)
    .optional()
    .describe("Markdown body. Required for text and section."),
  media: z
    .array(mediaSchema)
    .min(1)
    .max(10)
    .optional()
    .describe(
      "For gallery, 1-10 images. For section, exactly one, shown as a " +
        "thumbnail on the right."
    ),
  buttons: z
    .array(buttonSchema)
    .min(1)
    .max(5)
    .optional()
    .describe(
      "For buttons, 1-5 link buttons on one row. For section, exactly one. " +
        "Link buttons only: this server does not answer interactions, so a " +
        "button that fires one would fail for whoever clicked it."
    ),
  divider: z
    .boolean()
    .optional()
    .describe("For separator, draw a horizontal rule. Default true."),
  spacing: z
    .enum(["small", "large"])
    .optional()
    .describe("For separator, how much padding. Default small."),
  accent_color: z
    .string()
    .optional()
    .describe("For container, hex color of the left edge, like #5865f2."),
  spoiler: z
    .boolean()
    .optional()
    .describe("For container, blur the whole group until clicked."),
};

// The blocks that go inside a container. Spelled out rather than reusing
// the shape above, because a nested block genuinely has fewer options: a
// container cannot hold another container, so the container-only fields do
// not belong here at all. Descriptions are omitted because the fields are
// the same ones documented a few lines up, in the same schema a caller is
// already reading, and repeating every string costs about 1.5 KB in the
// tool list of every client that connects.
const innerBlockSchema = z.object({
  type: z
    .enum(["text", "section", "gallery", "separator", "buttons"])
    .describe("Same block types as above, except container."),
  text: z.string().min(1).max(4000).optional(),
  media: z.array(mediaSchema).min(1).max(10).optional(),
  buttons: z.array(buttonSchema).min(1).max(5).optional(),
  divider: z.boolean().optional(),
  spacing: z.enum(["small", "large"]).optional(),
});

const topBlockSchema = z.object({
  ...blockFields,
  components: z
    .array(innerBlockSchema)
    .min(1)
    .max(MAX_IN_CONTAINER)
    .optional()
    .describe("For container, the 1-10 blocks inside it."),
});

export const componentsParam = z
  .array(topBlockSchema)
  .min(1)
  .max(MAX_TOTAL_COMPONENTS)
  .optional()
  .describe(
    "Rich layout, in place of content and embeds. Sending this sets the " +
      "Components V2 flag, which is permanent for that message: it can " +
      "never show plain content or embeds afterward, so the two cannot be " +
      "combined."
  );

// Permissive on purpose. The schema above already narrows what a client can
// send, but compileComponents is also reached directly from tests and holds
// the checks that matter, so its input type stays the wider shape.
export type ComponentBlock = z.infer<typeof topBlockSchema>;

export type CompileResult =
  | {
      ok: true;
      components: APIMessageTopLevelComponent[];
      count: number;
      hasMedia: boolean;
    }
  | { ok: false; reason: string };

// Which optional fields each type reads. Anything else present is a
// misunderstanding worth reporting: silently ignoring accent_color on a
// text block teaches the caller that it worked.
const ALLOWED: Record<string, string[]> = {
  text: ["text"],
  section: ["text", "media", "buttons"],
  gallery: ["media"],
  separator: ["divider", "spacing"],
  buttons: ["buttons"],
  container: ["accent_color", "spoiler", "components"],
};

const OPTIONAL_FIELDS = [
  "text",
  "media",
  "buttons",
  "divider",
  "spacing",
  "accent_color",
  "spoiler",
  "components",
];

function strayFields(block: ComponentBlock, where: string): string | null {
  const allowed = ALLOWED[block.type] ?? [];
  const stray = OPTIONAL_FIELDS.filter(
    (f) =>
      !allowed.includes(f) &&
      (block as unknown as Record<string, unknown>)[f] !== undefined
  );
  if (stray.length === 0) return null;
  return (
    `${where} is a ${block.type} block, which does not use ` +
    `${stray.join(" or ")}. A ${block.type} takes ` +
    (allowed.length > 0 ? allowed.join(", ") : "no other fields") +
    "."
  );
}

function parseHex(value: string): number | null {
  const hex = value.replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  return parseInt(hex, 16);
}

function compileMedia(m: {
  url: string;
  description?: string;
  spoiler?: boolean;
}) {
  return {
    media: { url: m.url },
    ...(m.description ? { description: m.description } : {}),
    ...(m.spoiler ? { spoiler: true } : {}),
  };
}

type BlockResult =
  | { component: APIMessageTopLevelComponent; count: number; media: boolean }
  | { error: string };

// Returns the compiled component and how many components it accounts for
// against the cap. Gallery items are not components; the action row, each
// button, the section, its text and its accessory all are.
function compileBlock(
  block: ComponentBlock,
  where: string,
  insideContainer: boolean
): BlockResult {
  const stray = strayFields(block, where);
  if (stray) return { error: stray };

  switch (block.type) {
    case "text": {
      if (!block.text) {
        return { error: `${where} is a text block with no text.` };
      }
      return {
        component: { type: ComponentType.TextDisplay, content: block.text },
        count: 1,
        media: false,
      };
    }

    case "separator": {
      return {
        component: {
          type: ComponentType.Separator,
          ...(block.divider === undefined ? {} : { divider: block.divider }),
          ...(block.spacing
            ? {
                spacing:
                  block.spacing === "large"
                    ? SeparatorSpacingSize.Large
                    : SeparatorSpacingSize.Small,
              }
            : {}),
        },
        count: 1,
        media: false,
      };
    }

    case "gallery": {
      if (!block.media || block.media.length === 0) {
        return { error: `${where} is a gallery with no media.` };
      }
      return {
        component: {
          type: ComponentType.MediaGallery,
          items: block.media.map(compileMedia),
        },
        count: 1,
        media: true,
      };
    }

    case "buttons": {
      if (!block.buttons || block.buttons.length === 0) {
        return { error: `${where} is a buttons block with no buttons.` };
      }
      return {
        component: {
          type: ComponentType.ActionRow,
          components: block.buttons.map((b) => ({
            type: ComponentType.Button as const,
            style: ButtonStyle.Link as const,
            label: b.label,
            url: b.url,
            ...(b.disabled ? { disabled: true } : {}),
          })),
        },
        count: 1 + block.buttons.length,
        media: false,
      };
    }

    case "section": {
      if (!block.text) {
        return { error: `${where} is a section with no text.` };
      }
      const thumbs = block.media?.length ?? 0;
      const btns = block.buttons?.length ?? 0;
      if (thumbs > 0 === btns > 0) {
        return {
          error:
            `${where} is a section, which needs exactly one accessory: ` +
            "either one entry in media for a thumbnail, or one entry in " +
            "buttons for a link button" +
            (thumbs > 0 ? ", not both." : ", and has neither."),
        };
      }
      if (thumbs > 1) {
        return {
          error:
            `${where} is a section with ${thumbs} images. A section shows ` +
            "one thumbnail; use a gallery for more.",
        };
      }
      if (btns > 1) {
        return {
          error:
            `${where} is a section with ${btns} buttons. A section shows ` +
            "one; use a buttons block for a row.",
        };
      }
      const accessory: APISectionAccessoryComponent =
        thumbs > 0
          ? {
              type: ComponentType.Thumbnail,
              ...compileMedia(block.media![0]),
            }
          : {
              type: ComponentType.Button,
              style: ButtonStyle.Link,
              label: block.buttons![0].label,
              url: block.buttons![0].url,
              ...(block.buttons![0].disabled ? { disabled: true } : {}),
            };
      return {
        component: {
          type: ComponentType.Section,
          components: [
            { type: ComponentType.TextDisplay, content: block.text },
          ],
          accessory,
        },
        // The section, its text display, and its accessory.
        count: 3,
        media: thumbs > 0,
      };
    }

    case "container": {
      if (insideContainer) {
        return {
          error: `${where} is a container inside a container. Containers do not nest.`,
        };
      }
      const children = block.components ?? [];
      if (children.length === 0) {
        return { error: `${where} is a container with nothing in it.` };
      }
      const out: APIComponentInContainer[] = [];
      let count = 1;
      let media = false;
      for (let i = 0; i < children.length; i += 1) {
        const child = compileBlock(
          children[i] as ComponentBlock,
          `${where}, block ${i + 1} inside it,`,
          true
        );
        if ("error" in child) return { error: child.error };
        // Safe because the insideContainer flag above rejects the one
        // top-level type a container cannot hold, another container.
        out.push(child.component as APIComponentInContainer);
        count += child.count;
        media = media || child.media;
      }
      let color: number | undefined;
      if (block.accent_color) {
        const parsed = parseHex(block.accent_color);
        if (parsed === null) {
          return {
            error:
              `${where} has accent_color "${block.accent_color}", which is ` +
              "not a hex color. Use the form #5865f2.",
          };
        }
        color = parsed;
      }
      return {
        component: {
          type: ComponentType.Container,
          components: out,
          ...(color === undefined ? {} : { accent_color: color }),
          ...(block.spoiler ? { spoiler: true } : {}),
        },
        count,
        media,
      };
    }

    default:
      return { error: `${where} has an unknown type.` };
  }
}

// The other direction, for reading a message back. A Components V2 message
// carries an empty content field, so any digest built from content alone
// shows it as blank. Walking the tree for its text puts the words back where
// every reader already looks. Link buttons come along as markdown links
// because in a rules or welcome panel the button is often the point.
export function textFromComponents(node: unknown): string {
  const lines: string[] = [];

  function walk(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const n = value as Record<string, unknown>;

    if (n.type === ComponentType.TextDisplay && typeof n.content === "string") {
      lines.push(n.content);
    }
    if (
      n.type === ComponentType.Button &&
      typeof n.url === "string" &&
      typeof n.label === "string"
    ) {
      lines.push(`[${n.label}](${n.url})`);
    }

    walk(n.components);
    walk(n.accessory);
  }

  walk(node);
  return lines.join("\n");
}

export function compileComponents(blocks: ComponentBlock[]): CompileResult {
  if (blocks.length === 0) {
    return { ok: false, reason: "components was empty." };
  }
  const out: APIMessageTopLevelComponent[] = [];
  let count = 0;
  let hasMedia = false;

  for (let i = 0; i < blocks.length; i += 1) {
    const compiled = compileBlock(blocks[i], `Block ${i + 1}`, false);
    if ("error" in compiled) return { ok: false, reason: compiled.error };
    out.push(compiled.component);
    count += compiled.count;
    hasMedia = hasMedia || compiled.media;
  }

  if (count > MAX_TOTAL_COMPONENTS) {
    return {
      ok: false,
      reason:
        `That layout is ${count} components and Discord allows ` +
        `${MAX_TOTAL_COMPONENTS}. Every block counts: a section counts as ` +
        "three, a button row as one plus each button.",
    };
  }

  return { ok: true, components: out, count, hasMedia };
}
