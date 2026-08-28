<?php
// Line-by-line execution tracer for the IDE's Visualize feature — the PHP
// counterpart to python_tracer.py, producing the exact same JSON contract
// ({steps, finalOutput, truncated, error}) so the frontend
// (CodeVisualizer.jsx/ReferenceDiagram.jsx) needs no per-language branches.
//
// PHP has no sys.settrace/TracePoint equivalent, and no Xdebug installed
// here to fall back on — register_tick_function() was the obvious next
// choice, but its callback runs in GLOBAL scope with no way to reach the
// caller's local variables, which would leave the whole locals/heap panel
// permanently empty. What actually works: rewrite the student's own source
// (via PHP's built-in tokenizer — no extension needed) to insert a call to
// a recorder function after every statement, passing get_defined_vars() —
// which, evaluated as an ARGUMENT at that exact call site, correctly
// reflects the CALLER's own scope, not the recorder's. __LINE__ at each
// insertion point is a compile-time constant that (since instrumentation
// is appended inline, never on its own new line) still matches the
// student's real original line numbers with no remapping needed.
//
// Usage: php php_tracer.php <path-to-student-source>

// Non-fatal issues (an undefined array key, an uninitialized property read,
// etc.) print directly to the same stdout stream this tracer is capturing
// by default — verified empirically that one of these landing mid-run
// corrupts the final JSON output with a stray "PHP Warning: ..." line
// ahead of it. A genuine crash still throws a real Throwable and is caught
// by the try/catch and set_exception_handler() below either way; this only
// silences the advisory noise that was never structured trace data.
ini_set('display_errors', '0');
error_reporting(0);

const MAX_STEPS = 400;
const MAX_LOCALS = 25;
const MAX_HEAP_OBJECTS = 14;
const MAX_COLLECTION_ITEMS = 8;
const MAX_VALUE_LEN = 60;

function truncate_str($s) {
    return strlen($s) > MAX_VALUE_LEN ? substr($s, 0, MAX_VALUE_LEN) . '…' : $s;
}

function format_key($key) {
    if (is_int($key) || is_string($key)) return $key;
    return '<key>';
}

// JSON-safe representation of one value — mirrors python_tracer.py's
// describe() and ruby_tracer.rb's describe(), with one deliberate PHP-
// specific difference: arrays are PHP value types (copy-on-write, not
// reference types — `$b = $a` for an array makes an independent copy, not
// an alias), so array heap entries are never deduped by identity, only by
// a fresh serial per occurrence — correctly showing two separate boxes for
// two arrays that merely have equal contents, never merging them the way
// a real alias would. Objects DO have PHP reference semantics, so those
// use spl_object_id() for real identity/aliasing tracking, same spirit as
// Python's id() or Ruby's object_id.
function describe($value, &$heap, &$visiting, &$next_id) {
    try {
        if ($value === null || is_bool($value) || is_int($value) || is_float($value)) return $value;
        if (is_string($value)) return truncate_str($value);

        if (is_array($value)) {
            if (count($heap) >= MAX_HEAP_OBJECTS) return '<array>';
            $id = (string)($next_id++);
            $visiting[$id] = true;
            $is_list = array_is_list($value);
            $items = [];
            $count = 0;
            foreach ($value as $k => $v) {
                if ($count >= MAX_COLLECTION_ITEMS) break;
                if ($is_list) {
                    $items[] = describe($v, $heap, $visiting, $next_id);
                } else {
                    $items[] = [format_key($k), describe($v, $heap, $visiting, $next_id)];
                }
                $count++;
            }
            unset($visiting[$id]);
            $heap[$id] = [
                'type' => $is_list ? 'list' : 'dict',
                'items' => $items,
                'more' => max(0, count($value) - MAX_COLLECTION_ITEMS),
            ];
            return ['__ref__' => $id];
        }

        if (is_object($value)) {
            $obj_id = (string)spl_object_id($value);
            if (isset($heap[$obj_id]) || isset($visiting[$obj_id])) return ['__ref__' => $obj_id];
            if (count($heap) >= MAX_HEAP_OBJECTS) return '<' . get_class($value) . '>';

            $visiting[$obj_id] = true;
            $props = get_object_vars($value);
            $items = [];
            $count = 0;
            foreach ($props as $k => $v) {
                if ($count >= MAX_COLLECTION_ITEMS) break;
                $items[] = [format_key($k), describe($v, $heap, $visiting, $next_id)];
                $count++;
            }
            unset($visiting[$obj_id]);
            $heap[$obj_id] = [
                'type' => 'dict',
                'items' => $items,
                'more' => max(0, count($props) - MAX_COLLECTION_ITEMS),
            ];
            return ['__ref__' => $obj_id];
        }

        $type = gettype($value);
        return "<$type>";
    } catch (\Throwable $e) {
        return '<unrepresentable>';
    }
}

