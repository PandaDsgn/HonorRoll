// Line-by-line execution tracer for the IDE's Visualize feature — the
// JavaScript counterpart to python_tracer.py, producing the exact same
// JSON contract ({steps, finalOutput, truncated, error}) so the frontend
// (CodeVisualizer.jsx/ReferenceDiagram.jsx) needs no per-language branches.
//
// Python has sys.settrace as a language-level hook; JS has no equivalent,
// but Node's built-in inspector module exposes the same V8 Inspector
// Protocol a real debugger client uses, IN-PROCESS (self-debugging, no
// separate transport). Debugger.setInstrumentationBreakpoint({instrumentation:
// 'beforeScriptExecution'}) pauses right as a script's top-level starts
// running — two other approaches were tried and rejected first:
// Debugger.pause() arms a generic "break on the very next statement" flag
// that Node's own bootstrap code (module loading, console color-support
// probing, etc.) consumes before the student script even parses; and
// Debugger.setBreakpointByUrl at line 0 resolves to wherever V8 considers
// the nearest valid breakpoint location, which for a script starting with
// a function/class declaration is INSIDE that declaration's body, not the
// module's actual first top-level statement — everything before that
// function is later called then runs completely unpaused.
//
// Everything inside the pause→record→step cycle below is deliberately
// plain-callback style, NOT async/await: V8 runs a nested message loop
// while paused to keep processing debugger protocol commands, and that
// nested loop reliably pumps session.post()'s own callback, but an
// async/await chain (Promise microtasks) was found empirically to survive
// only the first hop — a `Debugger.stepInto` issued after more than one
// prior `await` in the same handler silently resumed the program to
// completion instead of pausing again. Recording a step needs several
// dependent Runtime.getProperties round-trips (one per scope, recursively
// per container value), so the whole walk is written in continuation-
// passing style instead: callback-in, callback-out, letting the very last
// callback in a step's chain be the one that requests the next stepInto.
//
// Usage: node js_tracer.js <path-to-student-source>
'use strict';
const fs = require('fs');
const vm = require('vm');
const inspector = require('inspector');
const util = require('util');

const MAX_STEPS = 400;
const MAX_LOCALS = 25;
const MAX_HEAP_OBJECTS = 14;
const MAX_COLLECTION_ITEMS = 8;
const MAX_VALUE_LEN = 60;
const STUDENT_FILENAME = 'main.js';

// Runs in the target object's own context via Runtime.callFunctionOn — see
// the long comment on describe() below for why this exists instead of a
// HeapProfiler-based id. globalThis.__traceIdCounter__ lives in the same
// realm the student script runs in (vm.Script.runInThisContext shares it),
// so it persists correctly across every call for the life of one trace.
const MARKER_FN = `function() {
  if (!Object.prototype.hasOwnProperty.call(this, '__traceId__')) {
    if (typeof globalThis.__traceIdCounter__ !== 'number') globalThis.__traceIdCounter__ = 1;
    try {
      Object.defineProperty(this, '__traceId__', { value: globalThis.__traceIdCounter__++, enumerable: false, configurable: true });
    } catch (e) { return -1; }
  }
  return this.__traceId__;
}`;

function makeRef(objectId) {
  return { __ref__: String(objectId) };
}

function truncateStr(s) {
  return s.length > MAX_VALUE_LEN ? s.slice(0, MAX_VALUE_LEN) + '…' : s;
}

