"""Line-by-line execution tracer for the IDE's Visualize feature — the Rust
counterpart to python_tracer.py/c_tracer.py, producing the exact same JSON
contract ({steps, finalOutput, truncated, error}). Same batch-lldb-script
architecture as c_tracer.py (see its own module docstring for why: an
interactive one-command-at-a-time session was tried first and abandoned as
unreliable) — this module only documents what's actually DIFFERENT for Rust.

Three Rust-specific things found and worked around, all verified
empirically:
  - Breaking on `--name main` lands on the C ABI entry point wrapping
    Rust's own runtime startup, not the student's `fn main()` — same root
    cause as C's own declaration-line quirk (see below), just one level
    removed. Fixed by finding `fn main(` in the source directly and
    breaking by file+line instead, which sidesteps name-mangling (Rust
    mangles `fn main()` into `<crate>::main::<hash>`) entirely.
  - A breakpoint set exactly ON a `fn foo(...) {` declaration line
    resolves to the first statement INSIDE that function, not the
    function itself starting — meaning breaking at "line 1" of a file
    whose first few lines are `fn add(...) {...}` (defined before main)
    lands inside add() and only fires once add() is later CALLED, never
    at the true top of the program. This is why the breakpoint always
    targets `fn main(`'s own line specifically, not "line 1" blindly.
  - `step` dives into Rust's OWN std library internals (println!'s
    formatting/flush machinery, etc.) — unlike a plain libc call, these
    genuinely have debug info of their own (rustup ships std built with
    it), so step-in/out-avoid-nodebug doesn't exclude them. Excluded via
    target.process.thread.step-avoid-regexp instead, matching on the
    std::/core::/alloc:: namespace prefixes.
  - Unlike C, no stdout-buffering workaround was needed at all — verified
    empirically that Rust's Stdout flushes per newline by default even
    when redirected to a file, not just to a real terminal.

One more real difference: this uses `rust-lldb`, NOT plain `lldb` — a thin
wrapper (shipped by rustup) that loads Rust-aware pretty-printers for
String/Vec/Option/etc. Verified empirically that plain lldb shows these as
raw, unreadable internal buffer/capacity/discriminant structures; rust-lldb
renders them as `"text"`, `size=N { ... }`, `Some(42)` the way a student
would actually expect. Its own output shape differs from a C struct's in
one structural way that matters for parsing: Rust struct AND array values
BOTH use parens — `(x = 1, y = 2)` for a struct, `([0] = 1, [1] = 2)` for
an array — told apart here only by whether every entry looks like `[N] = `.

Usage: python3 rust_tracer.py <path-to-student-source.rs>
"""
import sys
import os
import re
import json
import subprocess

MAX_STEPS = 400
MAX_LOCALS = 25
MAX_VALUE_LEN = 60
MAX_COLLECTION_ITEMS = 8


def fail(message):
    sys.stdout.write(json.dumps({'error': message}))


def truncate_str(s):
    return s if len(s) <= MAX_VALUE_LEN else s[:MAX_VALUE_LEN] + '…'


FRAME_RE = re.compile(r'frame #0:.*? at ([^:]+):(\d+):(\d+)')
# The student's source is always written out as main.rs (see TRACE_CONFIG
# in backend/index.js), so rustc — with no --crate-name override — always
# infers the crate name "main" from it; every one of the student's own
# functions is therefore mangled as main::<path>::<name>::h<hash>. That's
# what makes filtering possible at all: a raw backtrace also includes
# Rust's OWN runtime bootstrap (std::rt::lang_start_internal,
# core::ops::function::..., std::panicking::catch_unwind, a
# do_call/catch_unwind pair per frame, ...) wrapping the student's real
# main() — verified empirically these leak straight into `thread
# backtrace` with no separate marker distinguishing them, so requiring the
# main:: prefix is the only reliable way to keep the displayed stack to
# just the student's own calls.
FUNC_RE = re.compile(r'frame #0:.*? \S+`main((?:::[A-Za-z_][A-Za-z0-9_]*)*)::h[0-9a-f]+(?:\(|\s+at\s)')
BT_FRAME_RE = re.compile(r'frame #\d+: \S+ \S+`main((?:::[A-Za-z_][A-Za-z0-9_]*)*)::h[0-9a-f]+(?:\(|\s+at\s)')
EXIT_RE = re.compile(r'exited with status = (\d+)')
SIGNAL_RE = re.compile(r'stop reason = (EXC_BAD_ACCESS[^\n]*|signal \w+|EXC_[A-Z_]+[^\n]*)')
# "panicked at " is followed by the file:line:col location — everything up
# to that line's own trailing ':\n' — then the actual message, up to the
# "note: run with RUST_BACKTRACE=..." line every panic ends with. NOT
# anchored on "thread '...' panicked" specifically: verified empirically
# the real format also has a "(PID)" segment in between
# (`thread 'main' (568185) panicked at ...`) that a stricter pattern
# missed entirely, silently falling through to showing the whole raw
# multi-line stderr blob as the error instead of just its message.
PANIC_RE = re.compile(r"panicked at [^\n]*:\s*\n(.*?)\nnote:", re.DOTALL)


