// The engine lives in engine.mjs so the exporter can embed the exact same
// source into standalone scripts. This module keeps the app's import path stable.
export { runWorkflow, template } from "./engine.mjs";
export type { LogEntry, EngineConnection, EngineEdge, EngineNode } from "./engine.mjs";
