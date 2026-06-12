// Name resolution. Discord entities are addressed by snowflake IDs, but
// nobody talks that way. Every tool parameter that names an entity runs
// through this resolver so "the support channel" works as well as an ID.
// Resolution order, strongest first: exact ID, exact name, normalized
// name (case, spaces, hyphens, underscores, and channel/user sigils all
// ignored), prefix, substring. When the winner is not clear the caller
// gets candidates back instead of a guess.

const SNOWFLAKE = /^\d{17,20}$/;

export interface Resolvable {
  id: string;
  name: string;
  type: string;
  // Extra display context for disambiguation, like a channel's category
  // or a member's nickname.
  context?: string;
}

export interface Candidate extends Resolvable {
  score: number;
}

export function normalize(value: string): string {
  return value.toLowerCase().replace(/[\s\-_#@]/g, "");
}

export function rankCandidates(
  query: string,
  items: Resolvable[]
): Candidate[] {
  const trimmed = query.trim();
  const norm = normalize(trimmed);
  const out: Candidate[] = [];

  for (const item of items) {
    let score = 0;
    if (SNOWFLAKE.test(trimmed) && item.id === trimmed) {
      score = 100;
    } else if (item.name === trimmed) {
      score = 90;
    } else {
      const itemNorm = normalize(item.name);
      if (itemNorm === norm) score = 80;
      else if (norm.length > 0 && itemNorm.startsWith(norm)) score = 70;
      else if (norm.length > 1 && itemNorm.includes(norm)) score = 60;
    }
    if (score > 0) out.push({ ...item, score });
  }

  // Higher score first; among equals, shorter names first since the query
  // matched a larger fraction of them.
  out.sort((a, b) => b.score - a.score || a.name.length - b.name.length);
  return out;
}

export type Resolution =
  | { match: Candidate }
  | { candidates: Candidate[] };

export function resolveOne(query: string, items: Resolvable[]): Resolution {
  const ranked = rankCandidates(query, items);
  if (ranked.length === 0) return { candidates: [] };
  if (ranked.length === 1) return { match: ranked[0] };
  // A unique top score wins. A tie means the caller has to pick.
  if (ranked[0].score > ranked[1].score) return { match: ranked[0] };
  return { candidates: ranked.slice(0, 5) };
}
