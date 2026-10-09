import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthRole, NodeConfig, NodeKind, NodeStatus } from "./types";

export interface LogEntry {
  nodeId: string;
  label: string;
  status: NodeStatus;
  message: string;
  ms?: number;
}

export interface EngineNodeData {
  kind: NodeKind;
  label: string;
  config: NodeConfig;
}

export interface EngineNode {
  id: string;
  data: EngineNodeData;
}

export interface EngineEdge {
  source: string;
  target: string;
}

export interface EngineConnection {
  url: string;
  anonKey: string;
  /** Fallback when a service_role auth node has no key of its own. */
  serviceKey?: string | undefined;
  /** Fallback when an authenticated auth node has no password of its own. */
  password?: string | undefined;
  email?: string | undefined;
}

/** Auth state carried between nodes. password/serviceKey are optional overrides of conn. */
export interface EngineAuth {
  role: AuthRole;
  email?: string | undefined;
  password?: string | undefined;
  serviceKey?: string | undefined;
}

/** Safe-to-persist description of the active role. */
export interface AuthInfo {
  role: AuthRole;
  user_id?: string;
  email?: string;
}

export interface ExecuteEnv {
  client?: SupabaseClient | undefined;
  conn: EngineConnection;
  prev: unknown;
  ctx: Record<string, unknown>;
  input?: unknown;
}

export interface ExecuteResult {
  out: unknown;
  /** Set by auth nodes: the new auth state for downstream nodes. */
  auth?: EngineAuth;
  client?: SupabaseClient | undefined;
}

export function template(input: string | undefined, scope: Record<string, unknown>): string;
export function parseJson(src: string | undefined, scope: Record<string, unknown>, field: string): unknown;
export function topo(nodes: EngineNode[], edges: EngineEdge[]): string[];
export function isFatalError(err: unknown): boolean;
export function errorMessage(err: unknown): string;
export function clientForAuth(
  auth: EngineAuth | undefined,
  conn: EngineConnection,
): Promise<{ client: SupabaseClient; info: AuthInfo }>;
export function executeNode(data: EngineNodeData, env: ExecuteEnv): Promise<ExecuteResult>;

export function runWorkflow(
  nodes: EngineNode[],
  edges: EngineEdge[],
  conn: EngineConnection,
  onStatus: (id: string, status: NodeStatus, result?: unknown) => void,
  log: (e: LogEntry) => void,
  opts?: { input?: unknown },
): Promise<Record<string, unknown>>;
