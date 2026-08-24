import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * db-mcp 是連線/專案登記的唯一來源（不是像 svn-mcp 那樣跟 claudeweb 各自獨立一份）——
 * 因為專案分組、schema 快取、AI 筆記都只有在「單一登記處」的前提下才有意義。
 * claudeweb 之後改成透過 HTTP bridge 呼叫這裡的資料，自己不再存連線設定。
 */
function getInfoDir(): string {
  const configured = process.env.DB_MCP_INFO_DIR;
  return configured ? path.resolve(configured) : path.resolve(__dirname, "..", "info");
}

function getProjectsFilePath(): string {
  return path.join(getInfoDir(), "projects.json");
}

function getConnectionsFilePath(): string {
  return path.join(getInfoDir(), "db-connections.json");
}

export function getProjectSchemaDbPath(projectId: string): string {
  const dir = path.join(getInfoDir(), "projects", projectId);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "schema.sqlite");
}

export function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch (e: any) {
    if (e?.code === "ENOENT") return fallback;
    throw e;
  }
}

function writeJsonFile(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

// ===== Project =====

export interface Project {
  id: string;
  name: string;
  description: string;
  createdAt: string;
}

interface ProjectsFile {
  projects: Project[];
}

export function listProjects(): Project[] {
  return readJsonFile<ProjectsFile>(getProjectsFilePath(), { projects: [] }).projects;
}

export function findProject(id: string): Project | undefined {
  return listProjects().find((p) => p.id === id);
}

export function createProject(name: string, description: string): Project {
  const projects = listProjects();
  const project: Project = {
    id: generateId("proj"),
    name,
    description,
    createdAt: new Date().toISOString(),
  };
  projects.push(project);
  writeJsonFile(getProjectsFilePath(), { projects });
  return project;
}

// ===== Connection =====

export type DbType = "postgresql" | "mysql" | "mssql" | "oracle";
export type DbEnv = "dev" | "test" | "staging" | "prod";

export interface DbConnection {
  id: string;
  projectId: string;
  name: string;
  env: DbEnv;
  type: DbType;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  createdAt: string;
}

interface ConnectionsFile {
  connections: DbConnection[];
}

export function listConnections(projectId?: string): DbConnection[] {
  const all = readJsonFile<ConnectionsFile>(getConnectionsFilePath(), { connections: [] }).connections;
  return projectId ? all.filter((c) => c.projectId === projectId) : all;
}

export function findConnection(id: string): DbConnection | undefined {
  return listConnections().find((c) => c.id === id);
}

export function addConnection(input: Omit<DbConnection, "id" | "createdAt">): DbConnection {
  const connections = listConnections();
  const connection: DbConnection = {
    ...input,
    id: generateId("conn"),
    createdAt: new Date().toISOString(),
  };
  connections.push(connection);
  writeJsonFile(getConnectionsFilePath(), { connections });
  return connection;
}

/** 對外（例如 db_list_connections 工具）看到的連線資訊，絕對不含密碼。 */
export function toSafeConnection(c: DbConnection): Omit<DbConnection, "password"> {
  const { password, ...safe } = c;
  return safe;
}
