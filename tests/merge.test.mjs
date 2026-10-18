// Runs SideStage's mergeStage over the merge cases shared with the Character
// Editor (stage-merge-cases.json; its worlds.merge_stage runs the same file).
// src/stage.js imports nothing from SillyTavern, so it is imported as it is.
// Run: node tests/merge.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeStage, mergeStage } from '../src/stage.js';

const { cases } = JSON.parse(readFileSync(new URL('./stage-merge-cases.json', import.meta.url), 'utf8'));
let failed = 0;

for (const c of cases) {
    const local = structuredClone(c.local);
    mergeStage(local, structuredClone(c.base), structuredClone(c.file));
    delete local.rev;
    delete local.group;

    try {
        assert.deepEqual(local, normalizeStage(structuredClone(c.merged)));
        console.log(`ok   ${c.name}`);
    } catch (error) {
        failed++;
        console.log(`FAIL ${c.name}\n${error.message}`);
    }
}

console.log(`${cases.length - failed}/${cases.length} merge cases pass`);
process.exitCode = failed ? 1 : 0;
