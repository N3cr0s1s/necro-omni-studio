import { type ReactNode, Suspense, lazy } from 'react';
import type { CodeEditorProps } from './CodeEditor.js';

/**
 * The code editor, loaded when something first needs to edit text — issue #35.
 *
 * Monaco is four megabytes, which is a reasonable price for a real editor and an unreasonable one to
 * pay at launch. Nothing in the ordinary path through this application edits text: you open a
 * project, you cut, you export. The editor is a tab you deliberately open, so it is a chunk you
 * deliberately fetch.
 *
 * This matters more than bundle size usually does here. The spec fixes a 16 ms timeline budget and
 * `perfcheck` guards it; parsing four megabytes of editor before the first frame is drawn is exactly
 * the kind of cost that does not show up in any test and is felt every single launch.
 *
 * The fallback is deliberately plain. A spinner over an empty rectangle for a hundred milliseconds
 * reads as a stall; the file's own name reads as the file opening, which is what is happening.
 */

const CodeEditor = lazy(async () => {
  /*
   * The language features come with it, deliberately.
   *
   * `register-languages` registers Monaco's providers as a module side effect, so it must run once
   * and only after Monaco exists. Importing it eagerly anywhere would drag Monaco into the startup
   * bundle and undo this whole module; importing it here ties its lifetime to the editor's.
   */
  const [module] = await Promise.all([import('./CodeEditor.js'), import('./register-languages.js')]);
  return { default: module.CodeEditor };
});

export function LazyCodeEditor(props: CodeEditorProps): ReactNode {
  return (
    <Suspense
      fallback={
        <div className="text-muted-foreground flex size-full items-start p-4 font-mono text-xs">
          opening {props.path}…
        </div>
      }
    >
      <CodeEditor {...props} />
    </Suspense>
  );
}

export type { CodeEditorProps, CodeMarker } from './CodeEditor.js';
