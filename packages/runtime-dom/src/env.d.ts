/**
 * Minimal typing for the `process.env.NODE_ENV !== 'production'` dev-code
 * convention. This package targets browsers: `process` is never expected at
 * runtime — bundlers (and the planned prod dist build) statically replace
 * `process.env.NODE_ENV`, so gated blocks are dropped from production output.
 */
declare const process: { env: { NODE_ENV?: string } };