class ValueParser:
    """Same bracket-aware scanner as c_tracer.py's own ValueParser — see
    there for why a naive per-line split doesn't work for a multi-line
    struct value."""

    def __init__(self, text):
        self.text = text
        self.i = 0
        self.n = len(text)

    def parse_all(self):
        results = []
        while self.i < self.n:
            self._skip_ws()
            if self.i >= self.n:
                break
            entry = self._parse_one()
            if entry:
                results.append(entry)
            else:
                break
        return results

    def _skip_ws(self):
        while self.i < self.n and self.text[self.i] in ' \t\r\n':
            self.i += 1

    def _parse_one(self):
        if self.text[self.i:self.i + 1] != '(':
            self.i = self.n
            return None
        depth = 0
        start = self.i
        while self.i < self.n:
            if self.text[self.i] == '(':
                depth += 1
            elif self.text[self.i] == ')':
                depth -= 1
                if depth == 0:
                    self.i += 1
                    break
            self.i += 1
        type_text = self.text[start + 1:self.i - 1]
        self._skip_ws()
        name_start = self.i
        while self.i < self.n and self.text[self.i] != '=':
            self.i += 1
        if self.i >= self.n:
            return None
        name = self.text[name_start:self.i].strip()
        self.i += 1
        self._skip_ws()
        value_text = self._consume_value()
        return (name, type_text, value_text)

    def _consume_value(self):
        self._skip_ws()
        # A String/Vec/Option/struct value is a short PREFIX (a quoted
        # string, `size=N`, `Some(...)`, or nothing at all) followed by its
        # own `{ ... }` block — captured TOGETHER (not discarded) since
        # which part is the actually-meaningful one differs by type: a
        # Vec's real data lives INSIDE the braces (`size=3 { [0] = 10 }`),
        # a String's doesn't (`"hello" { [0] = 'h', ... }` — the quoted
        # prefix alone is already the whole value), and a bare struct has
        # no prefix at all, just `{ x = 1\ny = 2 }`. Keeping the full text
        # here and letting describe_value/describe_scalar_or_recurse sort
        # out which shape they're looking at was tried the other way first
        # (discarding the brace block unconditionally) and empirically
        # broke Vec entirely — its one and only data was in the part being
        # thrown away.
        prefix_start = self.i
        while self.i < self.n and self.text[self.i] not in '({\n':
            self.i += 1
        prefix = self.text[prefix_start:self.i]
        if self.i < self.n and self.text[self.i] == '{':
            depth = 0
            start = self.i
            while self.i < self.n:
                if self.text[self.i] == '{':
                    depth += 1
                elif self.text[self.i] == '}':
                    depth -= 1
                    if depth == 0:
                        self.i += 1
                        break
                self.i += 1
            return (prefix + self.text[start:self.i]).strip()
        if self.i < self.n and self.text[self.i] == '(':
            depth = 0
            start = self.i
            while self.i < self.n:
                if self.text[self.i] == '(':
                    depth += 1
                elif self.text[self.i] == ')':
                    depth -= 1
                    if depth == 0:
                        self.i += 1
                        break
                self.i += 1
            return (prefix + self.text[start:self.i]).strip()
        start = self.i
        while self.i < self.n and self.text[self.i] != '\n':
            self.i += 1
        return (prefix + self.text[start:self.i]).strip()


_next_heap_id = [1]


def box(entry, heap):
    hid = str(_next_heap_id[0])
    _next_heap_id[0] += 1
    heap[hid] = entry
    return {'__ref__': hid}


def split_top_level(s, sep):
    parts = []
    depth = 0
    start = 0
    for i, ch in enumerate(s):
        if ch in '({[':
            depth += 1
        elif ch in ')}]':
            depth -= 1
        elif ch == sep and depth == 0:
            parts.append(s[start:i])
            start = i + 1
    parts.append(s[start:])
    return parts


