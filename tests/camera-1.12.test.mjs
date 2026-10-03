// Run: node tests/camera-1.12.test.mjs - the wider camera vocabulary and first-person staging of 1.12 (pure logic).
import assert from 'node:assert/strict';
import { compileFrame, frameExpectation } from '../prompt-builder.js';
import { cameraPhrase, cameraTags, ANGLE_TAGS, ANGLE_PHRASES } from '../director.js';
import { buildSchema, systemPrompt, withShotVariety, completeBeats } from '../scene-parser.js';
import { DEFAULT_SETTINGS } from '../settings.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };

const CAST = [
    { name: 'Alex', role: 'player', sex: 'male', label: 'the dark-haired young man', look: 'young man, short dark hair', outfit: 'black T-shirt', aliases: [] },
    { name: 'Nora', sex: 'female', label: 'the green-eyed brunette', look: 'young woman, long brown hair, green eyes', outfit: 'cream knit sweater, blue jeans', aliases: [] },
];
const CTX = { style: 'natural', presets: DEFAULT_SETTINGS.promptPresets, cast: CAST, setBook: [], world: null, setting: 'a narrow apartment hallway', personaName: 'Alex' };
const nora = (o = {}) => ({ kind: 'character', description: 'Nora carries a box down the hallway.', background: '', people: [{ name: 'Nora', side: 'center', action: 'carrying a cardboard box, walking away down the hall', expression: 'relaxed, a faint smile', gaze: 'the viewer', ...o }] });

const NEW_ANGLES = ['top-down view', 'ground-level view', 'dutch angle', 'from behind', 'profile view', 'through foreground'];

test('every angle the director may choose has a tag and a sentence', () => {
    const enumAngles = buildSchema().properties.beats.items.properties.camera.properties.angle.enum;
    for (const a of enumAngles) {
        assert.ok(a in ANGLE_TAGS, `tag for ${a}`);
        assert.ok(a in ANGLE_PHRASES, `phrase for ${a}`);
    }
    for (const a of NEW_ANGLES) {
        assert.ok(enumAngles.includes(a), `${a} is offered to the director`);
        assert.ok(ANGLE_TAGS[a] && ANGLE_PHRASES[a], `${a} is written out`);
        assert.match(cameraPhrase({ shot: 'medium shot', angle: a }), new RegExp(ANGLE_PHRASES[a].slice(0, 12)));
        assert.ok(cameraTags({ shot: 'close-up', angle: a }).includes(ANGLE_TAGS[a].split(',')[0]));
    }
});

test('new angles reach the natural-language image prompt', () => {
    for (const a of ['top-down view', 'dutch angle', 'profile view', 'through foreground', 'ground-level view']) {
        const [p] = compileFrame(nora(), { shot: 'medium shot', angle: a }, CTX);
        assert.ok(p.includes(ANGLE_PHRASES[a]), `${a}: ${p.slice(0, 200)}`);
    }
});

test('"from behind": the back is shown, no face and no look at the viewer is written', () => {
    const [p] = compileFrame(nora(), { shot: 'medium shot', angle: 'from behind' }, CTX);
    assert.match(p, /Seen from behind/);
    assert.ok(!/faint smile/.test(p), 'the expression is not in the prompt: no face is seen');
    assert.ok(!/looks? (?:straight )?at the viewer/i.test(p), 'no eye contact is written');
    const tags = compileFrame(nora(), { shot: 'medium shot', angle: 'from behind' }, { ...CTX, style: 'tags' }).join(' ');
    assert.match(tags, /from behind/);
    assert.ok(!/faint smile/.test(tags));
});

test('an ordinary angle still writes the face and the look', () => {
    const [p] = compileFrame(nora(), { shot: 'medium shot', angle: 'eye level' }, CTX);
    assert.match(p, /faint smile/);
});

test('first-person mode: whatever the angle, the player is never drawn', () => {
    const spec = { kind: 'character', description: 'Nora talks while Alex listens.', background: '', people: [
        { name: 'Alex', side: 'left', action: 'standing', expression: 'calm', gaze: 'Nora' },
        { name: 'Nora', side: 'right', action: 'leaning on the doorframe', expression: 'amused', gaze: 'Alex' },
    ] };
    const fp = compileFrame(spec, { shot: 'medium shot', angle: 'profile view' }, { ...CTX, povMode: true }).join(' ');
    const plain = compileFrame(spec, { shot: 'medium shot', angle: 'profile view' }, CTX).join(' ');
    assert.ok(!/dark-haired young man/.test(fp), 'the player is not in the picture in first-person mode');
    assert.match(plain, /dark-haired young man/, 'and is when first-person mode is off');
});

