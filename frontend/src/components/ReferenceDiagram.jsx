import { useLayoutEffect, useRef, useState } from 'react';

const HEAP_TYPES = ['list', 'dict', 'tuple', 'set'];

function isRef(value) {
  return value !== null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, '__ref__');
}

// bin/oct/hex only make sense for whole numbers — a float falls back to
// decimal regardless of the toggle, same as Python's own int()-only
// int(x, base).
const RADIX_INFO = { bin: [2, '0b'], oct: [8, '0o'], hex: [16, '0x'] };

function formatNumber(value, base) {
  const info = RADIX_INFO[base];
  if (!info || !Number.isInteger(value)) return String(value);
  const [radix, prefix] = info;
  const sign = value < 0 ? '-' : '';
  const digits = Math.abs(value).toString(radix);
  return `${sign}${prefix}${digits}`;
}

// A colored primitive value — same idea as a syntax highlighter (numbers,
// strings, True/False all read differently at a glance) rather than one
// flat text color for every value in the diagram. See python_tracer.py's
// describe(): only true primitives (or its own "<type>" placeholders for
// things like functions) ever reach here, containers always arrive as a
// {"__ref__": id} pointer instead and never hit this function.
function PrimitiveValue({ value, numberBase }) {
  if (value === null) return <span className="viz-val-none">None</span>;
  if (typeof value === 'boolean') return <span className={value ? 'viz-val-true' : 'viz-val-false'}>{value ? 'True' : 'False'}</span>;
  if (typeof value === 'number') return <span className="viz-val-number">{formatNumber(value, numberBase)}</span>;
  if (typeof value === 'string') {
    if (value.startsWith('<') && value.endsWith('>')) return <span className="viz-val-placeholder">{value}</span>;
    return <span className="viz-val-string">{JSON.stringify(value)}</span>;
  }
  return <span>{String(value)}</span>;
}

// Plain-text version for spots that shouldn't carry their own color (dict
// keys already have a dedicated dim style, so a key doesn't need to double
// up with a value-style color too).
function formatPrimitive(value) {
  if (value === null) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    if (value.startsWith('<') && value.endsWith('>')) return value;
    return JSON.stringify(value);
  }
  return String(value);
}

const BRACKETS = { list: '[ ]', tuple: '( )', set: '{ }' };

// Small hand-drawn glyphs (same 12x12/currentColor convention as the
// toolbar's PlayIcon/VizIcon) so each floating object reads at a glance —
// a kid scanning the canvas shouldn't have to read the word "dict" to tell
// it apart from a "list" shape. Rendered in currentColor so each one just
// inherits its box's own type color (see .viz-type-* in Visualizer.css).
function TypeIcon({ type }) {
  if (type === 'dict') {
    return (
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
        <rect x="1" y="1" width="4.2" height="4.2" rx="0.8" /><rect x="6.8" y="1" width="4.2" height="4.2" rx="0.8" />
        <rect x="1" y="6.8" width="4.2" height="4.2" rx="0.8" /><rect x="6.8" y="6.8" width="4.2" height="4.2" rx="0.8" />
      </svg>
    );
  }
  if (type === 'set') {
    return (
      <svg width="12" height="10" viewBox="0 0 12 10" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
        <circle cx="4.5" cy="5" r="3.7" /><circle cx="7.5" cy="5" r="3.7" />
      </svg>
    );
  }
  if (type === 'tuple') {
    return (
      <svg width="11" height="12" viewBox="0 0 11 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
        <path d="M3.8 1c-2 1.6-2 8.4 0 10M7.2 1c2 1.6 2 8.4 0 10" />
      </svg>
    );
  }
  // list
  return (
    <svg width="12" height="10" viewBox="0 0 12 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <path d="M1 1.5h10M1 5h10M1 8.5h10" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 1v7M3 5.5 6 8.5 9 5.5" /><path d="M1.5 10.5h9" />
    </svg>
  );
}

