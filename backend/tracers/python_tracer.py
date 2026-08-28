"""Line-by-line execution tracer for the IDE's Visualize feature.

Runs a student's program under sys.settrace, recording one "step" per
line/call/return/exception event: the line number, the enclosing function,
the call stack, and the frame's local variables — plus a "heap" of every
list/dict/tuple/set reachable from those locals, keyed by Python object
identity (id()). Locals hold either an inline primitive or a {"__ref__": id}
pointer into that step's heap, so two variables aliasing the same list show
up as two arrows into ONE heap box, the way pythontutor.com renders it —
the frontend draws the boxes-and-arrows diagram from this shape.

The whole trace is collected in memory and printed as a single JSON blob at
the end — this matches the sandbox's existing "spawn once, capture output,
tear down" model (see executeInSandboxRaw in backend/index.js) rather than
requiring a persistent interactive process per student.

Usage: python3 python_tracer.py <path-to-student-source>
Student stdin is passed through untouched (same as normal execution) so
input() calls behave exactly as they would outside the tracer.
"""
import sys
import json
import io

# Bounds keep the trace small enough to fit runLimited's 1MB stdout cap and
# keep tracing overhead from itself blowing the CPU ulimit on a student's
# infinite loop — once MAX_STEPS is hit, we stop recording and disable the
# trace hook so the program still runs to completion (or hits the CPU
# limit) at full speed. Lower than a locals-only trace would need, since
# each step can now also carry a heap of container objects.
MAX_STEPS = 400
MAX_LOCALS = 25
MAX_HEAP_OBJECTS = 14
MAX_COLLECTION_ITEMS = 8
MAX_VALUE_LEN = 60

# compile()'s `filename` argument below is set to this exact string, which is
# also how we tell the student's frames apart from the tracer's own (or any
# stdlib) frames in the trace function — no separate flag/allowlist needed.
STUDENT_FILENAME = 'main.py'


def make_ref(obj_id):
    return {'__ref__': str(obj_id)}


def format_key(key):
    """Dict keys go out as-is when JSON can carry them natively (so the
    frontend can render 3 vs "3" correctly); anything else (tuples, custom
    __hash__ objects) falls back to repr() text."""
    if key is None or isinstance(key, (bool, int, float, str)):
        return key
    try:
        return repr(key)[:MAX_VALUE_LEN]
    except Exception:
        return '<key>'


def describe(value, heap, visiting):
    """JSON-safe representation of one value for a locals slot or a
    container cell: an inline primitive, a {"__ref__": id} pointer into
    heap (registering the object there — and recursively describing ITS
    contents — the first time it's seen), or a short "<type>" placeholder
    for anything else (functions, modules, open files, custom objects) or
    once MAX_HEAP_OBJECTS has been reached. Never raises — a value that
    can't be introspected safely just becomes a placeholder instead of
    aborting the whole trace step."""
    try:
        if value is None or isinstance(value, (bool, int, float, str)):
            if isinstance(value, str) and len(value) > MAX_VALUE_LEN:
                return value[:MAX_VALUE_LEN] + '…'
            return value

        obj_id = id(value)
        is_container = isinstance(value, (list, tuple, set, frozenset, dict))
        if not is_container:
            return f'<{type(value).__name__}>'

        # Already boxed (or in the middle of being boxed, for a
        # self-referential container like `a = []; a.append(a)`) — just
        # point at it again rather than re-describing or recursing forever.
        if str(obj_id) in heap or obj_id in visiting:
            return make_ref(obj_id)
        if len(heap) >= MAX_HEAP_OBJECTS:
            return f'<{type(value).__name__}>'

        visiting.add(obj_id)
        try:
            if isinstance(value, dict):
                items = list(value.items())[:MAX_COLLECTION_ITEMS]
                entry = {
                    'type': 'dict',
                    'items': [[format_key(k), describe(v, heap, visiting)] for k, v in items],
                    'more': max(0, len(value) - MAX_COLLECTION_ITEMS),
                }
            else:
                kind = 'list' if isinstance(value, list) else ('tuple' if isinstance(value, tuple) else 'set')
                items = list(value)[:MAX_COLLECTION_ITEMS]
                entry = {
                    'type': kind,
                    'items': [describe(v, heap, visiting) for v in items],
                    'more': max(0, len(value) - MAX_COLLECTION_ITEMS),
                }
        finally:
            visiting.discard(obj_id)

        heap[str(obj_id)] = entry
        return make_ref(obj_id)
    except Exception:
        return '<unrepresentable>'


def call_stack(frame):
    """Function names from outermost to innermost, student frames only."""
    names = []
    f = frame
    while f is not None and f.f_code.co_filename == STUDENT_FILENAME:
        names.append(f.f_code.co_name)
        f = f.f_back
    names.reverse()
    return names


def main():
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'No source file provided to tracer.'}))
        return

    try:
        with open(sys.argv[1], 'r') as f:
            source = f.read()
    except Exception as e:
        print(json.dumps({'error': f'Could not read source: {e}'}))
        return

    try:
        code_obj = compile(source, STUDENT_FILENAME, 'exec')
    except SyntaxError as e:
        print(json.dumps({'error': f'SyntaxError: {e}'}))
        return

    steps = []
    truncated = False
    captured_stdout = io.StringIO()
    real_stdout = sys.stdout

    def record(event, frame, error=None):
        nonlocal truncated
        if truncated:
            return
        if len(steps) >= MAX_STEPS:
            truncated = True
            sys.settrace(None)
            return
        local_items = [
            (k, v) for k, v in frame.f_locals.items() if not k.startswith('__')
        ][:MAX_LOCALS]

        heap = {}
        visiting = set()
        locals_out = {k: describe(v, heap, visiting) for k, v in local_items}

        step = {
            'line': frame.f_lineno,
            'event': event,
            'func': frame.f_code.co_name,
            'stack': call_stack(frame),
            'locals': locals_out,
            'heap': heap,
            'stdout': captured_stdout.getvalue(),
        }
        if error:
            step['error'] = error
        steps.append(step)

    def tracer(frame, event, arg):
        if frame.f_code.co_filename != STUDENT_FILENAME:
            return None
        if event in ('line', 'call', 'return'):
            record(event, frame)
        elif event == 'exception':
            exc_type, exc_val, _ = arg
            record('exception', frame, error=f'{exc_type.__name__}: {exc_val}')
        return tracer

    top_error = None
    sys.stdout = captured_stdout
    sys.settrace(tracer)
    try:
        exec(code_obj, {'__name__': '__main__'})
    except SystemExit:
        pass
    except BaseException as e:
        top_error = f'{type(e).__name__}: {e}'
    finally:
        sys.settrace(None)
        sys.stdout = real_stdout

    result = {
        'steps': steps,
        'finalOutput': captured_stdout.getvalue(),
        'truncated': truncated,
        'error': top_error,
    }
    real_stdout.write(json.dumps(result))


if __name__ == '__main__':
    main()
