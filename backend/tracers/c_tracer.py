"""Line-by-line execution tracer for the IDE's Visualize feature — the C/
C++ counterpart to python_tracer.py, producing the exact same JSON contract
({steps, finalOutput, truncated, error}).

Neither language has anything like sys.settrace — this is a genuinely
compiled, native target, so the only way to get line-by-line control is a
real debugger. gdb isn't installed in this environment; lldb is, but its
Python scripting bindings are broken here (a native-module ABI mismatch
between the system python3 and lldb's own bundled one, verified
empirically), so this drives the lldb CLI itself instead — as a single
BATCH script (`lldb -b -s commands.txt`), not an interactive session.

An interactive session (spawn lldb, write one command at a time to its
stdin, read until a sentinel) was tried first and abandoned: verified
empirically that `run`/`step`/`continue` behave asynchronously even when
piped — a queued follow-up command's own echo can appear in the output
BEFORE the target actually finishes stopping, permanently desyncing a
one-command-at-a-time protocol and hanging the whole tracer. A batch
script sidesteps this entirely: every command this tracer will ever need
(MAX_STEPS repetitions of `frame variable` / `thread backtrace` / `step`)
is written upfront and run as ONE lldb invocation; the full transcript is
then parsed afterward, stopping at the first sign the student's program
has exited, crashed, or left main.c (having run right off the end of
main() into the C runtime's own exit machinery, which is verified to
happen and has no debug info of its own worth stepping through) — whatever
batch commands were queued past that point just produce inert, discarded
output, never causing a hang.

Two lldb pitfalls found and worked around, both verified empirically:
  - `step-in-avoid-nodebug`/`step-out-avoid-nodebug` default such that
    stepping into a plain libc call (printf, with no debug info of its
    own) doesn't just skip over it — lldb falls into raw single-
    instruction stepping through dyld/libSystem internals instead. Both
    settings are forced true before running.
  - C's stdio is fully buffered once its output isn't a terminal (which a
    debugger-redirected file counts as), so printf's output wouldn't show
    up in a per-step stdout snapshot until the buffer happened to fill or
    the program exited. Fixed by prepending a GCC/Clang `constructor`
    attribute function that calls setvbuf(..., _IONBF, ...) before main()
    ever runs — no need to locate/rewrite main() itself for this.

Usage: python3 c_tracer.py <path-to-student-source>  (.c or .cpp — see main())
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


def wrap_source(source, is_cpp):
    # #line resets the compiler's own idea of "current file/line" back to
    # 1/main.c for everything after it, so every diagnostic AND every
    # breakpoint/frame location lldb reports afterward lines up exactly
    # with the student's own file — none of this wrapper's own lines ever
    # show up in a line number the student would see.
    setvbuf_header = '#include <cstdio>\n' if is_cpp else '#include <stdio.h>\n'
    ctor = (
        '__attribute__((constructor)) static void __unbuffer_stdio(void) {\n'
        '    setvbuf(stdout, 0, 2, 0);\n'
        '}\n'
    )
    return f'{setvbuf_header}{ctor}#line 1 "main.c"\n{source}'


FRAME_RE = re.compile(r'frame #0:.*? at ([^:]+):(\d+):(\d+)')
# A function called with no visible args (e.g. `main`, declared `void`)
# prints with no trailing "(...)" at all — just the bare name followed by
# " at FILE:LINE" — verified empirically against `frame #1: ... `main at
# test1.c:10:18`, which an earlier, paren-requiring version of this regex
# silently failed to match, dropping main from every stack this parsed.
FUNC_RE = re.compile(r'frame #0:.*? \S+`([A-Za-z_][A-Za-z0-9_:<>~]*)(?:\(|\s+at\s)')
BT_FRAME_RE = re.compile(r'frame #\d+: \S+ \S+`([A-Za-z_][A-Za-z0-9_:<>~]*)(?:\(|\s+at\s)')
EXIT_RE = re.compile(r'exited with status = (\d+)')
SIGNAL_RE = re.compile(r'stop reason = (EXC_BAD_ACCESS[^\n]*|signal \w+|EXC_[A-Z_]+[^\n]*)')


def truncate_str(s):
    return s if len(s) <= MAX_VALUE_LEN else s[:MAX_VALUE_LEN] + '…'


class ValueParser:
    """Parses one `frame variable` command's full text output into a list
    of (name, type, raw_value_text) triples. lldb's own format nests
    braces for structs (possibly across multiple lines) and parens for
    arrays (single line) — this walks it as a small bracket-aware scanner
    rather than a single regex, since a naive line-by-line split breaks on
    any multi-line struct value."""

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
        if self.i < self.n and self.text[self.i] in '({':
            open_c = self.text[self.i]
            close_c = ')' if open_c == '(' else '}'
            depth = 0
            start = self.i
            while self.i < self.n:
                if self.text[self.i] == open_c:
                    depth += 1
                elif self.text[self.i] == close_c:
                    depth -= 1
                    if depth == 0:
                        self.i += 1
                        break
                self.i += 1
            return self.text[start:self.i]
        start = self.i
        while self.i < self.n and self.text[self.i] != '\n':
            self.i += 1
        return self.text[start:self.i].strip()


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


def split_struct_fields(s):
    """`  x = 10\n  y = 20\n  ` -> [('x','10'), ('y','20')] — a struct's
    own field separator is a newline, not a comma (verified empirically),
    and nested struct/array field values can themselves span multiple
    lines, so this walks bracket depth rather than doing a naive
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


