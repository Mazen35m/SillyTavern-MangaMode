// Run: node tests/adapters.test.mjs - model adapters and style profiles (pure logic).
// Proves: the Anima adapter reproduces the shipped wording exactly; another adapter never receives Anima's patches;
// styles are separate from models; old settings keep their behaviour and their cache keys.
import assert from 'node:assert/strict';
import { compileFrame } from '../prompt-builder.js';
import { ADAPTERS, LEGACY_ANIMA_PATCHES, LEGACY_SHARED_PATCHES, NO_PATCHES, STYLE_PROFILES, resolveAdapter, effectivePresets, ensureStyleFields, artistPhrase, dialectOf } from '../model-adapters.js';
import { DEFAULT_SETTINGS, getSettings } from '../settings.js';
import { jobKeyParts } from '../job-key.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };

const CAST = [
    { name: 'Nora', sex: 'female', label: 'the green-eyed brunette', look: 'young woman, long brown hair, green eyes', outfit: 'cream knit sweater, jeans, white sneakers', aliases: [] },
    { name: 'Alex', sex: 'male', label: 'the tall man in the grey coat', look: 'tall man, short black hair', outfit: 'grey coat', aliases: [] },
];
const SET = [{ name: 'Cafe', kind: 'place', label: 'the corner cafe', look: 'brick walls, small round tables, warm lamps' }];
const ctxFor = (settings, extra = {}) => ({ style: settings.promptStyle, presets: effectivePresets(settings), adapter: resolveAdapter(settings), cast: CAST, setBook: SET, world: { era_and_technology: 'Modern day; smartphones' }, setting: 'a cafe at night', personaName: 'Alex', povMode: false, ...extra });
const twoPeople = {
    kind: 'character', location: 'Cafe', camera: { shot: 'medium shot', angle: 'eye level' }, light: 'dim lamplight, deep shadows', view: 'the window and the rain',
    description: 'Nora sits at the table and slides a mug across to Alex.', interaction: 'Her hand pushes the mug into his open palm.', background: '',
    people: [
        { name: 'Nora', side: 'left', action: 'sits at the table, pushing the mug forward', expression: 'soft smile, lowered lashes', gaze: 'Alex' },
        { name: 'Alex', side: 'right', action: 'sits across the table, palm open', expression: 'raised brows, small smile', gaze: 'Nora' },
    ],
    characters: ['Nora', 'Alex'],
};
const solo = { ...twoPeople, interaction: '', people: [twoPeople.people[0]], characters: ['Nora'], camera: { shot: 'medium shot', angle: 'eye level' } };
const ANIMA_ONLY = [/It is one single continuous picture/, /Signs, pages and screens/, /fully drawn and painted edge to edge/, /score_7/, /cowboy shot/, /upper body/, /open space/, /On the left,/, /low-key and dim/, /is sitting/];

test('the default settings select the Anima adapter, as every 1.0.x install did', () => {
    const s = getSettings({});
    assert.equal(resolveAdapter(s).id, 'anima');
    assert.equal(resolveAdapter({ promptStyle: 'tags' }).id, 'illustrious');
    assert.equal(resolveAdapter({ promptStyle: 'tags_pony' }).id, 'pony');
    assert.equal(resolveAdapter({ promptStyle: 'natural', modelAdapter: 'sentences' }).id, 'sentences');
    assert.equal(resolveAdapter({ promptStyle: 'natural', modelAdapter: 'nonsense' }).id, 'anima', 'an unknown adapter name falls back, never throws');
});

test('Anima with the default look composes exactly the text 1.0.1 shipped', () => {
    const s = getSettings({});
    assert.equal(s.styleProfile, 'webtoon-color');
    assert.deepEqual(effectivePresets(s).natural, DEFAULT_SETTINGS.promptPresets.natural);
    assert.deepEqual(effectivePresets(s).tags, DEFAULT_SETTINGS.promptPresets.tags);
    assert.deepEqual(effectivePresets(s).tags_pony, DEFAULT_SETTINGS.promptPresets.tags_pony);
});

