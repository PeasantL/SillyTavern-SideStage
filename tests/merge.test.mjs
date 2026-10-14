// Runs SideStage's mergeStage over the merge cases shared with the Character
// Editor (stage-merge-cases.json; its worlds.merge_stage runs the same file).
// index.js imports SillyTavern's modules, so the functions are read out of its
// source rather than imported. Run: node tests/merge.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const source = read('../index.js');

/** The source of a top-level function in index.js, by name. */
function grab(name) {
    const start = source.indexOf(`\nfunction ${name}(`);
    assert.notEqual(start, -1, `index.js has no function ${name}`);
    let depth = 0;

    for (let i = source.indexOf('{', source.indexOf(')', start)); i < source.length; i++) {
        if (source[i] === '{') {
            depth++;
        } else if (source[i] === '}' && --depth === 0) {
            return source.slice(start, i + 1);
        }
    }

    throw new Error(`Unbalanced braces in ${name}`);
}

const { normalizeStage, mergeStage } = new Function(
    `${['normalizeStage', 'mergeKeys', 'mergeStage'].map(grab).join('\n')}\nreturn { normalizeStage, mergeStage };`)();

const { cases } = JSON.parse(read('./stage-merge-cases.json'));
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
