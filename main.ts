// Driver for the csv-reader-speed entry: the harness runs
// `node /bot/main.ts` (node22). It reads every case from
// /input/cases.json, answers each one alone with run() from solve.js, and
// writes /output/answers.json with the answers in the cases' order.
// Outside a container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in
// for /input and /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// Turn V8's incremental marking off before solve.js is imported, so all
// of its work runs under it (the rules allow an entry to tune V8's flags
// the same way the house baseline does).
setFlagsFromString('--no-incremental-marking');

// solve.js is a plain ES module, so import it by URL and take run.
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
};

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as {
  id: string;
  input: unknown;
}[];

const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));

writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
