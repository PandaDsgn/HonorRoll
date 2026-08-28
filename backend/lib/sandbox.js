// Sandboxed code execution + line-by-line trace engine — shared by
// Playground execution and graded problem submissions. Split out of
// index.js as part of breaking that monolith into modules. Pure
// relocation: nothing about ulimits, sandbox uid/gid, or any
// language's build/run config changed, only where it lives.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// backend/temp — used only by this module (student code execution dirs
// + the shared Go build cache). __dirname here is backend/lib, so '..'
// is needed to land in the same backend/temp directory index.js's own
// original tempDir pointed at.
const tempDir = path.join(__dirname, '..', 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir);
}

// ============================================================================
// Sandbox Runner â€” shared by Playground execution AND graded problem submissions
// ============================================================================

const LANGUAGE_CONFIG = {
  python: {
    filename: 'main.py',
    buildCmd: null,
    runCmd: ['python3', ['main.py']],
    memKb: 65536,   // ulimit -v, in KB
    cpuSec: 5,      // ulimit -t
  },
  c: {
    filename: 'main.c',
    buildCmd: ['gcc', ['main.c', '-o', 'program']],
    runCmd: ['./program', []],
    memKb: 65536,
    cpuSec: 5,
  },
  cpp: {
    filename: 'main.cpp',
    buildCmd: ['g++', ['main.cpp', '-o', 'program']],
    runCmd: ['./program', []],
    memKb: 98304,
    cpuSec: 5,
  },
  java: {
    filename: 'Main.java',
    // -J-Xmx / -Xmx cap the JVM's actual heap usage directly â€” this is the
    // correct way to limit Java memory. ulimit -v (virtual address space) is
    // NOT used for Java: JVMs reserve huge virtual address ranges on startup
    // (heap headroom, metaspace, JIT code cache, thread stacks) regardless of
    // real usage, so a tight -v limit kills the JVM before it can even print
    // an error â€” which is exactly what an empty-stderr "Compilation failed"
    // with no compiler output means.
    buildCmd: ['javac', ['-J-Xmx256m', 'Main.java']],
    runCmd: ['java', ['-Xmx256m', 'Main']],
    memKb: 262144,  // JVM baseline overhead is real â€” give it room
    cpuSec: 8,
    noVirtualMemLimit: true,
  },
  javascript: {
    filename: 'main.js',
    buildCmd: null,
    runCmd: ['node', ['main.js']],
    memKb: 131072,
    cpuSec: 5,
    // V8 reserves a large virtual address range on startup regardless of
    // actual usage, same reasoning as java's noVirtualMemLimit above.
    noVirtualMemLimit: true,
  },
  typescript: {
    filename: 'main.ts',
    // Plain `tsc main.ts` compiles to main.js next to it (no tsconfig/
    // --outFile needed for a single free-standing file) — exits non-zero on
    // type errors same as any other compiled language here, which is the
    // right behavior for a language whose whole point is catching those.
    buildCmd: ['tsc', ['main.ts']],
    runCmd: ['node', ['main.js']],
    memKb: 131072,
    cpuSec: 12,     // tsc's own startup + typechecking is slow relative to just running node
    noVirtualMemLimit: true,
    // tsc (and npm-installed CLIs generally) can fail or warn noisily
    // looking for a writable $HOME — see needsHome handling in
    // executeInSandboxRaw.
    needsHome: true,
  },
  go: {
    filename: 'main.go',
    // `go build main.go` (a file explicitly named on the command line)
    // compiles in "file mode," which — unlike `go build .` — doesn't
    // require a go.mod in the directory, so no extra module-init step
    // is needed for a single free-standing file.
    buildCmd: ['go', ['build', '-o', 'program', 'main.go']],
    runCmd: ['./program', []],
    memKb: 131072,
    cpuSec: 10,
    // The Go runtime reserves virtual address space up front like the
    // JVM/V8 above.
    noVirtualMemLimit: true,
    // The go tool always needs a writable $HOME to create its build cache
    // (GOCACHE defaults to $HOME/.cache/go-build) — without this it fails
    // outright rather than just warning, unlike tsc above.
    needsHome: true,
    // Without a persistent GOCACHE, every single run recompiles the entire
    // standard library dependency chain (fmt, reflect, sync, ...) from
    // scratch — slow enough on its own to risk the cpuSec budget, and one
    // of those intermediate package archives is what blew past the default
    // ulimit -f below on a cold cache. Reusing one shared dir across runs
    // (see GO_BUILD_CACHE_DIR in executeInSandboxRaw) fixes both: repeat
    // builds hit the cache instead of recompiling stdlib, and the file
    // that originally triggered "file too large" only gets written once.
    usesGoBuildCache: true,
    // Belt-and-braces on top of the cache fix above — a cold cache (this
    // instance's very first Go run) still needs to write that same large
    // intermediate archive at least once. Default 2048 blocks (1MB) is far
    // too tight for that; every other language's binaries/object files
    // stay well under this even at the default.
    fileBlocks: 65536, // ulimit -f, in 512-byte blocks (~32MB)
  },
  rust: {
    filename: 'main.rs',
    buildCmd: ['rustc', ['main.rs', '-o', 'program']],
    runCmd: ['./program', []],
    memKb: 131072,
    cpuSec: 10,
  },
  ruby: {
    filename: 'main.rb',
    buildCmd: null,
    runCmd: ['ruby', ['main.rb']],
    memKb: 65536,
    cpuSec: 5,
  },
  php: {
    filename: 'main.php',
    buildCmd: null,
    runCmd: ['php', ['main.php']],
    memKb: 65536,
    cpuSec: 5,
  },
};

