/**
 * DOM platform identity — the side effects that make this package the
 * platform: the form model processor (two-way `model={...}` binding on
 * native inputs/checkboxes/radios/selects/textareas), the default mount
 * registration (evaluating the render machinery), and the standard
 * built-in directives (`show`) whose JSX types are globally visible and
 * therefore must always resolve at runtime.
 *
 * Built as its own dist entry (`@sigx/runtime-dom/platform`) and named in
 * `sideEffects`, so bundlers preserve it even while tree-shaking pure
 * re-export chains. `sigx`'s entries import this subpath explicitly.
 *
 * Custom and pack directives register through the seams instead:
 * `app.directive(name, def)` per app, or `registerBuiltInDirective()`
 * globally.
 */

import './model-processor.js';
import './render.js';

import { registerBuiltInDirective } from './directives.js';
import { show } from './directives/show.js';
registerBuiltInDirective('show', show);
