// TypeScript line-by-line tracer for the IDE's Visualize feature — a thin
// wrapper around js_tracer.js rather than a tracer in its own right.
// TypeScript has no runtime of its own (V8 only ever executes the compiled
// JS), so this: 1) compiles the student's .ts to .js with tsc, emitting a
// source map, 2) runs js_tracer.js against the COMPILED .js exactly as if
// it were a JS submission, 3) remaps every step's line number from the
// compiled JS back to the student's own .ts source via that source map,
// so what the student sees lines up with the file they actually wrote,
// not the emitted JS (which for many TS constructs — enums, decorators,
// interfaces stripped away — doesn't share the same line count at all).
//
// Usage: node ts_tracer.js <path-to-student-source.ts>
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { SourceMapConsumer } = require('source-map-js');

function fail(message) {
  process.stdout.write(JSON.stringify({ error: message }));
}

function main() {
  const studentPath = process.argv[2];
  if (!studentPath) return fail('No source file provided to tracer.');
  if (!fs.existsSync(studentPath)) return fail(`Could not read source: ${studentPath} not found`);

  const dir = path.dirname(studentPath);
  const jsPath = studentPath.replace(/\.ts$/, '.js');
  const mapPath = `${jsPath}.map`;

  try {
    // --outDir the same directory the .ts already lives in (matches plain
    // `tsc main.ts` compiling next to itself, same as LANGUAGE_CONFIG's own
    // build step for ordinary — non-traced — TypeScript execution). tsc
    // writes its own diagnostics to STDOUT, not stderr (verified — an
    // unrelated tool convention, not a typo) — piping stdout is what
    // actually captures a type/syntax error message here.
    execFileSync('tsc', ['--sourceMap', '--outDir', dir, studentPath], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    const stdout = e.stdout ? e.stdout.toString().trim() : e.message;
    return fail(`TypeScript compile error: ${stdout.split('\n')[0] || 'compilation failed'}`);
  }

  if (!fs.existsSync(jsPath)) return fail('TypeScript compiled with no output.');

  let raw;
  try {
    raw = execFileSync('node', [path.join(__dirname, 'js_tracer.js'), jsPath], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  } catch (e) {
    return fail(`Tracer failed: ${e.message}`);
  }

  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    return fail('Trace generation failed unexpectedly.');
  }
  if (!result.steps || result.steps.length === 0) {
    process.stdout.write(raw);
    return;
  }

  if (fs.existsSync(mapPath)) {
    const rawMap = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    const consumer = new SourceMapConsumer(rawMap);
    result.steps = result.steps.filter((step) => {
      // column 0 was tried first and is wrong: tsc's mappings for an
      // indented statement only start at the column where the real code
      // begins (e.g. 4, past the leading whitespace) — querying column 0
      // lands strictly before that segment and comes back completely
      // unmapped even on lines that DO have a real TS source line. A large
      // column instead reliably lands on the LAST mapping segment that
      // line actually has, which is what's wanted here anyway (this is a
      // line-level trace, not a column-precise one).
      const pos = consumer.originalPositionFor({ line: step.line, column: 99999 });
      if (pos && pos.line != null) {
        step.line = pos.line;
        return true;
      }
      // No original position at all means this line is tsc's own
      // boilerplate ("use strict", the trailing //# sourceMappingURL
      // comment) with no correspondence to anything the student wrote —
      // drop the step rather than show a line number pointing at code
      // that doesn't exist in their .ts file.
      return false;
    });
  }

  process.stdout.write(JSON.stringify(result));
}

main();
