/**
 * Shared adapter contract. Every framework adapter builds the SAME logical
 * component tree per scenario from the shared data in ../scenarios/data.ts.
 */

export type ScenarioName =
    | 'small-page'
    | 'large-table'
    | 'large-table-1k'
    | 'deep-tree'
    | 'attr-style-heavy'
    | 'escape-heavy'
    | 'escape-clean';

export interface FrameworkAdapter {
    name: string;
    renderToString(scenario: ScenarioName): Promise<string>;
    /**
     * Streaming render: resolves TTFB (time to first chunk) and total time,
     * both in nanoseconds, plus total bytes written. Only implemented by
     * frameworks with node streaming support (sigx, Vue, React).
     */
    renderStream?(scenario: ScenarioName): Promise<{ ttfbNs: bigint; totalNs: bigint; bytes: number }>;
}
