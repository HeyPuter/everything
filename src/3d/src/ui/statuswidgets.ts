// Status bar extension point, kept apart from the shell so modules that only add a widget
// (e.g. bake progress) don't pull the whole user interface into their imports.
import type { Child } from './h';

/** Extra status bar content (e.g. the progress of a running render job), drawn before reports. */
export const statusWidgets: (() => Child)[] = [];