def describe_scalar(type_text, value_text):
    if type_text in ('i8', 'i16', 'i32', 'i64', 'i128', 'isize',
                      'u8', 'u16', 'u32', 'u64', 'u128', 'usize', 'int', 'unsigned int'):
        try:
            return int(value_text)
        except ValueError:
            return truncate_str(value_text)
    if type_text in ('f32', 'f64', 'float', 'double'):
        try:
            return float(value_text)
        except ValueError:
            return truncate_str(value_text)
    if type_text == 'bool':
        return value_text.strip() == 'true'
    if type_text == 'char':
        m = re.match(r"'(.*)'", value_text)
        return m.group(1) if m else truncate_str(value_text)
    return truncate_str(value_text)


def finalize_entries(parsed, heap):
    """Shared by every container shape below — a Rust struct, a fixed-size
    array, and a Vec's own inner item list all boil down to the same
    (key, value) pairs once split apart, differing only in whether they
    were comma- or newline-separated to begin with (see the two
    `describe_*` callers) and whether every key looks like an array index
    (`[0]`, `[1]`, ...), which is the only signal available to tell an
    array/Vec apart from a struct at all — both a struct and an array
    render through the exact same `key = value` syntax."""
    is_list = bool(parsed) and all(k and k.startswith('[') for k, _ in parsed)
    items, more = [], 0
    for idx, (key, val) in enumerate(parsed):
        if idx >= MAX_COLLECTION_ITEMS:
            more += 1
            continue
        described = describe_scalar_or_recurse(val, heap)
        items.append(described if is_list else [key or f'field{idx}', described])
    return box({'type': 'list' if is_list else 'dict', 'items': items, 'more': more}, heap)


def describe_entries(value_text, heap):
    """A parenthesized `(a = 1, b = 2)` value, comma-separated — either a
    Rust struct (field names) or a fixed-size array (`[0] = `, `[1] = `,
    ...); see finalize_entries for how those are actually told apart."""
    inner = value_text[1:-1]
    raw_entries = split_top_level(inner, ',')
    parsed = []
    for e in raw_entries:
        e = e.strip()
        if not e:
            continue
        m = re.match(r'^(\[\d+\]|[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$', e, re.DOTALL)
        if m:
            parsed.append((m.group(1), m.group(2).strip()))
        else:
            parsed.append((None, e))
    return finalize_entries(parsed, heap)


def split_struct_fields(s):
    """`  x = 10\n  y = 20\n  ` -> [('x','10'), ('y','20')] — a struct
    shown as a brace block (verified empirically: SOME struct values
    render with braces and newline-separated fields, others with the
    parens format describe_entries above handles — both are real,
    depending on context, not a typo either way) separates fields with a
    newline, not a comma, and a nested field's own value can itself span
    multiple lines, so this walks bracket depth rather than a naive
    splitlines()."""
    fields = []
    i, n = 0, len(s)
    while i < n:
        while i < n and s[i] in ' \t\r\n':
            i += 1
        if i >= n:
            break
        name_start = i
        while i < n and s[i] not in '=\n':
            i += 1
        if i >= n or s[i] == '\n':
            break
        name = s[name_start:i].strip()
        i += 1
        while i < n and s[i] in ' \t':
            i += 1
        val_start = i
        if i < n and s[i] in '({':
            open_c = s[i]
            close_c = ')' if open_c == '(' else '}'
            depth = 0
            while i < n:
                if s[i] == open_c:
                    depth += 1
                elif s[i] == close_c:
                    depth -= 1
                    if depth == 0:
                        i += 1
                        break
                i += 1
        else:
            while i < n and s[i] != '\n':
                i += 1
        fields.append((name, s[val_start:i].strip()))
    return fields


def describe_brace_struct(value_text, heap):
    """A brace block, newline-separated — verified empirically THREE
    different shapes actually render this way, not just a struct: a plain
    struct (`{ x = 1\ny = 2 }`), a fixed-size array (yes, sometimes braces
    instead of the parens describe_entries handles — array formatting
    isn't consistent across contexts), and a Vec's own inner item list
    once its `size=N` prefix has been stripped off by the caller. All
    three are `key = value` pairs, newline- not comma-separated (a Vec's
    `[0] = 10` entries were first assumed comma-separated like an array's
    parens form and that was wrong — verified empirically it collapsed a
    3-element Vec into one mangled multi-line entry), so this is just
    split_struct_fields feeding the same is-every-key-an-index? check
    describe_entries uses for its own comma-separated case."""
    inner = value_text[1:-1]
    fields = split_struct_fields(inner)
    return finalize_entries(fields, heap)


