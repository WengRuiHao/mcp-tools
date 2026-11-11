import { stat } from "node:fs/promises";
import path from "node:path";
import { deliverablePaths, internalPaths } from "../workflow/deliverable-files.js";
import type { WorkflowDefinition } from "../workflow/schema.js";

/** 收件用清單：正式交付物（可直接交給客戶／使用者）與內部過程檔（不交付）兩組，各附是否存在。 */
export interface FileListing {
  path: string;
  exists: boolean;
}

async function exists(dir: string, rel: string): Promise<FileListing> {
  const ok = await stat(path.join(dir, rel)).then(() => true, () => false);
  return { path: rel, exists: ok };
}

export async function listDeliverables(dir: string, def: WorkflowDefinition): Promise<{ deliverables: FileListing[]; internalFiles: FileListing[] }> {
  const [deliverables, internalFiles] = await Promise.all([Promise.all(deliverablePaths(def).map((p) => exists(dir, p))), Promise.all(internalPaths(def).map((p) => exists(dir, p)))]);
  return { deliverables, internalFiles };
}
