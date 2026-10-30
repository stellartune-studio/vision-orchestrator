import type { DatabaseSync } from "node:sqlite";
export interface AnimationBackgroundPlan { revision_id: string; background_asset_id: string; background_sha256: string; foreground_asset_id: string; foreground_sha256: string }
export function animationBackgroundPlan(db: DatabaseSync, revisionId: string): AnimationBackgroundPlan | undefined {
  return db.prepare("SELECT revision_id, background_asset_id, background_sha256, foreground_asset_id, foreground_sha256 FROM animation_background_plans WHERE revision_id = ?").get(revisionId) as unknown as AnimationBackgroundPlan | undefined;
}
export function insertAnimationBackgroundPlan(db: DatabaseSync, plan: AnimationBackgroundPlan): void {
  db.prepare("INSERT INTO animation_background_plans (revision_id, background_asset_id, background_sha256, foreground_asset_id, foreground_sha256) VALUES (?, ?, ?, ?, ?)").run(plan.revision_id, plan.background_asset_id, plan.background_sha256, plan.foreground_asset_id, plan.foreground_sha256);
}
