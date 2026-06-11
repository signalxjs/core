/**
 * DOM platform identity — the side effects that make this package the
 * platform: the form model processor (two-way `model={...}` binding on
 * native inputs/checkboxes/radios/selects/textareas) and the default
 * mount registration (evaluating the render machinery).
 *
 * Built as its own dist entry (`@sigx/runtime-dom/platform`) and named in
 * `sideEffects`, so bundlers preserve it even while tree-shaking pure
 * re-export chains. `sigx`'s entries import this subpath explicitly.
 */

import './model-processor.js';
import './render.js';
