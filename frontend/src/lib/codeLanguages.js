import { python } from '@codemirror/lang-python';
import { cpp } from '@codemirror/lang-cpp';
import { java } from '@codemirror/lang-java';
import { javascript } from '@codemirror/lang-javascript';
import { go } from '@codemirror/lang-go';
import { rust } from '@codemirror/lang-rust';
import { php } from '@codemirror/lang-php';
import { StreamLanguage } from '@codemirror/language';
import { ruby as rubyMode } from '@codemirror/legacy-modes/mode/ruby';

// Every language the code judge/IDE supports, shared by every page that
// renders a language picker + CodeMirror editor (IDE.jsx, Sandbox.jsx,
// ExamAttempt.jsx, ScanCapture.jsx, AssignmentForm.jsx, ExamForm.jsx) so
// the list can't drift between them. `id` must match backend/index.js's
// LANGUAGE_CONFIG keys exactly — that's what actually gets sent to
// POST /api/playground/execute/:language and /api/problems/:id/submit.
//
// `traceSupported` mirrors backend/index.js's TRACE_CONFIG keys — only
// languages with a tracer harness (see backend/tracers/) can back the IDE's
// "Visualize" line-by-line panel. Flip it on here once a language gets one;
// nothing else in IDE.jsx needs to change.
export const CODE_LANGUAGES = [
  { id: 'python', label: 'Python', dot: '#60a5fa', traceSupported: true },
  { id: 'c', label: 'C', dot: '#a78bfa', traceSupported: true },
  { id: 'cpp', label: 'C++', dot: '#f43f5e', traceSupported: true },
  { id: 'java', label: 'Java', dot: '#f472b6', traceSupported: true },
  { id: 'javascript', label: 'JavaScript', dot: '#f7df1e', traceSupported: true },
  { id: 'typescript', label: 'TypeScript', dot: '#3178c6', traceSupported: true },
  { id: 'go', label: 'Go', dot: '#00add8', traceSupported: true },
  { id: 'rust', label: 'Rust', dot: '#dea584', traceSupported: true },
  { id: 'ruby', label: 'Ruby', dot: '#cc342d', traceSupported: true },
  { id: 'php', label: 'PHP', dot: '#8892be', traceSupported: true },
];

const LANG_EXT = {
  python: 'py', c: 'c', cpp: 'cpp', java: 'java', javascript: 'js',
  typescript: 'ts', go: 'go', rust: 'rs', ruby: 'rb', php: 'php',
};

// Builds the file-tab chip name each page shows above its editor — IDE.jsx
// uses "main.py"/"Main.java", Sandbox.jsx uses "solution.py"/"Solution.java";
// baseName carries that per-page convention, capitalized for Java only
// (matching a real `public class Main`/`public class Solution` entry point).
export function codeFileName(languageId, baseName) {
  const ext = LANG_EXT[languageId] || 'txt';
  const base = languageId === 'java' ? baseName.charAt(0).toUpperCase() + baseName.slice(1) : baseName;
  return `${base}.${ext}`;
}

// Ruby has no first-class @codemirror/lang-ruby package (unlike the others
// here) — @codemirror/legacy-modes ports CodeMirror 5's stream-based modes
// for exactly this gap, wrapped via StreamLanguage.define.
export function getCodeMirrorExtension(languageId) {
  if (languageId === 'python') return [python()];
  if (languageId === 'c' || languageId === 'cpp') return [cpp()];
  if (languageId === 'java') return [java()];
  if (languageId === 'javascript') return [javascript()];
  if (languageId === 'typescript') return [javascript({ typescript: true })];
  if (languageId === 'go') return [go()];
  if (languageId === 'rust') return [rust()];
  if (languageId === 'ruby') return [StreamLanguage.define(rubyMode)];
  if (languageId === 'php') return [php()];
  return [];
}

export const HELLO_WORLD_CODE = {
  python: 'print("Hello, world!")\n',
  c: '#include <stdio.h>\n\nint main(void) {\n    printf("Hello, world!\\n");\n    return 0;\n}\n',
  cpp: '#include <iostream>\n\nint main() {\n    std::cout << "Hello, world!\\n";\n    return 0;\n}\n',
  java: 'public class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello, world!");\n    }\n}\n',
  javascript: 'console.log("Hello, world!");\n',
  typescript: 'const message: string = "Hello, world!";\nconsole.log(message);\n',
  go: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("Hello, world!")\n}\n',
  rust: 'fn main() {\n    println!("Hello, world!");\n}\n',
  ruby: 'puts "Hello, world!"\n',
  php: '<?php\necho "Hello, world!\\n";\n',
};
