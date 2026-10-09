// Durable steps: one "use step" function per node kind. Each runs with full Node.js
// access, is retried by Workflow SDK on transient failures (default 3 retries) and
// shows up by name in `npx workflow web`. The node logic itself is the shared engine.
import { FatalError } from "workflow";
import {
  clientForAuth,
  errorMessage,
  executeNode,
  isFatalError,
  type EngineAuth,
  type EngineConnection,
} from "../lib/workflow/engine.mjs";
import type { FlowNode } from "../lib/workflow/graph";
import type { AuthRole } from "../lib/workflow/types";

/** Public connection details that may travel with a run (persisted in the event log). */
export interface PublicConnection {
  url?: string | undefined;
  anonKey?: string | undefined;
}

/** Auth state persisted between steps — never contains secrets. */
export interface StepAuth {
  role: AuthRole;
  email?: string | undefined;
  password?: string | undefined;
}

export interface StepInput {
  node: FlowNode;
  prev: unknown;
  ctx: Record<string, unknown>;
  input?: unknown;
  auth: StepAuth;
  conn: PublicConnection;
}

export interface StepOutput {
  out: unknown;
  ms: number;
  /** Set by the auth step. */
  auth?: StepAuth;
}

/**
 * Secrets only ever come from the server environment, and are only used against
 * SUPABASE_URL — never against a URL supplied by the caller.
 */
function serverConnection(
  {
    url,
    anonKey,
    serviceKey,
    password,
    email,
  }: {
      url?: string,
      anonKey?: string,
      serviceKey?: string,
      password?: string,
      email?: string,
    }): EngineConnection {

  const envUrl = process.env["SUPABASE_URL"];
  const envAnonKey = process.env["SUPABASE_ANON_KEY"] || process.env["SUPABASE_PUBLISHABLE_KEY"];
  const envServiceKey = process.env["SUPABASE_SERVICE_ROLE_KEY"] || process.env["SUPABASE_SECRET_KEY"];
  const envPassword = process.env["WF_PASSWORD"];
  const envEmail = process.env["WF_EMAIL"];
  if (envUrl && envAnonKey) {
    return {
      url: envUrl,
      anonKey: envAnonKey,
      serviceKey: envServiceKey,
      password: envPassword,
      email: envEmail,
    };
  }
  return { url: url || "", anonKey: anonKey || "", serviceKey: serviceKey || "", password: password || "" };
}

async function execute({ node, prev, ctx, input, auth, conn: pub }: StepInput): Promise<StepOutput> {
  const t0 = performance.now();
  const conn = serverConnection({
    url: process.env["SUPABASE_URL"] || pub.url || "",
    anonKey: pub.anonKey || process.env["SUPABASE_PUBLISHABLE_KEY"] || "",
    serviceKey: process.env["SUPABASE_SERVICE_ROLE_KEY"] || process.env["SUPABASE_SECRET_KEY"] || pub.anonKey || "",
    email: auth.email || "",
    password: auth.password || process.env["WF_PASSWORD"] || ""
  });
  try {
    // Clients don't survive between steps, so rebuild one for the current role.
    const client = node.data.kind === "auth" ? undefined : (await clientForAuth(auth as EngineAuth, conn)).client;
    const r = await executeNode(node.data, { client, conn, prev, ctx, input });
    return {
      out: r.out ?? null,
      ms: Math.round(performance.now() - t0),
      ...(r.auth ? { auth: { role: r.auth.role, email: r.auth.email } } : {}),
    };
  } catch (err) {
    // Bad config and 4xx responses won't fix themselves — fail without retrying.
    if (isFatalError(err)) throw new FatalError(errorMessage(err));
    throw err instanceof Error ? err : new Error(errorMessage(err));
  }
}

export async function webhookStep(args: StepInput) {
  "use step";
  return execute(args);
}

export async function authStep(args: StepInput) {
  "use step";
  return execute(args);
}

export async function edgeFunctionStep(args: StepInput) {
  "use step";
  return execute(args);
}

export async function dbFunctionStep(args: StepInput) {
  "use step";
  return execute(args);
}

export async function dbQueryStep(args: StepInput) {
  "use step";
  return execute(args);
}

export async function scriptStep(args: StepInput) {
  "use step";
  return execute(args);
}

export async function resultStep(args: StepInput) {
  "use step";
  return execute(args);
}