$GLOBALS['__trace_steps'] = [];
$GLOBALS['__trace_truncated'] = false;
$GLOBALS['__trace_heap_next_id'] = 1;
$GLOBALS['__trace_stdout_buf'] = '';

// Called inline from the rewritten student source (see the tokenizer pass
// below) — $vars is get_defined_vars() evaluated at the CALL SITE, i.e.
// the student's own current scope, not this function's.
function __trace_step($line, $vars) {
    if ($GLOBALS['__trace_truncated']) return;
    if (count($GLOBALS['__trace_steps']) >= MAX_STEPS) {
        $GLOBALS['__trace_truncated'] = true;
        return;
    }

    // debug_backtrace() is innermost-first: $trace[0] describes the call
    // TO __trace_step itself (function === '__trace_step', filtered out
    // below), $trace[1] describes the call to whatever function encloses
    // THAT (the real innermost student frame), and so on outward — but
    // since the student's whole program runs via eval() inside THIS
    // tracer's own main(), the trace also includes main()'s and eval()'s
    // OWN frames, which have to be excluded too: verified empirically that
    // every frame genuinely inside the eval'd student code reports its
    // 'file' as ".../php_tracer.php(N) : eval()'d code", while this
    // tracer's own real frames (main, the eval call site itself) report
    // the real file path — that's the actual, reliable boundary, not
    // function-name matching (a student could plausibly name their own
    // function "main"). Reversed after filtering to get outermost-first —
    // matching python_tracer.py's own call_stack() convention — with
    // '<main>' prepended as the implicit top-level frame every call chain
    // sits on top of (absent from debug_backtrace() itself, since global/
    // top-level scope was never itself "called").
    $trace = debug_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS);
    $names = [];
    foreach ($trace as $frame) {
        $in_student_code = isset($frame['file']) && str_contains($frame['file'], "eval()'d code");
        if ($in_student_code && isset($frame['function']) && $frame['function'] !== '__trace_step') {
            $names[] = $frame['function'];
        }
    }
    $stack = array_merge(['<main>'], array_reverse($names));
    $func = end($stack);

    $heap = [];
    $visiting = [];
    $locals = [];
    $count = 0;
    foreach ($vars as $name => $val) {
        if ($count >= MAX_LOCALS) break;
        $locals[$name] = describe($val, $heap, $visiting, $GLOBALS['__trace_heap_next_id']);
        $count++;
    }

    $GLOBALS['__trace_steps'][] = [
        'line' => $line,
        'event' => 'line',
        'func' => $func,
        'stack' => $stack,
        'locals' => $locals,
        'heap' => $heap,
        'stdout' => ob_get_contents(),
    ];
}

function __trace_format_error($e) {
    $lines = explode("\n", $e->getMessage());
    return get_class($e) . ': ' . $lines[0];
}

// eval() runs in the CALLING function's own variable scope, not an
// isolated one — verified empirically that calling eval($rewritten)
// directly inside main() leaked main()'s own locals ($source, $tokens,
// $rewritten, ...) into every single get_defined_vars() call the
// instrumentation makes, mixed right in with the student's real variables.
// This function exists ONLY so eval() has a scope with nothing else in it
// to leak — no parameters (a parameter would itself leak in as one spurious
// variable), reading the code to run from $GLOBALS instead.
function __trace_run() {
    eval($GLOBALS['__trace_rewritten_code']);
}

