// Run: node tests/frames-1.13.test.mjs - per-frame view and the insert fallback of 1.13 (pure logic).
import assert from 'node:assert/strict';
import { fallbackFromInsert } from '../frame-plan.js';
import { compileFrame } from '../prompt-builder.js';
import { buildSchema, systemPrompt } from '../scene-parser.js';
import { DEFAULT_SETTINGS } from '../settings.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };
const CAST = [{ name: 'Nora', sex: 'female', label: 'the green-eyed brunette', look: 'young woman, long brown hair, green eyes', outfit: 'cream knit sweater, blue jeans', aliases: [] }];
const CTX = { style: 'natural', presets: DEFAULT_SETTINGS.promptPresets, cast: CAST, setBook: [], world: null, setting: 'a narrow apartment hallway', personaName: 'Alex' };
const spec = (o = {}) => ({ kind: 'character', description: 'Nora carries a box.', background: '', people: [{ name: 'Nora', side: 'center', action: 'carrying a box', expression: 'calm', gaze: 'the box' }], ...o });

test('the schema asks for a view in every frame, and the rule tells the director how to use it', () => {
    const beat = buildSchema().properties.beats.items;
    assert.ok(beat.properties.view, 'view in the beat');
    assert.ok(beat.required.includes('view'), 'view is required by the strict schema');
    assert.match(systemPrompt({}), /EVERY FRAME HAS ITS OWN BACKGROUND/);
    assert.match(systemPrompt({}), /same person never gets the same expression in two frames in a row/);
});

test('the view reaches the natural-language prompt, before the "painted edge to edge" sentence', () => {
    const [p] = compileFrame(spec({ view: 'the door end of the hall, daylight falling through its frosted glass' }), { shot: 'medium shot', angle: 'eye level' }, CTX);
    assert.match(p, /In this view, the background shows the door end of the hall, daylight falling through its frosted glass\./);
    assert.ok(p.indexOf('In this view') < p.indexOf('painted edge to edge'));
});

test('the view reaches the tag-style prompt, and an insert never gets one', () => {
    const tags = compileFrame(spec({ view: 'a rainy window' }), { shot: 'medium shot', angle: 'eye level' }, { ...CTX, style: 'tags' }).join(' ');
    assert.match(tags, /a rainy window/);
    const insert = compileFrame(spec({ kind: 'insert', view: 'a rainy window' }), { shot: 'close-up', angle: 'eye level' }, CTX).join(' ');
    assert.ok(!/rainy window/.test(insert));
});

test('a saved storyboard without views (1.12 and older) compiles exactly as before', () => {
    const [p] = compileFrame(spec(), { shot: 'medium shot', angle: 'eye level' }, CTX);
    assert.ok(!/In this view/.test(p));
});

test('fallback: a failed insert with a person becomes a medium shot of that person, same angle, same moment', () => {
    const insert = spec({ kind: 'insert', description: 'Two hands lift a box.', characters: ['Nora'] });
    const out = fallbackFromInsert(insert, { shot: 'close-up', angle: 'high angle' });
    assert.equal(out.spec.kind, 'character');
    assert.equal(out.camera.shot, 'medium shot');
    assert.equal(out.camera.angle, 'high angle');
    assert.equal(out.spec.description, insert.description);
    assert.deepEqual(out.spec.people, insert.people);
});

test('fallback: first-person inserts stay first-person; over-the-shoulder becomes eye level', () => {
    assert.equal(fallbackFromInsert(spec({ kind: 'insert' }), { shot: 'close-up', angle: 'pov' }).camera.angle, 'pov');
    assert.equal(fallbackFromInsert(spec({ kind: 'insert' }), { shot: 'close-up', angle: 'over the shoulder' }).camera.angle, 'eye level');
});

test('fallback: nothing for an object insert with nobody to draw, nor for a frame that is not an insert', () => {
    assert.equal(fallbackFromInsert(spec({ kind: 'insert', people: [] }), { shot: 'close-up', angle: 'eye level' }), null);
    assert.equal(fallbackFromInsert(spec(), { shot: 'close-up', angle: 'eye level' }), null);
    assert.equal(fallbackFromInsert(null, null), null);
});

test('1.14 rules: people stay the heart of the page; inserts never show the player\'s body', () => {
    const p = systemPrompt({ povMode: true });
    for (const w of ['PEOPLE STAY THE HEART OF THE PAGE', 'INSERTS are only for a hand or object', "Never an insert of the player's own feet", 'ONE frame of its own']) assert.ok(p.includes(w), w);
});

console.log(`${n} passed`);
