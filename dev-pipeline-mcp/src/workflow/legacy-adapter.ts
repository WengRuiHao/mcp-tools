import type { SasdConfig, TestCapabilityConfig } from "../project-registry.js";
import { buildAsanaTicketWorkflow } from "./builtin/asana-ticket.js";
import type { CheckDef, WorkflowDefinition } from "./schema.js";
import type { WhenContext } from "./validate.js";

/** gates.json 的形狀（只取 workflow 用得到的兩組；與 project-gates.ts 內部型別一致，這裡不改動它）。 */
export interface LegacyGatesConfig {
  analysisReferences?: Array<{ ticketNamePattern: string; heading: string; pathPrefix: string; minPaths?: number; requireSasd?: boolean }>;
  implementationSections?: Array<{ ticketNamePattern: string; heading: string; minChars?: number }>;
}

export interface LegacyFlow {
  workflow: WorkflowDefinition;
  /** 給 resolveWorkflow 的 when 條件上下文。 */
  context: WhenContext;
  warnings: string[];
}

function analysisChecks(gates: LegacyGatesConfig | null): CheckDef[] {
  return (gates?.analysisReferences ?? []).map((g, i) => ({
    id: `analysis-reference-${i + 1}`,
    description: `分析文件必須有標題含「${g.heading}」的一節，並引用 ${g.pathPrefix} 底下至少 ${g.minPaths ?? 1} 個既有路徑`,
    heading: g.heading,
    ticketNamePattern: g.ticketNamePattern,
  }));
}

function implementationChecks(gates: LegacyGatesConfig | null): CheckDef[] {
  return (gates?.implementationSections ?? []).map((g, i) => ({
    id: `implementation-section-${i + 1}`,
    description: `實作文件必須有標題含「${g.heading}」的一節`,
    heading: g.heading,
    ...(g.minChars !== undefined ? { minChars: g.minChars } : {}),
    ticketNamePattern: g.ticketNamePattern,
  }));
}

function testNote(tc: TestCapabilityConfig | null): string | undefined {
  if (!tc || tc.mode === "modern") return undefined;
  const base = tc.mode === "none" ? "這個專案不能寫自動化測試" : "這個專案只能用 JUnit4 等級的測試工具";
  return tc.note ? `${base}（${tc.note}）` : base;
}

/**
 * 把現有的專案設定（sasd_config、test_capability、legacy_test_profile、gates.json）
 * 翻成 workflow 定義＋when 上下文。唯讀：不寫任何設定、不改既有行為。
 * self-generated 但 specOrder 缺漏時不猜，兩個規格撰寫者角色都不啟用並給 warning。
 */
export function fromLegacy(
  sasd: SasdConfig | null,
  testCapability: TestCapabilityConfig | null,
  legacyTestProfile: boolean,
  gates: LegacyGatesConfig | null
): LegacyFlow {
  const base = buildAsanaTicketWorkflow();
  const warnings: string[] = [];
  if (!sasd) warnings.push("尚未登記 sasd_config：沒有規格模式，規格撰寫者角色一律不啟用");
  if (sasd?.sdMode === "self-generated" && !sasd.specOrder) warnings.push("self-generated 缺 specOrder：不猜，規格撰寫者角色都不啟用");
  const engineerNote = testNote(testCapability);
  const testerNote = legacyTestProfile ? "套用老舊系統測試章節（legacy_test_profile）" : undefined;
  const workflow: WorkflowDefinition = {
    ...base,
    roles: base.roles.map((r) => {
      if (r.id === "engineer" && engineerNote) return { ...r, roleNotes: engineerNote };
      if (r.id === "tester" && testerNote) return { ...r, roleNotes: testerNote };
      return r;
    }),
    gates: base.gates.map((g) => {
      if (g.id === "analysis-content") return { ...g, checks: analysisChecks(gates) };
      if (g.id === "implementation-content") return { ...g, checks: implementationChecks(gates) };
      return g;
    }),
  };
  const context: WhenContext = {
    sdMode: sasd?.sdMode ?? null,
    specOrder: sasd?.sdMode === "self-generated" ? (sasd.specOrder ?? null) : null,
    testCapabilityMode: testCapability?.mode ?? null,
    legacyTestProfile: String(legacyTestProfile),
  };
  return { workflow, context, warnings };
}
