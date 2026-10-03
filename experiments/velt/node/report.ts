/** Prints the run.sh results (JSON lines) as a markdown table: median ms and speedup vs Node. */
import { readFileSync } from 'node:fs';

type Row = { runtime: string; scenario: string; bytes: number; ms: number };
const rows: Row[] = readFileSync(process.argv[2], 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const label = (r: string) => (r === 'node' ? 'Node + sigx' : r === 'out/velt' ? 'Velt (generic)' : 'Velt (precompile)');
const runtimes = [...new Set(rows.map((r) => r.runtime))];
const scenarios = [...new Set(rows.map((r) => r.scenario))];
console.log(`\n| scenario | bytes | ${runtimes.map(label).join(' | ')} |`);
console.log(`|---|---:|${runtimes.map(() => '---:').join('|')}|`);
for (const s of scenarios) {
    const node = rows.find((r) => r.scenario === s && r.runtime === 'node')!;
    const cells = runtimes.map((rt) => {
        const r = rows.find((x) => x.scenario === s && x.runtime === rt)!;
        const ms = r.ms < 1 ? r.ms.toFixed(3) : r.ms.toFixed(1);
        return rt === 'node' ? `${ms} ms` : `${ms} ms (${(node.ms / r.ms).toFixed(1)}×)`;
    });
    console.log(`| ${s} | ${node.bytes} | ${cells.join(' | ')} |`);
}