// Breadth-first from the locals so a heap box's first appearance (and thus
// its position in the right-hand column) follows the order a student would
// naturally read the variables in, not raw object-id order.
function computeHeapOrder(locals, heap) {
  const order = [];
  const seen = new Set();
  const queue = [];
  for (const v of Object.values(locals)) if (isRef(v)) queue.push(v.__ref__);
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id) || !heap[id]) continue;
    seen.add(id);
    order.push(id);
    const obj = heap[id];
    const cellValues = obj.type === 'dict' ? obj.items.map(([, v]) => v) : obj.items;
    for (const v of cellValues) if (isRef(v)) queue.push(v.__ref__);
  }
  // Defensive fallback — the tracer only ever puts reachable objects in
  // heap, so this shouldn't fire, but an unreached entry is still worth
  // drawing rather than silently dropping.
  for (const id of Object.keys(heap)) if (!seen.has(id)) order.push(id);
  return order;
}

// Every pointer relationship in this step, as (DOM anchor key -> heap id)
// pairs — arrows are drawn from these after the boxes holding them mount.
// targetType rides along so the arrow (and its arrowhead) can be colored
// to match the object it points at, same as the box itself.
function collectArrows(locals, heap) {
  const arrows = [];
  const typeOf = (id) => (HEAP_TYPES.includes(heap[id]?.type) ? heap[id].type : 'list');
  for (const [name, v] of Object.entries(locals)) {
    if (isRef(v)) arrows.push({ source: `var:${name}`, target: v.__ref__, targetType: typeOf(v.__ref__) });
  }
  for (const [id, obj] of Object.entries(heap)) {
    const cells = obj.type === 'dict' ? obj.items.map(([, v]) => v) : obj.items;
    cells.forEach((v, i) => {
      if (isRef(v)) arrows.push({ source: `heap:${id}:${i}`, target: v.__ref__, targetType: typeOf(v.__ref__) });
    });
  }
  return arrows;
}

function RefSlot({ anchorKey, setRef, type }) {
  return <span className={`viz-ref-dot viz-ref-dot-${HEAP_TYPES.includes(type) ? type : 'list'}`} ref={(el) => setRef(anchorKey, el)} />;
}

