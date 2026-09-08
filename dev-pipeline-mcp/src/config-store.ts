import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function getDataDir(): string {
  return path.resolve(process.env.ASANA_PIPELINE_DATA_DIR ?? path.join(__dirname, "..", "data"));
}

/** Directory holding this MCP's bundled reference templates (e.g. the SD spec writing/versioning rules). */
export function getTemplatesDir(): string {
  return path.resolve(__dirname, "..", "templates");
}

/** Absolute path to asana-mcp's compiled entrypoint (dist/index.js), used to spawn it as a child MCP server. */
export function getAsanaMcpEntrypoint(): string {
  const configured = process.env.ASANA_MCP_PATH;
  if (configured) return path.resolve(configured);
  return path.resolve(__dirname, "..", "..", "asana-mcp", "dist", "index.js");
}

/** Absolute path to spec-pipeline-mcp's compiled entrypoint (dist/index.js), used to spawn it as a child MCP server. */
export function getSpecPipelineMcpEntrypoint(): string {
  const configured = process.env.SPEC_PIPELINE_MCP_PATH;
  if (configured) return path.resolve(configured);
  return path.resolve(__dirname, "..", "..", "spec-pipeline-mcp", "dist", "index.js");
}

/** Absolute path to svn-mcp's compiled entrypoint (dist/index.js), used to spawn it as a child MCP server. */
export function getSvnMcpEntrypoint(): string {
  const configured = process.env.SVN_MCP_PATH;
  if (configured) return path.resolve(configured);
  return path.resolve(__dirname, "..", "..", "svn-mcp", "dist", "index.js");
}

/** Lightweight taskGid -> absolute folder path lookup index. The actual ticket content lives inside each project's own directory (see pipeline-store.ts); only this small index stays in the MCP's own data dir. */
export function getTicketsIndexFile(): string {
  return path.join(getDataDir(), "tickets-index.json");
}

/** Per-projectDir registry of actual git version-control roots (front-end/back-end may differ), used by run_project_shell to refuse to run git commands against an unexpected/unverified repo. */
export function getGitRootsConfigFile(): string {
  return path.join(getDataDir(), "git-roots-config.json");
}

/** Per-absolute-path record of the content hash this MCP last wrote via write_project_file, used to detect external modification (see file-write-state.ts). Lives in this MCP's own data dir, never inside the target project. */
export function getFileWriteStateFile(): string {
  return path.join(getDataDir(), "file-write-state.json");
}

/** Where write_project_file backs up on-disk content it's about to overwrite when acknowledgeExternalChange forces past an external-modification block. Deliberately outside any target project directory (never inside projectDir/.asana-pipeline), so a conflict snapshot can never end up committed into the user's own repo by accident. */
export function getConflictBackupsDir(): string {
  return path.join(getDataDir(), "conflict-backups");
}
