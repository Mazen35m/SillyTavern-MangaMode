// Run: node tests/composition-1.15.test.mjs - one person off-centre, never three centred frames in a row (1.15, pure logic).
import assert from 'node:assert/strict';
import { compileFrame } from '../prompt-builder.js';
import { systemPrompt, withComposition } from '../scene-parser.js';
import { DEFAULT_SETTINGS } from '../settings.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };
const CAST = [{ name: 'Nora', sex: 'female', label: 'the green-eyed brunette', look: 'young woman, long brown hair, green eyes', outfit: 'cream knit sweater', aliases: [] }];
const CTX = { style: 'natural', presets: DEFAULT_SETTINGS.promptPresets, cast: CAST, setBook: [], world: null, setting: 'a living room', personaName: 'Alex' };
const solo = (side, shot = 'medium shot', extra = {}) => ({ kind: 'character', camera: { shot, angle: 'eye level' }, people: [{ name: 'Nora', side, action: 'standing', expression: 'calm', gaze: 'the window' }], ...extra });
const sides = (bs) => bs.map((b) => b.people?.[0]?.side);

test('the director is told to vary the side of a single person', () => {
    assert.match(systemPrompt({}), /ONE person vary "side"/);
});

test('the third centred single-person frame in a row is moved to a side', () => {
    const out = withComposition([solo('center'), solo('center'), solo('center'), solo('center')]);
    assert.deepEqual(sides(out), ['center', 'center', 'left', 'center']);
});

test('sides the director chose are kept and break a run', () => {
    const input = [solo('center'), solo('center'), solo('left'), solo('center'), solo('center'), solo('center')];
    const out = withComposition(input);
    assert.deepEqual(sides(out).slice(0, 5), ['center', 'center', 'left', 'center', 'center']);
    assert.equal(sides(out)[5], 'right', 'the forced side is the opposite of the last side used (left)');
});

test('close-ups, inserts, establishing frames and groups break a run and are never changed', () => {
    const input = [solo('center'), solo('center'), solo('center', 'close-up'), solo('center'), { kind: 'insert', people: [] }, solo('center'),
        { ...solo('center'), people: [{ ...solo('center').people[0] }, { ...solo('center').people[0], name: 'Mia', side: 'right' }] }, solo('center')];
    assert.deepEqual(withComposition(input), input);
});

test('applying it twice changes nothing, and the input is not modified', () => {
    const input = [solo('center'), solo('center'), solo('center'), solo('center'), solo('center'), solo('center')];
    const copy = JSON.parse(JSON.stringify(input));
    const once = withComposition(input);
    assert.deepEqual(input, copy);
    assert.deepEqual(withComposition(once), once);
});

test('short scenes and odd input pass through', () => {
    assert.deepEqual(withComposition([solo('center'), solo('center')]).length, 2);
    assert.equal(withComposition(undefined), undefined);
    assert.deepEqual(withComposition([]), []);
});

test('a single person on the left or right gets a composition sentence, in the center or in a close-up none', () => {
    const [left] = compileFrame(solo('left'), { shot: 'medium shot', angle: 'eye level' }, CTX);
    assert.match(left, /Composition: .* is placed in the left third of the frame, with open space on the right\./);
    const [right] = compileFrame(solo('right'), { shot: 'full shot', angle: 'eye level' }, CTX);
    assert.match(right, /placed in the right third of the frame, with open space on the left\./);
    const [mid] = compileFrame(solo('center'), { shot: 'medium shot', angle: 'eye level' }, CTX);
    assert.ok(!/Composition:/.test(mid));
    const [cu] = compileFrame(solo('left', 'close-up'), { shot: 'close-up', angle: 'eye level' }, CTX);
    assert.ok(!/Composition:/.test(cu));
});

test('an insert gets no composition sentence', () => {
    const [ins] = compileFrame({ kind: 'insert', description: 'Her hand on a cup.', people: [] }, { shot: 'close-up', angle: 'eye level' }, CTX);
    assert.ok(!/Composition:/.test(ins));
});

console.log(`${n} passed`);