function main() {
    global $argv;
    $student_path = $argv[1] ?? null;
    if (!$student_path) {
        echo json_encode(['error' => 'No source file provided to tracer.']);
        return;
    }
    $source = @file_get_contents($student_path);
    if ($source === false) {
        echo json_encode(['error' => "Could not read source: file not found"]);
        return;
    }

    // token_get_all requires a leading <?php tag to tokenize as PHP at
    // all — strip the student's own opening tag first (if present) so it
    // isn't duplicated once re-added here. Deliberately NOT `\s*` on
    // either side (which would swallow any blank lines right after the
    // tag too) — stripping exactly the tag plus at most the one newline
    // immediately following it keeps line numbers in the reconstructed
    // source identical to the student's original file.
    $body = preg_replace('/^<\?php[ \t]*\r?\n?/', '', $source, 1);
    $tokens = @token_get_all("<?php\n" . $body);
    if ($tokens === false) {
        echo json_encode(['error' => 'ParseError: could not tokenize source']);
        return;
    }

    $rewritten = '';
    $depth = 0; // paren/bracket depth — a `;` inside a for(...)'s own
                // header, or a `{`/`;` inside an array literal, must NOT
                // get instrumented; only real statement/block boundaries
                // at depth 0 do. (Known limitation: a closure passed
                // inline as a call argument — array_map(function($x){...},
                // $arr) — sits at depth > 0 for its entire body too, since
                // the outer call's own paren hasn't closed yet, so it goes
                // un-instrumented same as anything else at that depth.)
    //
    // A brace can ALSO open a class/interface/trait/enum body, where only
    // declarations are legal — inserting a plain statement there (as if it
    // were a normal if/while/function block) is a syntax error, verified
    // empirically against `class Point { public $x = 1; ... }`. $brace_stack
    // tracks, per currently-open depth-0 brace, whether it's one of those
    // declaration-only bodies, so its own `{` and every `;` directly inside
    // it (property/case declarations) are correctly left uninstrumented —
    // while a METHOD body nested inside still gets instrumented normally,
    // since entering it pushes its own 'normal' frame on top.
    $brace_stack = [];
    $pending_class_like = false;
    foreach ($tokens as $tok) {
        if (is_array($tok)) {
            [$id, $text] = $tok;
            // eval() already assumes PHP context — including the literal
            // "<?php\n" text (this token's own content) in $rewritten
            // would hand eval() a stray "<" it can't parse. Replaced with
            // a bare newline, NOT dropped outright: the student's own
            // file has "<?php" as its real line 1, so their actual first
            // code line is line 2 — dropping this token's newline too
            // would shift every subsequent __LINE__ down by one relative
            // to what the student sees in their own editor.
            if ($id === T_OPEN_TAG) { $rewritten .= "\n"; continue; }
            $rewritten .= $text;
            if (in_array($id, [T_CLASS, T_INTERFACE, T_TRAIT, T_ENUM], true)) {
                $pending_class_like = true;
            }
        } else {
            $rewritten .= $tok;
            if ($tok === '(' || $tok === '[') {
                $depth++;
            } elseif ($tok === ')' || $tok === ']') {
                $depth--;
            } elseif ($tok === '{' && $depth === 0) {
                $is_class_body = $pending_class_like;
                $pending_class_like = false;
                $brace_stack[] = $is_class_body ? 'class' : 'normal';
                if (!$is_class_body) {
                    $rewritten .= ' __trace_step(__LINE__, get_defined_vars());';
                }
            } elseif ($tok === '}' && $depth === 0) {
                array_pop($brace_stack);
            } elseif ($tok === ';' && $depth === 0) {
                $top = empty($brace_stack) ? 'normal' : end($brace_stack);
                if ($top !== 'class') {
                    $rewritten .= ' __trace_step(__LINE__, get_defined_vars());';
                }
            }
        }
    }

    $top_error = null;
    ob_start();
    set_exception_handler(function ($e) use (&$top_error) {
        global $argv;
        $GLOBALS['__trace_steps'][] = [
            'line' => $e->getLine(),
            'event' => 'exception',
            'func' => '<main>',
            'stack' => ['<main>'],
            'locals' => [],
            'heap' => [],
            'stdout' => ob_get_contents(),
            'error' => __trace_format_error($e),
        ];
        $GLOBALS['__trace_top_error'] = __trace_format_error($e);
    });

    $GLOBALS['__trace_rewritten_code'] = $rewritten;
    try {
        __trace_run();
    } catch (\Throwable $e) {
        $top_error = __trace_format_error($e);
        $GLOBALS['__trace_steps'][] = [
            'line' => $e->getLine(),
            'event' => 'exception',
            'func' => '<main>',
            'stack' => ['<main>'],
            'locals' => [],
            'heap' => [],
            'stdout' => ob_get_contents(),
            'error' => $top_error,
        ];
    }
    if (isset($GLOBALS['__trace_top_error'])) $top_error = $GLOBALS['__trace_top_error'];

    $final_output = ob_get_contents();
    ob_end_clean();

    $result = [
        'steps' => $GLOBALS['__trace_steps'],
        'finalOutput' => $final_output,
        'truncated' => $GLOBALS['__trace_truncated'],
        'error' => $top_error,
    ];
    echo json_encode($result);
}

main();
