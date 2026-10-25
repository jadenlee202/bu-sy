// Print the snapshot for one synthetic fixture. Local calculation only; no network.
// Usage: node demo.mjs [caseIndex]
import { readFileSync } from 'node:fs';
import { buildSnapshot } from './src/availability.mjs';

const { cases } = JSON.parse(readFileSync(new URL('./fixtures/snapshot-cases.json', import.meta.url), 'utf8'));
const i = Number(process.argv[2] ?? 0);
if (!cases[i]) {
  console.error(`case index must be 0..${cases.length - 1}`);
  cases.forEach((c, n) => console.error(`  ${n}: ${c.name}`));
  process.exit(1);
}
console.log(`# ${cases[i].name}`);
console.log(JSON.stringify(buildSnapshot(cases[i].input), null, 2));
