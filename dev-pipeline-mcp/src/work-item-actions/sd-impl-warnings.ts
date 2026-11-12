import { readFile } from "node:fs/promises";
import path from "node:path";
import type { WorkflowDefinition } from "../workflow/schema.js";
import { compareSdWithImpl, type EngineerKind } from "../workflow/sd-impl-files-check.js";

const ENGINEER: Readonly<Record<string, { kind: EngineerKind; artifact: string }>> = {
  "frontend-engineer": { kind: "frontend", artifact: "impl-fe" },
  "backend-engineer": { kind: "backend", artifact: "impl-be" },
};

export async function readOptionalText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf-8");
  } catch {
    return undefined;
  }
}

/** 工程師 done 時比對 impl 改動檔案與 SD 引用位置，回警告清單（不擋交件；缺檔或沒有改動清單回空）。 */
export async function sdImplWarnings(dir: string, roleId: string, def: WorkflowDefinition): Promise<string[]> {
  const rule = ENGINEER[roleId];
  if (!rule) return [];
  const sdFile = def.artifacts.find((a) => a.id === "sd")?.file;
  const implFile = def.artifacts.find((a) => a.id === rule.artifact)?.file;
  if (!sdFile || !implFile) return [];
  const [sd, impl] = await Promise.all([readOptionalText(path.join(dir, sdFile)), readOptionalText(path.join(dir, implFile))]);
  if (sd === undefined || impl === undefined) return [];
  try {
    return compareSdWithImpl(sd, impl, rule.kind, sdFile, implFile);
  } catch {
    return [];
  }
}
