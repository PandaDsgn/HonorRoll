import { StateEffect, StateField, RangeSet } from '@codemirror/state';
import { Decoration, EditorView, gutterLineClass, GutterMarker } from '@codemirror/view';

// Highlights the line the IDE's Visualize panel is currently stepped to —
// both the line background and a marker in the existing line-number gutter
// (like a debugger's "current line" arrow). A StateField pair (not a plain
// prop) because CodeMirror 6 owns its own document/decoration state — the
// only way to change what's marked after the editor mounts is to dispatch a
// transaction, not re-render.
export const setExecLine = StateEffect.define();

export const execLineHighlightField = StateField.define({
  create() {
    return Decoration.none;
  },
  update(decorations, tr) {
    decorations = decorations.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setExecLine)) continue;
      if (effect.value == null) {
        decorations = Decoration.none;
      } else {
        const lineNumber = Math.min(Math.max(1, effect.value), tr.state.doc.lines);
        const line = tr.state.doc.line(lineNumber);
        decorations = Decoration.set([
          Decoration.line({ attributes: { class: 'cm-exec-line' } }).range(line.from),
        ]);
      }
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

class ExecLineGutterMarker extends GutterMarker {
  elementClass = 'cm-exec-line-gutter';
}
const execLineGutterMarker = new ExecLineGutterMarker();

export const execLineGutterField = StateField.define({
  create() {
    return RangeSet.empty;
  },
  update(markers, tr) {
    markers = markers.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setExecLine)) continue;
      if (effect.value == null) {
        markers = RangeSet.empty;
      } else {
        const lineNumber = Math.min(Math.max(1, effect.value), tr.state.doc.lines);
        const line = tr.state.doc.line(lineNumber);
        markers = RangeSet.of([execLineGutterMarker.range(line.from)]);
      }
    }
    return markers;
  },
  provide: (field) => gutterLineClass.from(field),
});

// Bundled together so call sites just spread one array into their
// extensions list instead of having to know both fields exist.
export const execLineExtensions = [execLineHighlightField, execLineGutterField];
