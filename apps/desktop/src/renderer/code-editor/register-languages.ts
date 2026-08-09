import { schemaFor } from '../file-schemas.js';
import { registerJsonCompletions, pathOf } from './json-completion.js';

/**
 * Language features, registered once for the window — issue #35.
 *
 * Monaco keeps providers per *language*, not per editor, so registering from a component would stack
 * a duplicate provider on every mount and offer every suggestion as many times as a tab had been
 * opened. Module scope is the honest place for something that is genuinely global.
 *
 * The lookup is the same registry the old editor used: a path decides which description applies, and
 * anything unmodelled offers nothing rather than something plausible.
 */

registerJsonCompletions((path) => schemaFor(path)?.shape);

export { pathOf };