test('a user who wrote their own prompt text keeps it: the look becomes "custom" and nothing is rewritten', () => {
    const own = { natural: { prefix: 'my prefix', suffix: 'my suffix' } };
    const s = getSettings({ mangaMode: { promptPresets: own } });
    assert.equal(s.styleProfile, 'custom');
    assert.equal(effectivePresets(s).natural.prefix, 'my prefix');
    assert.equal(effectivePresets(s).natural.suffix, 'my suffix');
    // Idempotent: loading it again changes nothing.
    assert.equal(ensureStyleFields(s).styleProfile, 'custom');
});

test('the look is separate from the model: the same look, three adapters, three phrasings, no model words in the look itself', () => {
    for (const style of Object.values(STYLE_PROFILES)) {
        assert.doesNotMatch(`${style.sentence} ${style.finish} ${style.tags}`, /score_|masterpiece|best quality|@/, `${style.id} carries no model quality tokens`);
    }
    const base = { styleProfile: 'manga-bw', promptPresets: DEFAULT_SETTINGS.promptPresets };
    const anima = effectivePresets({ ...base, promptStyle: 'natural' });
    const plain = effectivePresets({ ...base, promptStyle: 'natural', modelAdapter: 'sentences' });
    const sdxl = effectivePresets({ ...base, promptStyle: 'tags', modelAdapter: 'illustrious' });
    assert.match(anima.natural.prefix, /^masterpiece, best quality, score_7, A black and white manga illustration\.$/);
    assert.equal(plain.natural.prefix, 'A black and white manga illustration.', 'a sentence model gets no booru quality tokens');
    assert.match(sdxl.tags.suffix, /monochrome, greyscale, manga style/);
});

test('an artist is phrased the way each adapter reads it', () => {
    assert.equal(artistPhrase(ADAPTERS.anima, 'greg, @rutkowski'), '@greg, @rutkowski');
    assert.equal(artistPhrase(ADAPTERS.illustrious, 'greg'), 'by greg');
    assert.equal(artistPhrase(ADAPTERS.sentences, 'greg'), 'In the style of greg.');
    assert.equal(artistPhrase(ADAPTERS.anima, '  '), '');
    const s = getSettings({ mangaMode: { artistStyle: 'someone' } });
    assert.match(effectivePresets(s).natural.prefix, /score_7, @someone, A colored webtoon manhwa illustration\.$/);
    const own = getSettings({ mangaMode: { promptPresets: { natural: { prefix: 'my prefix.', suffix: 'my suffix.' } }, artistStyle: 'someone' } });
    assert.match(effectivePresets(own).natural.prefix, /my prefix, @someone$/, 'a custom look keeps its words and gains the artist');
});

test('the Anima adapter writes the same prompt as before for two people and for one', () => {
    const s = getSettings({});
    const withAdapter = compileFrame(twoPeople, twoPeople.camera, ctxFor(s));
    const without = compileFrame(twoPeople, twoPeople.camera, { ...ctxFor(s), adapter: undefined });
    assert.deepEqual(withAdapter, without, 'no adapter = the Anima patches the code always had');
    assert.match(withAdapter[0], /It is one single continuous picture\./);
    assert.match(withAdapter[0], /^masterpiece, best quality, score_7, A colored webtoon manhwa illustration, upper body, cowboy shot\./);
    const one = compileFrame(solo, solo.camera, ctxFor(s));
    assert.deepEqual(one, compileFrame(solo, solo.camera, { ...ctxFor(s), adapter: undefined }));
});

test('another sentence adapter never receives an Anima patch', () => {
    const s = getSettings({ mangaMode: { modelAdapter: 'sentences' } });
    for (const spec of [twoPeople, solo, { ...solo, kind: 'insert', people: [solo.people[0]], description: 'Her hands hold a mug.' }, { ...twoPeople, light: 'a single candle in a dark cellar' }]) {
        const text = compileFrame(spec, spec.camera, ctxFor(s))[0];
        for (const re of ANIMA_ONLY) assert.doesNotMatch(text, re, `${re} leaked into the neutral adapter's prompt`);
    }
    // ... and it still says what the picture is about: the people, what happens, where, the light.
    const text = compileFrame(twoPeople, twoPeople.camera, ctxFor(s))[0];
    assert.match(text, /Her hand pushes the mug into his open palm/);
    assert.match(text, /the corner cafe/);
    assert.match(text, /Lighting: dim lamplight/);
    assert.match(text, /^A colored webtoon manhwa illustration\./);
});

