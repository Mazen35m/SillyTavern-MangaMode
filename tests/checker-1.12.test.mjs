// Run: node tests/checker-1.12.test.mjs - the confirming second look of the quality check (pure logic).
import assert from 'node:assert/strict';
import { confirmVerdict } from '../vision-check.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };
const verdict = (pass, reasons = [], major = false, extra = {}) => ({ pass, reasons, major, answer: { score: pass ? 9 : 5 }, ...extra });

test('a passing first look is final, no second look is needed', () => {
    const first = verdict(true);
    assert.equal(confirmVerdict(first, verdict(false, ['x'])), first);
    assert.equal(confirmVerdict(first, null), first);
});

test('no second look (it failed to run): the first verdict stands', () => {
    const first = verdict(false, ['the young woman is not doing what was described'], false);
    assert.equal(confirmVerdict(first, null), first);
});

test('the second look passes: the picture is accepted (the checker contradicted itself)', () => {
    const out = confirmVerdict(verdict(false, ['a unlisted main figure(s)'], true), verdict(true));
    assert.equal(out.pass, true);
    assert.equal(out.major, false);
    assert.deepEqual(out.reasons, []);
    assert.deepEqual(out.overruled, ['a unlisted main figure(s)']);
});

test('both looks fail for the same reason: the fault stands (label and bracketed detail are ignored when comparing)', () => {
    const a = verdict(false, ['the nora-eyed young woman is not doing what was described (box)', 'prominent lettering in the picture'], false);
    const b = verdict(false, ['the nora-eyed young woman is not doing what was described', 'the action is not clearly shown'], false);
    const out = confirmVerdict(a, b);
    assert.equal(out.pass, false);
    assert.deepEqual(out.reasons, ['the nora-eyed young woman is not doing what was described']);
});

test('two looks that complain about different things are noise: accepted', () => {
    const out = confirmVerdict(verdict(false, ['prominent lettering in the picture']), verdict(false, ['partly blank background']));
    assert.equal(out.pass, true);
    assert.deepEqual(out.reasons, []);
});

test('"major" (immediate redraw) needs both looks to find a major fault', () => {
    const same = ['Kai missing'];
    assert.equal(confirmVerdict(verdict(false, same, true), verdict(false, same, true)).major, true);
    assert.equal(confirmVerdict(verdict(false, same, true), verdict(false, same, false)).major, false);
    assert.equal(confirmVerdict(verdict(false, same, false), verdict(false, same, true)).major, false);
});

test('the second look\'s answer is kept (its head boxes feed the crop and the balloons)', () => {
    const second = verdict(true, [], false, { answer: { score: 9, heads: [{ label: 'a', box: [0, 0, 100, 100] }] } });
    assert.deepEqual(confirmVerdict(verdict(false, ['x']), second).answer.heads.length, 1);
});

console.log(`${n} passed`);
