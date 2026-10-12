import { CONDITION_OPS, type ConditionOp, type ConditionRule } from "@/lib/workflow/types";

let seq = 0;
const ruleId = () => `r_${Date.now().toString(36)}${seq++}`;

/**
 * Inspector editor for a condition node's rules. Each rule is one output handle (its id); `else`
 * fires when nothing matched. Removing a rule also tells the caller which handle disappeared, so the
 * edges leaving it can be removed.
 */
export function ConditionRules({
  rules,
  onChange,
}: {
  rules: ConditionRule[];
  onChange: (rules: ConditionRule[], removedId?: string) => void;
}) {
  const update = (i: number, patch: Partial<ConditionRule>) => onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="wf-rules">
      <label className="wf-label">Branches · one output each, plus else</label>
      {rules.map((r, i) => {
        const unary = CONDITION_OPS.find((o) => o.op === r.op)?.unary;
        return (
          <div key={r.id} className="wf-rule">
            <div className="wf-rule-head">
              <input className="wf-input" aria-label="Branch name" value={r.label} placeholder={`branch ${i + 1}`} onChange={(e) => update(i, { label: e.target.value })} />
              <button className="wf-btn-ghost wf-rule-x" aria-label="Remove branch" onClick={() => onChange(rules.filter((_, j) => j !== i), r.id)}>
                ×
              </button>
            </div>
            <input className="wf-input" aria-label="Value" value={r.left} placeholder="{{prev.status}}" onChange={(e) => update(i, { left: e.target.value })} />
            <select className="wf-input" aria-label="Operator" value={r.op} onChange={(e) => update(i, { op: e.target.value as ConditionOp })}>
              {CONDITION_OPS.map((o) => (
                <option key={o.op} value={o.op}>
                  {o.label}
                </option>
              ))}
            </select>
            {!unary && (
              <input className="wf-input" aria-label="Compare with" value={r.right ?? ""} placeholder="200" onChange={(e) => update(i, { right: e.target.value })} />
            )}
          </div>
        );
      })}
      <button
        className="wf-btn-ghost"
        onClick={() => onChange([...rules, { id: ruleId(), label: `branch ${rules.length + 1}`, left: "{{prev}}", op: "==", right: "" }])}
      >
        + Add branch
      </button>
      <p className="wf-help">Both sides are templated, then compared as numbers when both are numeric, else as text.</p>
    </div>
  );
}
