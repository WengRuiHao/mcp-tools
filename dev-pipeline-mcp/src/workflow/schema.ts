import { z } from "zod";

/** Workflow 引擎 schema（schemaVersion 1）。階段 1 只做「定義、驗證、描述」，不取代任何現有行為。 */

export const HARD_STOP_IDS = [
  "destructive-db",
  "breaks-existing",
  "consecutive-fail-3",
  "reviewer-uncertain",
  "scope-split",
  "sensitive-data",
] as const;
export type HardStopId = (typeof HARD_STOP_IDS)[number];

export const CONFIRM_MODES = ["manual", "auto", "inherit"] as const;
export type ConfirmMode = (typeof CONFIRM_MODES)[number];

const idField = z.string().min(1);

export const ArtifactDefSchema = z
  .object({
    id: idField,
    file: z.string().min(1),
    kind: z.enum(["markdown", "mermaid", "sql", "report", "code-change", "html"]),
    attachments: z.array(z.string()).optional(),
    render: z.string().optional(),
    evidence: z.array(z.enum(["screenshot"])).optional(),
  })
  .strict();

export const RoleDefSchema = z
  .object({
    id: idField,
    promptRef: z.string().min(1),
    dependsOn: z.array(idField),
    parallelWith: z.array(idField).optional(),
    inputs: z.array(idField),
    outputs: z.array(idField),
    optional: z.boolean().optional(),
    /** 只支援 key==value，可用 && 連接。 */
    when: z.string().optional(),
    roleNotes: z.string().optional(),
  })
  .strict();

/** 內容類關卡的檢查項（對應現有 gates.json 的條目）。 */
export const CheckDefSchema = z
  .object({
    id: idField,
    description: z.string().min(1),
    heading: z.string().optional(),
    minChars: z.number().int().positive().optional(),
    ticketNamePattern: z.string().optional(),
    /** 以下三項來自 gates.json analysisReferences 的結構化保留（向後相容，皆選填）。 */
    pathPrefix: z.string().optional(),
    minPaths: z.number().int().positive().optional(),
    requireSasd: z.boolean().optional(),
  })
  .strict();

export const GateDefSchema = z
  .object({
    id: idField,
    after: z.union([idField, z.array(idField).min(1)]),
    type: z.enum(["confirmation", "content", "verdict", "evidence"]),
    confirmMode: z.enum(CONFIRM_MODES).optional(),
    locked: z.boolean().optional(),
    checks: z.array(CheckDefSchema).optional(),
    routeOnFail: z.record(z.string(), idField).optional(),
  })
  .strict();

export const WorkflowDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: idField,
    granularity: z.enum(["feature", "module", "system"]),
    source: z.enum(["asana", "manual"]),
    baseline: z.enum(["greenfield", "brownfield"]),
    confirmDefault: z.enum(["manual", "auto"]),
    hardStops: z.array(z.enum(HARD_STOP_IDS)),
    artifacts: z.array(ArtifactDefSchema),
    roles: z.array(RoleDefSchema),
    gates: z.array(GateDefSchema),
    children: z.object({ from: idField, workflow: idField }).strict().optional(),
  })
  .strict();

export type ArtifactDef = z.infer<typeof ArtifactDefSchema>;
export type RoleDef = z.infer<typeof RoleDefSchema>;
export type CheckDef = z.infer<typeof CheckDefSchema>;
export type GateDef = z.infer<typeof GateDefSchema>;
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

/** 自動重複偵測的專案設定（S12a）：只開放門檻與額外排除，皆有範圍限制。 */
export const DupSettingsSchema = z
  .object({
    minRun: z.number().int().min(4).max(100).optional(),
    testMinRun: z.number().int().min(4).max(200).optional(),
    minChars: z.number().int().min(20).max(2000).optional(),
    extraExcludes: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  })
  .strict();

/**
 * 專案 flow.json 覆寫：只允許 confirmMode、optional、內容類 checks、roleNotes，以及重複偵測設定 dup。
 * strict：其他欄位（locked、hardStops、dependsOn…）一律被 zod 拒絕。
 */
export const ProjectFlowOverrideSchema = z
  .object({
    schemaVersion: z.literal(1),
    confirmDefault: z.enum(["manual", "auto"]).optional(),
    gates: z
      .record(
        z.string(),
        z.object({ confirmMode: z.enum(CONFIRM_MODES).optional(), checks: z.array(CheckDefSchema).optional() }).strict()
      )
      .optional(),
    roles: z
      .record(z.string(), z.object({ optional: z.boolean().optional(), roleNotes: z.string().optional() }).strict())
      .optional(),
    dup: DupSettingsSchema.optional(),
  })
  .strict();
export type ProjectFlowOverride = z.infer<typeof ProjectFlowOverrideSchema>;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function parseWith<T>(schema: z.ZodType<T>, raw: unknown): ParseResult<T> {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}：${i.message}`) };
}

export const parseWorkflowDefinition = (raw: unknown) => parseWith(WorkflowDefinitionSchema, raw);
export const parseProjectFlowOverride = (raw: unknown) => parseWith(ProjectFlowOverrideSchema, raw);