// Dedicated low-privilege user that student code actually runs as, so a
// runaway/malicious submission can't touch the Express process, its env
// vars (DATABASE_URL, JWT_SECRET), or other students' temp files. Created
// in the Dockerfile with `useradd -m -s /usr/sbin/nologin sandbox`.
const SANDBOX_UID = Number(process.env.SANDBOX_UID || 1001);
const SANDBOX_GID = Number(process.env.SANDBOX_GID || 1001);

// Only the deployed container runs this process as root (see Dockerfile),
// which is what makes chown-ing temp files to the `sandbox` user and
// spawning as that uid possible. On local dev (your own Mac/Linux user
// account), there's no permission to do either and no uid 1001 to switch
// to, so we skip privilege-dropping entirely and just run as yourself â€”
// ulimits still apply either way, this only affects the extra user-isolation
// layer, which isn't needed against your own local test runs anyway.
const canDropPrivileges = typeof process.getuid === 'function' && process.getuid() === 0;

// Shared across every Go execution (unlike executionDir, this is never
// torn down) so the go tool's build cache actually does its job — see
// LANGUAGE_CONFIG.go's usesGoBuildCache comment for why a fresh cache per
// run defeats the point of having one at all. Only ever holds compiled
// standard-library package archives, not student source itself (each run's
// own main.go/program stay in its own disposable executionDir).
const GO_BUILD_CACHE_DIR = path.join(tempDir, '.gocache');

const { spawn } = require('child_process');

/**
 * Runs one command as the unprivileged `sandbox` user inside `cwd`, with
 * ulimits applied via a wrapping shell (ulimit is a shell builtin, not a
 * standalone binary, so it has to be set inside `sh -c` before exec'ing
 * the real program). Resolves { code, stdout, stderr, timedOut }.
 */