def describe_scalar_or_recurse(value_text, heap):
    value_text = value_text.strip()
    if re.match(r'^"', value_text):
        m = re.match(r'^"((?:[^"\\]|\\.)*)"', value_text)
        return truncate_str(m.group(1)) if m else '<str>'
    if re.match(r'^(Some|None|Ok|Err)\b', value_text):
        brace_pos = value_text.find('{')
        prefix = value_text[:brace_pos] if brace_pos != -1 else value_text
        return truncate_str(prefix.strip())
    if value_text.startswith('(') and value_text.endswith(')'):
        return describe_entries(value_text, heap)
    if value_text.startswith('size='):
        m = re.search(r'(\{.*\})\s*$', value_text, re.DOTALL)
        if m:
            return describe_brace_struct(m.group(1), heap)
        return '<Vec>'
    if value_text.startswith('{') and value_text.endswith('}'):
        return describe_brace_struct(value_text, heap)
    if value_text.startswith('{') and value_text.endswith('}'):
        return describe_brace_struct(value_text, heap)
    try:
        return int(value_text)
    except ValueError:
        pass
    try:
        return float(value_text)
    except ValueError:
        pass
    return truncate_str(value_text)


def describe_value(type_text, value_text, heap):
    type_text = type_text.strip()
    value_text = value_text.strip()

    # String — the pretty-printed form is `"text"` (its own internal
    # buf/cap detail block was already stripped off by ValueParser's own
    # _consume_value). Treated as a plain inline value, not a heap box:
    # unlike a container, tracking a String's true aliasing would need
    # the same raw-pointer identity work this tracer deliberately skips
    # for C's pointers too — out of scope, same reasoning.
    if re.match(r'^"', value_text):
        m = re.match(r'^"((?:[^"\\]|\\.)*)"', value_text)
        return truncate_str(m.group(1)) if m else '<String>'

    # Option/Result — shown as `Some(42) { 0 = 42 }` / `None { ... }` /
    # `Ok(x) { ... }` / `Err(e) { ... }`, that trailing `{ ... }` being the
    # same kind of messy internal enum-discriminant detail String's own
    # trailing block is (see above) — only the `Some(42)`/`None`/etc part
    # before it is kept, as a single plain string rather than decomposed
    # further: a clean, immediately-readable value a student would
    # recognize, instead of unpacking $variants$/$discr$ internals.
    if re.match(r'^(Some|None|Ok|Err)\b', value_text):
        brace_pos = value_text.find('{')
        prefix = value_text[:brace_pos] if brace_pos != -1 else value_text
        return truncate_str(prefix.strip())

    if value_text.startswith('size='):
        m = re.search(r'(\{.*\})\s*$', value_text, re.DOTALL)
        if m:
            return describe_brace_struct(m.group(1), heap)
        return '<Vec>'

    if value_text.startswith('(') and value_text.endswith(')'):
        return describe_entries(value_text, heap)

    if value_text.startswith('{') and value_text.endswith('}'):
        return describe_brace_struct(value_text, heap)

    if type_text.endswith('*') or type_text.startswith('&'):
        return f'<{type_text}>'

    return describe_scalar(type_text, value_text)


def build_step(line, event, locals_text, backtrace_text, stdout_so_far, error=None):
    heap = {}
    locals_out = {}
    count = 0
    for (name, type_text, value_text) in ValueParser(locals_text).parse_all():
        if count >= MAX_LOCALS:
            break
        locals_out[name] = describe_value(type_text, value_text, heap)
        count += 1

    def display_name(rest):
        # rest is BT_FRAME_RE's own group(1): '' for the bare `main`
        # frame itself, or '::add' / '::helper::inner' etc for anything
        # nested under it — the student-facing name is always just the
        # LAST path segment, matching how every other tracer's own stack
        # only ever shows a bare function name, not its full module path.
        return rest.rsplit('::', 1)[-1] if rest else 'main'

    raw_stack = [display_name(m.group(1)) for m in BT_FRAME_RE.finditer(backtrace_text)]
    raw_stack.reverse()
    # Rust's own generic/closure monomorphization under std::rt::lang_start
    # produces several distinct main::... symbols that all demangle to the
    # same last-segment name (verified empirically: 4 consecutive "main"
    # entries for one single real call to main()) — collapsing consecutive
    # duplicates is a fair, low-risk fix regardless of the exact mechanism,
    # since a real recursive call to the same function would also
    # legitimately look identical here and this tracer has no way (nor any
    # real need) to tell that case apart from a bogus repeat.
    stack = [name for i, name in enumerate(raw_stack) if i == 0 or name != raw_stack[i - 1]]
    if not stack:
        m = FUNC_RE.search(backtrace_text) or FUNC_RE.search(locals_text)
        stack = [display_name(m.group(1))] if m else ['main']

    step = {
        'line': line,
        'event': event,
        'func': stack[-1] if stack else 'main',
        'stack': stack,
        'locals': locals_out,
        'heap': heap,
        'stdout': stdout_so_far,
    }
    if error:
        step['error'] = error
    return step


