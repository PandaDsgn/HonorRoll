"""Line-by-line execution tracer for the IDE's Visualize feature — the Go
counterpart to python_tracer.py, producing the exact same JSON contract
({steps, finalOutput, truncated, error}).

Go ships no in-process tracing hook of its own, so this needs a real
debugger the same way C/C++/Rust do — but unlike lldb (driven as a
subprocess and its TEXT output parsed, see c_tracer.py/rust_tracer.py's
own module comments), Go's own debugger (delve, "dlv") exposes a real
JSON-RPC API over a plain TCP socket: newline-delimited JSON requests in,
newline-delimited JSON responses out (verified empirically — no HTTP
framing, no length-prefixing, just one JSON object per line). Structured
responses (delve's own Variable type: Kind/Value/Children fields) mean
this is closer in spirit to Java's JDI (see JdiTracer.java) than to the
lldb-based tracers' text scraping.

delve isn't installed by default in every environment this might run in —
this module assumes it's already on PATH as `dlv` (installed via
`go install github.com/go-delve/delve/cmd/dlv@latest`).

Usage: python3 go_tracer.py <path-to-student-source.go>
"""
import sys
import os
import re
import json
import socket
import subprocess
import time
import itertools

MAX_STEPS = 400
MAX_LOCALS = 25
MAX_HEAP_OBJECTS = 14
MAX_COLLECTION_ITEMS = 8
MAX_VALUE_LEN = 60


def fail(message):
    sys.stdout.write(json.dumps({'error': message}))


def truncate_str(s):
    return s if len(s) <= MAX_VALUE_LEN else s[:MAX_VALUE_LEN] + '…'


class DlvClient:
    """Minimal JSON-RPC client for delve's headless API server — request/
    response pairs over a raw socket, one JSON object per line each way.
    Not a general JSON-RPC library: delve's own protocol is simple enough
    (no batching, no notifications) that a full one would be overkill."""

    def __init__(self, port):
        self.sock = socket.create_connection(('127.0.0.1', port), timeout=15)
        self.buf = b''
        self._id = itertools.count(1)

    def call(self, method, params=None):
        req_id = next(self._id)
        req = {'method': method, 'params': [params] if params is not None else [{}], 'id': req_id}
        self.sock.sendall((json.dumps(req) + '\n').encode('utf-8'))
        while b'\n' not in self.buf:
            chunk = self.sock.recv(1 << 20)
            if not chunk:
                raise ConnectionError('delve closed the connection')
            self.buf += chunk
        line, self.buf = self.buf.split(b'\n', 1)
        res = json.loads(line)
        if res.get('error'):
            raise RuntimeError(str(res['error']))
        return res.get('result')

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


# delve's Variable.Kind is a Go reflect.Kind — a plain uint enum, NOT a
# string — serialized as a bare integer in the JSON response (reflect.Kind
# has a String() method for fmt.Stringer but no MarshalJSON, so encoding/json
# falls back to its underlying uint representation). Values below are
# reflect.Kind's own iota ordering (stable across Go versions — part of the
# public API), confirmed via `go doc -all reflect.Kind`.
KIND_INVALID = 0
KIND_BOOL = 1
KIND_INT, KIND_INT8, KIND_INT16, KIND_INT32, KIND_INT64 = 2, 3, 4, 5, 6
KIND_UINT, KIND_UINT8, KIND_UINT16, KIND_UINT32, KIND_UINT64, KIND_UINTPTR = 7, 8, 9, 10, 11, 12
KIND_FLOAT32, KIND_FLOAT64 = 13, 14
KIND_COMPLEX64, KIND_COMPLEX128 = 15, 16
KIND_ARRAY = 17
KIND_CHAN = 18
KIND_FUNC = 19
KIND_INTERFACE = 20
KIND_MAP = 21
KIND_PTR = 22
KIND_SLICE = 23
KIND_STRING = 24
KIND_STRUCT = 25
KIND_UNSAFE_POINTER = 26

_next_heap_id = [1]


def box(entry, heap):
    hid = str(_next_heap_id[0])
    _next_heap_id[0] += 1
    heap[hid] = entry
    return {'__ref__': hid}


