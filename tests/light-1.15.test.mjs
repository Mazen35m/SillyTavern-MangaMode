// Run: node tests/light-1.15.test.mjs - per-frame light of 1.15 (pure logic).
import assert from 'node:assert/strict';
import { compileFrame, isDarkLight, withoutVibrantColor } from '../prompt-builder.js';
import { buildSchema, systemPrompt } from '../scene-parser.js';
import { DEFAULT_SETTINGS } from '../settings.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };
const CAST = [{ name: 'Nora', sex: 'female', label: 'the green-eyed brunette', look: 'young woman, long brown hair, green eyes', outfit: 'cream knit sweater, blue jeans', aliases: [] }];
const CTX = { style: 'natural', presets: DEFAULT_SETTINGS.promptPresets, cast: CAST, setBook: [], world: null, setting: 'a living room', personaName: 'Alex' };
const spec = (o = {}) => ({ kind: 'character', description: 'Nora holds up her phone.', background: '', people: [{ name: 'Nora', side: 'center', action: 'holding up a phone', expression: 'squinting', gaze: 'the phone' }], ...o });
const CAM = { shot: 'medium shot', angle: 'eye level' };

test('the schema asks for a light in every frame and the rule says dark stays dark', () => {
    const beat = buildSchema().properties.beats.items;
    assert.ok(beat.properties.light && beat.required.includes('light'));
    assert.match(systemPrompt({}), /LIGHT \("light"\)/);
    assert.match(systemPrompt({}), /blackout.*DARK/s);
});

test('what counts as dark light, and what does not', () => {
    for (const t of ['dim blue moonlight through fog', 'only a phone flashlight in a dark room', 'warm candlelight, deep shadows', 'a storm outside', 'pitch-black cellar']) assert.ok(isDarkLight(t), t);
    for (const t of ['hard white noon sun', 'warm afternoon daylight', 'soft morning light through the window', '', undefined]) assert.ok(!isDarkLight(t), String(t));
});

test('the style suffix loses "vibrant colour" only, in every preset wording', () => {
    assert.equal(withoutVibrantColor('Clean digital lineart, cel shading, vibrant full color.'), 'Clean digital lineart, cel shading.');
    assert.equal(withoutVibrantColor('masterpiece, colored manhwa style, full color, cel shading, vibrant colors'), 'masterpiece, colored manhwa style, full color, cel shading');
    assert.equal(withoutVibrantColor('plain suffix'), 'plain suffix');
    assert.equal(withoutVibrantColor(''), '');
    assert.equal(withoutVibrantColor(withoutVibrantColor('a, vibrant colors')), 'a');
});

test('a dark frame says so and drops "vibrant full color"; a bright one keeps the old suffix', () => {
    const [dark] = compileFrame(spec({ light: 'only a phone flashlight cutting a dark room' }), CAM, CTX);
    assert.match(dark, /Lighting: only a phone flashlight cutting a dark room\. The picture is low-key and dim/);
    assert.ok(!/vibrant/.test(dark));
    const [bright] = compileFrame(spec({ light: 'warm afternoon daylight' }), CAM, CTX);
    assert.match(bright, /Lighting: warm afternoon daylight\./);
    assert.ok(!/low-key/.test(bright));
    assert.match(bright, /vibrant full color/);
});

test('a storyboard saved without light (1.14 and older) compiles exactly as before', () => {
    const [p] = compileFrame(spec(), CAM, CTX);
    assert.ok(!/Lighting:/.test(p));
    assert.match(p, /vibrant full color/);
});

test('tag-style prompts get the light too, and the dark ones drop the vibrant tag', () => {
    const tags = compileFrame(spec({ light: 'dim moonlight' }), CAM, { ...CTX, style: 'tags' }).join(' ');
    assert.match(tags, /dim moonlight, dark, dim lighting, low key, deep shadows/);
    assert.ok(!/vibrant/.test(tags));
    const day = compileFrame(spec({ light: 'bright noon sun' }), CAM, { ...CTX, style: 'tags' }).join(' ');
    assert.match(day, /bright noon sun/);
    assert.match(day, /vibrant colors/);
});

console.log(`${n} passed`);