def find_main_line(source):
    for i, line in enumerate(source.split('\n'), start=1):
        if re.search(r'\bfn\s+main\s*\(', line):
            return i
    return None


def main():
    if len(sys.argv) < 2:
        fail('No source file provided to tracer.')
        return
    student_path = sys.argv[1]

    try:
        with open(student_path) as f:
            source = f.read()
    except OSError as e:
        fail(f'Could not read source: {e}')
        return

    main_line = find_main_line(source)
    if main_line is None:
        fail('Could not find a fn main() to start tracing from.')
        return

    work_dir = os.path.dirname(student_path)
    binary_path = os.path.join(work_dir, 'traced_program')

    compile_res = subprocess.run(
        # debug-assertions/overflow-checks off: verified empirically that
        # WITH them (rustc's normal debug-build default), a step landing
        # anywhere near a Vec/String allocation dives into compiler-
        # inserted precondition_check/UB-check helpers — INLINED, so
        # step-avoid-regexp (which only excludes actual call boundaries)
        # can't skip them, each still carrying its own DWARF line info
        # pointing at rustc's internal ub_checks.rs. Trades away overflow-
        # panic detection (integer overflow silently wraps instead, same
        # semantics as a real release build) for a tracer that doesn't
        # spend its whole step budget stuck inside library internals no
        # student asked to see.
        ['rustc', '-g', '-C', 'debug-assertions=off', '-C', 'overflow-checks=off', '-o', binary_path, student_path],
        capture_output=True, text=True,
    )
    if compile_res.returncode != 0:
        first_error = next((ln for ln in compile_res.stderr.splitlines() if ln.strip().startswith('error')), None)
        fail(f'Compile error: {first_error or "compilation failed"}')
        return

    stdout_path = os.path.join(work_dir, 'program_stdout.txt')
    open(stdout_path, 'w').close()
    # A Rust panic isn't a signal/mach-exception the way a C segfault is —
    # by default (panic=unwind) it just prints to STDERR, unwinds the
    # stack, and the process exits with a non-zero status like any other
    # graceful-looking exit; verified empirically that without this, the
    # panic message goes nowhere this tracer ever reads, and 'exited' was
    # being treated as success regardless of status code. stderr_path
    # recovers the actual message; a non-zero exit status (checked
    # separately below) is what flags that this exit wasn't a clean one.
    stderr_path = os.path.join(work_dir, 'program_stderr.txt')
    open(stderr_path, 'w').close()
    commands_path = os.path.join(work_dir, 'commands.txt')

    with open(commands_path, 'w') as f:
        f.write('settings set target.process.thread.step-in-avoid-nodebug true\n')
        f.write('settings set target.process.thread.step-out-avoid-nodebug true\n')
        f.write('settings set target.process.thread.step-avoid-regexp ^std::|^core::|^alloc::|^<std|^<core|^<alloc\n')
        f.write(f'settings set target.output-path {stdout_path}\n')
        f.write(f'settings set target.error-path {stderr_path}\n')
        f.write(f'breakpoint set --file main.rs --line {main_line}\n')
        f.write('run\n')
        # 3x MAX_STEPS, not MAX_STEPS: a real step-in-avoid-regexp miss
        # (String::from, Vec's allocator, ...) burns some of this budget
        # on iterations that get skipped rather than recorded (see
        # in_student_code below) — extra headroom means a program that
        # trips a few of these still ends up with a full MAX_STEPS-sized
        # trace instead of coming up short for reasons invisible to
        # whoever's reading the result.
        for _ in range(MAX_STEPS * 3):
            f.write('frame variable\n')
            f.write('thread backtrace\n')
            f.write('step\n')
        # Same known, deliberate limitation as c_tracer.py: no working way
        # found to let a truncated program run itself to completion inside
        # lldb's batch mode — see its own comment for the full reasoning.

    proc = subprocess.run(['rust-lldb', '-b', '-s', commands_path, binary_path], capture_output=True, text=True)
    transcript = proc.stdout

    raw_chunks = transcript.split('(lldb) ')
    tagged = []
    for chunk in raw_chunks[1:]:
        first_nl = chunk.find('\n')
        if first_nl == -1:
            continue
        echoed = chunk[:first_nl].strip()
        tagged.append((echoed, chunk[first_nl + 1:]))

    run_output = next((out for cmd, out in tagged if cmd == 'run'), '')
    step_sequence = [(cmd, out) for cmd, out in tagged if cmd in ('frame variable', 'thread backtrace', 'step')]

    def current_stdout():
        try:
            with open(stdout_path) as f:
                return f.read()
        except OSError:
            return ''

    def read_panic_message():
        # Called only once an 'exited' status is already known non-zero —
        # the panic message itself never appears in the lldb transcript
        # this tracer otherwise parses (see stderr_path's own comment
        # above for why), so this is a second, separate read.
        try:
            with open(stderr_path) as f:
                stderr_text = f.read()
        except OSError:
            return None
        m = PANIC_RE.search(stderr_text)
        return m.group(1).strip() if m else (stderr_text.strip() or None)

    def parse_position(text):
        m = SIGNAL_RE.search(text)
        if m:
            return ('signal', m.group(1))
        m = EXIT_RE.search(text)
        if m:
            return ('exited', int(m.group(1)))
        m = FRAME_RE.search(text)
        if m:
            file, line, _col = m.groups()
            if os.path.basename(file) != 'main.rs':
                return ('left-student-code', None)
            return ('stopped', int(line))
        return ('unknown', None)

    steps = []
    truncated = False
    top_error = None

    kind, payload = parse_position(run_output)
    if kind != 'stopped':
        fail('Failed to start under the debugger (could not stop at main).')
        for p in (binary_path, commands_path, stdout_path, stderr_path):
            try:
                os.remove(p)
            except OSError:
                pass
        return
    current_line = payload

    # in_student_code tracks whether the position BEFORE this iteration's
    # own upcoming `step` is actually inside main.rs — false while
    # temporarily off inside a std library call (String::from, Vec's
    # allocator, etc., all verified empirically to genuinely dip into
    # non-main.rs source with their own real debug info, then return).
    # C's own tracer treats "left the student's file" as equivalent to
    # "the program is done" — correct there, since its exit sequence
    # genuinely never returns to main.c — but wrong for Rust: only
    # panics/exit/an actual crash mean the trace is over; a step landing
    # in std library code is skipped (not recorded, not counted against
    # MAX_STEPS) rather than ending the trace, and stepping resumes
    # silently once back in main.rs.
    in_student_code = True
    i = 0
    while i + 2 < len(step_sequence) and len(steps) < MAX_STEPS:
        _, locals_chunk = step_sequence[i]
        _, backtrace_chunk = step_sequence[i + 1]
        _, step_chunk = step_sequence[i + 2]
        i += 3

        if in_student_code:
            steps.append(build_step(current_line, 'line', locals_chunk, backtrace_chunk, current_stdout()))

        kind, payload = parse_position(step_chunk)
        if kind == 'exited':
            # A non-zero status is this tracer's only signal that this
            # was a panic, not a clean return from main() — see
            # stderr_path's own comment for why the panic message can't
            # just be matched out of the lldb transcript the way a C
            # signal-crash's message can.
            if payload != 0:
                message = read_panic_message()
                top_error = f'Panic: {message}' if message else f'Process exited with status {payload}'
                if steps:
                    steps[-1]['event'] = 'exception'
                    steps[-1]['error'] = top_error
            break
        if kind == 'signal':
            top_error = f'Runtime error: {payload}'
            if steps:
                steps[-1]['event'] = 'exception'
                steps[-1]['error'] = top_error
            break
        if kind == 'left-student-code':
            in_student_code = False
            continue
        if kind == 'stopped':
            in_student_code = True
            current_line = payload
            continue
        break
    else:
        if len(steps) >= MAX_STEPS:
            truncated = True

    final_output = current_stdout()

    for p in (binary_path, commands_path, stdout_path, stderr_path):
        try:
            os.remove(p)
        except OSError:
            pass

    result = {
        'steps': steps,
        'finalOutput': final_output,
        'truncated': truncated,
        'error': top_error,
    }
    sys.stdout.write(json.dumps(result))


if __name__ == '__main__':
    main()
