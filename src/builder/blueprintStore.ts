import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { dataDir } from "../home.js";
import type { Blueprint } from "./blueprint.js";

// The saved-blueprint store: one JSON file per blueprint in the data
// directory (see home.ts for where that lives). Flat files keep local
// deployments dependency-free and the blueprints human-readable and
// diffable in any editor.

function storeDir(): string {
  return join(dataDir(), "blueprints");
}

export interface SavedBlueprint {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  blueprint: Blueprint;
}

// Ids are randomBytes(8) hex: 16 lowercase hex characters. Validating
// before building any path stops a tool argument from escaping the store
// directory through path traversal.
const ID_PATTERN = /^[a-f0-9]{16}$/;

function fileFor(id: string): string {
  if (!ID_PATTERN.test(id)) {
    throw new Error("Invalid blueprint id.");
  }
  return join(storeDir(), `${id}.json`);
}

export function listBlueprints(): SavedBlueprint[] {
  const dir = storeDir();
  if (!existsSync(dir)) return [];
  const out: SavedBlueprint[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, file), "utf8")) as SavedBlueprint);
    } catch {
      // A corrupt file should not take the whole store down.
    }
  }
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

// Lookup by id first, then by exact name (case-insensitive).
export function findBlueprint(ref: string): SavedBlueprint | undefined {
  const all = listBlueprints();
  const trimmed = ref.trim();
  return (
    all.find((b) => b.id === trimmed) ??
    all.find((b) => b.name.toLowerCase() === trimmed.toLowerCase())
  );
}

export function saveBlueprint(
  name: string,
  blueprint: Blueprint,
  description?: string
): SavedBlueprint | { error: string } {
  if (listBlueprints().some((b) => b.name.toLowerCase() === name.toLowerCase())) {
    return {
      error:
        `A blueprint named "${name}" already exists. Delete it first or ` +
        "pick another name.",
    };
  }
  const now = new Date().toISOString();
  const saved: SavedBlueprint = {
    id: randomBytes(8).toString("hex"),
    name,
    description: description ?? null,
    created_at: now,
    updated_at: now,
    blueprint,
  };
  mkdirSync(storeDir(), { recursive: true });
  writeFileSync(fileFor(saved.id), JSON.stringify(saved, null, 2) + "\n");
  return saved;
}

export function deleteBlueprint(id: string): boolean {
  if (!ID_PATTERN.test(id)) return false;
  const file = fileFor(id);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}