function runLimited(cwd, memKb, cpuSec, [cmd, args], stdinData = '', skipVirtualMemLimit = false, extraEnv = {}, fileBlocks = 2048) {
  return new Promise((resolve) => {
    const quotedArgs = args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
    // -v and -u are Linux-only here. -v breaks dyld's shared-library loading
    // on macOS (see above); -u (max processes) is worse on macOS because
    // RLIMIT_NPROC counts every process owned by the user SYSTEM-WIDE, not
    // just this command's subtree â€” any real dev machine already exceeds a
    // limit like 32 before compilation even starts, since Chrome/VS
    // Code/Docker Desktop/etc. all run under the same uid. Both are meaningful
    // and safe on Linux (production), where the container has its own
    // isolated process namespace with nothing else running under that uid.
    const isMac = process.platform === 'darwin';
    // Each ulimit call is wrapped with `2>/dev/null || true` so an unsupported
    // flag on whatever /bin/sh is actually running this (dash, BusyBox ash,
    // etc. all differ slightly) can never abort the script or leak a shell
    // error into stderr where it'd look like the program itself failed. The
    // limit just silently doesn't apply on shells that don't support it,
    // rather than breaking every submission in that language.
    const memLimitLine = (isMac || skipVirtualMemLimit) ? '' : `ulimit -v ${memKb} 2>/dev/null || true;`;
    const procLimitLine = isMac ? '' : `ulimit -u 32 2>/dev/null || true;`;
    const shellLine = `${memLimitLine} ulimit -t ${cpuSec} 2>/dev/null || true; ${procLimitLine} ulimit -f ${fileBlocks} 2>/dev/null || true; exec ${cmd} ${quotedArgs}`;

    const child = spawn('sh', ['-c', shellLine], {
      cwd,
      ...(canDropPrivileges ? { uid: SANDBOX_UID, gid: SANDBOX_GID } : {}),
      timeout: (cpuSec + 3) * 1000,
      env: { PATH: process.env.PATH, ...extraEnv },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.on('data', (d) => { if (stdout.length < 1_000_000) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < 1_000_000) stderr += d; });
    child.on('error', (err) => resolve({ code: 1, stdout, stderr: err.message, timedOut: false }));
    child.on('close', (code, signal) => {
      if (signal === 'SIGTERM') timedOut = true;
      resolve({ code, stdout, stderr, timedOut });
    });

    // If the child exits (or never reads stdin at all) before this write
    // finishes, the pipe closes underneath us and .write() throws EPIPE.
    // Without this handler that's an UNCAUGHT exception that crashes the
    // entire Node process â€” not just this one request â€” taking every
    // student's session down with it. The 'close' listener above still
    // resolves this promise normally either way, so silently swallowing the
    // write error here is safe: we just don't fail to deliver stdin to a
    // process that was never going to read it anyway.
    child.stdin.on('error', () => {});
    try {
      child.stdin.write(stdinData ?? '');
      child.stdin.end();
    } catch {
      // Same reasoning as above â€” pipe already gone, nothing to do.
    }
  });
}

/**
 * Runs `code` as the unprivileged `sandbox` user with per-language memory/
 * CPU ulimits, and returns its stdout. No Docker involved â€” this is what
 * lets the whole app run on a plain Render web service with no privileged
 * container access, at the cost of weaker filesystem/network isolation
 * than the old Docker version (acceptable for beginner-level submissions,
 * not a substitute for real container sandboxing against adversarial code).
 */
async function executeInSandboxRaw(language, code, stdin = '') {
  const config = LANGUAGE_CONFIG[language];
  if (!config) {
    return { success: false, timedOut: false, output: '', error: 'Unsupported language' };
  }

  const executionDir = path.join(tempDir, crypto.randomUUID());
  fs.mkdirSync(executionDir, { recursive: true, mode: 0o770 });

  const cleanup = () => {
    if (fs.existsSync(executionDir)) fs.rmSync(executionDir, { recursive: true, force: true });
  };

  try {
    fs.writeFileSync(path.join(executionDir, config.filename), code);
    if (canDropPrivileges) {
      fs.chownSync(executionDir, SANDBOX_UID, SANDBOX_GID);
      fs.chownSync(path.join(executionDir, config.filename), SANDBOX_UID, SANDBOX_GID);
    }
  } catch (err) {
    cleanup();
    return { success: false, timedOut: false, output: '', error: 'Failed to prepare execution files' };
  }

  // Some toolchains (go, tsc) need a writable $HOME for their own cache
  // dirs — executionDir is already chowned to the sandbox user above and
  // gets torn down with everything else in cleanup(), so it doubles as a
  // safe, per-run HOME with nothing left behind between runs.
  const extraEnv = config.needsHome ? { HOME: executionDir } : {};

  if (config.usesGoBuildCache) {
    fs.mkdirSync(GO_BUILD_CACHE_DIR, { recursive: true, mode: 0o770 });
    if (canDropPrivileges) fs.chownSync(GO_BUILD_CACHE_DIR, SANDBOX_UID, SANDBOX_GID);
    // Overrides the $HOME-derived default above with the persistent dir —
    // go still wants a writable $HOME for other bookkeeping, but the build
    // cache itself should outlive this one executionDir.
    extraEnv.GOCACHE = GO_BUILD_CACHE_DIR;
  }

  if (config.buildCmd) {
    const build = await runLimited(executionDir, config.memKb, config.cpuSec, config.buildCmd, '', config.noVirtualMemLimit, extraEnv, config.fileBlocks);
    if (build.code !== 0) {
      cleanup();
      return { success: false, timedOut: build.timedOut, output: '', error: build.stderr || 'Compilation failed' };
    }
  }

  const run = await runLimited(executionDir, config.memKb, config.cpuSec, config.runCmd, stdin, config.noVirtualMemLimit, extraEnv, config.fileBlocks);
  cleanup();

  if (run.timedOut) {
    return { success: false, timedOut: true, output: '', error: 'Execution timed out (Infinite loop detected)' };
  }
  if (run.code !== 0) {
    return { success: false, timedOut: false, output: '', error: run.stderr || `Exited with code ${run.code}` };
  }
  return { success: true, timedOut: false, output: run.stdout, error: null };
}

// Caps how many student programs run at once on this instance. Without this,
// a deadline-night burst spawns dozens of compilers/interpreters simultaneously
// and starves the box (and this Express process along with it). Tune the
// number to your Render plan's actual vCPU count â€” don't exceed it for
// compile-heavy languages (C/C++/Java). Requires: npm install p-limit
const pLimit = require('p-limit');
const sandboxLimit = pLimit(Number(process.env.SANDBOX_CONCURRENCY || 4));

function executeInSandbox(language, code, stdin = '') {
  return sandboxLimit(() => executeInSandboxRaw(language, code, stdin));
}

// ============================================================================
// Execution Tracer â€” line-by-line trace for the IDE's "Visualize" panel
// ============================================================================

// Per-language config for the trace feature, deliberately separate from
// LANGUAGE_CONFIG above: tracing needs a language-specific harness script
// (see backend/tracers/), not just a run command, and only a subset of
// languages have one yet. A language missing here just gets a "not
// available yet" response from the route below — everything else about it
// (editing, running via LANGUAGE_CONFIG) keeps working as normal.
const TRACE_CONFIG = {
  python: {
    filename: 'main.py',
    tracerSource: path.join(__dirname, '..', 'tracers', 'python_tracer.py'),
    tracerFilename: 'tracer.py',
    interpreter: 'python3',
    memKb: 98304,
    cpuSec: 8, // tracing overhead is real â€” give it more headroom than a plain run
  },
  javascript: {
    filename: 'main.js',
    tracerSource: path.join(__dirname, '..', 'tracers', 'js_tracer.js'),
    tracerFilename: 'tracer.js',
    interpreter: 'node',
    memKb: 131072,
    cpuSec: 10,
    // V8 reserves a large virtual address range on startup regardless of
    // actual usage — same reasoning as LANGUAGE_CONFIG.javascript's own
    // noVirtualMemLimit, and just as necessary here: without it, node
    // itself fails to start under a tight ulimit -v before ever reaching
    // the student's code.
    noVirtualMemLimit: true,
  },
  typescript: {
    filename: 'main.ts',
    tracerSource: path.join(__dirname, '..', 'tracers', 'ts_tracer.js'),
    tracerFilename: 'tracer.js',
    // ts_tracer.js shells out to js_tracer.js by relative path — has to be
    // copied alongside it in the same executionDir (see extraFiles handling
    // above) since __dirname inside a copied file resolves to wherever it
    // was copied TO, not tracers/ where it actually lives on disk.
    extraFiles: [path.join(__dirname, '..', 'tracers', 'js_tracer.js')],
    interpreter: 'node',
    memKb: 131072,
    cpuSec: 15, // tsc's own compile step first, then a full JS trace on top
    noVirtualMemLimit: true,
    needsHome: true, // tsc needs a writable $HOME, same as plain execution's own LANGUAGE_CONFIG.typescript
    needsNodeModules: true, // ts_tracer.js requires source-map-js
  },
  ruby: {
    filename: 'main.rb',
    tracerSource: path.join(__dirname, '..', 'tracers', 'ruby_tracer.rb'),
    tracerFilename: 'tracer.rb',
    interpreter: 'ruby',
    memKb: 98304,
    cpuSec: 8,
  },
  php: {
    filename: 'main.php',
    tracerSource: path.join(__dirname, '..', 'tracers', 'php_tracer.php'),
    tracerFilename: 'tracer.php',
    interpreter: 'php',
    memKb: 98304,
    cpuSec: 8,
  },
  // c_tracer.py itself compiles the student's source (with lldb, not gcc's
  // own -o step here — it needs the exact same compiler either way) and
  // drives lldb as a batch script; it tells C and C++ apart purely from
  // the student filename's own extension (see its main()), so one script
  // backs both entries here.
  c: {
    filename: 'main.c',
    tracerSource: path.join(__dirname, '..', 'tracers', 'c_tracer.py'),
    tracerFilename: 'tracer.py',
    interpreter: 'python3',
    memKb: 131072,
    cpuSec: 25, // compile + a batch of up to ~1200 lldb commands is slower than plain interpretation
  },
  cpp: {
    filename: 'main.cpp',
    tracerSource: path.join(__dirname, '..', 'tracers', 'c_tracer.py'),
    tracerFilename: 'tracer.py',
    interpreter: 'python3',
    memKb: 131072,
    cpuSec: 25,
  },
  rust: {
    filename: 'main.rs',
    tracerSource: path.join(__dirname, '..', 'tracers', 'rust_tracer.py'),
    tracerFilename: 'tracer.py',
    interpreter: 'python3',
    memKb: 131072,
    // rustc + rust-lldb driving a 3x-oversized batch (extra headroom to
    // absorb unrecorded steps spent bouncing through std library
    // internals — see rust_tracer.py's own comment) measured ~25s wall
    // clock for a truncated (MAX_STEPS-hitting) trace, at only ~28% CPU
    // utilization — mostly waiting on subprocess I/O, not burning CPU.
    // That matters here specifically: runLimited's own child_process
    // `timeout` option (see below) is wall-clock (cpuSec + 3 seconds),
    // not CPU-time — a low-CPU-utilization process like this one would
    // hit THAT wall before ulimit -t's actual CPU-time limit ever does,
    // so cpuSec needs real margin above the observed wall-clock time, not
    // just above true CPU seconds consumed.
    cpuSec: 60,
  },
  // JdiTracer.java is precompiled (not run as source through an
  // interpreter) — it IS the debugger client, using com.sun.jdi (the Java
  // Debug Interface) directly rather than driving an external tool the
  // way c_tracer.py/rust_tracer.py drive lldb. It compiles the student's
  // own Main.java itself, then launches a SEPARATE JVM under debug
  // control to trace — two live JVMs at once (this tracer's own, plus the
  // one it launches), hence the generous memKb.
  java: {
    filename: 'Main.java',
    tracerSource: path.join(__dirname, '..', 'tracers', 'JdiTracer.class'),
    tracerFilename: 'JdiTracer.class',
    tracerIsClassName: true,
    interpreter: 'java',
    memKb: 393216,
    cpuSec: 20,
    noVirtualMemLimit: true, // same reasoning as LANGUAGE_CONFIG.java's own plain-execution entry — a JVM reserves large virtual address space up front regardless of actual usage
  },
  // go_tracer.py compiles the student's source with `go build` (same
  // -gcflags=all=-N -l delve itself always applies, done explicitly here
  // so a real compile error surfaces as this tracer's own clean message)
  // then drives delve's ("dlv") real JSON-RPC-over-TCP debugger API —
  // structurally closer to JdiTracer.java than to the lldb-based C/Rust
  // tracers' text scraping. Requires `dlv` on PATH (same as `go` already
  // is for LANGUAGE_CONFIG.go's plain-execution entry).
  go: {
    filename: 'main.go',
    tracerSource: path.join(__dirname, '..', 'tracers', 'go_tracer.py'),
    tracerFilename: 'tracer.py',
    interpreter: 'python3',
    memKb: 131072,
    needsHome: true, // `go build` needs a writable $HOME for its build cache (GOCACHE) — same reasoning as TRACE_CONFIG.typescript's own tsc requirement
    // Same fix as LANGUAGE_CONFIG.go's own usesGoBuildCache — without a
    // persistent GOCACHE, every trace request recompiles the entire
    // standard library from a cold cache, which is both slow enough to
    // risk cpuSec and produces a large intermediate archive that can blow
    // past the default ulimit -f.
    usesGoBuildCache: true,
    fileBlocks: 65536,

    // Measured worst case (a MAX_STEPS-truncating trace): ~12.6s wall /
    // ~13.7s combined CPU (compiler + dlv + the traced binary all running
    // at once — unlike Rust's I/O-bound lldb driving, this is genuinely
    // CPU-heavy across multiple processes). cpuSec needs margin above
    // BOTH numbers, since runLimited's own child_process `timeout` is
    // wall-clock (cpuSec + 3s), not CPU-time.
    cpuSec: 30,
  },
};

/**
 * Runs `code` once under its language's tracer harness and returns the
 * parsed { steps, finalOutput, truncated, error } trace. Same sandboxed,
 * unprivileged-user, run-once model as executeInSandboxRaw above â€” the
 * harness itself (not this function) is responsible for capping trace size
 * and running the student program to completion even past that cap.
 */
async function executeTraceRaw(language, code, stdin = '') {
  const config = TRACE_CONFIG[language];
  if (!config) {
    return { success: false, error: `Line-by-line tracing isn't available for ${language} yet.` };
  }

  const executionDir = path.join(tempDir, crypto.randomUUID());
  fs.mkdirSync(executionDir, { recursive: true, mode: 0o770 });

  const cleanup = () => {
    if (fs.existsSync(executionDir)) fs.rmSync(executionDir, { recursive: true, force: true });
  };

  const studentPath = path.join(executionDir, config.filename);
  const tracerPath = path.join(executionDir, config.tracerFilename);

  try {
    fs.writeFileSync(studentPath, code);
    fs.copyFileSync(config.tracerSource, tracerPath);
    // TypeScript's tracer is a thin wrapper that shells out to js_tracer.js
    // by relative path (__dirname/js_tracer.js) — __dirname resolves to
    // THIS execution dir once copied here, not the real backend/tracers/
    // source dir, so js_tracer.js has to be copied alongside it for that
    // relative require/exec to find it. Every other TRACE_CONFIG entry
    // needs nothing extra here, so extraFiles is empty/undefined for them.
    for (const extra of config.extraFiles || []) {
      fs.copyFileSync(extra, path.join(executionDir, path.basename(extra)));
    }
    if (canDropPrivileges) {
      fs.chownSync(executionDir, SANDBOX_UID, SANDBOX_GID);
      fs.chownSync(studentPath, SANDBOX_UID, SANDBOX_GID);
      fs.chownSync(tracerPath, SANDBOX_UID, SANDBOX_GID);
      for (const extra of config.extraFiles || []) {
        fs.chownSync(path.join(executionDir, path.basename(extra)), SANDBOX_UID, SANDBOX_GID);
      }
    }
  } catch (err) {
    cleanup();
    return { success: false, error: 'Failed to prepare trace files' };
  }

  // NODE_PATH lets a tracer running from the sandboxed executionDir (well
  // outside backend/) still `require()` this project's own node_modules —
  // ts_tracer.js needs source-map-js, which Node's normal upward node_modules
  // walk would never reach from a temp dir. Nothing else needs this, so
  // config.needsNodeModules is unset (falsy) for every other language.
  const extraEnv = {
    ...(config.needsHome ? { HOME: executionDir } : {}),
    ...(config.needsNodeModules ? { NODE_PATH: path.join(__dirname, '..', 'node_modules') } : {}),
  };
  // Same persistent-cache fix as executeInSandboxRaw's own usesGoBuildCache
  // handling — go_tracer.py's `go build` step would otherwise recompile
  // the entire standard library from scratch on every single trace request.
  if (config.usesGoBuildCache) {
    fs.mkdirSync(GO_BUILD_CACHE_DIR, { recursive: true, mode: 0o770 });
    if (canDropPrivileges) fs.chownSync(GO_BUILD_CACHE_DIR, SANDBOX_UID, SANDBOX_GID);
    extraEnv.GOCACHE = GO_BUILD_CACHE_DIR;
  }
  // JdiTracer.java runs as `java JdiTracer <studentPath>` — a compiled
  // class invoked BY NAME, not `java <path-to-.class-file> <arg>` the way
  // every interpreted-language tracer above passes its own tracerPath —
  // config.tracerIsClassName carries that: the .class runs from
  // executionDir (already this command's cwd, Java's own default
  // classpath) via its bare class name (tracerFilename minus ".class")
  // instead of the usual full tracerPath.
  const tracerArgs = config.tracerIsClassName
    ? [config.tracerFilename.replace(/\.class$/, ''), studentPath]
    : [tracerPath, studentPath];
  const run = await runLimited(executionDir, config.memKb, config.cpuSec, [config.interpreter, tracerArgs], stdin, config.noVirtualMemLimit, extraEnv, config.fileBlocks);
  cleanup();

  if (run.timedOut) {
    return { success: false, error: 'Execution timed out (infinite loop detected)' };
  }
  if (run.code !== 0) {
    return { success: false, error: run.stderr || `Tracer exited with code ${run.code}` };
  }

  let trace;
  try {
    trace = JSON.parse(run.stdout);
  } catch {
    return { success: false, error: 'Trace generation failed unexpectedly.' };
  }
  // A harness-reported error with no steps at all means the program never
  // started (e.g. a SyntaxError) â€” treat that like a failed build, not a
  // trace. An error WITH steps (an uncaught runtime exception mid-program)
  // is still a successful, scrubbable trace â€” the frontend shows the error
  // on its final step.
  if (trace.error && (!trace.steps || trace.steps.length === 0)) {
    return { success: false, error: trace.error };
  }
  return { success: true, trace };
}

function executeTrace(language, code, stdin = '') {
  return sandboxLimit(() => executeTraceRaw(language, code, stdin));
}

function normalizeOutput(str) {
  return (str ?? '').replace(/\r\n/g, '\n').trim();
}

module.exports = {
  LANGUAGE_CONFIG,
  TRACE_CONFIG,
  executeInSandbox,
  executeTrace,
  normalizeOutput,
};