# delve identifies a value's underlying memory by its Addr field (0 for
# non-addressable values, e.g. a computed expression result — never
# reused as a dedup key in that case, matching how a value with no real
# storage location can't meaningfully alias anything). The Go analogue of
# every other tracer's own identity primitive (Python's id(), Java's
# ObjectReference.uniqueID(), ...).
def describe(var, heap, visiting):
    if var is None:
        return None
    kind = var.get('kind', '')
    value = var.get('value', '')
    # `addr` is the address of the variable's OWN storage (e.g. a slice
    # header's stack slot) — two aliased slices (`alias := nums`) have
    # DIFFERENT addrs despite sharing the same backing array, since each
    # is its own local variable. `base` is the backing-array/struct
    # address (doc comment on api.Variable.Base: "Base address of arrays,
    # Base address of the backing array for slices ... address of the
    # struct backing chan and map variables") — the correct identity key
    # for reference-like kinds; `addr` remains correct for Struct (a
    # value type — no separate backing storage, its own address IS its
    # identity, and using it here just means two distinct struct
    # variables never falsely alias).
    addr = var.get('addr', 0)
    base = var.get('base', 0)
    children = var.get('children') or []

    if kind == KIND_BOOL:
        return value == 'true'
    if kind in (KIND_INT, KIND_INT8, KIND_INT16, KIND_INT32, KIND_INT64,
                KIND_UINT, KIND_UINT8, KIND_UINT16, KIND_UINT32, KIND_UINT64, KIND_UINTPTR):
        try:
            return int(value)
        except ValueError:
            return truncate_str(value)
    if kind in (KIND_FLOAT32, KIND_FLOAT64):
        try:
            return float(value)
        except ValueError:
            return truncate_str(value)
    if kind == KIND_STRING:
        return truncate_str(value)
    if kind in (KIND_COMPLEX64, KIND_COMPLEX128):
        return truncate_str(value)

    if kind in (KIND_SLICE, KIND_ARRAY):
        if base and base in heap.get('_addrmap', {}):
            return box_ref(heap, base)
        if base and base in visiting:
            return {'__ref__': str(visiting[base])}
        if len([k for k in heap if k != '_addrmap']) >= MAX_HEAP_OBJECTS:
            return '<%s>' % var.get('type', 'slice')
        items = []
        more = max(0, int(var.get('len', len(children))) - MAX_COLLECTION_ITEMS)
        for child in children[:MAX_COLLECTION_ITEMS]:
            items.append(describe(child, heap, visiting))
        entry = {'type': 'list', 'items': items, 'more': more}
        return commit(heap, base, entry)

    if kind == KIND_MAP:
        if base and base in heap.get('_addrmap', {}):
            return box_ref(heap, base)
        if len([k for k in heap if k != '_addrmap']) >= MAX_HEAP_OBJECTS:
            return '<map>'
        items = []
        # delve represents a map's entries as a FLAT children list,
        # alternating key,value,key,value,... — verified empirically
        # against ListLocalVars/EvalVariable output for a map-typed var.
        pairs = list(zip(children[0::2], children[1::2]))
        more = max(0, len(pairs) - MAX_COLLECTION_ITEMS)
        for k, v in pairs[:MAX_COLLECTION_ITEMS]:
            key_desc = describe(k, heap, visiting)
            if isinstance(key_desc, dict):
                key_desc = k.get('value', '<key>')
            items.append([key_desc, describe(v, heap, visiting)])
        entry = {'type': 'dict', 'items': items, 'more': more}
        return commit(heap, base, entry)

    if kind == KIND_STRUCT:
        if addr and addr in heap.get('_addrmap', {}):
            return box_ref(heap, addr)
        if len([k for k in heap if k != '_addrmap']) >= MAX_HEAP_OBJECTS:
            return '<%s>' % var.get('type', 'struct')
        items = []
        more = max(0, len(children) - MAX_COLLECTION_ITEMS)
        for child in children[:MAX_COLLECTION_ITEMS]:
            items.append([child.get('name', '?'), describe(child, heap, visiting)])
        entry = {'type': 'dict', 'items': items, 'more': more}
        return commit(heap, addr, entry)

    if kind == KIND_PTR:
        if not children:
            return '<nil>'
        # A pointer's own "identity" for aliasing purposes is really the
        # POINTEE's address, not the pointer variable's own (ephemeral,
        # stack-slot) address — dereferences transparently rather than
        # boxing the pointer itself as a distinct object.
        return describe(children[0], heap, visiting)

    if kind == KIND_FUNC:
        return '<func>'
    if kind == KIND_CHAN:
        return '<chan>'
    if kind == KIND_INTERFACE:
        return describe(children[0], heap, visiting) if children else None
    if kind == KIND_UNSAFE_POINTER:
        return '<unsafe.Pointer>'
    return truncate_str(value) if value else ('<%s>' % (var.get('type') or 'value'))