def describe_scalar(type_text, value_text):
    if type_text in ('int', 'short', 'long', 'long long', 'unsigned int', 'unsigned long',
                      'unsigned short', 'unsigned long long',
                      'size_t', 'ssize_t', 'int8_t', 'int16_t', 'int32_t', 'int64_t',
                      'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t'):
        try:
            return int(value_text.split("'")[0].strip())
        except ValueError:
            return truncate_str(value_text)
    if type_text in ('float', 'double'):
        try:
            return float(value_text)
        except ValueError:
            return truncate_str(value_text)
    if type_text in ('bool', '_Bool'):
        return value_text.strip() == 'true'
    if type_text == 'char':
        m = re.match(r"'(.*)'", value_text)
        return m.group(1) if m else truncate_str(value_text)
    return truncate_str(value_text)


def describe_scalar_or_recurse(value_text, heap):
    value_text = value_text.strip()
    if value_text.startswith('(') and re.match(r'^\(\s*\[0\]', value_text):
        return describe_value('', value_text, heap)
    if value_text.startswith('{'):
        return describe_value('', value_text, heap)
    if re.match(r'^0x[0-9a-fA-F]+\s*"', value_text):
        return describe_value('char *', value_text, heap)
    # Nested array/struct field values have no (type) prefix of their own
    # in lldb's own output (only the OUTER declaration gets one) — infer
    # int/float from shape alone rather than always falling through to a
    # quoted string, so e.g. an int[4]'s items come out as JSON numbers.
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

    if type_text in ('char *', 'const char *'):
        m = re.search(r'"((?:[^"\\]|\\.)*)"', value_text)
        return truncate_str(m.group(1)) if m else '<char *>'

    if type_text.endswith('*'):
        # Deliberately opaque — dereferencing arbitrary C pointers into a
        # heap graph (what __ref__ does for real container identity in
        # every other tracer here) would mean walking raw memory with no
        # type-safety net; out of scope, same as never chasing linked
        # structures through them.
        return f'<{type_text}>'

    if value_text.startswith('(') and re.match(r'^\(\s*\[0\]', value_text):
        inner = value_text[1:-1]
        items_raw = split_top_level(inner, ',')
        items, more = [], 0
        for idx, item in enumerate(items_raw):
            item = item.strip()
            m = re.match(r'^\[\d+\]\s*=\s*(.*)$', item, re.DOTALL)
            v = m.group(1) if m else item
            if idx >= MAX_COLLECTION_ITEMS:
                more += 1
                continue
            items.append(describe_scalar_or_recurse(v, heap))
        return box({'type': 'list', 'items': items, 'more': more}, heap)

    if value_text.startswith('{'):
        inner = value_text[1:-1]
        fields = split_struct_fields(inner)
        items, more = [], 0
        for idx, (fname, fval) in enumerate(fields):
            if idx >= MAX_COLLECTION_ITEMS:
                more += 1
                continue
            items.append([fname, describe_scalar_or_recurse(fval, heap)])
        return box({'type': 'dict', 'items': items, 'more': more}, heap)

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

    stack = [m.group(1) for m in BT_FRAME_RE.finditer(backtrace_text)]
    stack.reverse()
    if not stack:
        m = FUNC_RE.search(backtrace_text) or FUNC_RE.search(locals_text)
        stack = [m.group(1)] if m else ['main']

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