test('first-person mode: the checker is not told to expect the player or a stare at the camera', () => {
    const e = frameExpectation(nora({ gaze: 'the viewer' }), { shot: 'medium shot', angle: 'dutch angle' }, { ...CTX, povMode: true });
    assert.deepEqual(e.gazes, []);
});

test('the director is told to vary camera, acting and eye contact (the rules are in the prompt)', () => {
    const p = systemPrompt({ povMode: true });
    for (const w of ['VARIETY IS REQUIRED', 'THE PLACE LIVES', 'EYE CONTACT IS A BEAT', 'ACTING', 'top-down view', 'through foreground']) assert.ok(p.includes(w), w);
    assert.ok(!/Every frame the player is part of has camera angle "pov"/.test(p), 'first-person mode no longer forces one angle');
    assert.ok(!/Whoever talks to or looks at the player looks at "the viewer"\./.test(p), 'talking no longer means staring');
});

test('the rules name no character, place or story', () => {
    const p = systemPrompt({ povMode: true });
    for (const w of ['Nora', 'dwarf', 'Alex', 'isekai', 'goblin']) assert.ok(!new RegExp(`\\b${w}\\b`, 'i').test(p), w);
});

const SHOTS = ['extreme close-up', 'close-up', 'medium shot', 'full shot', 'wide shot'];
const KINDS = ['character', 'character', 'character', 'insert', 'establishing'];
let seed = 7;
const rnd = (k) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % k; };
const randomBeats = () => Array.from({ length: 3 + rnd(8) }, (_, i) => ({ id: i, kind: KINDS[rnd(5)], same_moment: rnd(9) === 0, camera: { shot: SHOTS[rnd(3) + 1 - (rnd(4) ? 0 : 1)] || 'medium shot', angle: 'eye level' }, description: 'x' }));

test('shot variety: no three people-frames in a row at one distance (400 random replies), nothing else changes', () => {
    for (let k = 0; k < 400; k++) {
        const input = randomBeats();
        const out = withShotVariety(input);
        assert.equal(out.length, input.length);
        for (let i = 0; i < input.length; i++) {
            assert.equal(out[i].id, input[i].id);
            if (out[i] !== input[i]) {
                assert.equal(input[i].kind, 'character', 'only people-frames change');
                assert.ok(!input[i].same_moment, 'a closer view of the same instant is kept');
                assert.notEqual(out[i].camera.shot, input[i].camera.shot);
                assert.equal(out[i].camera.angle, input[i].camera.angle);
            }
        }
        for (let i = 2; i < out.length; i++) {
            const same = out[i].camera.shot === out[i - 1].camera.shot && out[i - 1].camera.shot === out[i - 2].camera.shot;
            if (same) assert.ok(out[i - 1].kind !== 'character' || out[i - 1].same_moment, 'a run of three is left only where the middle frame is protected');
        }
        assert.deepEqual(withShotVariety(out), out, 'applying it twice changes nothing');
    }
});

test('shot variety: the input is not mutated, short replies are untouched', () => {
    const three = [0, 1, 2].map((i) => ({ id: i, kind: 'character', camera: { shot: 'medium shot', angle: 'pov' } }));
    const out = withShotVariety(three);
    assert.equal(three[1].camera.shot, 'medium shot');
    assert.deepEqual(out.map((b) => b.camera.shot), ['medium shot', 'close-up', 'medium shot']);
    assert.equal(withShotVariety(three.slice(0, 2)).length, 2);
    assert.equal(withShotVariety(undefined), undefined);
});

test('shot variety is part of completing a storyboard (parse and draw time)', () => {
    const beat = (i) => ({ kind: 'character', camera: { shot: 'medium shot', angle: 'eye level' }, description: `Nora moves ${i}.`, people: [{ name: 'Nora', side: 'center', action: 'standing', expression: 'calm', gaze: 'the viewer' }] });
    const scene = completeBeats({ setting: 'a hall', beats: [beat(1), beat(2), beat(3)], cast: [] }, { userName: 'Alex', cast: CAST });
    assert.deepEqual(scene.beats.map((b) => b.camera.shot), ['medium shot', 'close-up', 'medium shot']);
    const again = completeBeats(scene, { userName: 'Alex', cast: CAST });
    assert.deepEqual(again.beats.map((b) => b.camera.shot), ['medium shot', 'close-up', 'medium shot']);
});

console.log(`${n} passed`);