def box_ref(heap, addr):
    hid = heap['_addrmap'][addr]
    return {'__ref__': hid}


def commit(heap, addr, entry):
    hid = str(_next_heap_id[0])
    _next_heap_id[0] += 1
    if addr:
        heap.setdefault('_addrmap', {})[addr] = hid
    heap[hid] = entry
    return {'__ref__': hid}


def find_free_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


def main():
    if len(sys.argv) < 2:
        fail('No source file provided to tracer.')
        return
    student_path = sys.argv[1]
    work_dir = os.path.dirname(student_path) or '.'

    try:
        with open(student_path) as f:
            source = f.read()
    except OSError as e:
        fail(f'Could not read source: {e}')
        return

    binary_path = os.path.join(work_dir, 'traced_program')
    # -gcflags="all=-N -l" disables optimizations/inlining — same flags
    # `dlv debug` itself always applies internally; building explicitly
    # (rather than letting a bare `dlv exec` compile it) means a real
    # compile ERROR surfaces as this tracer's own clean "Compile error:"
    # message instead of an opaque delve-side launch failure.
    compile_res = subprocess.run(
        ['go', 'build', '-gcflags=all=-N -l', '-o', binary_path, student_path],
        capture_output=True, text=True, cwd=work_dir,
    )
    if compile_res.returncode != 0:
        # `go build`'s stderr always leads with a "# <package>" header
        # line (e.g. "# command-line-arguments") before the real
        # diagnostics — skip it so the surfaced message is the actual
        # compile error, not that header.
        first_error = next(
            (ln for ln in compile_res.stderr.splitlines() if ln.strip() and not ln.startswith('#')),
            None,
        )
        fail(f'Compile error: {first_error or "compilation failed"}')
        return

    # -r stdout:<file> redirects the DEBUGGEE's own stdout to a dedicated
    # file, separate from dlv's own diagnostic messages ("API server
    # listening at: ...", etc) on its normal stdout — without this, both
    # would land in the same stream with no way to tell them apart. Same
    # pattern c_tracer.py/rust_tracer.py use lldb's own target.output-path
    # setting for, and the same reason: a per-step "what's printed so far"
    # snapshot needs the student's OWN output in complete isolation.
    stdout_path = os.path.join(work_dir, 'program_stdout.txt')
    open(stdout_path, 'w').close()

    def current_stdout():
        try:
            with open(stdout_path) as f:
                return f.read()
        except OSError:
            return ''

    port = find_free_port()
    # stdin=DEVNULL matters, not just tidiness: dlv's own stdin here would
    # otherwise be inherited from THIS process, which (when launched
    # through the backend's runLimited/child_process.spawn, unlike a
    # plain interactive shell) is an anonymous pipe — on macOS, delve's
    # debugserver stub fails outright against that ("could not launch
    # process: stub exited while waiting for connection: exit status 0"),
    # confirmed empirically: identical otherwise, only the stdin fd type
    # differs between a passing and failing run. Nothing here needs to
    # forward stdin to dlv anyway — the debuggee is driven entirely over
    # the RPC socket, never through inherited stdio.
    dlv_proc = subprocess.Popen(
        ['dlv', 'exec', binary_path, '--headless', f'--listen=127.0.0.1:{port}', '--api-version=2',
         '--accept-multiclient', '-r', f'stdout:{stdout_path}'],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )

    client = None
    try:
        # dlv's headless server takes a moment to bind its listening
        # socket — polling a short connect-retry loop is more robust
        # than a single fixed sleep, and bounded so a genuinely failed
        # launch doesn't hang this tracer indefinitely.
        for _ in range(50):
            try:
                client = DlvClient(port)
                break
            except (ConnectionRefusedError, OSError):
                time.sleep(0.1)
        if client is None:
            # dlv_proc's stdout is a live PIPE — read() would block forever
            # on a still-running-but-stuck process, so kill it first, THEN
            # read (guaranteed to hit EOF immediately once the process is
            # dead) to safely surface whatever diagnostic it printed.
            try:
                dlv_proc.kill()
            except Exception:
                pass
            leftover = ''
            try:
                leftover, _ = dlv_proc.communicate(timeout=3)
            except Exception:
                pass
            detail = (leftover or '').strip().splitlines()[-1] if (leftover or '').strip() else ''
            fail('Failed to start under the debugger (dlv did not start in time).' + (f' [{detail}]' if detail else ''))
            return

        bp = client.call('RPCServer.CreateBreakpoint', {'Breakpoint': {'functionName': 'main.main'}})

        steps = []
        truncated = False
        top_error = None

        def record(state, event):
            nonlocal truncated
            if truncated or len(steps) >= MAX_STEPS:
                truncated = True
                return
            thread = state.get('currentThread') or {}
            loc_file = thread.get('file', '')
            if os.path.basename(loc_file) != os.path.basename(student_path):
                return  # not in student code — nothing to record

            line = thread.get('line', 0)
            goroutine_id = thread.get('goroutineID')
            try:
                stack_res = client.call('RPCServer.Stacktrace', {
                    'Id': goroutine_id, 'Depth': 50, 'Full': False,
                })
                frames = stack_res.get('Locations') or []
            except Exception:
                frames = []
            stack = []
            for f in reversed(frames):
                fn = (f.get('function') or {}).get('name', '')
                if fn.startswith('main.'):
                    stack.append(fn[len('main.'):])
            if not stack:
                stack = ['main']

            heap = {}
            locals_out = {}
            try:
                vres = client.call('RPCServer.ListLocalVars', {
                    'Scope': {'GoroutineID': goroutine_id, 'Frame': 0},
                    'Cfg': {'FollowPointers': True, 'MaxVariableRecurse': 3, 'MaxStringLen': MAX_VALUE_LEN, 'MaxArrayValues': MAX_COLLECTION_ITEMS, 'MaxStructFields': -1},
                })
                ares = client.call('RPCServer.ListFunctionArgs', {
                    'Scope': {'GoroutineID': goroutine_id, 'Frame': 0},
                    'Cfg': {'FollowPointers': True, 'MaxVariableRecurse': 3, 'MaxStringLen': MAX_VALUE_LEN, 'MaxArrayValues': MAX_COLLECTION_ITEMS, 'MaxStructFields': -1},
                })
                all_vars = (ares.get('Args') or []) + (vres.get('Variables') or [])
                count = 0
                for v in all_vars:
                    if count >= MAX_LOCALS:
                        break
                    name = v.get('name')
                    if not name or name.startswith('~'):
                        continue
                    locals_out[name] = describe(v, heap, {})
                    count += 1
            except Exception:
                pass
            heap.pop('_addrmap', None)

            step = {
                'line': line,
                'event': event,
                'func': stack[-1] if stack else 'main',
                'stack': stack,
                'locals': locals_out,
                'heap': heap,
                'stdout': current_stdout(),
            }
            steps.append(step)

        # Continue/Next/Step are NOT separate top-level RPC methods —
        # verified empirically ("unknown method: RPCServer.Continue") and
        # confirmed against delve's own source (service/rpc2/client.go):
        # every one of them is RPCServer.Command with a lowercase `name`
        # field ("continue"/"step"/...), wrapped in a {"State": {...}}
        # result.
        def run_command(name):
            res = client.call('RPCServer.Command', {'name': name})
            return (res or {}).get('State') or {}

        def panic_info(state):
            # DebuggerState.Err is explicitly excluded from JSON
            # (`json:"-"` in delve's own source) — a panic can NOT be
            # detected by an error field on the state the way it can be
            # inspected client-side in delve's own Go API; instead delve
            # installs an internal breakpoint with a special Name the
            # instant a panic starts unwinding, verified against delve's
            # own debugger.go source (proc.UnrecoveredPanic /
            # proc.FatalThrow, string constants "unrecovered-panic" /
            # "runtime-fatal-throw" respectively).
            thread = state.get('currentThread') or {}
            bp_name = ((thread.get('breakPoint') or {}).get('name')) or ''
            if bp_name in ('unrecovered-panic', 'runtime-fatal-throw'):
                return 'panic (unrecovered)' if bp_name == 'unrecovered-panic' else 'fatal error'
            return None

        # Continue to the initial breakpoint.
        state = run_command('continue')
        record(state, 'call')

        client.call('RPCServer.ClearBreakpoint', {'Id': bp['Breakpoint']['id']})

        def in_student_file(state):
            thread = state.get('currentThread') or {}
            return os.path.basename(thread.get('file', '')) == os.path.basename(student_path)

        def attribute_panic(state, panic):
            # A runtime panic's own trap PC (divide-by-zero, nil deref,
            # index out of range, ...) unwinds through the Go runtime
            # (runtime.sigpanic/panicdivide/...) — essentially never
            # student code itself, unlike a `panic("msg")` call written
            # directly in student code, which DOES land there. Either
            # way, attribute the error to the last student-code line we
            # actually observed (steps is only ever appended to from
            # student code, by construction) — that's the line a user
            # visualizing line-by-line expects highlighted as the crash.
            thread = state.get('currentThread') or {}
            loc_file = thread.get('file', '')
            if os.path.basename(loc_file) == os.path.basename(student_path) and len(steps) < MAX_STEPS:
                record(state, 'exception')
            if steps:
                steps[-1]['event'] = 'exception'
                steps[-1]['error'] = panic

        while len(steps) < MAX_STEPS:
            try:
                state = run_command('step')
            except Exception:
                break
            if state.get('exited'):
                break
            panic = panic_info(state)
            if panic:
                attribute_panic(state, panic)
                top_error = panic
                break

            # 'step' steps INTO every call, including library/runtime code
            # (fmt.Println, etc) that has full debug info — with no
            # concept of "skip non-student packages" the way JDI's
            # class-exclusion filters give Java (see JdiTracer.java).
            # Single-stepping line-by-line through an entire library call
            # (which can be thousands of internal steps deep) would both
            # blow past MAX_STEPS on library noise and be extremely slow.
            # Escaping via repeated stepOut (return to caller) instead of
            # single-stepping is the same "skip past library code, don't
            # single-step through it" idea C/Rust's tracers apply via
            # their own in_student_code flag.
            escape_guard = 0
            exited = False
            while not in_student_file(state) and escape_guard < 50:
                escape_guard += 1
                try:
                    state = run_command('stepOut')
                except Exception:
                    exited = True
                    break
                if state.get('exited'):
                    exited = True
                    break
                panic = panic_info(state)
                if panic:
                    break
            if exited or state.get('exited'):
                break
            if panic:
                attribute_panic(state, panic)
                top_error = panic
                break
            record(state, 'line')

        if len(steps) >= MAX_STEPS:
            truncated = True

    except Exception as e:
        fail(f'Tracer failure: {e}')
        try:
            dlv_proc.kill()
        except Exception:
            pass
        try:
            os.remove(binary_path)
        except OSError:
            pass
        return
    finally:
        if client:
            try:
                client.call('RPCServer.Detach', {'Kill': True})
            except Exception:
                pass
            client.close()

    try:
        dlv_proc.wait(timeout=5)
    except Exception:
        try:
            dlv_proc.kill()
        except Exception:
            pass

    try:
        os.remove(binary_path)
    except OSError:
        pass

    result = {
        'steps': steps,
        'finalOutput': current_stdout(),
        'truncated': truncated,
        'error': top_error,
    }
    sys.stdout.write(json.dumps(result))


if __name__ == '__main__':
    main()
