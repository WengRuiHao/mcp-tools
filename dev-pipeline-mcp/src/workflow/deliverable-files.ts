import { readdirSync } from "node:fs";
import path from "node:path";
import type { ArtifactDef, WorkflowDefinition } from "./schema.js";
import { EXTRA_INTERNAL_FILES } from "./internal-files.js";

/** 正式交付物與內部過程檔的清單（依流程定義的 deliverable 旗標；有 render 圖的產出物以圖為交付物，來源檔如 flow.mmd 不交付）。 */

/** 一個產出物對外的路徑：資料夾以「/」結尾。 */
export function artifactDeliverablePaths(a: ArtifactDef): string[] {
  return [...(a.render ? [a.render] : [a.file]), ...(a.attachments ?? [])];
}

export function deliverablePaths(def: WorkflowDefinition, only?: readonly string[]): string[] {
  return def.artifacts.filter((a) => a.deliverable === true && (!only || only.includes(a.id))).flatMap(artifactDeliverablePaths);
}

/** 內部過程檔：沒有 deliverable 旗標的產出物（含附屬檔與圖），加上不屬於流程產出物的 dup-report.md。 */
export function internalPaths(def: WorkflowDefinition): string[] {
  const delivered = new Set(deliverablePaths(def));
  const all = def.artifacts.filter((a) => a.deliverable !== true).flatMap((a) => [a.file, ...(a.attachments ?? []), ...(a.render ? [a.render] : [])]);
  return [...new Set([...all, ...EXTRA_INTERNAL_FILES])].filter((p) => !delivered.has(p));
}

/** 把交付物路徑展開成實際存在的 markdown 檔（相對工作項目目錄、用 / 分隔）；資料夾只展開底下的 .md。 */
export function expandMarkdownFiles(dir: string, paths: readonly string[]): string[] {
  return paths.flatMap((p) => {
    if (p.endsWith("/")) {
      try {
        return readdirSync(path.join(dir, p), { withFileTypes: true }).filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md")).map((e) => `${p}${e.name}`).sort();
      } catch {
        return [];
      }
    }
    return p.toLowerCase().endsWith(".md") ? [p] : [];
  });
}