test('the new path has no patches for any adapter; Classic keeps the legacy ones', () => {
    assert.deepEqual(Object.keys(LEGACY_ANIMA_PATCHES).sort(), Object.keys(NO_PATCHES).sort());
    assert.ok(Object.values(NO_PATCHES).every((v) => v === false));
    assert.ok(Object.values(LEGACY_ANIMA_PATCHES).every((v) => v === true));
    for (const id of Object.keys(ADAPTERS)) assert.equal(ADAPTERS[id].patches, undefined, `${id}: patches are not part of an adapter`);
    // New path: every adapter, and no adapter at all.
    for (const id of Object.keys(ADAPTERS)) assert.equal(dialectOf({ pipeline: 'moment', adapter: ADAPTERS[id] }), NO_PATCHES, `${id} in the new path`);
    assert.equal(dialectOf({ pipeline: 'moment' }), NO_PATCHES);
    // Classic: unchanged 1.0.x behaviour.
    assert.equal(dialectOf({}), LEGACY_ANIMA_PATCHES);
    assert.equal(dialectOf({ adapter: ADAPTERS.anima }), LEGACY_ANIMA_PATCHES);
    assert.equal(dialectOf({ adapter: ADAPTERS.sentences }), LEGACY_SHARED_PATCHES);
    assert.equal(LEGACY_SHARED_PATCHES.framingTags, false);
    assert.equal(LEGACY_SHARED_PATCHES.outfitFixes, true);
});

test('the new path writes none of the old patch wording, even with Anima selected', () => {
    const s = getSettings({ mangaMode: { modelAdapter: 'anima' } });
    const printed = { ...twoPeople, people: [{ ...twoPeople.people[0], action: 'sits holding a mug, a scrunchie on wrist' }, twoPeople.people[1]] };
    const cast = [{ ...CAST[0], outfit: 'band t-shirt, jeans, a scrunchie on wrist' }, CAST[1]];
    const LEAKS = [...ANIMA_ONLY, /small picture print/, /even while the hands are busy/, /into the picture, toward/, /turned toward .*, watching/, /seen from behind at a three-quarter/, /one wrist/];
    for (const spec of [twoPeople, printed, solo, { ...solo, kind: 'insert', people: [solo.people[0]], description: 'Her hands hold a mug.' }, { ...twoPeople, light: 'a single candle in a dark cellar' }]) {
        const text = compileFrame(spec, spec.camera, { ...ctxFor(s), cast, pipeline: 'moment' })[0];
        for (const re of LEAKS) assert.doesNotMatch(text.replace(/masterpiece, best quality, score_7/, ''), re, `${re} found in the new path`);
    }
    // the same frame in Classic still has them (Classic is the 1.0.x behaviour)
    const classic = compileFrame(printed, printed.camera, { ...ctxFor(s), cast })[0];
    assert.match(classic, /It is one single continuous picture/);
    assert.match(classic, /small picture print/);
    assert.match(classic, /even while the hands are busy/);
    // quality tokens are the model's, not a patch
    assert.match(compileFrame(twoPeople, twoPeople.camera, { ...ctxFor(s), pipeline: 'moment' })[0], /score_7/);
});

test('tag models are not touched by the adapter work', () => {
    const s = getSettings({ mangaMode: { promptStyle: 'tags' } });
    const chunks = compileFrame(twoPeople, twoPeople.camera, ctxFor(s));
    assert.ok(chunks.length >= 3, 'a shared chunk plus one chunk per person');
    assert.match(chunks[0], /masterpiece, best quality, colored manhwa style/);
    assert.doesNotMatch(chunks.join(' '), /It is one single continuous picture|score_7/);
});

test('the cache key of an untouched install is unchanged by adapters, looks and the planning mode', () => {
    const before = JSON.stringify(jobKeyParts('text', structuredClone(DEFAULT_SETTINGS), {}));
    const s = getSettings({});
    assert.equal(JSON.stringify(jobKeyParts('text', s, {})), before, 'defaults (webtoon-color look) leave the key alone');
    for (const change of [{ modelAdapter: 'sentences' }, { styleProfile: 'manga-bw' }, { artistStyle: 'x' }]) {
        assert.notEqual(JSON.stringify(jobKeyParts('text', { ...s, ...change }, {})), before, `${Object.keys(change)[0]} changes pictures, so it is in the key`);
    }
});

console.log(`${n} tests passed`);
