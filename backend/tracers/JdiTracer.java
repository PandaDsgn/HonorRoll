// Line-by-line execution tracer for the IDE's Visualize feature — the Java
// counterpart to python_tracer.py, producing the exact same JSON contract
// ({steps, finalOutput, truncated, error}) so the frontend
// (CodeVisualizer.jsx/ReferenceDiagram.jsx) needs no per-language branches.
//
// Unlike C/C++/Rust (which needed an external debugger driven as a
// subprocess and its text output parsed — see c_tracer.py/rust_tracer.py's
// own comments for why), Java ships a REAL programmatic debugger API in
// the standard library: com.sun.jdi (Java Debug Interface). This program
// IS the debugger client directly — no text-scraping, no lldb-equivalent
// subprocess, no batch-script/transcript-parsing workaround needed. It
// compiles the student's Main.java itself (via ProcessBuilder + javac),
// then uses JDI's CommandLineLaunch connector to launch a SECOND, fully
// separate JVM running the compiled Main class under debug control, and
// steps that VM one line at a time, recording each stop.
//
// Usage: java JdiTracer <path-to-student-source-dir-containing-Main.java>
import com.sun.jdi.*;
import com.sun.jdi.connect.*;
import com.sun.jdi.event.*;
import com.sun.jdi.request.*;

import java.io.*;
import java.util.*;

public class JdiTracer {
    static final int MAX_STEPS = 400;
    static final int MAX_LOCALS = 25;
    static final int MAX_HEAP_OBJECTS = 14;
    static final int MAX_COLLECTION_ITEMS = 8;
    static final int MAX_VALUE_LEN = 60;
    static final String MAIN_CLASS = "Main";

    public static void main(String[] args) {
        if (args.length < 1) {
            System.out.println(jsonError("No source file provided to tracer."));
            return;
        }
        // Passed the student's own file path, same convention every other
        // tracer's own argv[1]/ARGV[0]/$argv[1] uses — this just derives
        // the containing directory from it, rather than requiring a
        // different invocation shape just because this one happens to run
        // via `java JdiTracer <arg>` instead of `<interpreter> <tracerPath> <arg>`.
        File sourceFile = new File(args[0]);
        // A bare filename with no directory component (e.g. "Main.java",
        // no "./" or path prefix) makes File.getParent() return null, not
        // "." — verified empirically this threw a bare NullPointerException
        // with no message once handed to new File(null) below.
        String workDir = sourceFile.getParent();
        if (workDir == null) workDir = ".";
        if (!sourceFile.exists()) {
            System.out.println(jsonError("Could not read source: " + sourceFile + " not found"));
            return;
        }

        try {
            // -g: javac's OWN default debug info includes line numbers and
            // source file but NOT local variable tables — verified
            // empirically every step's locals came back completely empty
            // without this flag, silently (AbsentInformationException,
            // caught and swallowed in buildLocals() below as a "nothing
            // to show" case indistinguishable from a genuinely empty
            // scope).
            ProcessBuilder pb = new ProcessBuilder("javac", "-g", MAIN_CLASS + ".java");
            pb.directory(new File(workDir));
            pb.redirectErrorStream(false);
            Process compile = pb.start();
            String compileErr = readAll(compile.getErrorStream());
            int compileExit = compile.waitFor();
            if (compileExit != 0) {
                String firstError = firstErrorLine(compileErr);
                System.out.println(jsonError("Compile error: " + (firstError != null ? firstError : "compilation failed")));
                return;
            }
        } catch (Exception e) {
            System.out.println(jsonError("Could not compile: " + e.getMessage()));
            return;
        }

        try {
            new JdiTracer().run(workDir);
        } catch (Exception e) {
            System.out.println(jsonError("Tracer failure: " + e));
        }
    }

    private static String firstErrorLine(String stderr) {
        for (String line : stderr.split("\n")) {
            if (line.contains("error:")) return line.trim();
        }
        return null;
    }

