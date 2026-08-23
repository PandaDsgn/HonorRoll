// Hand-rolled 0-100 visual (no charting library anywhere in this codebase —
// see admin.css's .perf-bar comment). A null percent renders a dashed
// "no score yet" track instead of a filled bar. Shared by the teacher
// dashboard (AdminDashboard.jsx) and the student cross-institution
// performance dashboard (MyPerformance.jsx).
export default function PercentBar({ percent }) {
  const pct = percent == null ? null : Math.max(0, Math.min(100, percent));
  return (
    <div className="perf-bar" title={pct == null ? 'No graded score yet' : `${pct.toFixed(1)}%`}>
      {pct == null ? <div className="perf-bar-empty" /> : <div className="perf-bar-fill" style={{ width: `${pct}%` }} />}
    </div>
  );
}
