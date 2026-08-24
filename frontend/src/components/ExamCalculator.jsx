import { useState } from 'react';

// ---------------------------------------------------------------------------
// Safe expression engine for Basic/Scientific modes — no eval(). Supports
// + - * / ^ % ! ( ) , implicit multiplication (2π, 3(4+5)), and a small
// function/constant set. Trig functions respect the deg/rad toggle.
// ---------------------------------------------------------------------------
const FUNCS = new Set(['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'ln', 'log', 'sqrt', 'exp', 'abs']);
const CONSTS = { pi: Math.PI, e: Math.E };

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ') { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      tokens.push({ type: 'num', value: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[a-zA-Z]/.test(c)) {
      let j = i;
      while (j < src.length && /[a-zA-Z]/.test(src[j])) j++;
      tokens.push({ type: 'ident', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if ('+-*/^%!(),'.includes(c)) {
      tokens.push({ type: 'op', value: c });
      i++;
      continue;
    }
    throw new Error(`Unexpected character "${c}"`);
  }
  return tokens;
}

function makeParser(tokens, degMode) {
  let pos = 0;
  const peek = () => tokens[pos];
  const isPrimaryStart = (t) => t && (t.type === 'num' || t.type === 'ident' || (t.type === 'op' && t.value === '('));

  function toRad(v) { return degMode ? (v * Math.PI) / 180 : v; }
  function fromRad(v) { return degMode ? (v * 180) / Math.PI : v; }

  function applyFunc(name, arg) {
    switch (name) {
      case 'sin': return Math.sin(toRad(arg));
      case 'cos': return Math.cos(toRad(arg));
      case 'tan': return Math.tan(toRad(arg));
      case 'asin': return fromRad(Math.asin(arg));
      case 'acos': return fromRad(Math.acos(arg));
      case 'atan': return fromRad(Math.atan(arg));
      case 'ln': return Math.log(arg);
      case 'log': return Math.log10(arg);
      case 'sqrt': return Math.sqrt(arg);
      case 'exp': return Math.exp(arg);
      case 'abs': return Math.abs(arg);
      default: throw new Error(`Unknown function "${name}"`);
    }
  }

  function factorial(n) {
    if (n < 0 || Math.abs(n - Math.round(n)) > 1e-9 || n > 170) throw new Error('Invalid factorial');
    n = Math.round(n);
    let r = 1;
    for (let k = 2; k <= n; k++) r *= k;
    return r;
  }

  function parsePrimary() {
    const t = peek();
    if (!t) throw new Error('Unexpected end of expression');
    if (t.type === 'num') { pos++; return t.value; }
    if (t.type === 'op' && t.value === '(') {
      pos++;
      const v = parseExpression();
      if (!(peek() && peek().type === 'op' && peek().value === ')')) throw new Error('Missing ")"');
      pos++;
      return v;
    }
    if (t.type === 'ident') {
      pos++;
      if (peek() && peek().type === 'op' && peek().value === '(') {
        pos++;
        const arg = parseExpression();
        if (!(peek() && peek().type === 'op' && peek().value === ')')) throw new Error('Missing ")"');
        pos++;
        if (!FUNCS.has(t.value)) throw new Error(`Unknown function "${t.value}"`);
        return applyFunc(t.value, arg);
      }
      if (t.value in CONSTS) return CONSTS[t.value];
      throw new Error(`Unknown identifier "${t.value}"`);
    }
    throw new Error('Unexpected token');
  }

  function parsePostfix() {
    let v = parsePrimary();
    while (peek() && peek().type === 'op' && (peek().value === '%' || peek().value === '!')) {
      const op = tokens[pos].value;
      pos++;
      v = op === '%' ? v / 100 : factorial(v);
    }
    return v;
  }

  function parseUnary() {
    if (peek() && peek().type === 'op' && (peek().value === '-' || peek().value === '+')) {
      const op = tokens[pos].value;
      pos++;
      const v = parseUnary();
      return op === '-' ? -v : v;
    }
    return parsePostfix();
  }

  function parsePow() {
    const base = parseUnary();
    if (peek() && peek().type === 'op' && peek().value === '^') {
      pos++;
      const exp = parsePow();
      return Math.pow(base, exp);
    }
    return base;
  }

  function parseMulDiv() {
    let v = parsePow();
    for (;;) {
      const t = peek();
      if (t && t.type === 'op' && (t.value === '*' || t.value === '/')) {
        pos++;
        const rhs = parsePow();
        v = t.value === '*' ? v * rhs : v / rhs;
      } else if (isPrimaryStart(t)) {
        // implicit multiplication, e.g. 2π, 3(4+5)
        const rhs = parsePow();
        v *= rhs;
      } else break;
    }
    return v;
  }

  function parseExpression() {
    let v = parseMulDiv();
    for (;;) {
      const t = peek();
      if (t && t.type === 'op' && (t.value === '+' || t.value === '-')) {
        pos++;
        const rhs = parseMulDiv();
        v = t.value === '+' ? v + rhs : v - rhs;
      } else break;
    }
    return v;
  }

  return {
    run() {
      const v = parseExpression();
      if (pos !== tokens.length) throw new Error('Unexpected trailing input');
      return v;
    },
  };
}

function evaluateExpression(src, degMode) {
  const tokens = tokenize(src);
  if (tokens.length === 0) throw new Error('Empty expression');
  const value = makeParser(tokens, degMode).run();
  if (!Number.isFinite(value)) throw new Error('Result is not finite');
  return value;
}

function formatNumber(n) {
  if (Object.is(n, -0)) n = 0;
  const rounded = Math.round(n * 1e10) / 1e10;
  return String(rounded);
}

// ---------------------------------------------------------------------------
// Basic / Scientific — shared text-buffer engine, scientific just shows an
// extra row of function/mode buttons.
// ---------------------------------------------------------------------------
function ExpressionCalculator({ scientific }) {
  const [expr, setExpr] = useState('');
  const [justEvaluated, setJustEvaluated] = useState(false);
  const [error, setError] = useState('');
  const [memory, setMemory] = useState(0);
  const [degMode, setDegMode] = useState(true);

  const append = (text) => {
    setError('');
    setExpr((prev) => (justEvaluated ? text : prev + text));
    setJustEvaluated(false);
  };

  const clearAll = () => { setExpr(''); setError(''); setJustEvaluated(false); };
  const backspace = () => { setError(''); setExpr((prev) => prev.slice(0, -1)); setJustEvaluated(false); };

  const toggleSign = () => {
    setError('');
    setExpr((prev) => {
      if (!prev) return prev;
      if (prev.startsWith('-(') && prev.endsWith(')')) return prev.slice(2, -1);
      return `-(${prev})`;
    });
    setJustEvaluated(false);
  };

  const equals = () => {
    if (!expr.trim()) return;
    try {
      const value = evaluateExpression(expr, degMode);
      setExpr(formatNumber(value));
      setJustEvaluated(true);
      setError('');
    } catch {
      setError('Error');
    }
  };

  const memoryAdd = (sign) => {
    try {
      const value = evaluateExpression(expr || '0', degMode);
      setMemory((m) => m + sign * value);
    } catch { setError('Error'); }
  };
  const memoryRecall = () => append(formatNumber(memory));
  const memoryClear = () => setMemory(0);

  const basicButtons = [
    ['(', ')', 'AC', 'DEL'],
    ['7', '8', '9', '/'],
    ['4', '5', '6', '*'],
    ['1', '2', '3', '-'],
    ['0', '.', '%', '+'],
  ];

  return (
    <div className="exam-calc-body">
      <div className="exam-calc-display">
        <div className="exam-calc-expr">{expr || '0'}</div>
        {error && <div className="exam-calc-error">{error}</div>}
      </div>

      <div className="exam-calc-memrow">
        <button type="button" onClick={memoryClear}>MC</button>
        <button type="button" onClick={memoryRecall}>MR</button>
        <button type="button" onClick={() => memoryAdd(1)}>M+</button>
        <button type="button" onClick={() => memoryAdd(-1)}>M−</button>
        <button type="button" onClick={toggleSign}>±</button>
        {scientific && (
          <button type="button" className={degMode ? 'active' : ''} onClick={() => setDegMode((d) => !d)}>
            {degMode ? 'DEG' : 'RAD'}
          </button>
        )}
      </div>

      {scientific && (
        <div className="exam-calc-grid exam-calc-grid-fn">
          {['sin(', 'cos(', 'tan(', 'ln(', 'log('].map((f) => (
            <button key={f} type="button" onClick={() => append(f)}>{f.replace('(', '')}</button>
          ))}
          {['asin(', 'acos(', 'atan(', 'sqrt(', 'exp('].map((f) => (
            <button key={f} type="button" onClick={() => append(f)}>{f === 'sqrt(' ? '√' : f === 'exp(' ? 'eˣ' : f.replace('(', '⁻¹')}</button>
          ))}
          <button type="button" onClick={() => append('^')}>xʸ</button>
          <button type="button" onClick={() => append('!')}>x!</button>
          <button type="button" onClick={() => append('pi')}>π</button>
          <button type="button" onClick={() => append('e')}>e</button>
          <button type="button" onClick={() => append('abs(')}>|x|</button>
        </div>
      )}

      <div className="exam-calc-grid">
        {basicButtons.flat().map((b) => {
          if (b === 'AC') return <button key={b} type="button" className="exam-calc-op" onClick={clearAll}>AC</button>;
          if (b === 'DEL') return <button key={b} type="button" className="exam-calc-op" onClick={backspace}>DEL</button>;
          if ('+-*/'.includes(b)) return <button key={b} type="button" className="exam-calc-op" onClick={() => append(b)}>{{ '*': '×', '/': '÷' }[b] || b}</button>;
          return <button key={b} type="button" onClick={() => append(b)}>{b}</button>;
        })}
      </div>

      <button type="button" className="exam-calc-equals" onClick={equals}>=</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Programmer — base-N entry with simultaneous multi-base display, 32-bit
// two's-complement bitwise ops (matches typical classroom C/CS conventions).
// ---------------------------------------------------------------------------
const MASK32 = (1n << 32n) - 1n;
const DIGITS = '0123456789ABCDEF';

function parseInRadix(str, radix) {
  if (!str) return 0n;
  let v = 0n;
  for (const ch of str.toUpperCase()) {
    const d = DIGITS.indexOf(ch);
    if (d === -1 || d >= radix) throw new Error('Invalid digit');
    v = v * BigInt(radix) + BigInt(d);
  }
  return v & MASK32;
}

function toSignedDecimalString(v) {
  const unsigned = v & MASK32;
  const signed = unsigned >= (1n << 31n) ? unsigned - (1n << 32n) : unsigned;
  return signed.toString(10);
}

function ProgrammerCalculator() {
  const [base, setBase] = useState(10);
  const [input, setInput] = useState('0');
  const [stored, setStored] = useState(null);
  const [pendingOp, setPendingOp] = useState(null);
  const [error, setError] = useState('');

  const currentValue = () => {
    try { return parseInRadix(input, base); } catch { return 0n; }
  };

  const bases = [
    { label: 'BIN', radix: 2 },
    { label: 'OCT', radix: 8 },
    { label: 'DEC', radix: 10 },
    { label: 'HEX', radix: 16 },
  ];

  const switchBase = (radix) => {
    const v = currentValue();
    setBase(radix);
    setInput(radix === 10 ? toSignedDecimalString(v) : v.toString(radix).toUpperCase());
  };

  const pressDigit = (d) => {
    setError('');
    setInput((prev) => (prev === '0' ? d : prev + d));
  };
  const clearAll = () => { setInput('0'); setStored(null); setPendingOp(null); setError(''); };
  const backspace = () => setInput((prev) => (prev.length > 1 ? prev.slice(0, -1) : '0'));

  const applyOp = (op) => {
    try {
      const v = currentValue();
      if (op === 'NOT') {
        const result = (~v) & MASK32;
        setInput(base === 10 ? toSignedDecimalString(result) : result.toString(base).toUpperCase());
        return;
      }
      if (stored === null) {
        setStored(v);
        setPendingOp(op);
        setInput('0');
        return;
      }
      const result = combine(stored, v, pendingOp);
      setStored(null);
      setPendingOp(op === '=' ? null : op);
      setInput(base === 10 ? toSignedDecimalString(result) : result.toString(base).toUpperCase());
    } catch { setError('Error'); }
  };

  const combine = (a, b, op) => {
    let r;
    switch (op) {
      case 'AND': r = a & b; break;
      case 'OR': r = a | b; break;
      case 'XOR': r = a ^ b; break;
      case '<<': r = (a << (b & 31n)) & MASK32; break;
      case '>>': r = (a & MASK32) >> (b & 31n); break;
      case '+': r = a + b; break;
      case '-': r = a - b; break;
      case '*': r = a * b; break;
      case '/': if (b === 0n) throw new Error('div by 0'); r = a / b; break;
      default: r = b;
    }
    return r & MASK32;
  };

  const availableDigits = DIGITS.slice(0, base);

  return (
    <div className="exam-calc-body">
      <div className="exam-calc-basegrid">
        {bases.map((b) => {
          let display;
          try {
            const v = currentValue();
            display = b.radix === 10 ? toSignedDecimalString(v) : v.toString(b.radix).toUpperCase();
          } catch { display = '—'; }
          return (
            <button key={b.radix} type="button" className={base === b.radix ? 'active' : ''} onClick={() => switchBase(b.radix)}>
              <span className="exam-calc-base-label">{b.label}</span>
              <span className="exam-calc-base-value">{display}</span>
            </button>
          );
        })}
      </div>

      <div className="exam-calc-display">
        <div className="exam-calc-expr">{input}</div>
        {error && <div className="exam-calc-error">{error}</div>}
      </div>

      <div className="exam-calc-grid exam-calc-grid-4">
        {'0123456789ABCDEF'.split('').map((d) => (
          <button key={d} type="button" disabled={!availableDigits.includes(d)} onClick={() => pressDigit(d)}>{d}</button>
        ))}
      </div>

      <div className="exam-calc-grid exam-calc-grid-4">
        <button type="button" onClick={() => applyOp('AND')}>AND</button>
        <button type="button" onClick={() => applyOp('OR')}>OR</button>
        <button type="button" onClick={() => applyOp('XOR')}>XOR</button>
        <button type="button" onClick={() => applyOp('NOT')}>NOT</button>
        <button type="button" onClick={() => applyOp('<<')}>{'<<'}</button>
        <button type="button" onClick={() => applyOp('>>')}>{'>>'}</button>
        <button type="button" onClick={() => applyOp('+')}>+</button>
        <button type="button" onClick={() => applyOp('-')}>−</button>
        <button type="button" onClick={() => applyOp('*')}>×</button>
        <button type="button" onClick={() => applyOp('/')}>÷</button>
        <button type="button" onClick={backspace}>DEL</button>
        <button type="button" onClick={clearAll}>AC</button>
      </div>

      <button type="button" className="exam-calc-equals" onClick={() => applyOp('=')}>=</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Statistics — running data set with live descriptive stats.
// ---------------------------------------------------------------------------
function StatisticsCalculator() {
  const [values, setValues] = useState([]);
  const [input, setInput] = useState('');

  const addValue = () => {
    const n = Number(input);
    if (!input.trim() || !Number.isFinite(n)) return;
    setValues((prev) => [...prev, n]);
    setInput('');
  };
  const removeLast = () => setValues((prev) => prev.slice(0, -1));
  const clearAll = () => { setValues([]); setInput(''); };

  const n = values.length;
  const sum = values.reduce((a, b) => a + b, 0);
  const mean = n ? sum / n : 0;
  const sorted = [...values].sort((a, b) => a - b);
  const median = n ? (n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2) : 0;
  const variancePop = n ? values.reduce((a, v) => a + (v - mean) ** 2, 0) / n : 0;
  const varianceSample = n > 1 ? values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1) : 0;

  const stat = (label, v) => (
    <div className="exam-calc-stat-row" key={label}>
      <span>{label}</span>
      <span>{n ? formatNumber(v) : '—'}</span>
    </div>
  );

  return (
    <div className="exam-calc-body">
      <div className="exam-calc-display">
        <input
          className="exam-calc-stat-input"
          type="text"
          inputMode="decimal"
          value={input}
          placeholder="Enter a value…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addValue(); }}
        />
      </div>
      <div className="exam-calc-grid exam-calc-grid-3">
        <button type="button" onClick={addValue}>Add</button>
        <button type="button" onClick={removeLast}>Undo last</button>
        <button type="button" onClick={clearAll}>Clear all</button>
      </div>

      <div className="exam-calc-stat-list">
        {n === 0 ? <span className="exam-calc-stat-empty">No data entered yet.</span> : values.map((v, i) => (
          <span key={i} className="exam-calc-stat-chip">{formatNumber(v)}</span>
        ))}
      </div>

      <div className="exam-calc-stat-panel">
        {stat('n (count)', n)}
        {stat('Sum (Σx)', sum)}
        {stat('Mean (x̄)', mean)}
        {stat('Median', median)}
        {stat('Min', n ? Math.min(...values) : 0)}
        {stat('Max', n ? Math.max(...values) : 0)}
        {stat('Population variance (σ²)', variancePop)}
        {stat('Population std dev (σ)', Math.sqrt(variancePop))}
        {stat('Sample variance (s²)', varianceSample)}
        {stat('Sample std dev (s)', Math.sqrt(varianceSample))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Financial — classic 5-key TVM solver (N, I/Y, PV, PMT, FV), the same model
// HP 12C / TI BA II Plus style financial calculators use.
// ---------------------------------------------------------------------------
function solveTVM({ n, i, pv, pmt, fv }, solveFor) {
  const rate = i / 100;
  if (solveFor === 'FV') {
    if (rate === 0) return -(pv + pmt * n);
    const g = Math.pow(1 + rate, n);
    return -(pv * g + pmt * ((g - 1) / rate));
  }
  if (solveFor === 'PV') {
    if (rate === 0) return -(fv + pmt * n);
    const g = Math.pow(1 + rate, n);
    return -(fv + pmt * ((g - 1) / rate)) / g;
  }
  if (solveFor === 'PMT') {
    if (rate === 0) return -(pv + fv) / n;
    const g = Math.pow(1 + rate, n);
    return (-(pv * g) - fv) * rate / (g - 1);
  }
  if (solveFor === 'N') {
    if (rate === 0) return -(pv + fv) / pmt;
    const num = pmt - fv * rate;
    const den = pmt + pv * rate;
    return Math.log(num / den) / Math.log(1 + rate);
  }
  if (solveFor === 'I') {
    // Newton-Raphson on f(rate) = pv*(1+rate)^n + pmt*((1+rate)^n - 1)/rate + fv
    const f = (r) => {
      if (Math.abs(r) < 1e-12) return pv + pmt * n + fv;
      const g = Math.pow(1 + r, n);
      return pv * g + pmt * ((g - 1) / r) + fv;
    };
    let r = 0.1;
    for (let iter = 0; iter < 100; iter++) {
      const h = 1e-6;
      const derivative = (f(r + h) - f(r - h)) / (2 * h);
      if (Math.abs(derivative) < 1e-12) break;
      const next = r - f(r) / derivative;
      if (!Number.isFinite(next)) break;
      if (Math.abs(next - r) < 1e-10) { r = next; break; }
      r = next;
    }
    return r * 100;
  }
  throw new Error('Unknown target');
}

function FinancialCalculator() {
  const [fields, setFields] = useState({ n: '', i: '', pv: '', pmt: '', fv: '' });
  const [solveFor, setSolveFor] = useState('FV');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const set = (key, value) => setFields((prev) => ({ ...prev, [key]: value }));

  const compute = () => {
    setError('');
    setResult(null);
    try {
      const nums = {};
      for (const key of ['n', 'i', 'pv', 'pmt', 'fv']) {
        if (key === solveFor.toLowerCase()) { nums[key] = 0; continue; }
        const v = Number(fields[key]);
        if (fields[key].trim() === '' || !Number.isFinite(v)) throw new Error(`${key.toUpperCase()} is required`);
        nums[key] = v;
      }
      const value = solveTVM(nums, solveFor);
      if (!Number.isFinite(value)) throw new Error('No solution found');
      setResult(value);
    } catch (err) {
      setError(err.message || 'Could not solve — check inputs');
    }
  };

  const rows = [
    { key: 'n', label: 'N (periods)' },
    { key: 'i', label: 'I/Y (% per period)' },
    { key: 'pv', label: 'PV (present value)' },
    { key: 'pmt', label: 'PMT (payment)' },
    { key: 'fv', label: 'FV (future value)' },
  ];

  return (
    <div className="exam-calc-body">
      <p className="exam-calc-fin-hint">
        Sign convention: cash you receive is positive, cash you pay out is negative. Pick the value to solve for, fill in the other four, then Compute.
      </p>
      <div className="exam-calc-fin-grid">
        {rows.map((r) => (
          <div className="exam-calc-fin-row" key={r.key}>
            <label>
              <input
                type="radio"
                name="solveFor"
                checked={solveFor === r.key.toUpperCase()}
                onChange={() => setSolveFor(r.key.toUpperCase())}
              />
              {r.label}
            </label>
            <input
              type="number"
              disabled={solveFor === r.key.toUpperCase()}
              value={solveFor === r.key.toUpperCase() ? (result !== null ? formatNumber(result) : '') : fields[r.key]}
              placeholder={solveFor === r.key.toUpperCase() ? '(solving…)' : '0'}
              onChange={(e) => set(r.key, e.target.value)}
            />
          </div>
        ))}
      </div>
      {error && <div className="exam-calc-error">{error}</div>}
      <button type="button" className="exam-calc-equals" onClick={compute}>Compute {solveFor}</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
export default function ExamCalculator({ type, onClose }) {
  const titles = {
    basic: 'Basic Calculator',
    scientific: 'Scientific Calculator',
    programmer: 'Programmer Calculator',
    statistics: 'Statistics Calculator',
    financial: 'Financial Calculator',
  };

  return (
    <div className="exam-calc-panel panel">
      <div className="exam-calc-header">
        <span>{titles[type] || 'Calculator'}</span>
        <button type="button" className="exam-calc-close" onClick={onClose} aria-label="Close calculator">×</button>
      </div>
      {(type === 'basic' || type === 'scientific') && <ExpressionCalculator scientific={type === 'scientific'} />}
      {type === 'programmer' && <ProgrammerCalculator />}
      {type === 'statistics' && <StatisticsCalculator />}
      {type === 'financial' && <FinancialCalculator />}
    </div>
  );
}