    private static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[4096];
        int n;
        while ((n = in.read(chunk)) != -1) buf.write(chunk, 0, n);
        return buf.toString("UTF-8");
    }

    // ------------------------------------------------------------------

    private final List<Map<String, Object>> steps = new ArrayList<>();
    private boolean truncated = false;
    private String topError = null;
    private int nextHeapCounter = 1;
    private final Map<Long, String> heapIdByObjectId = new HashMap<>();

    private final StringBuilder stdoutBuf = new StringBuilder();
    private final Object stdoutLock = new Object();

    private String currentStdout() {
        synchronized (stdoutLock) {
            return stdoutBuf.toString();
        }
    }

    void run(String workDir) throws Exception {
        LaunchingConnector connector = (LaunchingConnector) Bootstrap.virtualMachineManager().defaultConnector();
        Map<String, Connector.Argument> arguments = connector.defaultArguments();
        arguments.get("main").setValue(MAIN_CLASS);
        arguments.get("options").setValue("-cp " + workDir);
        // A student's own infinite loop must still be killable by the
        // OUTER sandbox's cpuSec ulimit — that ulimit applies to THIS
        // process (JdiTracer itself), not the separate child JVM JDI
        // launches, so "suspend" here (start the child paused, not
        // running) matters: without it, an infinite loop could burn CPU
        // in the child indefinitely with no ulimit of its own watching it.
        if (arguments.containsKey("suspend")) arguments.get("suspend").setValue("true");

        VirtualMachine vm;
        try {
            vm = connector.launch(arguments);
        } catch (VMStartException e) {
            System.out.println(jsonError("Failed to start under the debugger: " + e.getMessage()));
            return;
        }

        Process process = vm.process();
        Thread stdoutReader = new Thread(() -> pumpStream(process.getInputStream(), stdoutBuf, stdoutLock));
        stdoutReader.setDaemon(true);
        stdoutReader.start();
        // Drained (not forwarded anywhere) purely so the child's OS pipe
        // buffer can never fill up and block it mid-write — this tracer's
        // own JSON result only ever comes from stdout, and Java
        // exceptions are already captured structurally via
        // ExceptionRequest/onException below, not by scraping stderr text
        // the way rust_tracer.py has to for a panic's message.
        Thread stderrReader = new Thread(() -> pumpStream(process.getErrorStream(), new StringBuilder(), new Object()));
        stderrReader.setDaemon(true);
        stderrReader.start();

        EventRequestManager erm = vm.eventRequestManager();
        ClassPrepareRequest cpr = erm.createClassPrepareRequest();
        cpr.addClassFilter(MAIN_CLASS);
        cpr.setSuspendPolicy(EventRequest.SUSPEND_ALL);
        cpr.enable();

        ExceptionRequest exReq = erm.createExceptionRequest(null, true, true);
        exReq.setSuspendPolicy(EventRequest.SUSPEND_ALL);
        exReq.enable();

        EventQueue queue = vm.eventQueue();
        vm.resume();

        boolean running = true;
        boolean vmAlreadyDead = false;
        while (running) {
            EventSet eventSet;
            try {
                eventSet = queue.remove();
            } catch (VMDisconnectedException e) {
                break;
            }
            boolean resumeSet = true;
            for (Event event : eventSet) {
                if (event instanceof ClassPrepareEvent) {
                    ClassPrepareEvent cpe = (ClassPrepareEvent) event;
                    ReferenceType refType = cpe.referenceType();
                    List<Location> locs = refType.methodsByName("main").isEmpty()
                        ? Collections.emptyList() : refType.methodsByName("main").get(0).allLineLocations();
                    if (!locs.isEmpty()) {
                        BreakpointRequest bpr = erm.createBreakpointRequest(locs.get(0));
                        bpr.setSuspendPolicy(EventRequest.SUSPEND_ALL);
                        bpr.enable();
                    }
                } else if (event instanceof BreakpointEvent || event instanceof StepEvent) {
                    LocatableEvent le = (LocatableEvent) event;
                    resumeSet = onStop(le, erm, vm);
                    if (!resumeSet) { running = false; }
                } else if (event instanceof ExceptionEvent) {
                    resumeSet = onException((ExceptionEvent) event, erm, vm);
                    if (!resumeSet) { running = false; }
                } else if (event instanceof VMDeathEvent || event instanceof VMDisconnectEvent) {
                    running = false;
                    vmAlreadyDead = true;
                }
            }
            if (running && resumeSet) {
                try { eventSet.resume(); } catch (VMDisconnectedException e) { vmAlreadyDead = true; break; }
            }
        }

        // Breaking out of the loop above due to truncation (onStop/
        // onException returning false) leaves the debuggee THREAD still
        // suspended — verified empirically that without this, the
        // student's own infinite/large loop would never actually run to
        // completion at all: process.waitFor() right below would just
        // hang forever waiting on a process that's paused, not running,
        // and was never going to resume itself. Every other tracer here
        // disables its own hook and lets the underlying interpreter keep
        // running at full speed on truncation; this is the JDI
        // equivalent — explicitly resume, once stepping/exception
        // watching has already been torn down (see disableAllStepping),
        // so nothing pauses it again.
        if (!vmAlreadyDead) {
            try { vm.resume(); } catch (VMDisconnectedException ignored) { }
        }
        try { process.waitFor(); } catch (InterruptedException ignored) { }
        try { stdoutReader.join(500); } catch (InterruptedException ignored) { }

        StringBuilder out = new StringBuilder();
        out.append("{\"steps\":[");
        for (int i = 0; i < steps.size(); i++) {
            if (i > 0) out.append(',');
            writeStepJson(out, steps.get(i));
        }
        out.append("],\"finalOutput\":").append(jsonString(currentStdout()));
        out.append(",\"truncated\":").append(truncated);
        out.append(",\"error\":").append(topError == null ? "null" : jsonString(topError));
        out.append('}');
        System.out.println(out);
    }

    private static void pumpStream(InputStream in, StringBuilder into, Object lock) {
        try {
            byte[] chunk = new byte[4096];
            int n;
            while ((n = in.read(chunk)) != -1) {
                String piece = new String(chunk, 0, n, "UTF-8");
                synchronized (lock) { into.append(piece); }
            }
        } catch (IOException ignored) {
        }
    }

    // Returns false if tracing should stop (truncated or otherwise done).
    private boolean onStop(LocatableEvent event, EventRequestManager erm, VirtualMachine vm) {
        if (steps.size() >= MAX_STEPS) {
            truncated = true;
            disableAllStepping(erm);
            return false;
        }
        try {
            ThreadReference thread = event.thread();
            StackFrame frame = thread.frame(0);
            Location loc = frame.location();

            Map<String, Object> step = new LinkedHashMap<>();
            step.put("line", loc.lineNumber());
            step.put("event", steps.isEmpty() ? "call" : "line");
            List<String> stack = buildStack(thread);
            step.put("func", stack.isEmpty() ? "main" : stack.get(stack.size() - 1));
            step.put("stack", stack);

            Map<String, Object> heap = new LinkedHashMap<>();
            Map<String, Object> locals = buildLocals(frame, heap);
            step.put("locals", locals);
            step.put("heap", heap);
            step.put("stdout", currentStdout());
            steps.add(step);
        } catch (Exception e) {
            // A frame that can't be introspected (rare — e.g. the thread
            // raced past this exact point) shouldn't abort the whole
            // trace; this step is just skipped, same "best effort" spirit
            // as every other tracer's own per-value fallback.
        }

        if (event instanceof BreakpointEvent) {
            erm.deleteEventRequest(event.request());
        }
        // JDI allows only ONE active step request per thread — verified
        // empirically (DuplicateRequestException) that creating a new one
        // on every stop without first deleting the previous one throws
        // immediately on the second step.
        for (StepRequest old : new ArrayList<>(erm.stepRequests())) {
            if (old.thread().equals(event.thread())) erm.deleteEventRequest(old);
        }
        // Manual STEP_INTO-then-STEP_OUT control (based on checking each
        // frame's own declaring class) was tried as a replacement for
        // these exclusion filters and abandoned — verified empirically it
        // HANGS outright the moment stepping enters certain JDK internals
        // (a HashMap constructor's own superclass-constructor chain, at
        // minimum), never converging back to student code at all. These
        // exclusion filters work correctly for everything except one
        // known, narrow edge case: stepping from the second-to-last line
        // straight into a plain library call ON the very last line (with
        // no student code left afterward for a step to land on, e.g. a
        // program literally ending in System.out.println(...)) doesn't
        // produce a further StepEvent — that final call's own step is
        // silently missing from the trace, though finalOutput still
        // captures its actual printed output correctly regardless (that
        // capture doesn't depend on stepping at all, see currentStdout()).
        StepRequest sr = erm.createStepRequest(event.thread(), StepRequest.STEP_LINE, StepRequest.STEP_INTO);
        sr.addClassExclusionFilter("java.*");
        sr.addClassExclusionFilter("javax.*");
        sr.addClassExclusionFilter("sun.*");
        sr.addClassExclusionFilter("jdk.*");
        sr.addClassExclusionFilter("com.sun.*");
        sr.setSuspendPolicy(EventRequest.SUSPEND_ALL);
        sr.enable();
        return true;
    }

    private boolean onException(ExceptionEvent event, EventRequestManager erm, VirtualMachine vm) {
        try {
            ThreadReference thread = event.thread();
            ObjectReference exc = event.exception();
            String excType = exc.referenceType().name();
            String message = null;
            try {
                Method getMessage = exc.referenceType().methodsByName("getMessage").isEmpty() ? null
                    : exc.referenceType().methodsByName("getMessage").get(0);
                if (getMessage != null) {
                    Value v = exc.invokeMethod(thread, getMessage, Collections.emptyList(), ObjectReference.INVOKE_SINGLE_THREADED);
                    if (v instanceof StringReference) message = ((StringReference) v).value();
                }
            } catch (Exception ignored) { }
            String errorText = excType + (message != null ? ": " + message : "");

            if (steps.size() < MAX_STEPS) {
                StackFrame frame = thread.frame(0);
                Location loc = frame.location();
                Map<String, Object> step = new LinkedHashMap<>();
                step.put("line", loc.lineNumber());
                step.put("event", "exception");
                List<String> stack = buildStack(thread);
                step.put("func", stack.isEmpty() ? "main" : stack.get(stack.size() - 1));
                step.put("stack", stack);
                Map<String, Object> heap = new LinkedHashMap<>();
                step.put("locals", buildLocals(frame, heap));
                step.put("heap", heap);
                step.put("stdout", currentStdout());
                step.put("error", errorText);
                steps.add(step);
            }
            // ExceptionEvent fires for every throw, caught or not (JDI's
            // own equivalent of Python's sys.settrace 'exception' event
            // firing regardless of whether a catch exists) — only an
            // UNCAUGHT one should set the trace's own top-level error,
            // matching every other tracer's "did the whole program
            // actually crash" semantics. event.catchLocation() is null
            // specifically for the uncaught case.
            if (event.catchLocation() == null) {
                topError = errorText;
            }
        } catch (Exception e) {
            // Fall through — still let stepping continue below.
        }

        if (steps.size() >= MAX_STEPS) {
            truncated = true;
            disableAllStepping(erm);
            return false;
        }
        return true;
    }

    private void disableAllStepping(EventRequestManager erm) {
        for (StepRequest sr : new ArrayList<>(erm.stepRequests())) erm.deleteEventRequest(sr);
        for (BreakpointRequest br : new ArrayList<>(erm.breakpointRequests())) erm.deleteEventRequest(br);
        for (ExceptionRequest er : new ArrayList<>(erm.exceptionRequests())) erm.deleteEventRequest(er);
    }

    private List<String> buildStack(ThreadReference thread) {
        List<String> names = new ArrayList<>();
        try {
            List<StackFrame> frames = thread.frames();
            for (int i = frames.size() - 1; i >= 0; i--) {
                Method m = frames.get(i).location().method();
                if (m.declaringType().name().equals(MAIN_CLASS)) {
                    names.add(m.name().equals("main") ? "main" : m.name());
                }
            }
        } catch (Exception ignored) { }
        if (names.isEmpty()) names.add("main");
        return names;
    }

    private Map<String, Object> buildLocals(StackFrame frame, Map<String, Object> heap) {
        Map<String, Object> locals = new LinkedHashMap<>();
        try {
            ThreadReference thread = frame.thread();
            List<LocalVariable> vars = frame.visibleVariables();
            int count = 0;
            for (LocalVariable v : vars) {
                if (count >= MAX_LOCALS) break;
                Value val = frame.getValue(v);
                locals.put(v.name(), describe(val, heap, new HashSet<>(), thread));
                count++;
            }
        } catch (AbsentInformationException e) {
            // Compiled without -g locals info — shouldn't happen (javac's
            // own default DOES include line numbers and source file, but
            // local variable TABLES specifically need -g or -g:vars) —
            // handled by always compiling with -g, see main()'s javac
            // invocation; this catch is just the graceful fallback for
            // any locals javac still couldn't emit info for.
        }
        return locals;
    }

    // JSON-safe representation of one JDI Value — mirrors every other
    // tracer's own describe(): an inline primitive, a {"__ref__": id}
    // pointer into heap (registering the object there, and recursively
    // describing its contents, the first time it's seen), or a short
    // "<Type>" placeholder for anything else. uniqueID() is a REAL,
    // native object identity primitive JDI provides directly — the Java
    // analogue of Python's id()/Ruby's object_id, no workaround needed
    // (unlike JS, which needed a hand-rolled marker-property trick — see
    // js_tracer.js — because V8's own Inspector protocol has no such
    // primitive exposed).
    private Object describe(Value value, Map<String, Object> heap, Set<Long> visiting, ThreadReference thread) {
        try {
            if (value == null) return null;
            if (value instanceof BooleanValue) return ((BooleanValue) value).value();
            if (value instanceof ByteValue) return (int) ((ByteValue) value).value();
            if (value instanceof CharValue) return String.valueOf(((CharValue) value).value());
            if (value instanceof ShortValue) return (int) ((ShortValue) value).value();
            if (value instanceof IntegerValue) return ((IntegerValue) value).value();
            if (value instanceof LongValue) return ((LongValue) value).value();
            if (value instanceof FloatValue) return ((FloatValue) value).value();
            if (value instanceof DoubleValue) return ((DoubleValue) value).value();
            if (value instanceof StringReference) return truncateStr(((StringReference) value).value());

            if (value instanceof ArrayReference) {
                ArrayReference arr = (ArrayReference) value;
                long id = arr.uniqueID();
                // heapIdByObjectId assigns a STABLE id per object across
                // the WHOLE trace (needed so the frontend's own cross-step
                // numbering — and real aliasing, two variables sharing one
                // box — stays consistent run to run), but each STEP's own
                // `heap` dict is independent, serialized and consumed on
                // its own — verified empirically that skipping the
                // describe/heap.put() work below just because an object
                // was ALREADY boxed in an EARLIER step left THIS step's
                // heap with a dangling __ref__ pointing at an id that
                // simply isn't present in it. Known-id-but-not-in-this-
                // step's-heap still needs the full describe walk; only
                // known-AND-already-in-this-heap can shortcut.
                String existingHid = heapIdByObjectId.get(id);
                if (existingHid != null && heap.containsKey(existingHid)) return ref(existingHid);
                if (visiting.contains(id)) return ref(String.valueOf(id));
                if (heap.size() >= MAX_HEAP_OBJECTS) return "<array>";
                String hid = existingHid != null ? existingHid : String.valueOf(nextHeapCounter++);
                heapIdByObjectId.put(id, hid);
                visiting.add(id);
                int len = arr.length();
                List<Object> items = new ArrayList<>();
                int shown = Math.min(len, MAX_COLLECTION_ITEMS);
                for (int i = 0; i < shown; i++) {
                    items.add(describe(arr.getValue(i), heap, visiting, thread));
                }
                visiting.remove(id);
                Map<String, Object> entry = new LinkedHashMap<>();
                entry.put("type", "list");
                entry.put("items", items);
                entry.put("more", Math.max(0, len - MAX_COLLECTION_ITEMS));
                heap.put(hid, entry);
                return ref(hid);
            }

            if (value instanceof ObjectReference) {
                ObjectReference obj = (ObjectReference) value;
                ReferenceType type = obj.referenceType();
                String typeName = type.name();

                // Boxed primitives / common value-ish wrapper types worth
                // showing inline rather than as a heap box — matches how
                // every other tracer treats its own language's immutable
                // "feels like a primitive" types.
                if (typeName.equals("java.lang.Integer") || typeName.equals("java.lang.Long")
                    || typeName.equals("java.lang.Short") || typeName.equals("java.lang.Byte")) {
                    return invokeNumberValue(obj);
                }
                if (typeName.equals("java.lang.Double") || typeName.equals("java.lang.Float")) {
                    return invokeNumberValue(obj);
                }
                if (typeName.equals("java.lang.Boolean")) {
                    Field f = type.fieldByName("value");
                    Value v = f != null ? obj.getValue(f) : null;
                    return v instanceof BooleanValue ? ((BooleanValue) v).value() : "<Boolean>";
                }
                if (typeName.equals("java.lang.Character")) {
                    Field f = type.fieldByName("value");
                    Value v = f != null ? obj.getValue(f) : null;
                    return v instanceof CharValue ? String.valueOf(((CharValue) v).value()) : "<Character>";
                }

                long id = obj.uniqueID();
                // Same stable-id-but-per-step-heap reasoning as the
                // ArrayReference branch above — see its own comment.
                String existingHid = heapIdByObjectId.get(id);
                if (existingHid != null && heap.containsKey(existingHid)) return ref(existingHid);
                if (visiting.contains(id)) return ref(String.valueOf(id));
                if (heap.size() >= MAX_HEAP_OBJECTS) return "<" + shortTypeName(typeName) + ">";

                String hid = existingHid != null ? existingHid : String.valueOf(nextHeapCounter++);
                heapIdByObjectId.put(id, hid);
                visiting.add(id);

                Map<String, Object> entry;
                if (isListLike(type)) {
                    entry = describeListLike(obj, heap, visiting, thread);
                } else if (isMapLike(type)) {
                    entry = describeMapLike(obj, heap, visiting, thread);
                } else {
                    entry = describeFields(obj, type, heap, visiting, thread);
                }
                visiting.remove(id);
                heap.put(hid, entry);
                return ref(hid);
            }
            return "<value>";
        } catch (Exception e) {
            return "<unrepresentable>";
        }
    }

    private Object invokeNumberValue(ObjectReference obj) {
        try {
            ReferenceType type = obj.referenceType();
            Field f = type.fieldByName("value");
            if (f == null) return "<Number>";
            Value v = obj.getValue(f);
            if (v instanceof IntegerValue) return ((IntegerValue) v).value();
            if (v instanceof LongValue) return ((LongValue) v).value();
            if (v instanceof ShortValue) return (int) ((ShortValue) v).value();
            if (v instanceof ByteValue) return (int) ((ByteValue) v).value();
            if (v instanceof DoubleValue) return ((DoubleValue) v).value();
            if (v instanceof FloatValue) return ((FloatValue) v).value();
            return "<Number>";
        } catch (Exception e) {
            return "<Number>";
        }
    }

    private static String shortTypeName(String fqName) {
        int idx = fqName.lastIndexOf('.');
        return idx >= 0 ? fqName.substring(idx + 1) : fqName;
    }

    private boolean isListLike(ReferenceType type) {
        String n = type.name();
        return n.startsWith("java.util.ArrayList") || n.startsWith("java.util.LinkedList")
            || n.startsWith("java.util.List") || implementsInterface(type, "java.util.List");
    }

    private boolean isMapLike(ReferenceType type) {
        String n = type.name();
        return n.startsWith("java.util.HashMap") || n.startsWith("java.util.LinkedHashMap")
            || n.startsWith("java.util.TreeMap") || implementsInterface(type, "java.util.Map");
    }

    private boolean implementsInterface(ReferenceType type, String ifaceName) {
        if (!(type instanceof ClassType)) return false;
        try {
            for (InterfaceType it : ((ClassType) type).allInterfaces()) {
                if (it.name().equals(ifaceName)) return true;
            }
        } catch (Exception ignored) { }
        return false;
    }

    // ArrayList/LinkedList/etc via reflection-ish JDI calls (toArray()) —
    // simpler and more robust than reading private internal fields
    // (elementData, size, ...) directly, which differ between
    // ArrayList/LinkedList/etc and aren't a stable contract to depend on.
    // toArray() gives every element in ONE call rather than N separate
    // get(i) invocations — each ObjectReference.invokeMethod() call
    // actually resumes and re-suspends the target VM under the hood, so
    // minimizing call count matters for how long tracing a single step
    // takes, not just code brevity.
    private Map<String, Object> describeListLike(ObjectReference obj, Map<String, Object> heap, Set<Long> visiting, ThreadReference thread) {
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("type", "list");
        List<Object> items = new ArrayList<>();
        int more = 0;
        try {
            Value arrVal = invokeNoArg(obj, "toArray", thread);
            if (arrVal instanceof ArrayReference) {
                ArrayReference arr = (ArrayReference) arrVal;
                int len = arr.length();
                int shown = Math.min(len, MAX_COLLECTION_ITEMS);
                for (int i = 0; i < shown; i++) {
                    items.add(describe(arr.getValue(i), heap, visiting, thread));
                }
                more = Math.max(0, len - MAX_COLLECTION_ITEMS);
            }
        } catch (Exception ignored) {
            // Falls through with whatever was collected so far — a list
            // this tracer can't fully introspect still isn't worth
            // aborting the step over.
        }
        entry.put("items", items);
        entry.put("more", more);
        return entry;
    }

    // Map has no toArray() of its own — entrySet() gives a Set of
    // Map.Entry, which DOES, so this is two invocations deep (entrySet(),
    // then toArray() on that) before getKey()/getValue() on each entry.
    private Map<String, Object> describeMapLike(ObjectReference obj, Map<String, Object> heap, Set<Long> visiting, ThreadReference thread) {
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("type", "dict");
        List<Object> items = new ArrayList<>();
        int more = 0;
        try {
            Value entrySetVal = invokeNoArg(obj, "entrySet", thread);
            if (entrySetVal instanceof ObjectReference) {
                Value arrVal = invokeNoArg((ObjectReference) entrySetVal, "toArray", thread);
                if (arrVal instanceof ArrayReference) {
                    ArrayReference arr = (ArrayReference) arrVal;
                    int len = arr.length();
                    int shown = Math.min(len, MAX_COLLECTION_ITEMS);
                    for (int i = 0; i < shown; i++) {
                        Value entryVal = arr.getValue(i);
                        if (entryVal instanceof ObjectReference) {
                            ObjectReference entryObj = (ObjectReference) entryVal;
                            Value keyVal = invokeNoArg(entryObj, "getKey", thread);
                            Value valVal = invokeNoArg(entryObj, "getValue", thread);
                            List<Object> pair = new ArrayList<>();
                            pair.add(describeMapKey(keyVal, heap, visiting, thread));
                            pair.add(describe(valVal, heap, visiting, thread));
                            items.add(pair);
                        }
                    }
                    more = Math.max(0, len - MAX_COLLECTION_ITEMS);
                }
            }
        } catch (Exception ignored) {
        }
        entry.put("items", items);
        entry.put("more", more);
        return entry;
    }

    // A dict "key" slot in the shared trace JSON is a bare JSON
    // string/number, never a {"__ref__"} pointer (matching python_tracer.py's
    // own format_key()) — a Map keyed by a primitive-ish type (String,
    // Integer, ...) renders that value directly; anything else just gets
    // its toString()'d, since introspecting an arbitrary custom key TYPE
    // the same way a value would be is more than this needs.
    private Object describeMapKey(Value key, Map<String, Object> heap, Set<Long> visiting, ThreadReference thread) {
        Object described = describe(key, heap, visiting, thread);
        if (described instanceof Map) {
            try {
                return key instanceof ObjectReference ? invokeToString((ObjectReference) key, thread) : String.valueOf(key);
            } catch (Exception e) {
                return "<key>";
            }
        }
        return described;
    }

    private String invokeToString(ObjectReference obj, ThreadReference thread) {
        try {
            Value v = invokeNoArg(obj, "toString", thread);
            return v instanceof StringReference ? truncateStr(((StringReference) v).value()) : "<key>";
        } catch (Exception e) {
            return "<key>";
        }
    }

    private Value invokeNoArg(ObjectReference obj, String methodName, ThreadReference thread) throws Exception {
        List<Method> candidates = obj.referenceType().methodsByName(methodName);
        Method method = null;
        for (Method m : candidates) {
            if (m.argumentTypeNames().isEmpty()) { method = m; break; }
        }
        if (method == null) throw new NoSuchMethodException(methodName);
        return obj.invokeMethod(thread, method, Collections.emptyList(), ObjectReference.INVOKE_SINGLE_THREADED);
    }

    private Map<String, Object> describeFields(ObjectReference obj, ReferenceType type, Map<String, Object> heap, Set<Long> visiting, ThreadReference thread) {
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("type", "dict");
        List<Object> items = new ArrayList<>();
        int more = 0;
        int count = 0;
        List<Field> fields = type.fields();
        for (Field f : fields) {
            if (f.isStatic()) continue;
            if (count >= MAX_COLLECTION_ITEMS) { more++; continue; }
            try {
                Value v = obj.getValue(f);
                List<Object> pair = new ArrayList<>();
                pair.add(f.name());
                pair.add(describe(v, heap, visiting, thread));
                items.add(pair);
            } catch (Exception ignored) { }
            count++;
        }
        entry.put("items", items);
        entry.put("more", more);
        return entry;
    }

    private static Map<String, Object> ref(String id) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("__ref__", id);
        return m;
    }

    private static String truncateStr(String s) {
        if (s == null) return null;
        return s.length() > MAX_VALUE_LEN ? s.substring(0, MAX_VALUE_LEN) + "…" : s;
    }

    // ------------------------------------------------------------------
    // Minimal hand-rolled JSON writer — no library available without
    // network/build-tool access, and the output shape here (nested
    // Map/List/String/Number/Boolean/null) is simple enough not to need
    // one.
    private static void writeStepJson(StringBuilder out, Map<String, Object> step) {
        writeJson(out, step);
    }

    @SuppressWarnings("unchecked")
    private static void writeJson(StringBuilder out, Object value) {
        if (value == null) {
            out.append("null");
        } else if (value instanceof String) {
            out.append(jsonString((String) value));
        } else if (value instanceof Boolean || value instanceof Integer || value instanceof Long) {
            out.append(value.toString());
        } else if (value instanceof Double || value instanceof Float) {
            double d = ((Number) value).doubleValue();
            if (d == Math.floor(d) && !Double.isInfinite(d)) {
                out.append((long) d).append(".0");
            } else {
                out.append(d);
            }
        } else if (value instanceof Map) {
            out.append('{');
            boolean first = true;
            for (Map.Entry<String, Object> e : ((Map<String, Object>) value).entrySet()) {
                if (!first) out.append(',');
                first = false;
                out.append(jsonString(e.getKey())).append(':');
                writeJson(out, e.getValue());
            }
            out.append('}');
        } else if (value instanceof List) {
            out.append('[');
            boolean first = true;
            for (Object item : (List<Object>) value) {
                if (!first) out.append(',');
                first = false;
                writeJson(out, item);
            }
            out.append(']');
        } else {
            out.append(jsonString(value.toString()));
        }
    }

    private static String jsonString(String s) {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder();
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        sb.append('"');
        return sb.toString();
    }

    private static String jsonError(String message) {
        return "{\"error\":" + jsonString(message) + "}";
    }
}
