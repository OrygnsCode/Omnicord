import { randomBytes } from "node:crypto";
import type { Blueprint } from "./blueprint.js";
import type { PlanStep } from "./planner.js";

// Staged plans live in memory with a TTL. In stdio mode the store dies
// with the process, which is why execute_build_plan will also accept a
// full blueprint directly: a plan_id is a convenience, not the only path.

const PLAN_TTL_MS = 30 * 60_000;

export interface StagedPlan {
  planId: string;
  guildId: string;
  blueprint: Blueprint;
  steps: PlanStep[];
  warnings: string[];
  createdAt: number;
}

const plans = new Map<string, StagedPlan>();

function sweep(now: number): void {
  for (const [id, plan] of plans) {
    if (now - plan.createdAt > PLAN_TTL_MS) plans.delete(id);
  }
}

export function stagePlan(
  guildId: string,
  blueprint: Blueprint,
  steps: PlanStep[],
  warnings: string[]
): StagedPlan {
  const now = Date.now();
  sweep(now);
  const plan: StagedPlan = {
    planId: randomBytes(8).toString("hex"),
    guildId,
    blueprint,
    steps,
    warnings,
    createdAt: now,
  };
  plans.set(plan.planId, plan);
  return plan;
}

export function getPlan(planId: string): StagedPlan | undefined {
  sweep(Date.now());
  return plans.get(planId);
}

export function planTtlMinutes(): number {
  return PLAN_TTL_MS / 60_000;
}
