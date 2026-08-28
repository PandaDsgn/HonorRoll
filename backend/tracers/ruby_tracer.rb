# Line-by-line execution tracer for the IDE's Visualize feature — the Ruby
# counterpart to python_tracer.py, producing the exact same JSON contract
# ({steps, finalOutput, truncated, error}) so the frontend
# (CodeVisualizer.jsx/ReferenceDiagram.jsx) needs no per-language branches.
#
# Ruby's TracePoint is a genuine language-level hook, same category as
# Python's sys.settrace (unlike JS, which has no such thing and needed the
# V8 Inspector protocol instead — see js_tracer.js) — and object_id gives a
# real, stable identity per object for free, so heap/aliasing tracking here
# doesn't need js_tracer.js's callFunctionOn marker workaround either.
#
# Usage: ruby ruby_tracer.rb <path-to-student-source>
require 'json'
require 'stringio'

MAX_STEPS = 400
MAX_LOCALS = 25
MAX_HEAP_OBJECTS = 14
MAX_COLLECTION_ITEMS = 8
MAX_VALUE_LEN = 60

# compile()'s `filename` argument below is set to this exact string, which is
# also how student frames are told apart from the tracer's own (or any
# stdlib) frames in the trace callback — no separate flag/allowlist needed,
# matching python_tracer.py's own STUDENT_FILENAME convention exactly.
STUDENT_FILENAME = 'main.rb'

def make_ref(obj_id)
  { '__ref__' => obj_id.to_s }
end

def truncate_str(s)
  s.length > MAX_VALUE_LEN ? s[0, MAX_VALUE_LEN] + '…' : s
end

# Some Ruby exceptions (NoMethodError's "Did you mean?" suggestions, most
# visibly) embed a real newline in #message — python_tracer.py's error
# field is always exactly one line, so this keeps that same convention
# here rather than letting a multi-line string leak into the JSON value.
def format_error(exc)
  "#{exc.class}: #{exc.message}".lines.first.to_s.chomp
end

def format_key(key)
  case key
  when nil, true, false, Integer, Float, String
    key
  else
    key.inspect[0, MAX_VALUE_LEN]
  end
rescue StandardError
  '<key>'
end

# JSON-safe representation of one value for a locals slot or a container
# cell — mirrors python_tracer.py's describe() exactly: an inline
# primitive, a {"__ref__": id} pointer into heap (registering the object
# there, and recursively describing its contents, the first time it's
# seen), or a short "<Type>" placeholder for anything else. Never raises —
# an unrepresentable value just becomes a placeholder instead of aborting
# the whole trace step.
def describe(value, heap, visiting)
  case value
  when nil, true, false, Integer, Float
    value
  when String
    truncate_str(value)
  when Symbol
    truncate_str(value.to_s)
  when Array, Hash
    obj_id = value.object_id
    return make_ref(obj_id) if heap.key?(obj_id.to_s) || visiting.include?(obj_id)
    return "<#{value.class}>" if heap.size >= MAX_HEAP_OBJECTS

    visiting << obj_id
    begin
      if value.is_a?(Hash)
        items = value.first(MAX_COLLECTION_ITEMS).map { |k, v| [format_key(k), describe(v, heap, visiting)] }
        entry = { 'type' => 'dict', 'items' => items, 'more' => [0, value.size - MAX_COLLECTION_ITEMS].max }
      else
        items = value.first(MAX_COLLECTION_ITEMS).map { |v| describe(v, heap, visiting) }
        entry = { 'type' => 'list', 'items' => items, 'more' => [0, value.size - MAX_COLLECTION_ITEMS].max }
      end
    ensure
      visiting.delete(obj_id)
    end
    heap[obj_id.to_s] = entry
    make_ref(obj_id)
  else
    "<#{value.class}>"
  end
rescue StandardError
  '<unrepresentable>'
end

def main
  student_path = ARGV[0]
  unless student_path
    puts JSON.generate({ 'error' => 'No source file provided to tracer.' })
    return
  end

  begin
    source = File.read(student_path)
  rescue StandardError => e
    puts JSON.generate({ 'error' => "Could not read source: #{e.message}" })
    return
  end

  steps = []
  truncated = false
  # A manual call stack, not TracePoint's own binding.eval('caller') (which
  # would include every frame back through this tracer's own eval/require
  # machinery, not just the student's) — pushed on :call, popped on
  # :return, always starting with the implicit top-level frame the same
  # way python_tracer.py's call_stack() always ends up with at least
  # ['<module>'] once code is running at all.
  call_stack_names = ['<main>']

  real_stdout = $stdout
  captured = StringIO.new
  $stdout = captured

  record = lambda do |event, tp, error = nil|
    next if truncated
    if steps.length >= MAX_STEPS
      truncated = true
      next
    end

    locals = {}
    heap = {}
    visiting = []
    begin
      names = tp.binding.local_variables.first(MAX_LOCALS)
      names.each { |n| locals[n.to_s] = describe(tp.binding.local_variable_get(n), heap, visiting) }
    rescue StandardError
      # Some frames (certain C-boundary or already-unwound bindings) can't
      # be introspected — same graceful "just show fewer locals" fallback
      # as describe() itself, never lets one bad frame abort the trace.
    end

    step = {
      'line' => tp.lineno,
      'event' => event,
      'func' => call_stack_names.last,
      'stack' => call_stack_names.dup,
      'locals' => locals,
      'heap' => heap,
      # .dup matters here, not stylistic — StringIO#string returns the
      # SAME mutable buffer object every call, not a snapshot copy. Without
      # it every step's 'stdout' would alias that one buffer, and by the
      # time the whole trace is JSON-serialized at the end, every step
      # would show the FINAL cumulative output instead of what had
      # actually printed by that point (verified empirically — this was
      # the actual bug, not a hypothetical).
      'stdout' => captured.string.dup,
    }
    step['error'] = error if error
    steps << step
  end

  trace = TracePoint.new(:line, :call, :return, :raise) do |tp|
    next if tp.path != STUDENT_FILENAME

    case tp.event
    when :call
      call_stack_names << tp.method_id.to_s
      record.call('call', tp)
    when :return
      record.call('return', tp)
      call_stack_names.pop if call_stack_names.length > 1
    when :raise
      exc = tp.raised_exception
      record.call('exception', tp, format_error(exc))
    when :line
      record.call('line', tp)
    end
  end

  top_error = nil
  trace.enable
  begin
    eval(source, TOPLEVEL_BINDING, STUDENT_FILENAME, 1) # rubocop:disable Security/Eval
  rescue SystemExit
    # A student calling exit/exit! ends the trace normally, same as
    # python_tracer.py's own `except SystemExit: pass`.
  rescue Exception => e # rubocop:disable Lint/RescueException
    top_error = format_error(e)
  ensure
    trace.disable
    $stdout = real_stdout
  end

  result = {
    'steps' => steps,
    'finalOutput' => captured.string,
    'truncated' => truncated,
    'error' => top_error,
  }
  real_stdout.write(JSON.generate(result))
end

main