function HeapBox({ id, obj, heap, setRef, changed, label, showIndex, numberBase }) {
  const isDict = obj.type === 'dict';
  const cells = obj.items;
  const typeOf = (targetId) => (HEAP_TYPES.includes(heap[targetId]?.type) ? heap[targetId].type : 'list');
  return (
    <div className={`viz-heap-box viz-type-${obj.type}${changed ? ' viz-heap-box-changed' : ''}`} ref={(el) => setRef(`heap:${id}`, el)}>
      <div className="viz-heap-box-title">
        {label != null && <span className="viz-heap-badge">#{label}</span>}
        <TypeIcon type={obj.type} />
        {obj.type}
        {!isDict && <span className="viz-heap-box-brackets">{BRACKETS[obj.type]}</span>}
      </div>
      <div className={isDict ? 'viz-heap-rows' : 'viz-heap-cells'}>
        {isDict
          ? cells.map(([key, value], i) => (
              <div className="viz-heap-row" key={i}>
                <span className="viz-heap-key">{formatPrimitive(key)}</span>
                <span className="viz-heap-cell">
                  {isRef(value)
                    ? <RefSlot anchorKey={`heap:${id}:${i}`} setRef={setRef} type={typeOf(value.__ref__)} />
                    : <PrimitiveValue value={value} numberBase={numberBase} />}
                </span>
              </div>
            ))
          : cells.map((value, i) => (
              <div className="viz-heap-cellwrap" key={i}>
                {showIndex && <span className="viz-heap-idx">{i}</span>}
                <span className="viz-heap-cell">
                  {isRef(value)
                    ? <RefSlot anchorKey={`heap:${id}:${i}`} setRef={setRef} type={typeOf(value.__ref__)} />
                    : <PrimitiveValue value={value} numberBase={numberBase} />}
                </span>
              </div>
            ))}
        {obj.more > 0 && <div className="viz-heap-more">+{obj.more} more</div>}
      </div>
    </div>
  );
}

function buildArrowPath(p) {
  if (p.heapToHeap) {
    // Heap objects now flow left-to-right in a single row (see
    // .viz-diagram-heap), so a target can be on EITHER side of its
    // source — a rightward-only bulge (the old approach, back when the
    // heap was a vertical stack) would loop the wrong way whenever the
    // target sits to the left. Dipping below both boxes instead works
    // regardless of their left-right order.
    const bulge = Math.max(40, Math.abs(p.x2 - p.x1) / 3) + 30;
    return `M ${p.x1},${p.y1} C ${p.x1},${p.y1 + bulge} ${p.x2},${p.y2 + bulge} ${p.x2},${p.y2}`;
  }
  const dx = Math.max(40, Math.abs(p.x2 - p.x1) / 2);
  return `M ${p.x1},${p.y1} C ${p.x1 + dx},${p.y1} ${p.x2 - dx},${p.y2} ${p.x2},${p.y2}`;
}

// Lazily loaded (html2canvas is a real, if smallish, chunk on its own —
// no reason to ship it in the main bundle for students who never click
// download) and only ever invoked from the click handler below.
async function downloadDiagramPng(canvasEl, theme) {
  const { default: html2canvas } = await import('html2canvas');
  const bg = getComputedStyle(canvasEl).backgroundColor;
  const rendered = await html2canvas(canvasEl, {
    backgroundColor: bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : (theme === 'light' ? '#ffffff' : '#131619'),
    scale: 2,
  });
  const link = document.createElement('a');
  link.download = 'memory-diagram.png';
  link.href = rendered.toDataURL('image/png');
  link.click();
}

// The boxes-and-arrows memory diagram — variable boxes on the left, heap
// objects (lists/dicts/tuples/sets) "floating" on the right as their own
// elevated, color-coded cards (list=blue, dict=violet, tuple=pink,
// set=cyan — see .viz-type-* in Visualizer.css, reusing the same palette
// already used for language dots elsewhere in the app), arrows drawn
// between them wherever a variable or a container cell holds a reference,
// each arrow tinted to match the object it points at. Two variables
// aliasing the same list correctly draw as two arrows into ONE box, since
// both carry the same heap id from the tracer. prevLocals/prevHeap (the
// previous step's data, optional) drive the "just changed" glow — a box
// that's genuinely new this step gets a mount-triggered float-in instead,
// handled by CSS alone. idLabels maps each heap id to a small, STABLE
// number (assigned once for the whole trace, in first-appearance order —
// see CodeVisualizer's buildHeapIdLabels) so the same object keeps the
// same #N tag across every step it appears in, not just this one.
export default function ReferenceDiagram({ locals, heap, prevLocals, prevHeap, idLabels, showIndex, numberBase, theme }) {
  const canvasRef = useRef(null);
  const nodeRefs = useRef({});
  const [paths, setPaths] = useState([]);
  const [downloading, setDownloading] = useState(false);
  const heapIds = computeHeapOrder(locals, heap);
  const arrows = collectArrows(locals, heap);
  const localEntries = Object.entries(locals);

  const setRef = (key, el) => {
    if (el) nodeRefs.current[key] = el;
    else delete nodeRefs.current[key];
  };

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const measure = () => {
      const canvasRect = canvas.getBoundingClientRect();
      if (canvasRect.width === 0 && canvasRect.height === 0) return;
      const next = [];
      for (const { source, target, targetType } of arrows) {
        const fromEl = nodeRefs.current[source];
        const toEl = nodeRefs.current[`heap:${target}`];
        if (!fromEl || !toEl) continue;
        const fromRect = fromEl.getBoundingClientRect();
        const toRect = toEl.getBoundingClientRect();
        const heapToHeap = source.startsWith('heap:');
        // Heap objects sit side-by-side in one row now (see
        // .viz-diagram-heap), so a heap-to-heap arrow connects bottom
        // edges and dips below both boxes (buildArrowPath) — that works
        // whichever side the target is on. Variable-to-heap arrows are
        // unaffected: vars stay in their own left-hand column, so
        // right-edge-to-left-edge still reads naturally.
        next.push({
          key: `${source}->${target}`,
          x1: heapToHeap ? (fromRect.left + fromRect.width / 2 - canvasRect.left) : (fromRect.right - canvasRect.left),
          y1: heapToHeap ? (fromRect.bottom - canvasRect.top) : (fromRect.top + fromRect.height / 2 - canvasRect.top),
          x2: heapToHeap ? (toRect.left + toRect.width / 2 - canvasRect.left) : (toRect.left - canvasRect.left),
          y2: heapToHeap ? (toRect.bottom - canvasRect.top) : (toRect.top + toRect.height / 2 - canvasRect.top),
          heapToHeap,
          targetType,
        });
      }
      setPaths(next);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
    // Re-measure whenever this step's data (and therefore the boxes it
    // renders) changes — arrows/positions can't be trusted to stay valid
    // across a step change otherwise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locals, heap]);

  const handleDownload = async () => {
    if (!canvasRef.current || downloading) return;
    setDownloading(true);
    try {
      await downloadDiagramPng(canvasRef.current, theme);
    } catch {
      // A failed export (e.g. the dynamic import getting blocked offline)
      // isn't worth its own error banner — the diagram itself is unaffected,
      // the button just silently stays clickable to try again.
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="viz-diagram-wrap">
      <div className="viz-diagram-topbar">
        <span className="viz-diagram-count">
          {heapIds.length} object{heapIds.length === 1 ? '' : 's'}
        </span>
        <button type="button" className="btn btn-ghost viz-png-btn" onClick={handleDownload} disabled={downloading}>
          <DownloadIcon />
          {downloading ? 'Saving…' : 'PNG'}
        </button>
      </div>
      <div className="viz-diagram">
        <div className="viz-diagram-canvas" ref={canvasRef}>
          <div className="viz-diagram-vars">
            {localEntries.length === 0 && <div className="viz-empty-row">No local variables yet</div>}
            {localEntries.map(([name, value]) => {
              const changed = prevLocals != null
                && (!(name in prevLocals) || JSON.stringify(prevLocals[name]) !== JSON.stringify(value));
              const targetType = isRef(value) && HEAP_TYPES.includes(heap[value.__ref__]?.type) ? heap[value.__ref__].type : 'list';
              return (
                <div className={`viz-var-box${changed ? ' viz-var-box-changed' : ''}`} key={name}>
                  <span className="viz-var-name">{name}</span>
                  <span className="viz-var-value">
                    {isRef(value)
                      ? <RefSlot anchorKey={`var:${name}`} setRef={setRef} type={targetType} />
                      : <PrimitiveValue value={value} numberBase={numberBase} />}
                  </span>
                </div>
              );
            })}
          </div>

          {heapIds.length > 0 && (
            <div className="viz-diagram-heap">
              {heapIds.map((id) => {
                const changed = prevHeap != null && id in prevHeap
                  && JSON.stringify(prevHeap[id]) !== JSON.stringify(heap[id]);
                return (
                  <HeapBox
                    key={id}
                    id={id}
                    obj={heap[id]}
                    heap={heap}
                    setRef={setRef}
                    changed={changed}
                    label={idLabels?.[id]}
                    showIndex={showIndex}
                    numberBase={numberBase}
                  />
                );
              })}
            </div>
          )}

          <svg className="viz-diagram-svg">
            <defs>
              {HEAP_TYPES.map((t) => (
                <marker key={t} id={`viz-arrowhead-${t}`} markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                  <path d="M0,0 L6,3 L0,6 Z" className={`viz-arrowhead-fill-${t}`} />
                </marker>
              ))}
            </defs>
            {paths.map((p) => (
              <path
                key={p.key}
                d={buildArrowPath(p)}
                className={`viz-diagram-arrow viz-arrow-${p.targetType}`}
                markerEnd={`url(#viz-arrowhead-${p.targetType})`}
              />
            ))}
          </svg>
        </div>
      </div>
    </div>
  );
}