function main() {
  const studentPath = process.argv[2];
  if (!studentPath) {
    process.stdout.write(JSON.stringify({ error: 'No source file provided to tracer.' }));
    return;
  }
  let source;
  try {
    source = fs.readFileSync(studentPath, 'utf8');
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: `Could not read source: ${e.message}` }));
    return;
  }

  // V8 steps at a finer, sub-statement granularity than Python's line hook
  // (e.g. pausing once mid-evaluation of a console.log(...) call and again
  // right after), and can also land one position past the last real
  // statement as the script finishes — sourceLineCount bounds that, and
  // lastKey below collapses same-line reruns into one step, keeping the
  // trace at roughly Python's coarser one-step-per-line granularity.
  const sourceLineCount = source.replace(/\n$/, '').split('\n').length;

  const session = new inspector.Session();
  session.connect();

  const steps = [];
  let lastKey = null;
  let truncated = false;
  let stdoutBuf = '';
  let topError = null;
  let prevStackDepth = 0;
  let studentScriptId = null;
  let finished = false;

  session.on('Debugger.scriptParsed', (msg) => {
    if (msg.params.url === STUDENT_FILENAME) studentScriptId = msg.params.scriptId;
  });

  ['log', 'info', 'warn', 'error'].forEach((method) => {
    console[method] = (...args) => { stdoutBuf += util.format(...args) + '\n'; };
  });

  // Recursively resolves one Runtime.RemoteObject into the same
  // inline-value / {__ref__} / heap-entry shape python_tracer.py produces.
  // cb(value) is called exactly once, synchronously for primitives or via
  // session.post's own callback for anything needing a property lookup.
  //
  // Heap dedup can NOT key on the RemoteObject's own .objectId — verified
  // empirically that two properties aliasing the literal same underlying
  // object (`let b = a`, or `{ref: obj1, other: obj1}`) come back from two
  // separate Runtime.getProperties calls with two DIFFERENT .objectId
  // strings: Runtime's objectId is a handle on that ONE serialization, not
  // a stable identity for the heap object itself. HeapProfiler.getHeapObjectId
  // was tried next and turned out to be unusable here too — verified it
  // returns the literal string "0" for every single object in this Node
  // build, with no error, so it silently collapsed every object in a step
  // into one shared heap entry instead of correctly deduping only real
  // aliases. What actually works, verified empirically: tag the object
  // itself with a hidden, non-enumerable marker property the first time
  // it's seen (via Runtime.callFunctionOn, MARKER_FN below) — reading it
  // back afterward is the same value for every alias of that one object,
  // since it's a real property ON the object, not a serialization handle.
  // The JS analogue of Python's id(), and the only way aliasing shows up
  // correctly as two arrows into one heap box instead of two separate
  // (wrong) boxes.
  function describe(remoteObj, heap, visiting, cb) {
    if (!remoteObj) return cb(null);
    const { type, subtype, value, objectId, description } = remoteObj;
    if (type === 'undefined') return cb('<undefined>');
    if (value === null && type === 'object') return cb(null);
    if (type === 'string') return cb(truncateStr(value));
    if (type === 'number' || type === 'boolean') return cb(value);
    if (type === 'bigint') return cb(truncateStr(String(description || value)));
    if (type === 'function') return cb('<function>');
    if (type !== 'object') return cb(`<${type}>`);

    const isContainer = subtype === 'array' || !subtype;
    if (!isContainer) return cb(`<${subtype || 'object'}>`);
    if (!objectId) return cb('<object>');

    session.post('Runtime.callFunctionOn', { objectId, functionDeclaration: MARKER_FN, returnByValue: true }, (idErr, idRes) => {
      const heapId = (!idErr && idRes && idRes.result && idRes.result.value >= 0) ? String(idRes.result.value) : objectId;
      if (heap[heapId] || visiting.has(heapId)) return cb(makeRef(heapId));
      if (Object.keys(heap).length >= MAX_HEAP_OBJECTS) return cb(`<${subtype || 'object'}>`);

      visiting.add(heapId);
      session.post('Runtime.getProperties', { objectId, ownProperties: true, generatePreview: false }, (err, props) => {
        if (err) { visiting.delete(heapId); return cb('<unrepresentable>'); }
        const entries = (props.result || []).filter((p) => p.enumerable && p.value !== undefined && p.name !== 'length');
        const slice = entries.slice(0, MAX_COLLECTION_ITEMS);
        const more = Math.max(0, entries.length - MAX_COLLECTION_ITEMS);

        const describedItems = [];
        const walkNext = (i) => {
          if (i >= slice.length) {
            heap[heapId] = subtype === 'array'
              ? { type: 'list', items: describedItems, more }
              : { type: 'dict', items: describedItems, more };
            visiting.delete(heapId);
            return cb(makeRef(heapId));
          }
          describe(slice[i].value, heap, visiting, (v) => {
            if (subtype === 'array') describedItems.push(v);
            else describedItems.push([slice[i].name, v]);
            walkNext(i + 1);
          });
        };
        walkNext(0);
      });
    });
  }

  // Walks every non-global scope of the paused frame, resolving each one's
  // own properties (and recursively, via describe, anything they point
  // into) — cb(locals, heap) once every scope has been consumed.
  function collectLocals(scopeChain, cb) {
    const heap = {};
    const visiting = new Set();
    const locals = {};
    let count = 0;

    const scopes = scopeChain.filter((s) => s.type !== 'global');
    const walkScope = (si) => {
      if (si >= scopes.length || count >= MAX_LOCALS) return cb(locals, heap);
      session.post('Runtime.getProperties', { objectId: scopes[si].object.objectId, ownProperties: true, generatePreview: false }, (err, props) => {
        if (err) return walkScope(si + 1);
        const entries = (props.result || []).filter((p) => p.name in locals === false);
        const walkProp = (pi) => {
          if (pi >= entries.length || count >= MAX_LOCALS) return walkScope(si + 1);
          const p = entries[pi];
          describe(p.value, heap, visiting, (v) => {
            locals[p.name] = v;
            count++;
            walkProp(pi + 1);
          });
        };
        walkProp(0);
      });
    };
    walkScope(0);
  }

  // The one place execution actually advances — called after a step has
  // been fully recorded (or immediately, if this pause wasn't recordable
  // at all, e.g. inside tracer-internal frames). Not called at all once
  // truncated/finished, which leaves the program to run to completion at
  // full speed with no further pausing.
  function stepOn() {
    if (truncated || finished) return;
    session.post('Debugger.stepInto', {}, (err) => {
      if (err) finished = true; // session likely torn down already
    });
  }

  session.on('Debugger.paused', (msg) => {
    const { callFrames, reason, data } = msg.params;

    if (truncated) return; // Debugger.disable() below already resumes it

    if (steps.length >= MAX_STEPS) {
      truncated = true;
      session.post('Debugger.disable', {}, () => {});
      return;
    }

    const studentFrames = callFrames.filter((f) => f.location.scriptId === studentScriptId);
    const top = studentFrames[0];
    // No student frame at all (paused somewhere in Node/V8-internal code a
    // stepInto wandered into), or one position past the last real line (V8
    // landing just past the final statement as the script finishes) — skip
    // recording but keep stepping, same "not every pause is a real step"
    // handling either way.
    if (!top || top.location.lineNumber + 1 > sourceLineCount) { stepOn(); return; }

    collectLocals(top.scopeChain, (locals, heap) => {
      const stack = studentFrames.map((f) => f.functionName || '<module>').reverse();
      const depth = studentFrames.length;
      let event;
      if (reason === 'exception') event = 'exception';
      else if (depth > prevStackDepth) event = 'call';
      else if (depth < prevStackDepth) event = 'return';
      else event = 'line';
      prevStackDepth = depth;

      const step = {
        line: top.location.lineNumber + 1,
        event,
        func: top.functionName || '<module>',
        stack,
        locals,
        heap,
        stdout: stdoutBuf,
      };
      if (reason === 'exception') {
        const desc = data && (data.description || data.className) ? (data.description || data.className) : 'Error';
        step.error = String(desc).split('\n')[0];
      }

      const key = `${step.line}|${step.func}|${stack.join(',')}`;
      if (key === lastKey && !step.error && steps.length > 0 && !steps[steps.length - 1].error) {
        steps[steps.length - 1] = step;
      } else {
        steps.push(step);
        lastKey = key;
      }
      stepOn();
    });
  });

  session.post('Debugger.enable', {}, () => {
    session.post('Runtime.enable', {}, () => {
      // Off by default — without this, V8 never pauses on a throw at all,
      // so an exception would only ever show up as the top-level `error`
      // field with no corresponding traced step at the actual line it
      // happened on. 'uncaught' (not 'all') was tried first and doesn't
      // work here: this tracer necessarily wraps runInThisContext() in its
      // own try/catch (to capture the final result and avoid crashing the
      // whole process), and from V8's perspective that outer catch makes
      // every exception "caught" regardless of whether the student wrote
      // one — verified empirically, 'uncaught' never paused at all, even
      // for a genuinely uncaught TypeError. 'all' pauses on every throw
      // instead, including ones the student's own try/catch goes on to
      // handle — which actually matches python_tracer.py's own behavior:
      // sys.settrace's 'exception' event fires the same way for a Python
      // exception regardless of whether it's later caught.
      session.post('Debugger.setPauseOnExceptions', { state: 'all' }, () => {
        session.post('Debugger.setInstrumentationBreakpoint', { instrumentation: 'beforeScriptExecution' }, () => {
          try {
            const script = new vm.Script(source, { filename: STUDENT_FILENAME });
            script.runInThisContext();
          } catch (e) {
            if (steps.length === 0) {
              const label = e instanceof SyntaxError ? 'SyntaxError' : (e.constructor ? e.constructor.name : 'Error');
              process.stdout.write(JSON.stringify({ error: `${label}: ${e.message}` }));
              return;
            }
            topError = `${e.constructor ? e.constructor.name : 'Error'}: ${e.message}`;
          }
          finished = true;
          session.post('Debugger.disable', {}, () => {
            session.disconnect();
            process.stdout.write(JSON.stringify({ steps, finalOutput: stdoutBuf, truncated, error: topError }));
          });
        });
      });
    });
  });
}

main();
