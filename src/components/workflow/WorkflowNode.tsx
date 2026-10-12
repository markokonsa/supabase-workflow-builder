import { useEffect } from "react";
import { Handle, Position, useUpdateNodeInternals, type NodeProps, type Node } from "@xyflow/react";
import { ELSE_HANDLE, HOOK_EVENT, HOOK_TIMEOUT, NODE_META, type WFNodeData } from "@/lib/workflow/types";

function hostOf(url: string) {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** Named outputs of branching nodes; other nodes have one unnamed output. */
function outputsOf(data: WFNodeData): { id: string; label: string }[] | null {
  if (data.kind === "condition") {
    return [
      ...data.config.rules.map((r, i) => ({ id: r.id, label: r.label || `branch ${i + 1}` })),
      { id: ELSE_HANDLE, label: "else" },
    ];
  }
  if (data.kind === "hook") return [{ id: HOOK_EVENT, label: "triggered" }, { id: HOOK_TIMEOUT, label: "timeout" }];
  return null;
}

export function WorkflowNode({ id, data, selected }: NodeProps<Node<WFNodeData>>) {
  const meta = NODE_META[data.kind] ?? {
    title: data.kind,
    icon: "icon-unknown",
    sdk: "-",
    hint: "-",
  };
  const summary =
    data.kind === "edge" ? data.config.name :
    data.kind === "rpc" ? `${data.config.fn}()` :
    data.kind === "query" ? `${data.config.op} · ${data.config.table}` :
    data.kind === "auth" ? data.config.role :
    data.kind === "http" ? `${data.config.method} ${hostOf(data.config.url)}` :
    data.kind === "hook" ? `wait ≤ ${data.config.timeout || "5m"}` :
    data.kind === "condition" ? `${data.config.rules.length} rule${data.config.rules.length === 1 ? "" : "s"} · ${data.config.mode === "all" ? "all matches" : "first match"}` :
    meta?.hint;

  const Icon = meta ? meta.icon : undefined;
  const outputs = outputsOf(data);
  // React Flow caches handle positions; refresh them when branches are added or removed.
  const updateNodeInternals = useUpdateNodeInternals();
  const handleKey = outputs?.map((o) => o.id).join("|") ?? "";
  useEffect(() => updateNodeInternals(id), [id, handleKey, updateNodeInternals]);

  return (
    <div className="wf-node" data-kind={data.kind} data-status={data.status ?? "idle"} data-selected={selected}>
      {data.kind !== "start" && <Handle type="target" position={Position.Left} />}
      <div className="wf-node-head">
        {Icon ? <Icon className="wf-node-icon" size={14} strokeWidth={2.25} aria-hidden /> : <span className="wf-dot" />}
        <span className="wf-kind">{meta.title}</span>
        <span className="wf-sdk">{meta.sdk}</span>
      </div>
      <div className="wf-node-label">{data.label}</div>
      <div className="wf-node-sum">{summary}</div>
      {outputs ? (
        <div className="wf-branches">
          {outputs.map((o) => (
            <div key={o.id} className="wf-branch" data-else={o.id === ELSE_HANDLE || o.id === HOOK_TIMEOUT}>
              <span>{o.label}</span>
              <Handle type="source" position={Position.Right} id={o.id} />
            </div>
          ))}
        </div>
      ) : (
        data.kind !== "output" && <Handle type="source" position={Position.Right} />
      )}
    </div>
  );
}