def main():
    if len(sys.argv) < 2:
        fail('No source file provided to tracer.')
        return
    student_path = sys.argv[1]
    # One tracer script serves both languages — TRACE_CONFIG in
    # backend/index.js writes the student's own source out as main.c for
    # the "c" entry and main.cpp for the "cpp" entry, so the extension
    # alone is enough to tell them apart without a second CLI argument.
    is_cpp = student_path.endswith('.cpp')

    try:
        with open(student_path) as f:
            source = f.read()
    except OSError as e:
        fail(f'Could not read source: {e}')
        return

    work_dir = os.path.dirname(student_path)
    wrapped_path = os.path.join(work_dir, 'wrapped.' + ('cpp' if is_cpp else 'c'))
    binary_path = os.path.join(work_dir, 'traced_program')
    with open(wrapped_path, 'w') as f:
        f.write(wrap_source(source, is_cpp))

    compiler = 'g++' if is_cpp else 'gcc'
    compile_res = subprocess.run(
        [compiler, '-g', '-O0', '-std=' + ('c++17' if is_cpp else 'c11'), wrapped_path, '-o', binary_path],
        capture_output=True, text=True,
    )
    if compile_res.returncode != 0:
        first_error = next((ln for ln in compile_res.stderr.splitlines() if 'error:' in ln), None)
        fail(f'Compile error: {first_error or "compilation failed"}')
        return

    stdout_path = os.path.join(work_dir, 'program_stdout.txt')
    open(stdout_path, 'w').close()
    commands_path = os.path.join(work_dir, 'commands.txt')

    with open(commands_path, 'w') as f:
        f.write('settings set target.process.thread.step-in-avoid-nodebug true\n')
        f.write('settings set target.process.thread.step-out-avoid-nodebug true\n')
        f.write(f'settings set target.output-path {stdout_path}\n')
        f.write('breakpoint set --name main\n')
        f.write('run\n')
        for _ in range(MAX_STEPS):
            f.write('frame variable\n')
            f.write('thread backtrace\n')
            f.write('step\n')
        # Known, deliberate limitation: unlike every other tracer here
        # (which disables its own in-process hook and lets the real
        # program run itself to completion once truncated, capturing its
        # true final output), there's no working equivalent found for
        # lldb's batch mode — appending `breakpoint delete` + `continue`
        # as trailing commands was tried and, verified empirically, lldb
        # just quits (killing the still-running child) once it reaches the
        # end of the command file rather than waiting for `continue` to
        # actually finish running the target. finalOutput for a truncated
        # C/C++ program is therefore only whatever printed before
        # MAX_STEPS was reached, not the program's true eventual output.

    proc = subprocess.run(['lldb', '-b', '-s', commands_path, binary_path], capture_output=True, text=True)
    transcript = proc.stdout

    # Every command's echo+output is announced by its own "(lldb) " —
    # split on that and pair each resulting chunk with the command that
    # produced it (its own first line, since lldb echoes back exactly what
    # it read right after the prompt). Deliberately NOT positional/index-
    # based: `-b -s file` inserts its own extra "command source -s 0
    # 'file'" + "Executing commands in ..." banner chunk before the
    # commands actually IN that file start running — verified empirically
    # — which would silently shift every fixed-offset assumption by one.
    # Matching each chunk by its own echoed command text instead is
    # immune to that (and to any other banner noise lldb might add).
    raw_chunks = transcript.split('(lldb) ')
    tagged = []  # [(echoed_command, output_text), ...]
    for chunk in raw_chunks[1:]:
        first_nl = chunk.find('\n')
        if first_nl == -1:
            continue
        echoed = chunk[:first_nl].strip()
        tagged.append((echoed, chunk[first_nl + 1:]))

    run_output = next((out for cmd, out in tagged if cmd == 'run'), '')
    initial_chunk = run_output
    step_sequence = [(cmd, out) for cmd, out in tagged if cmd in ('frame variable', 'thread backtrace', 'step')]

    def current_stdout():
        try:
            with open(stdout_path) as f:
                return f.read()
        except OSError:
            return ''

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
            if os.path.basename(file) != 'main.c':
                return ('left-student-code', None)
            return ('stopped', int(line))
        return ('unknown', None)

    steps = []
    truncated = False
    top_error = None

    kind, payload = parse_position(initial_chunk)
    if kind != 'stopped':
        # The breakpoint on main() never actually resolved/hit — treat as
        # a build-adjacent failure rather than silently returning an empty
        # trace with no explanation.
        fail('Failed to start under the debugger (could not stop at main).')
        os.remove(wrapped_path); os.remove(binary_path); os.remove(commands_path); os.remove(stdout_path)
        return
    current_line = payload

    # step_sequence is exactly frame_variable/thread_backtrace/step
    # repeating (see the filter above) — grouped in 3s in that same fixed
    # order this tracer itself generated the command file in.
    i = 0
    while i + 2 < len(step_sequence) and len(steps) < MAX_STEPS:
        _, locals_chunk = step_sequence[i]
        _, backtrace_chunk = step_sequence[i + 1]
        _, step_chunk = step_sequence[i + 2]
        i += 3

        steps.append(build_step(current_line, 'line', locals_chunk, backtrace_chunk, current_stdout()))

        kind, payload = parse_position(step_chunk)
        if kind == 'exited':
            break
        if kind == 'signal':
            top_error = f'Runtime error: {payload}'
            steps[-1]['event'] = 'exception'
            steps[-1]['error'] = top_error
            break
        if kind == 'left-student-code':
            # Stepped off the end of main() into the C runtime's own exit
            # sequence (verified empirically — has no debug info worth
            # descending into) — the program is, for the student's
            # purposes, done.
            break
        if kind != 'stopped':
            break
        current_line = payload
    else:
        if len(steps) >= MAX_STEPS:
            truncated = True

    final_output = current_stdout()

    for p in (wrapped_path, binary_path, commands_path, stdout_path):
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
