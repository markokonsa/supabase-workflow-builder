import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { NODE_META, type WFNodeData } from "@/lib/workflow/types";

export function WorkflowNode({ data, selected }: NodeProps<Node<WFNodeData>>) {
  const meta = NODE_META[data.kind];
  const summary =
    data.kind === "edge" ? data.config.name :
    data.kind === "rpc" ? `${data.config.fn}()` :
    data.kind === "query" ? `${data.config.op} · ${data.config.table}` :
    data.kind === "auth" ? data.config.role : meta.hint;
  return (
    <div className="wf-node" data-kind={data.kind} data-status={data.status ?? "idle"} data-selected={selected}>
      {data.kind !== "start" && <Handle type="target" position={Position.Left} />}
      <div className="wf-node-head">
        <span className="wf-dot" />
        <span className="wf-kind">{meta.title}</span>
        <span className="wf-sdk">{meta.sdk}</span>
      </div>
      <div className="wf-node-label">{data.label}</div>
      <div className="wf-node-sum">{summary}</div>
      {data.kind !== "output" && <Handle type="source" position={Position.Right} />}
    </div>
  );
}
