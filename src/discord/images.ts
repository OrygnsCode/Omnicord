// Image fetching for emoji and avatar uploads, which Discord takes as
// base64 data URIs. The validation half is pure and unit tested; the
// fetch half is a thin wrapper around it.

// Discord documents 256 KB for emoji and 512 KB for stickers and
// soundboard sounds. The avatar cap is Omnicord's own conservative
// product limit, not an API number.
export const MAX_EMOJI_BYTES = 256 * 1024;
export const MAX_AVATAR_BYTES = 1024 * 1024;
export const MAX_STICKER_BYTES = 512 * 1024;
export const MAX_SOUND_BYTES = 512 * 1024;

const ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

// Stickers take png, apng, and gif; Discord serves apng as image/png.
export const STICKER_TYPES = new Set(["image/png", "image/apng", "image/gif"]);

export const AUDIO_TYPES = new Set(["audio/mpeg", "audio/mp3", "audio/ogg"]);

export function validateAsset(
  contentType: string | null,
  bytes: number,
  maxBytes: number,
  allowed: Set<string>,
  label: string
): string | null {
  const normalized = contentType?.split(";")[0].trim().toLowerCase() ?? "";
  if (!allowed.has(normalized)) {
    return (
      `Unsupported ${label} type "${normalized || "unknown"}". ` +
      `Allowed: ${[...allowed].join(", ")}.`
    );
  }
  if (bytes > maxBytes) {
    return (
      `The ${label} is ${Math.ceil(bytes / 1024)} KB; the limit here is ` +
      `${Math.floor(maxBytes / 1024)} KB.`
    );
  }
  if (bytes === 0) {
    return `The ${label} is empty.`;
  }
  return null;
}

export function validateImage(
  contentType: string | null,
  bytes: number,
  maxBytes: number
): string | null {
  return validateAsset(contentType, bytes, maxBytes, ALLOWED_TYPES, "image");
}

// Fetches any binary asset with type and size validation; the building
// block for sticker uploads (multipart) and sound uploads (data URI).
export async function fetchBinary(
  url: string,
  maxBytes: number,
  allowed: Set<string>,
  label: string
): Promise<
  | { ok: true; contentType: string; data: Buffer }
  | { ok: false; error: string }
> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    return { ok: false, error: `Could not fetch ${url}.` };
  }
  if (!res.ok) {
    return { ok: false, error: `Fetch failed with status ${res.status}.` };
  }
  const contentType = res.headers.get("content-type") ?? "";
  const data = Buffer.from(await res.arrayBuffer());
  const problem = validateAsset(contentType, data.length, maxBytes, allowed, label);
  if (problem) return { ok: false, error: problem };
  return { ok: true, contentType: contentType.split(";")[0].trim().toLowerCase(), data };
}

export async function fetchAudioAsDataUri(
  url: string,
  maxBytes: number
): Promise<{ ok: true; dataUri: string } | { ok: false; error: string }> {
  const result = await fetchBinary(url, maxBytes, AUDIO_TYPES, "sound");
  if (!result.ok) return result;
  // Discord wants audio/mp3 spelled audio/mpeg in the data URI.
  const type = result.contentType === "audio/mp3" ? "audio/mpeg" : result.contentType;
  return { ok: true, dataUri: toDataUri(type, result.data) };
}

export function toDataUri(contentType: string, data: Buffer): string {
  const normalized = contentType.split(";")[0].trim().toLowerCase();
  return `data:${normalized};base64,${data.toString("base64")}`;
}

export async function fetchImageAsDataUri(
  url: string,
  maxBytes: number
): Promise<{ ok: true; dataUri: string } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    return { ok: false, error: `Could not fetch ${url}.` };
  }
  if (!res.ok) {
    return { ok: false, error: `Image fetch failed with status ${res.status}.` };
  }
  const contentType = res.headers.get("content-type");
  const data = Buffer.from(await res.arrayBuffer());
  const problem = validateImage(contentType, data.length, maxBytes);
  if (problem) return { ok: false, error: problem };
  return { ok: true, dataUri: toDataUri(contentType ?? "", data) };
}
