// Run: node tests/unit.test.mjs   (pure-logic tests, no SillyTavern/ComfyUI needed)
import assert from 'node:assert/strict';
import { contactCamera, compileFrame, stripSpeech, gazeSentence, replaceNames, namePairs, effectiveCamera, frameExpectation, tidy, withoutHeldProps } from '../prompt-builder.js';
import { buildComfyWorkflow, withSafetyNegative, runComfyWithRetry, generationStats, parseLoraList, buildRefineWorkflow, addCharacterReference, SAFETY_NEGATIVE } from '../image-generator.js';
import { DEFAULT_SETTINGS } from '../settings.js';
import { resolveTailUp, placeBubbleGroups, trimGutters, headZones } from '../bubble-placement.js';
import { computeGroupGeometry, toShoutGeometry } from '../bubble-geometry.js';
import { planPanels, splitCrowdedPages, splitLongSpeech, normalizeDialogueAssignment, messagesSinceFullBleed, selectBeats, fitBudget, beatValue, wantsEstablishing } from '../director.js';
import { chooseLayout, frameGenerationSize } from '../page-layout.js';
import { computeCropRect, pickHead, peopleCenterX, headCropRect, faceRegion } from '../panel-crop.js';
import { hairColorOf, locateTopClumps, skinToneOf } from '../image-analysis.js';
import { ensureProfiles, applyProfile, profileFromSettings, getActiveProfile } from '../model-profiles.js';
import { getSettings } from '../settings.js';
import { splitLongLine } from '../bubbles.js';
import { completeBeats, parseScene, buildSchema } from '../scene-parser.js';
import { findKnownSet, mergeSet, matchPlace, objectsIn } from '../set-book.js';
import { extractSpeechLines, segmentSpeech, resolveDialogueRefs } from '../dialogue-lines.js';
import { mergeCast, findKnownCast, sameName, findPerson, uniqueLabels, formatKnownCast, stablePart, labelForOutfit, takenOff } from '../cast-book.js';
import { formatWorld } from '../world-book.js';
import { withContactPartners, withPlayerInForeground } from '../scene-parser.js';
import { judge, headOf, headsInCrop, frameCheckRequest, findByLabel, labelKey } from '../vision-check.js';
import { locatedFor } from '../bubble-placement.js';
import { frameFigures, framePairs, stripSpeechSafe, eraPhrase } from '../prompt-builder.js';
import { prepareCustomGraph, fillPlaceholders, refineFromCustom, filledUi, workflowNameOf, wantsReference, BLANK_REFERENCE } from '../custom-workflow.js';

import { withBackgroundPeople, withShoulderOwner, withPostureCarried, normalizeScene, withPlayerUnseen, systemPrompt } from '../scene-parser.js';
import { costLine } from '../renderer.js';
import { withoutCameraClause, withoutStrayPronouns, withoutAbsences, layeredOutfit, withoutDividers, withoutGlass } from '../text-rules.js';
import { shotForWords } from '../director.js';
import { contentBox } from '../vision-check.js';
import { drawPlanFor, redrawVariant } from '../frame-plan.js';
import { lintFrame } from './prompt-lint.mjs';

let passed = 0;
const asyncTestsFull = [];
const test = (name, fn) => { fn(); passed++; console.log('ok -', name); };
const presets = DEFAULT_SETTINGS.promptPresets;

const identities = [
    { kind: 'character', name: 'Seraphina', appearance: { physicalTraits: 'adult woman, pink long hair, amber eyes', defaultOutfit: 'black sundress' } },
    { kind: 'persona', name: 'alex', appearance: { physicalTraits: 'young man, short dark brown hair', defaultOutfit: 'black T-shirt, dark gray pants' } },
];
const scene = {
    image_tags: '1boy, 1girl, holding hands, ruins, rain, alex',
    image_description: 'Two people hold hands in ruins.',
    characters: [
        { name: 'Seraphina', count_tag: '1girl', outfit: '', visual_tags: 'smile, wet hair' },
        { name: 'Alex', count_tag: '1boy', outfit: 'heavy cloak', visual_tags: 'determined' },
        { name: 'old innkeeper', count_tag: '1boy', visual_tags: 'old man, grey beard, brown apron' },
    ],
};

test('one chunk -> graph identical to baseline workflow 000', () => {
    const g = buildComfyWorkflow({ checkpoint: 'c', positiveChunks: ['p'], negativePrompt: 'n', sampler: 's', scheduler: 'k', steps: 28, cfg: 6, width: 896, height: 1152, seed: 1 });
    assert.deepEqual(Object.keys(g).sort(), ['3', '4', '5', '6', '7', '8', '9']);
    assert.deepEqual(g['3'].inputs.positive, ['6', 0]);
});

test('several chunks -> ConditioningConcat chain', () => {
    const g = buildComfyWorkflow({ checkpoint: 'c', positiveChunks: ['a', 'b', 'c'], negativePrompt: 'n', sampler: 's', scheduler: 'k', steps: 28, cfg: 6, width: 896, height: 1152, seed: 1 });
    assert.equal(g['21'].class_type, 'ConditioningConcat');
    assert.deepEqual(g['23'].inputs.conditioning_to, ['21', 0]);
    assert.deepEqual(g['3'].inputs.positive, ['23', 0]);
});

test('tail points up when the balloon sits below the subject, down when above', () => {
    const art = { x0: 0, y0: 0.1, x1: 1, y1: 0.9 };
    assert.equal(resolveTailUp({ x0: 0.1, y0: 0.7, x1: 0.4, y1: 0.8 }, { x: 0.5, y: 0.4 }, art), true);
    assert.equal(resolveTailUp({ x0: 0.1, y0: 0.12, x1: 0.4, y1: 0.2 }, { x: 0.5, y: 0.4 }, art), false);
    assert.equal(resolveTailUp({ x0: 0.1, y0: 0.92, x1: 0.4, y1: 0.98 }, null, art), true);
});

test('placement keeps reading order top-to-bottom and never overlaps', () => {
    const groups = [1, 2, 3].map((i) => ({ id: 'g' + i, width: 200, height: 80, hintSide: i % 2 ? 'left' : 'right' }));
    const res = placeBubbleGroups({ stripWidth: 800, stripHeight: 1200, imageRect: { x0: 0, y0: 0.08, x1: 1, y1: 0.92 }, groups, occupancyMap: null });
    const tops = groups.map((g) => res.get(g.id).top);
    assert.ok(tops[0] < tops[1] && tops[1] < tops[2]);
});

test('dialogue assignment: every line once, in order, gaps filled', () => {
    assert.deepEqual(normalizeDialogueAssignment([{ dialogue_indices: [0, 2] }, { dialogue_indices: [1, 3] }], 5), [[0], [1, 2, 3, 4]]);
    assert.deepEqual(normalizeDialogueAssignment([{ dialogue_indices: [] }, { dialogue_indices: [0, 1] }], 2), [[], [0, 1]]);
});

const dir = (panels, dialogue = 2) => ({ characters: [{ name: 'A', screen_position: 'left' }, { name: 'B', screen_position: 'right' }], dialogue: Array.from({ length: dialogue }, (_, i) => ({ speaker: i % 2 ? 'B' : 'A', text: 'x' })), camera: { shot: 'medium shot', angle: 'eye level' }, panels });
const P = (o) => ({ beat: 'b', characters: ['A', 'B'], camera: { shot: 'medium shot', angle: 'eye level' }, image_tags: '', people: [], dialogue_indices: [], intensity: 'calm', same_moment: false, ...o });

test('director: no panels -> one generated panel with all dialogue', () => {
    const plan = planPanels(dir(undefined, 3));
    assert.equal(plan.length, 1);
    assert.equal(plan[0].strategy, 'generate');
    assert.deepEqual(plan[0].dialogue, [0, 1, 2]);
});

test('director: caps panel count and reframes a same-moment closer shot', () => {
    const plan = planPanels(dir([P({ dialogue_indices: [0] }), P({ same_moment: true, camera: { shot: 'close-up', angle: 'eye level' }, dialogue_indices: [1] }), P({}), P({})]), { maxPanels: 3 });
    assert.equal(plan.length, 3);
    assert.equal(plan[1].strategy, 'reframe');
    assert.equal(plan[1].fromPanel, 0);
    // Over the panel budget, the two least valuable neighbours share one panel instead of one being thrown away.
    assert.equal(plan[2].strategy, 'grid');
    assert.equal(plan[2].frames.length, 2);
});

test('director: full-bleed only for peak, only after cooldown, at most one', () => {
    const scene = dir([P({ intensity: 'peak' }), P({ intensity: 'peak' })]);
    assert.equal(planPanels(scene, { sinceFullBleed: 3, fullBleedCooldown: 10 }).filter((p) => p.fullBleed).length, 0);
    const plan = planPanels(scene, { sinceFullBleed: Infinity, fullBleedCooldown: 10 });
    assert.equal(plan.filter((p) => p.fullBleed).length, 1);
    assert.deepEqual(plan[0].size, { width: 832, height: 1216 });
});

test('director: long single-beat dialogue splits into frame + crop', () => {
    const plan = planPanels(dir(undefined, 6), { splitDialogueThreshold: 5 });
    assert.equal(plan.length, 2);
    assert.equal(plan[1].strategy, 'split');
    assert.deepEqual(plan[0].dialogue, [0, 1, 2]);
    assert.deepEqual(plan[1].dialogue, [3, 4, 5]);
});

test('director: beats beyond the budget keep first, last and the most intense, lines preserved', () => {
    const b = (intensity, d) => P({ intensity, dialogue_indices: d });
    const out = selectBeats([b('calm', [0]), b('calm', [1]), b('peak', [2]), b('calm', [3]), b('tense', [4])], 3);
    assert.equal(out.length, 3);
    assert.deepEqual(out.map((o) => o.intensity), ['calm', 'peak', 'tense']);
    assert.deepEqual(out.map((o) => o.dialogue_indices), [[0, 1], [2, 3], [4]]);
});

test('director: reads object beats as panel proposals', () => {
    const scene = { ...dir(undefined, 2), beats: [P({ dialogue_indices: [0] }), P({ dialogue_indices: [1], camera: { shot: 'close-up', angle: 'eye level' } })] };
    const plan = planPanels(scene, {});
    assert.equal(plan.length, 2);
    assert.equal(plan[1].strategy, 'generate');
});

test('director: one proposed panel but several beats -> frame + speaker close-up', () => {
    const scene = { ...dir([P({ dialogue_indices: [0, 1] })]), beats: ['they climb', 'she nods'] }; // legacy string beats
    const plan = planPanels(scene, {});
    assert.equal(plan.length, 2);
    assert.deepEqual(plan[0].dialogue, []);
    assert.deepEqual(plan[1].dialogue, [0, 1]);
    assert.equal(plan[1].focusName, 'A');
});

test('full-bleed cooldown is read from chat history', () => {
    const chat = [{ is_user: false, extra: { manga: { panels: [{ fullBleed: true }] } } }, { is_user: true }, { is_user: false }, { is_user: false }];
    assert.equal(messagesSinceFullBleed(chat, 4), 3);
    assert.equal(messagesSinceFullBleed(chat.slice(1), 3), Infinity);
    // a full-bleed two replies later also counts (regenerating an older message)
    assert.equal(messagesSinceFullBleed([{ is_user: false }, { is_user: false }, { is_user: false, extra: { manga: { panels: [{ fullBleed: true }] } } }], 0), 2);
    const pending = new WeakSet(); const m = { is_user: false }; pending.add(m);
    assert.equal(messagesSinceFullBleed([m, { is_user: false }], 1, 50, pending), 1);
});

test('crop rect stays inside the image and keeps the requested framing', () => {
    const r = computeCropRect({ x: 0.9, y: 0.1 }, 896 / 1152, 'close-up');
    assert.ok(r.x0 >= 0 && r.y0 >= 0 && r.x1 <= 1 + 1e-9 && r.y1 <= 1 + 1e-9);
    assert.ok(Math.abs((r.x1 - r.x0) * 896 / ((r.y1 - r.y0) * 1152) - 1) < 0.01);
});

test('hair colour is read from appearance text, dark hair ignored', () => {
    assert.equal(hairColorOf('adult woman, pink long hair, amber eyes'), 'pink');
    assert.equal(hairColorOf('long_blonde_hair, blue eyes'), 'blonde');
    assert.equal(hairColorOf('young man, short dark brown hair, dark brown eyes'), null);
    assert.equal(hairColorOf('red dress, black hair'), null);
});

test('shout geometry grows by the spike amplitude and keeps text lobes inside', () => {
    const g = computeGroupGeometry([{ width: 120, height: 20 }]);
    const s = toShoutGeometry(g, { amp: 9 });
    assert.equal(s.width, g.width + 18);
    assert.ok(s.segments[0].length >= 6);
    const pts = s.segments[0];
    assert.ok(pts.every((p) => p.x >= -0.5 && p.y >= -0.5 && p.x <= s.width + 0.5 && p.y <= s.height + 0.5));
});

test('long lines split at a boundary near the middle, words unchanged', () => {
    const line = 'Long before the Shadowfangs ever crawled from the depths, before this land was even called Eldoria, there was only the wild earth and the primeval breath of the world.';
    const parts = splitLongLine(line);
    assert.ok(parts.length >= 2 && parts.every((p) => p.split(' ').length <= 18));
    assert.equal(parts.join(' '), line);
    assert.deepEqual(splitLongLine('Short line here.'), ['Short line here.']);
});

test('split workflow family: UNET + CLIP + VAE loaders wired through encode, sampler and decode', () => {
    const g = buildComfyWorkflow({ family: 'split', unet: 'anima.safetensors', clip: 'qwen.safetensors', clipType: 'stable_diffusion', vae: 'qwen_vae.safetensors', positiveChunks: ['p'], negativePrompt: 'n', sampler: 'er_sde', scheduler: 'simple', steps: 30, cfg: 4, width: 1024, height: 1024, seed: 1 });
    assert.equal(g['4'].class_type, 'UNETLoader');
    assert.deepEqual(g['6'].inputs.clip, ['10', 0]);
    assert.deepEqual(g['3'].inputs.model, ['4', 0]);
    assert.deepEqual(g['8'].inputs.vae, ['11', 0]);
    assert.ok(!Object.values(g).some((n) => n.class_type === 'CheckpointLoaderSimple'));
});

test('checkpoint family is unchanged unless a separate VAE is given', () => {
    const base = { checkpoint: 'c', positiveChunks: ['p'], negativePrompt: 'n', sampler: 's', scheduler: 'k', steps: 28, cfg: 6, width: 896, height: 1152, seed: 1 };
    assert.deepEqual(buildComfyWorkflow(base)['8'].inputs.vae, ['4', 2]);
    assert.deepEqual(buildComfyWorkflow({ ...base, vae: 'v.safetensors' })['8'].inputs.vae, ['11', 0]);
});

test('model profiles: first run saves the Anima Turbo defaults plus an Illustrious example; applying a profile sets its Prompt Style and files', () => {
    const settings = getSettings({});
    assert.equal(settings.modelProfiles.length, 2);
    assert.equal(getActiveProfile(settings).id, 'anima-turbo-v11');
    assert.equal(getActiveProfile(settings).promptStyle, 'natural');
    assert.equal(settings.comfy.family, 'split');
    assert.equal(settings.comfy.unet, 'anima-turbo-v1.1.safetensors');
    assert.equal(settings.comfy.clip, 'qwen_3_06b_base.safetensors');
    assert.equal(settings.comfy.vae, 'qwen_image_vae.safetensors');
    assert.equal(settings.comfy.sampler, 'er_sde');
    assert.equal(settings.comfy.steps, 10);
    assert.equal(settings.comfy.cfg, 1);
    assert.equal(settings.comfy.modelNegative, 'score_1, score_2, score_3');
    assert.equal(settings.promptStyle, 'natural');
    const sdxl = settings.modelProfiles.find((p) => p.id === 'illustrious-xl-v01');
    applyProfile(settings, sdxl);
    assert.equal(settings.promptStyle, 'tags');
    assert.equal(settings.comfy.family, 'checkpoint');
    assert.equal(settings.comfy.checkpoint, 'illustriousXL_v01.safetensors');
    assert.equal(settings.comfy.url, 'http://127.0.0.1:8188', 'server URL stays global');
    applyProfile(settings, settings.modelProfiles[0]);
    assert.equal(settings.promptStyle, 'natural');
    assert.equal(settings.comfy.family, 'split');
    assert.equal(profileFromSettings(settings, { name: 'X' }).generation.unet, 'anima-turbo-v1.1.safetensors');
    // a profile carries its own quality tags for its style
    const oo = { ...profileFromSettings(settings, { id: 'oo', name: 'OO' }), promptPreset: { prefix: '', suffix: 'masterpiece, very awa' } };
    applyProfile(settings, oo);
    assert.equal(settings.promptPresets.natural.suffix, 'masterpiece, very awa');
});

test('upgrading keeps an existing install exactly as it was (profiles and settings are never replaced)', () => {
    const old = { mangaMode: { comfy: { family: 'checkpoint', checkpoint: 'mine.safetensors', sampler: 'euler', scheduler: 'normal', steps: 20, cfg: 5 }, promptStyle: 'tags', modelProfiles: [{ id: 'mine', name: 'Mine', promptStyle: 'tags', generation: {} }], activeProfileId: 'mine' } };
    const s = getSettings(old);
    assert.equal(s.comfy.checkpoint, 'mine.safetensors');
    assert.equal(s.comfy.sampler, 'euler');
    assert.equal(s.promptStyle, 'tags');
    assert.equal(s.modelProfiles.length, 1);
    assert.equal(s.activeProfileId, 'mine');
});

test('model-specific negative terms join the negative prompt', () => {
    assert.match(withSafetyNegative('text', 'score_1, score_2'), /^text, score_1, score_2, loli/);
});

// async: a workflow ComfyUI rejects is not retried and says what to check
const asyncTests = [async () => {
    const before = generationStats.attempts;
    globalThis.fetch = async () => ({ ok: false, text: async () => 'ComfyUI returned an error.' });
    await assert.rejects(runComfyWithRetry({ getRequestHeaders: () => ({}) }, 'u', {}), /model file named in the model profile is not installed/);
    assert.equal(generationStats.attempts - before, 1, 'no retry for a rejected workflow');
    passed++; console.log('ok - rejected workflow: no retry, actionable message');
}];
for (const t of asyncTests) await t();

test('grown gutters give back the side no balloon uses', () => {
    const g = { grow: 177, baseTop: 40, baseBottom: 40 };
    assert.deepEqual(trimGutters({ usesTop: true, usesBottom: false, ...g }), { top: 217, bottom: 40, shiftY: 0 });
    assert.deepEqual(trimGutters({ usesTop: false, usesBottom: true, ...g }), { top: 40, bottom: 217, shiftY: -177 });
    assert.deepEqual(trimGutters({ usesTop: false, usesBottom: false, ...g }), { top: 40, bottom: 40, shiftY: -177 });
});

test('director: the porch beat is kept, the "player stands alone" beat goes first (Vanessa #6)', () => {
    const beat = (o) => ({ beat: 'b', characters: ['Vanessa', 'alex'], camera: { shot: 'medium shot', angle: 'eye level' }, people: [], dialogue_indices: [], intensity: 'calm', same_moment: false, ...o });
    const beats = [
        beat({ dialogue_indices: [0] }),
        beat({ intensity: 'tense', dialogue_indices: [1, 2, 3] }),
        beat({ dialogue_indices: [4, 5, 6], location: 'porch' }),
        beat({ characters: ['alex'], dialogue_indices: [] }),
    ];
    // The old rule kept first + last and dropped the porch. With 3 images the player-alone beat goes.
    const kept = fitBudget(beats, { maxPanels: 3, maxImages: 3, playerName: 'alex' }).flat();
    assert.equal(kept.length, 3);
    assert.ok(kept.some((b) => b.location === 'porch'));
    assert.ok(!kept.some((b) => b.characters.length === 1));
    assert.ok(beatValue(beats[3], { playerName: 'alex' }) < beatValue(beats[2], { playerName: 'alex' }));
});

test('director: linked beats share a panel as frames; budgets hold; every line kept once', () => {
    const beat = (o) => ({ beat: 'b', characters: ['A'], camera: { shot: 'medium shot', angle: 'eye level' }, people: [], dialogue_indices: [], intensity: 'calm', same_moment: false, new_panel: true, location: 'the old porch', ...o });
    const scene = {
        characters: [{ name: 'A', screen_position: 'left' }],
        dialogue: Array.from({ length: 5 }, () => ({ speaker: 'A', text: 'x' })),
        beats: [
            beat({ kind: 'establishing', characters: [], emphasis: 'main' }),
            beat({ camera: { shot: 'full shot', angle: 'eye level' }, dialogue_indices: [0] }),
            beat({ new_panel: false, emphasis: 'main', camera: { shot: 'close-up', angle: 'eye level' }, dialogue_indices: [1] }),
            beat({ new_panel: false, emphasis: 'minor', dialogue_indices: [2] }),
            beat({ dialogue_indices: [3, 4], location: 'somewhere else entirely' }),
        ],
    };
    const plan = planPanels(scene, { maxPanels: 4, maxImages: 6, seed: 't' });
    assert.equal(plan.length, 3, 'a new place keeps its own panel; the establishing view stays alone');
    assert.equal(plan[0].strategy, 'generate');
    assert.deepEqual(plan[0].size, { width: 1344, height: 768 }, 'establishing view is wide');
    assert.equal(plan[1].strategy, 'grid');
    assert.equal(plan[1].frames.length, 3);
    const shares = plan[1].frames.map((f) => f.rect.share);
    assert.equal(Math.max(...shares), shares[1], 'the main frame is drawn biggest');
    assert.deepEqual(plan.flatMap((p) => p.dialogue), [0, 1, 2, 3, 4]);
    for (const f of plan[1].frames) {
        assert.ok(f.size.width % 64 === 0 && f.size.height % 64 === 0);
        assert.ok(Math.abs(f.size.width / f.size.height - f.rect.aspect) < 0.2, 'generated at the frame\'s own shape');
    }
    // Tighter image budget: frames are dropped, lines never.
    const small = planPanels(scene, { maxPanels: 2, maxImages: 3, seed: 't' });
    assert.ok(small.length <= 2);
    assert.equal(small.reduce((n, p) => n + (p.frames ? p.frames.length : 1), 0), 3);
    assert.deepEqual(small.flatMap((p) => p.dialogue), [0, 1, 2, 3, 4]);
});

test('layout: frames tile the panel without overlap, main frame largest, varied by seed', () => {
    const frames = [{ shot: 'full shot', people: 1, emphasis: 'main' }, { shot: 'close-up', people: 1 }, { shot: 'close-up', people: 1 }];
    const L = chooseLayout(frames, { seed: 'a' });
    const r = L.frames;
    for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) {
        const ix = Math.max(0, Math.min(r[i].x1, r[j].x1) - Math.max(r[i].x0, r[j].x0));
        const iy = Math.max(0, Math.min(r[i].y1, r[j].y1) - Math.max(r[i].y0, r[j].y0));
        assert.equal(ix * iy, 0);
    }
    assert.equal(Math.max(...r.map((f) => f.share)), r[0].share);
    const templates = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((seed) => chooseLayout([{ shot: 'medium shot', people: 1 }, { shot: 'medium shot', people: 1 }, { shot: 'medium shot', people: 1 }], { seed }).template));
    assert.ok(templates.size >= 1);
    assert.deepEqual(frameGenerationSize(1, 0.5), { width: 1024, height: 1024 });
});

test('director: an establishing view opens a reply that dwells on the surroundings, within budget', () => {
    assert.equal(wantsEstablishing('Night falls. Fireflies blink over the dark field and the first stars come out.'), true);
    assert.equal(wantsEstablishing('"You klutz!" she shouts, scooping up the books.'), false);
    const beat = (o) => ({ beat: 'b', characters: ['A'], camera: { shot: 'medium shot', angle: 'eye level' }, people: [], dialogue_indices: [], intensity: 'calm', same_moment: false, ...o });
    const scene = { setting: 'porch steps at night over a dark field', characters: [{ name: 'A' }], dialogue: [{ speaker: 'A', text: 'x' }], beats: [beat({ dialogue_indices: [0] }), beat({})] };
    const plan = planPanels(scene, { maxPanels: 4, maxImages: 6, establishingHint: true });
    assert.equal(plan[0].spec.kind, 'establishing');
    assert.deepEqual(plan[0].size, { width: 1344, height: 768 });
    assert.deepEqual(plan.flatMap((p) => p.dialogue), [0]);
    // No room: nothing is pushed out for it.
    assert.equal(planPanels(scene, { maxPanels: 2, maxImages: 6, establishingHint: true })[0].spec.kind, undefined);
});

test('balloons keep off head zones when there is room elsewhere', () => {
    const zones = headZones([{ name: 'A', screen_position: 'left' }, { name: 'B', screen_position: 'right' }], new Map(), 'medium shot');
    assert.equal(zones.length, 2);
    const res = placeBubbleGroups({ stripWidth: 600, stripHeight: 900, imageRect: { x0: 0, y0: 0.1, x1: 1, y1: 0.9 }, groups: [{ id: 'g', width: 170, height: 90, hintSide: 'right' }], occupancyMap: null, avoid: zones });
    const p = res.get('g');
    const rect = { x0: p.left / 600, x1: (p.left + 170) / 600, y0: p.top / 900, y1: (p.top + 90) / 900 };
    for (const z of zones) {
        const s = { x0: z.x0, x1: z.x1, y0: 0.1 + z.y0 * 0.8, y1: 0.1 + z.y1 * 0.8 };
        const ix = Math.max(0, Math.min(rect.x1, s.x1) - Math.max(rect.x0, s.x0));
        const iy = Math.max(0, Math.min(rect.y1, s.y1) - Math.max(rect.y0, s.y0));
        assert.ok(ix * iy < 0.25 * (s.x1 - s.x0) * (s.y1 - s.y0), 'a face is not covered');
    }
});

test('layout: a page of 5-6 frames tiles without overlap, main frame largest', () => {
    for (const frames of [
        [{ kind: 'insert', people: 0 }, { shot: 'extreme close-up', people: 1 }, { shot: 'full shot', people: 2, emphasis: 'main' }, { shot: 'medium shot', people: 1 }, { kind: 'insert', people: 0 }],
        [{ shot: 'close-up', people: 1 }, { shot: 'medium shot', people: 1 }, { shot: 'full shot', people: 1, emphasis: 'main' }, { shot: 'medium shot', people: 1 }, { kind: 'insert', people: 0 }, { shot: 'close-up', people: 1 }],
    ]) {
        const L = chooseLayout(frames, { seed: 'p' });
        const r = L.frames;
        assert.equal(r.length, frames.length);
        for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) {
            const ix = Math.max(0, Math.min(r[i].x1, r[j].x1) - Math.max(r[i].x0, r[j].x0));
            const iy = Math.max(0, Math.min(r[i].y1, r[j].y1) - Math.max(r[i].y0, r[j].y0));
            assert.ok(ix * iy < 1e-9);
        }
        const main = frames.findIndex((f) => f.emphasis === 'main');
        assert.ok(r[main].share >= Math.max(...r.map((f) => f.share)) - 0.05);
    }
});

test('director: consecutive short panels in one place are packed into one page', () => {
    const beat = (o) => ({ beat: 'b', characters: ['A'], camera: { shot: 'medium shot', angle: 'eye level' }, people: [], dialogue_indices: [], intensity: 'calm', same_moment: false, new_panel: true, location: 'dirt driveway by the cottage', ...o });
    const scene = { characters: [{ name: 'A' }], dialogue: Array.from({ length: 8 }, () => ({ speaker: 'A', text: 'x' })), beats: [
        beat({ dialogue_indices: [0] }), beat({ new_panel: false, dialogue_indices: [1] }),
        beat({ dialogue_indices: [2, 3], location: 'sun-baked dirt driveway' }), beat({ new_panel: false, dialogue_indices: [4] }),
        beat({ dialogue_indices: [5, 6, 7, 0].slice(0, 3) }), beat({ new_panel: false }),
    ] };
    const plan = planPanels(scene, { maxPanels: 6, maxImages: 10, seed: 'k' });
    assert.equal(plan.length, 2);
    assert.equal(plan[0].frames.length, 4);
    assert.equal(plan[1].frames.length, 2);
    assert.deepEqual(plan.flatMap((p) => p.dialogue), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('faces: the highest skin clumps, hands below are dropped; crops pick the face, not yellow grass', () => {
    const blob = (cx, cy, r, out) => { for (let x = cx - r; x <= cx + r; x += 0.004) for (let y = cy - r; y <= cy + r; y += 0.004) out.push(x, y); };
    const pts = [];
    blob(0.3, 0.15, 0.06, pts); // face A
    blob(0.72, 0.2, 0.06, pts); // face B, a little lower
    blob(0.5, 0.6, 0.07, pts); // a hand far below
    const faces = locateTopClumps(pts, 250 * 250);
    assert.equal(faces.length, 2);
    assert.ok(Math.abs(faces[0].x - 0.3) < 0.03 && Math.abs(faces[0].y - 0.15) < 0.03);
    assert.ok(Math.abs(faces[1].x - 0.72) < 0.03);
    // Yellow grass far to the side is ignored; the side hint picks between two faces.
    const grass = { x: 0.92, y: 0.55, spreadY: 0.1 };
    assert.ok(Math.abs(pickHead(faces, grass, 0.3).x - 0.3) < 0.03);
    assert.ok(Math.abs(pickHead(faces, null, 0.7).x - 0.72) < 0.03);
    // Hair right above a face picks that face whatever the side hint says.
    assert.ok(Math.abs(pickHead(faces, { x: 0.71, y: 0.16, spreadY: 0.05 }, 0.2).x - 0.72) < 0.03);
    // No faces: low hair is scenery.
    assert.equal(pickHead([], grass, 0.5), null);
});

test('speech is cut into balloons in code: sentences, lone exclamations, interrupted sentences', () => {
    assert.deepEqual(segmentSpeech('Personal space! Two-meter buffer zone, please!'), ['Personal space!', 'Two-meter buffer zone, please!']);
    // An ellipsis before a lower-case word is a pause, not a sentence end; short bits join.
    assert.deepEqual(segmentSpeech('I have... lemonade. Or water. Whichever one stops you from breathing like a dying vacuum cleaner.'),
        ['I have... lemonade. Or water.', 'Whichever one stops you from breathing like a dying vacuum cleaner.']);
    assert.ok(segmentSpeech('word '.repeat(30).trim() + '.').every((p) => p.split(' ').length <= 18));
    const text = '"First of all," *she says, counting on a finger,* "your cadence is all wrong today." *She reads "Dune" aloud.* “Sit *down*.”';
    const lines = extractSpeechLines(text);
    assert.deepEqual(lines.map((l) => l.text), ['First of all, your cadence is all wrong today.', 'Dune', 'Sit down.']);
    assert.deepEqual(lines.map((l) => l.aside), [false, true, false]);
    assert.deepEqual(extractSpeechLines('*She waves.* Hi there.'), []);
});

test('numbered balloons come back as full lines; skipped ones are put back; beats re-pointed', () => {
    const lines = [{ text: 'I am not angry!', passage: 0 }, { text: 'I am... perturbed.', passage: 0 }, { text: 'Dune', passage: 1, aside: true }, { text: 'Sit down.', passage: 2 }];
    const scene = {
        dialogue: [
            { line: 0, speaker: 'Vanessa', bubble_type: 'shout', text: '' },
            { line: -1, speaker: 'Vanessa', bubble_type: 'inner', text: 'He is so *tall*.' },
            { line: 2, speaker: 'Vanessa', bubble_type: 'none', text: '' },
            { line: 3, speaker: 'Vanessa', bubble_type: 'speech', text: 'ignored' },
        ],
        beats: [{ dialogue_indices: [0, 1] }, { dialogue_indices: [2, 3] }],
    };
    const out = resolveDialogueRefs(scene, lines, { fallbackSpeaker: 'X' });
    assert.deepEqual(out.dialogue.map((d) => [d.text, d.bubble_type, d.speaker]), [
        ['I am not angry!', 'shout', 'Vanessa'],
        ['He is so tall.', 'inner', 'Vanessa'],
        ['I am... perturbed.', 'speech', 'Vanessa'],
        ['Sit down.', 'speech', 'Vanessa'],
    ]);
    assert.deepEqual(out.beats.map((b) => b.dialogue_indices), [[0, 1], [3]]);
});

test('beats get their characters from their people and carry the location forward', () => {
    const scene = { setting: 'gravel driveway', beats: [
        { people: [{ name: 'Vanessa' }], location: '' },
        { people: [{ name: 'Vanessa' }, { name: 'alex' }], location: 'porch steps' },
        { people: [], location: '' },
        { characters: ['Old'], people: [], location: 'kept' },
    ] };
    const out = completeBeats(scene).beats;
    assert.deepEqual(out.map((b) => b.characters), [['Vanessa'], ['Vanessa', 'alex'], [], ['Old']]);
    assert.deepEqual(out.map((b) => b.location), ['gravel driveway', 'porch steps', 'porch steps', 'kept']);
});

test('a page with too much lettering is cut in two where the words balance', () => {
    const dialogue = Array.from({ length: 10 }, () => ({ speaker: 'V', text: 'one two three four five six seven eight nine ten eleven twelve' }));
    const spec = (lines, o = {}) => ({ kind: 'character', emphasis: 'normal', dialogue_indices: lines, ...o });
    const page = [spec([0, 1]), spec([2, 3], { emphasis: 'main' }), spec([4, 5]), spec([6, 7]), spec([8, 9])];
    const out = splitCrowdedPages([page], dialogue, { maxPanels: 6 });
    assert.ok(out.length >= 2);
    assert.deepEqual(out.flat().flatMap((s) => s.dialogue_indices), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const half of out) if (half.length > 1) assert.equal(half.filter((s) => s.emphasis === 'main').length, 1);
    // Light pages and the panel budget are respected.
    assert.equal(splitCrowdedPages([page], dialogue.map((d) => ({ ...d, text: 'hi' })), { maxPanels: 6 }).length, 1);
    assert.equal(splitCrowdedPages([page], dialogue, { maxPanels: 1 }).length, 1);
});

test('crops ignore small skin-coloured clumps (wood) and keep the people in a narrow cut', () => {
    const face = { x: 0.53, y: 0.14, share: 0.019, spreadY: 0.05 };
    const post = { x: 0.23, y: 0.1, share: 0.0086, spreadY: 0.05 };
    const step = { x: 0.94, y: 0.08, share: 0.008, spreadY: 0.03 };
    assert.ok(Math.abs(pickHead([face, step, post], null, 0.3).x - 0.53) < 0.01);
    assert.ok(Math.abs(peopleCenterX([face, step, post]) - 0.53) < 0.01);
    const two = [{ x: 0.3, y: 0.2, share: 0.02 }, { x: 0.7, y: 0.25, share: 0.018 }];
    assert.ok(Math.abs(peopleCenterX(two) - 0.5) < 0.01);
    assert.equal(peopleCenterX([]), 0.5);
});

test('a long speech in one beat becomes frames of at most three lines, alternating a closer camera', () => {
    const dialogue = Array.from({ length: 7 }, (_, i) => ({ speaker: 'V', text: `line ${i}`, bubble_type: 'speech' }));
    const beat = { kind: 'character', new_panel: true, emphasis: 'main', camera: { shot: 'medium shot', angle: 'low angle' }, characters: ['V'], people: [], dialogue_indices: [0, 1, 2, 3, 4, 5, 6], sfx: 'x' };
    const out = splitLongSpeech([beat], dialogue);
    assert.deepEqual(out.map((b) => b.dialogue_indices), [[0, 1, 2], [3, 4, 5], [6]]);
    assert.deepEqual(out.map((b) => b.camera.shot), ['medium shot', 'close-up', 'medium shot']);
    assert.deepEqual(out.map((b) => b.new_panel), [true, false, false]);
    assert.equal(out[1].sfx, '');
    assert.equal(splitLongSpeech([{ ...beat, dialogue_indices: [0, 1, 2] }], dialogue).length, 1);
    assert.equal(splitLongSpeech([{ ...beat, kind: 'insert' }], dialogue).length, 1);
});

test('set book: places and objects keep the look they were first given', () => {
    const chat = [
        { extra: { manga: { scene: { places: [{ name: "Vanessa's porch", kind: 'place', look: 'white wooden porch, three steps, green screen door' }, { name: "the player's road bike", kind: 'object', look: 'mint-green road bike' }] } } } },
        { extra: { manga: { scene: { places: [{ name: "Vanessa's porch", kind: 'place', look: 'a DIFFERENT porch' }, { name: 'the old garage', kind: 'place', look: 'red barn-style garage, peeling paint' }] } } } },
    ];
    const known = findKnownSet(chat, 2);
    assert.equal(known.length, 3);
    assert.match(known[0].look, /white wooden porch/);
    assert.equal(mergeSet(known, [{ name: 'Vanessa’s porch', kind: 'place', look: 'x' }, { name: 'cornfield', kind: 'place', look: 'tall corn' }]).length, 4);
    assert.equal(matchPlace('porch steps at dusk', known)?.name, "Vanessa's porch");
    assert.equal(matchPlace('the garage doorway', known)?.name, 'the old garage');
    assert.equal(matchPlace('open sky', known), null);
    assert.deepEqual(objectsIn('She points at the bike chain.', known).map((o) => o.name), ["the player's road bike"]);
});

test('face finding looks for the skin tone the card states', () => {
    assert.equal(skinToneOf('adult woman, blonde hair, fair, pale skin'), 'light');
    assert.equal(skinToneOf('tall man, dark skin, short black hair'), 'dark');
    assert.equal(skinToneOf('tanned skin, freckles'), 'tan');
    assert.equal(skinToneOf('olive-skinned woman'), 'tan');
    assert.equal(skinToneOf(''), 'light');
});

test('profile LoRAs chain on the model; the detail pass re-samples a loaded image', () => {
    assert.deepEqual(parseLoraList('a.safetensors:0.6, b.safetensors'), [{ name: 'a.safetensors', strength: 0.6 }, { name: 'b.safetensors', strength: 1 }]);
    assert.deepEqual(parseLoraList(''), []);
    const base = { positiveChunks: ['p'], negativePrompt: 'n', sampler: 'er_sde', scheduler: 'simple', steps: 10, cfg: 1, width: 1024, height: 1024, seed: 1, family: 'split', unet: 'u', clip: 'c', clipType: 'stable_diffusion', vae: 'v' };
    const g = buildComfyWorkflow({ ...base, loras: 'a.safetensors:0.6, b.safetensors' });
    assert.equal(g['40'].class_type, 'LoraLoaderModelOnly');
    assert.deepEqual(g['40'].inputs.model, ['4', 0]);
    assert.deepEqual(g['41'].inputs.model, ['40', 0]);
    assert.deepEqual(g['3'].inputs.model, ['41', 0]);
    assert.ok(!buildComfyWorkflow(base)['40']);
    const r = buildRefineWorkflow({ ...base, base64: 'AAAA', denoise: 0.38 });
    assert.ok(!r['5']);
    assert.deepEqual(r['3'].inputs.latent_image, ['32', 0]);
    assert.equal(r['3'].inputs.denoise, 0.38);
    assert.equal(r['30'].class_type, 'easy loadImageBase64');
});

test('character reference: pictures are encoded, batched and attached after the in-context LoRA', () => {
    const base = { positiveChunks: ['p'], negativePrompt: 'n', sampler: 'er_sde', scheduler: 'simple', steps: 10, cfg: 1, width: 896, height: 1152, seed: 1, family: 'split', unet: 'u', clip: 'c', clipType: 'stable_diffusion', vae: 'v' };
    const g = addCharacterReference(buildComfyWorkflow(base), { refs: ['A', 'B'], width: 896, height: 1152, lora: 'ic.safetensors', loraStrength: 0.5 });
    assert.deepEqual(g['50'].inputs.model, ['4', 0]);
    assert.equal(g['50'].inputs.strength_model, 0.5);
    assert.equal(g['70'].class_type, 'AnimaRefEncode');
    assert.deepEqual(g['70'].inputs.vae, ['11', 0]);
    assert.equal(g['70'].inputs.target_width, 896);
    assert.deepEqual(g['81'].inputs.ref_latent_2, ['71', 0]);
    assert.deepEqual(g['90'].inputs.ref_latent, ['81', 0]);
    assert.deepEqual(g['3'].inputs.model, ['90', 0]);
    const plain = buildComfyWorkflow(base);
    assert.deepEqual(addCharacterReference(plain, { refs: [], width: 1, height: 1 })['3'].inputs.model, ['4', 0]);
});

// ---- full mode_ma ----


// ---------------------------------------------------------------- the cleanup (world book, cast book, compiler, check)

const CAST = uniqueLabels([
    { name: 'alex', role: 'player', sex: 'male', label: 'the young man in the black t-shirt', look: 'young man, short dark brown hair, dark brown eyes', outfit: 'black T-shirt, dark gray pants, black sneakers', aliases: [] },
    { name: 'Guard Roland', sex: 'male', label: 'the armoured watchman', look: 'man in his forties, short brown hair, stubble, a scar on the left brow', outfit: 'polished steel breastplate over a blue tabard, iron gauntlets, leather greaves, broadsword at the hip', aliases: [] },
    { name: 'Newspaper Boy', sex: 'male', label: 'the newsboy', look: 'boy of about twelve, messy brown hair, freckles', outfit: 'grey flat cap, patched brown coat, leather satchel of papers, worn boots', aliases: [] },
]);
const SET = mergeSet([], [{ name: "The Boar's Tusk", kind: 'place', label: 'the tavern', look: 'squat timber-framed tavern, oak double doors, a carved sign of a foaming mug' }]);
const CTX = { style: 'natural', presets: DEFAULT_SETTINGS.promptPresets, cast: CAST, setBook: SET, world: { era_and_technology: 'late-medieval fantasy, no gunpowder' }, setting: 'cobblestone market street, morning', personaName: 'alex' };

test('compiler: every person drawn from the cast book (armour and all), names never reach the image model', () => {
    const spec = { kind: 'character', description: 'Roland stands squarely in front of alex, sternly confronting him.', background: 'shoppers whisper behind merchant awnings', people: [
        { name: 'alex', side: 'left', action: 'standing calmly', expression: 'unbothered', gaze: 'Guard Roland' },
        { name: 'Roland', side: 'right', action: 'right hand on his sword hilt', expression: 'jaw clenched, left eye twitching', gaze: 'alex' },
    ] };
    const [p] = compileFrame(spec, { shot: 'medium shot', angle: 'eye level' }, CTX);
    assert.match(p, /On the right, the armoured watchman is an adult man: man in his forties[^.]*; wearing polished steel breastplate over a blue tabard, iron gauntlets, broadsword at the hip\./);
    assert.ok(!/sneakers|greaves/.test(p), 'shoes and leg armour left out of a waist-up shot');
    assert.ok(!/\bRoland\b|\balex\b/i.test(p), 'no names');
    assert.match(p, /Around them: shoppers behind merchant awnings\./);
    assert.ok(!/No one else/.test(p), 'background people are allowed when the frame has them');
    assert.match(p, /From left to right: the young man in the black t-shirt, the armoured watchman\./);
    assert.match(p, /looks at the armoured watchman, his eyes on that person's face/);
    assert.match(p, /World: late-medieval fantasy\./);
    assert.ok(!/gunpowder/.test(p), 'what the world lacks is not named');
    assert.match(p, /Signs, pages and screens in the picture show only small pictures and unreadable marks\./);
    assert.ok(!/\b(?:never|not|no)\b(?! gunpowder)/i.test(p.replace(/World:[^.]*\./, '')), 'the prompt never names what it does not want: the model is run without a negative prompt (CFG 1) and draws what is named');
});

test('compiler: an action about legs is framed as a full shot; a close-up base stays as asked', () => {
    const spec = { kind: 'character', description: 'The newsboy skids to a halt, boots scraping the cobbles.', background: '', people: [{ name: 'Newspaper Boy', side: 'center', action: 'skidding to a halt, one foot planted back', expression: 'surprised', gaze: 'the viewer' }] };
    assert.equal(effectiveCamera(spec, { shot: 'medium shot', angle: 'low angle' }).shot, 'full shot');
    const [p] = compileFrame(spec, { shot: 'medium shot', angle: 'low angle' }, CTX);
    assert.match(p, /full body/);
    assert.ok(!/no legs or feet/.test(p));
    assert.match(p, /The newsboy is a boy:/);
    assert.equal(effectiveCamera(spec, { shot: 'medium shot', forCrop: true }).shot, 'medium shot');
});

test('compiler: inserts show hands only; establishing views keep their crowd; places go by their label', () => {
    const [ins] = compileFrame({ kind: 'insert', description: 'A heavy iron gauntlet bars the way.', people: [{ name: 'Roland' }] }, { shot: 'close-up' }, CTX);
    // Someone else's hands are seen from in front of them, against their own clothes (not first-person).
    assert.match(ins, /close-up detail shot of the armoured watchman's hands and an object, seen from the front: the hands are held in front of his body, against his polished steel breastplate over a blue tabard, and the face is cut off above the top edge of the picture\./);
    assert.match(ins, /The armoured watchman's hands \(adult man\), wearing iron gauntlets\./);
    // The player's own hands stay first-person.
    const [own] = compileFrame({ kind: 'insert', description: 'Coins on an open palm.', people: [{ name: 'alex' }] }, { shot: 'close-up' }, { ...CTX, personaName: 'alex' });
    assert.match(own, /Only the hands and forearms of/);
    const [est] = compileFrame({ kind: 'establishing', location: "The Boar's Tusk", description: "The Boar's Tusk across the plaza.", background: 'early patrons drinking quietly', people: [] }, { shot: 'wide shot' }, CTX);
    assert.match(est, /the people in it are small/);
    assert.match(est, /In the scene: early patrons drinking quietly\./);
    assert.ok(!/Boar|nobody in it/.test(est));
    assert.match(est, /Setting: the tavern: squat timber-framed tavern/);
});

test('compiler: tag styles get a shared chunk and one chunk per person from the cast', () => {
    const chunks = compileFrame({ kind: 'character', description: 'two men face each other', people: [{ name: 'alex', side: 'left' }, { name: 'Roland', side: 'right', action: 'hand on sword hilt' }] }, { shot: 'medium shot', angle: 'eye level' }, { ...CTX, style: 'tags' });
    assert.equal(chunks.length, 3);
    assert.match(chunks[0], /^2boys, /);
    assert.match(chunks[2], /^1boy, adult, man in his forties.*polished steel breastplate.*hand on sword hilt/);
});

test('speech filter: real speech verbs go with their clause; nouns, adjectives and action verbs stay', () => {
    assert.equal(stripSpeech('Roland tightens his grip on his hilt, delivering an authoritative demand for identification.'), 'Roland tightens his grip on his hilt, delivering an authoritative demand for identification.');
    assert.equal(stripSpeech('Head tilted forward with gritted teeth and an intense, demanding glare.'), 'Head tilted forward with gritted teeth and an intense, demanding glare.');
    assert.equal(stripSpeech('He snapped the rope in two.'), 'He snapped the rope in two.');
    assert.equal(stripSpeech('The boy leans close to him, whispering directions, while glancing at the guard.'), 'The boy leans close to him, while glancing at the guard.');
    assert.equal(tidy('The the brown-haired boy hushes a the man. then he runs.'), 'The brown-haired boy hushes the man. Then he runs.');
});

test('names: titled names, their core and place names all become labels', () => {
    const pairs = namePairs(CAST, SET);
    assert.equal(replaceNames("Roland glances toward The Boar's Tusk while Guard Roland's hand stays on the hilt.", pairs), "The armoured watchman glances toward the tavern while the armoured watchman's hand stays on the hilt.");
    assert.equal(replaceNames('The Newspaper Boy runs.', pairs), 'The newsboy runs.');
});

test('gaze: at a figure in the frame, at the viewer when the player is out of frame, toward the viewer over the shoulder', () => {
    const ron = { name: 'Roland', gaze: 'alex', cast: findPerson(CAST, 'Roland'), label: 'the armoured watchman' };
    const me = { name: 'alex', cast: findPerson(CAST, 'alex'), label: 'the young man in the black t-shirt' };
    assert.equal(gazeSentence(ron, [ron, me], { personaName: 'alex' }), "He looks at the young man in the black t-shirt, his eyes on that person's face.");
    assert.equal(gazeSentence(ron, [ron], { personaName: 'alex' }), 'He looks straight at the viewer.');
    assert.equal(gazeSentence(ron, [ron, me], { personaName: 'alex', overShoulder: true }), 'He looks toward the viewer.');
});

test('cast book: a person keeps label and look; the outfit changes only when a reply says so', () => {
    assert.ok(sameName('Guard Roland', 'Roland'));
    assert.ok(!sameName('Lady Elaine', 'Sir Brandon'));
    let cast = mergeCast([], [{ name: 'Guard Roland', sex: 'male', label: 'the armoured watchman', look: 'forties, stubble', outfit: 'steel breastplate' }]);
    cast = mergeCast(cast, [{ name: 'Roland', sex: 'male', label: 'another label', look: 'other look', outfit: 'plain linen shirt', outfit_changed: false }]);
    assert.equal(cast.length, 1);
    assert.equal(cast[0].label, 'the watchman');
    assert.equal(cast[0].outfit, 'steel breastplate', 'armour stays on');
    cast = mergeCast(cast, [{ name: 'Roland', outfit: 'plain linen shirt, armour off', outfit_changed: true }]);
    assert.equal(cast[0].outfit, 'plain linen shirt, armour off');
    const named = mergeCast(mergeCast([], [{ name: 'Off-duty Guard', sex: 'male', label: 'the off-duty guard', look: 'l', outfit: 'o' }]), [{ name: 'Guard Roland', same_as: 'Off-duty Guard', label: '', look: '', outfit: '' }]);
    assert.equal(named.length, 1, 'a known person who gets a name stays one person');
    assert.equal(findPerson(named, 'Roland').label, 'the off-duty guard');
    const chat = [{}, { extra: { manga: { scene: { cast: [{ name: 'Wolf-eared Grocer', sex: 'male', label: 'the grocer', look: 'old man with grey wolf ears', outfit: 'apron' }] } } } }];
    const known = findKnownCast(chat, 2, [{ name: 'Alex the traveller', role: 'player', sex: 'male', label: 'the traveller', look: 'l', outfit: 'o' }], { personaName: 'alex' });
    assert.deepEqual(known.map((p) => p.name), ['alex', 'Wolf-eared Grocer']);
    assert.match(formatKnownCast(known, { personaName: 'alex' }), /^- alex \(THE PLAYER\) \[male\] the traveller/);
    assert.deepEqual(uniqueLabels([{ label: 'the guard' }, { label: 'guard' }]).map((p) => p.label), ['the guard', 'the second guard']);
});

test('thoughts in backticks are balloons word for word, in reading order with the quotes', () => {
    const lines = extractSpeechLines('He stops. `A disguised demon? A cultist?` He frowns. "Identify yourself." `No... not a demon.`');
    assert.deepEqual(lines.map((l) => [l.text, Boolean(l.thought)]), [['A disguised demon?', true], ['A cultist?', true], ['Identify yourself.', false], ['No... not a demon.', true]]);
    const back = resolveDialogueRefs({ dialogue: [{ line: 0, speaker: 'Roland', bubble_type: 'speech' }], beats: [] }, lines, { fallbackSpeaker: 'Roland' });
    assert.deepEqual(back.dialogue.map((d) => d.bubble_type), ['thought', 'thought', 'speech', 'thought']);
});

test('world book is shown to the director as plain rules', () => {
    const text = formatWorld({ summary: 'A magic city.', era_and_technology: 'medieval', dress_by_role: [{ role: 'guards', look: 'steel breastplates' }], peoples: [{ name: 'kemonomimi', visual: 'animal ears on the head' }], architecture: 'timber', palette_and_light: 'warm' });
    assert.match(text, /- guards: steel breastplates/);
    assert.match(text, /- kemonomimi: animal ears on the head/);
});

test('quality check: judged in code; head boxes become crop rectangles', () => {
    const exp = { labels: ['the armoured watchman', 'the newsboy'], kind: 'character', forCrop: false };
    const ok = { figures: [{ label: 'the armoured watchman', present: true, count: 1, matches_look: true }, { label: 'the newsboy', present: true, count: 1, matches_look: true }], extra_main_figures: 0, lettering: 'small background signs', defects: '', heads: [] };
    assert.equal(judge(ok, exp).pass, true);
    const bad = { ...ok, figures: [{ label: 'the armoured watchman', present: true, count: 1, matches_look: false, note: 'no armour' }, { label: 'the newsboy', present: false, count: 0 }], lettering: 'prominent' };
    assert.deepEqual(judge(bad, exp).reasons, ['the armoured watchman does not match their look (no armour)', 'the newsboy missing', 'prominent lettering in the picture']);
    const ans = { heads: [{ label: 'the newsboy', box: [100, 400, 300, 600] }] };
    assert.deepEqual(headOf(ans, 'the newsboy'), { x0: 0.4, y0: 0.1, x1: 0.6, y1: 0.3 });
    const r = headCropRect(headOf(ans, 'the newsboy'), 1, 'close-up', 0.9);
    assert.ok(r.x0 <= 0.4 && r.x1 >= 0.6 && r.y0 <= 0.1 && r.y1 >= 0.3, 'the whole head is inside the crop');
    const inCrop = headsInCrop(ans, { x0: 0.3, y0: 0, x1: 0.8, y1: 0.5 });
    assert.ok(Math.abs(inCrop[0].box.x0 - 0.2) < 1e-9 && Math.abs(inCrop[0].box.y1 - 0.6) < 1e-9);
    assert.equal(judge({ ...ok, heads: [] }, { ...exp, forCrop: true }).pass, false, 'a close-up base needs the head');
    assert.deepEqual(judge({ ...ok, background: 'blank or white' }, exp).reasons, ['blank background']);
    assert.equal(judge({ ...ok, background: 'blank or white' }, { ...exp, kind: 'insert', labels: [] }).pass, true, 'an insert may be plain');
    assert.equal(judge({ ...ok, lettering: 'prominent' }, { ...exp, writing: true }).pass, true, 'a newspaper frame may show letters');
    const paper = frameExpectation({ kind: 'insert', description: 'Hands unfold the newspaper; the front page shows a knight.', people: [] }, { shot: 'close-up', angle: 'pov' }, { cast: [], setBook: [], personaName: 'Kai' });
    assert.equal(paper.writing, true);
    assert.equal(frameExpectation({ kind: 'character', description: 'He draws his sword.', people: [] }, { shot: 'medium shot', angle: 'eye level' }, { cast: [], setBook: [], personaName: 'Kai' }).writing, false);
});

test('frame expectation lists the main figures with their look and outfit', () => {
    const e = frameExpectation({ kind: 'character', people: [{ name: 'Roland', action: 'hand on hilt' }], description: 'Roland blocks the way.' }, { shot: 'medium shot' }, CTX);
    assert.deepEqual(e.labels, ['the armoured watchman']);
    assert.match(e.text, /"the armoured watchman": man in his forties.*polished steel breastplate/);
});

test('custom workflow: placeholders filled, else the sampler\'s text boxes; seed and size set per frame', () => {
    const api = {
        1: { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece, %prompt%', clip: ['9', 0] } },
        2: { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['9', 0] } },
        3: { class_type: 'KSampler', inputs: { seed: 5, steps: 20, positive: ['1', 0], negative: ['2', 0], latent_image: ['4', 0], denoise: 1, model: ['9', 0] } },
        4: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
        5: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['9', 2] } },
    };
    const g = prepareCustomGraph(api, { prompt: 'a knight', negative: 'text', seed: 42, width: 896, height: 1152 });
    assert.equal(g[1].inputs.text, 'masterpiece, a knight');
    assert.equal(g[2].inputs.text, 'text', 'empty negative box gets the negative prompt');
    assert.equal(g[3].inputs.seed, 42);
    assert.deepEqual([g[4].inputs.width, g[4].inputs.height], [896, 1152]);
    const plain = { ...api, 1: { class_type: 'CLIPTextEncode', inputs: { text: 'old text', clip: ['9', 0] } } };
    assert.equal(prepareCustomGraph(plain, { prompt: 'p', negative: 'n', seed: 1, width: 1, height: 1 })[1].inputs.text, 'p', 'no placeholder: the positive box is filled');
    const r = refineFromCustom(g, { base64: 'AAA', width: 640, height: 640, denoise: 0.38 });
    assert.deepEqual(r[3].inputs.latent_image, ['mm_encode', 0]);
    assert.deepEqual(r.mm_encode.inputs.vae, ['9', 2]);
    assert.equal(r[3].inputs.denoise, 0.38);
    assert.equal(filledUi({ nodes: [{ widgets_values: ['%prompt%'] }] }, { prompt: 'say "hi"', negative: '' }).nodes[0].widgets_values[0], 'say "hi"');
});

test('director schema: storyboard first, cast/places/beats with background; no source_text', () => {
    const s = buildSchema({ maxImages: 8 });
    assert.equal(Object.keys(s.properties)[0], 'storyboard');
    assert.ok(s.properties.beats.items.required.includes('background'));
    assert.ok(!s.properties.beats.items.properties.source_text);
});

test('custom workflow names come from the bridge copies in SillyTavern', () => {
    assert.equal(workflowNameOf('MangaMode - the true one.json'), 'the true one');
    assert.equal(workflowNameOf('MangaMode - the true one.ui'), null);
    assert.equal(workflowNameOf('Default_Comfy_Workflow.json'), null);
});

test('custom workflow: an IP-Adapter gets the person of the frame, or a grey picture at weight 0', () => {
    const api = {
        1: { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%' } },
        2: { class_type: 'easy loadImageBase64', inputs: { base64_data: '%reference%' } },
        3: { class_type: 'AnimaIPAdapterApply', inputs: { weight: '%reference_weight%', image: ['2', 0] } },
        4: { class_type: 'AnimaIPAdapterApply', inputs: { strength: 1, ref_image: ['2', 0] } },
    };
    assert.equal(wantsReference(api), true);
    assert.equal(wantsReference({ 1: { inputs: { text: '%prompt%' } } }), false);
    const withRef = prepareCustomGraph(api, { prompt: 'p', negative: 'n', seed: 1, width: 8, height: 8, refs: ['FULL', 'FACE'], referenceStrength: 0.8 });
    assert.equal(withRef[2].inputs.base64_data, 'FACE', '%reference% is the face picture');
    assert.equal(withRef[3].inputs.weight, 0.8);
    assert.equal(withRef[4].inputs.strength, 0.8, 'number boxes of IP-Adapter nodes are set too');
    const kept = prepareCustomGraph(api, { prompt: 'p', negative: 'n', seed: 1, width: 8, height: 8, refs: [], keepUnusedAdapter: true });
    assert.equal(kept[2].inputs.base64_data, BLANK_REFERENCE);
    assert.equal(kept[3].inputs.weight, 0);
    assert.equal(kept[4].inputs.strength, 0);
});

test('1.06 custom workflow: without a reference the IP-Adapter is taken out of the graph (it was not neutral at strength 0)', () => {
    const api = {
        1: { class_type: 'KSampler', inputs: { seed: 1, model: ['21', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['3', 0] } },
        2: { class_type: 'UNETLoader', inputs: { unet_name: 'anima.safetensors' } },
        3: { class_type: 'EmptyLatentImage', inputs: { width: 896, height: 1152, batch_size: 1 } },
        4: { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%' } },
        5: { class_type: 'CLIPTextEncode', inputs: { text: '%negative%' } },
        7: { class_type: 'SaveImage', inputs: { images: ['6', 0] } },
        6: { class_type: 'VAEDecode', inputs: { samples: ['1', 0], vae: ['9', 0] } },
        9: { class_type: 'VAELoader', inputs: { vae_name: 'v' } },
        20: { class_type: 'AnimaIPAdapterLoader', inputs: { ip_adapter_name: 'ip.safetensors' } },
        21: { class_type: 'AnimaIPAdapterApply', inputs: { strength: 0.6, use_lora: true, model: ['2', 0], ip_adapter: ['20', 0], ref_image: ['22', 0] } },
        22: { class_type: 'easy loadImageBase64', inputs: { base64_data: '%reference%' } },
    };
    const none = prepareCustomGraph(api, { prompt: 'p', negative: 'n', seed: 5, width: 8, height: 8, refs: [] });
    assert.deepEqual(none[1].inputs.model, ['2', 0], 'the sampler takes the plain model');
    assert.ok(!none[20] && !none[21] && !none[22], 'adapter, its loader and its picture are gone');
    assert.ok(none[2] && none[6] && none[7] && none[9], 'everything else stays');
    const withRef = prepareCustomGraph(api, { prompt: 'p', negative: 'n', seed: 5, width: 8, height: 8, refs: ['FULL', 'FACE'], referenceStrength: 0.6 });
    assert.deepEqual(withRef[1].inputs.model, ['21', 0], 'with a reference the adapter is used');
    assert.equal(withRef[21].inputs.strength, 0.6);
});

test('labels keep who someone is, not what they are doing right now', () => {
    assert.equal(stablePart('the sprinting watchman with crossbow'), 'the watchman with crossbow');
    assert.equal(stablePart('the leaning off-duty guard'), 'the off-duty guard');
    assert.equal(stablePart('the scarred mercenary'), 'the scarred mercenary');
    assert.equal(stablePart('the running'), 'the running');
    assert.equal(stablePart('the iron-armored town guard'), 'the town guard');
    assert.equal(stablePart('the blonde swordswoman in silver armor'), 'the blonde swordswoman');
    assert.equal(stablePart('the dark-haired young man in modern clothing'), 'the dark-haired young man');
    assert.equal(stablePart('the freckled human boy with a brown cap'), 'the freckled human boy');
    assert.equal(stablePart('the wolf-eared old grocer'), 'the wolf-eared old grocer');
    assert.equal(stablePart('the towering black-armored knight with a single eye'), 'the towering knight with a single eye');
    assert.equal(judge({ figures: [], extra_main_figures: 0, lettering: 'none', defects: '', background: 'partly blank' }, { labels: [], kind: 'character' }).major, false, 'white corners: minor, one more seed');
    assert.deepEqual(judge({ figures: [], extra_main_figures: 0, lettering: 'none', defects: '', background: 'full scene', white_corner: 0.9 }, { labels: [], kind: 'character' }).reasons, ['partly blank background'], 'a white corner counted in pixels');
    assert.deepEqual(judge({ panels: 2, figures: [], extra_main_figures: 0, lettering: 'none', defects: '', background: 'full scene' }, { labels: [], kind: 'character' }).reasons, ['split into 2 panels']);
});

test('taking the armour off also takes it out of the label', () => {
    assert.equal(labelForOutfit('the weathered town guard in a steel breastplate', 'sweat-darkened blue gambeson, dark trousers'), 'the weathered town guard');
    assert.equal(labelForOutfit('the girl in the red dress', 'red dress with a white apron'), 'the girl in the red dress');
    const known = [{ name: 'Haddon', sex: 'male', label: 'the town guard in a steel breastplate', look: 'l', outfit: 'steel breastplate over blue gambeson' }];
    const after = mergeCast(known, [{ name: 'Haddon', sex: 'male', label: 'x', look: 'y', outfit: 'blue gambeson', outfit_changed: true }]);
    assert.equal(after[0].label, 'the town guard');
    assert.equal(after[0].outfit, 'blue gambeson');
    assert.deepEqual(after[0].takenOff, ['steel breastplate']);
    assert.deepEqual(takenOff('polished steel breastplate over blue gambeson, steel pauldrons, riveted gauntlets, heavy leather boots, sheathed broadsword at hip',
        'sweat-darkened blue gambeson with steel pauldrons, riveted gauntlets, heavy leather boots, sword belt with sheathed broadsword'), ['polished steel breastplate']);
    const exp = frameExpectation({ kind: 'character', description: 'He sits.', people: [{ name: 'Haddon', action: 'sits' }] }, { shot: 'medium shot', angle: 'eye level' }, { cast: after, setBook: [], personaName: 'Kai' });
    assert.match(exp.text, /must NOT be wearing now\): steel breastplate/);
});

test('place labels read naturally after an article; no "inside Inside"', () => {
    const pairs = [{ name: 'Guard Barracks', label: 'the guard barracks' }];
    assert.equal(replaceNames('Inside the stone Guard Barracks, light falls.', pairs), 'Inside the stone guard barracks, light falls.');
    assert.equal(replaceNames('He walks into Guard Barracks.', pairs), 'He walks into the guard barracks.');
});

test('a hand-over is drawn with both people, named in one sentence, and checked', () => {
    const cast = [
        { name: 'Ana', sex: 'female', label: 'the red-haired courier', look: 'adult woman, red hair', outfit: 'green cloak' },
        { name: 'Bo', sex: 'male', label: 'the bald innkeeper', look: 'adult man, bald', outfit: 'brown apron' },
    ];
    const spec = { kind: 'character', description: 'Ana pays Bo.', interaction: 'Bo\'s fingers close over the three silver coins on Ana\'s open palm.', background: '', people: [{ name: 'Ana', side: 'left', action: 'holds out her palm', expression: 'calm', gaze: 'Bo' }, { name: 'Bo', side: 'right', action: 'takes the coins', expression: 'wary', gaze: 'Ana' }] };
    assert.equal(contactCamera(spec, { shot: 'close-up', angle: 'eye level' }).shot, 'medium shot', 'no face crop for a contact');
    assert.equal(contactCamera({ ...spec, interaction: '', people: [{ name: 'Bo', action: 'narrows his eyes' }] }, { shot: 'close-up' }).shot, 'close-up');
    assert.equal(contactCamera({ ...spec, interaction: '', people: [{ name: 'Bo', action: 'releases his grip on the paper' }] }, { shot: 'close-up' }).shot, 'medium shot', 'hands on an object');
    assert.equal(contactCamera(spec, { shot: 'extreme close-up' }).shot, 'extreme close-up');
    const ctx = { style: 'natural', presets: DEFAULT_SETTINGS.promptPresets, cast, setBook: [], personaName: '' };
    const text = compileFrame(spec, { shot: 'medium shot', angle: 'eye level' }, ctx)[0];
    assert.match(text, /The key moment, clearly visible: The bald innkeeper's fingers close over the three silver coins on the red-haired courier's open palm\./);
    const exp = frameExpectation(spec, { shot: 'medium shot', angle: 'eye level' }, ctx);
    assert.equal(exp.contact, true);
    const ok = { panels: 1, figures: exp.labels.map((label) => ({ label, present: true, count: 1, matches_look: true })), extra_main_figures: 0, lettering: 'none', defects: '', background: 'full scene', action_shown: true };
    assert.equal(judge(ok, exp).pass, true);
    assert.deepEqual(judge({ ...ok, action_shown: false }, exp).reasons, ['the key moment is not shown']);
    assert.equal(judge({ ...ok, action_shown: false }, { ...exp, contact: false }).major, false, 'an unclear action without a contact is minor');
});

test('names made of ordinary words are swapped only as whole names', () => {
    const cast = [
        { name: 'Town Guard', label: 'the iron-armored town guard', look: 'adult man', outfit: 'iron breastplate' },
        { name: 'Curious Townsman', label: 'the portly townsman', look: 'adult man', outfit: 'red doublet' },
        { name: 'Guard Haddon', label: 'the weathered town guard', look: 'adult man', outfit: 'blue gambeson' },
    ];
    const pairs = namePairs(cast);
    assert.equal(replaceNames('The armored Town Guard steps off the curb.', pairs), 'The iron-armored town guard steps off the curb.');
    assert.equal(replaceNames('A sunny cobblestone town square.', pairs), 'A sunny cobblestone town square.');
    assert.equal(replaceNames('A curious crowd gathers.', pairs), 'A curious crowd gathers.');
    assert.equal(replaceNames('Haddon sits down.', pairs), 'The weathered town guard sits down.');
    assert.equal(replaceNames('He looks at haddon-like shapes.', pairs), 'He looks at haddon-like shapes.');
});

test('onlookers are turned toward the person they watch', () => {
    const cast = [
        { name: 'Kai', sex: 'male', label: 'the dark-haired young man', look: 'adult man', outfit: 'black t-shirt' },
        { name: 'Dwarf', sex: 'male', label: 'the red-bearded dwarf', look: 'adult dwarf', outfit: 'chainmail' },
        { name: 'Cat', sex: 'female', label: 'the cat-eared woman', look: 'adult woman, cat ears', outfit: 'leather armour' },
    ];
    const spec = { kind: 'character', description: 'Two mercenaries stop and stare at Kai.', background: '', people: [
        { name: 'Dwarf', side: 'left', action: 'stops', expression: 'frown', gaze: 'Kai' },
        { name: 'Cat', side: 'center', action: 'stops', expression: 'narrowed eyes', gaze: 'Kai' },
        { name: 'Kai', side: 'right', action: 'talks', expression: 'calm', gaze: 'the boy' }] };
    const text = compileFrame(spec, { shot: 'wide shot', angle: 'eye level' }, { style: 'natural', presets: DEFAULT_SETTINGS.promptPresets, cast, setBook: [], personaName: '' })[0];
    assert.match(text, /The red-bearded dwarf and the cat-eared woman are turned toward the dark-haired young man, watching\./);
    const far = { ...spec, background: 'Kai and a boy talking further down the street.', people: spec.people.slice(0, 2) };
    const t2 = compileFrame(far, { shot: 'wide shot', angle: 'eye level' }, { style: 'natural', presets: DEFAULT_SETTINGS.promptPresets, cast, setBook: [], personaName: 'Kai' })[0];
    assert.match(t2, /seen from behind at a three-quarter angle, facing into the picture toward the dark-haired young man in the distance/);
    assert.match(t2, /looks away from the viewer, into the picture, toward the dark-haired young man further away/);
    assert.doesNotMatch(t2, /straight at the viewer/);
});

test('a face touch-up redraws a square around the head, inside the picture', () => {
    const r = faceRegion({ x0: 0.45, y0: 0.2, x1: 0.55, y1: 0.35 }, 1);
    assert.ok(r.x0 <= 0.45 && r.x1 >= 0.55 && r.y0 <= 0.2 && r.y1 >= 0.35);
    assert.ok(Math.abs((r.x1 - r.x0) - (r.y1 - r.y0)) < 1e-9, 'square in a square picture');
    const edge = faceRegion({ x0: 0.9, y0: 0.0, x1: 1.0, y1: 0.1 }, 1.5);
    assert.ok(edge.x1 <= 1 + 1e-9 && edge.y0 >= 0 && edge.x0 >= 0);
    assert.ok(Math.abs((edge.x1 - edge.x0) * 1.5 - (edge.y1 - edge.y0)) < 1e-9, 'square in pixels on a wide picture');
});

test('compiler: the body faces the way the action goes (walking away, looking back, glancing past)', () => {
    const boy = (o) => ({ kind: 'character', description: 'x', people: [{ name: 'Newspaper Boy', side: 'center', expression: '', gaze: 'the viewer', ...o }] });
    const [away] = compileFrame(boy({ action: 'walking away at a brisk pace' }), { shot: 'full shot' }, CTX);
    assert.match(away, /He is seen from behind, walking away from the viewer, back turned\./);
    assert.ok(!/looks straight at the viewer/.test(away));
    const [back] = compileFrame(boy({ action: 'one foot on the stair, twisting his torso back toward alex' }), { shot: 'full shot' }, CTX);
    assert.match(back, /He is turned away from the viewer, and looks back over his shoulder at the viewer\./);
    const [past] = compileFrame(boy({ action: 'peers past the viewer', expression: 'eyes shifted to the side' }), { shot: 'medium shot', angle: 'pov' }, CTX);
    assert.match(past, /his eyes turned off to one side/);
    const [guard] = compileFrame(boy({ action: 'glances over his shoulder', gaze: 'the guard by the apothecary' }), { shot: 'medium shot' }, CTX);
    assert.match(guard, /turned away from the guard by the apothecary, and looks back over his shoulder at the guard by the apothecary\./);
    const [plain] = compileFrame(boy({ action: 'standing with crossed arms' }), { shot: 'medium shot' }, CTX);
    assert.match(plain, /He looks straight at the viewer\./);
    // With the player drawn in the picture, "the viewer" is the player.
    const two = { kind: 'character', description: 'x', people: [{ name: 'alex', side: 'left', action: 'standing', gaze: 'Newspaper Boy' }, { name: 'Newspaper Boy', side: 'right', action: 'walking away quickly', gaze: 'the viewer' }] };
    const [leave] = compileFrame(two, { shot: 'full shot' }, CTX);
    assert.match(leave, /He walks away from the young man in the black t-shirt, his back turned to the young man in the black t-shirt and to the viewer\./);
});

test('compiler: in a first-person frame the player is "the viewer"; two people who look at each other face each other', () => {
    const spec = { kind: 'character', description: 'The newsboy glances past alex toward the tavern.', people: [{ name: 'Newspaper Boy', side: 'center', action: 'standing', gaze: 'the viewer' }] };
    const [pov] = compileFrame(spec, { shot: 'medium shot', angle: 'pov' }, CTX);
    assert.match(pov, /glances past the viewer toward the tavern/);
    assert.ok(!/young man in the black t-shirt/.test(pov), 'no second man in a one-person first-person frame');
    const [third] = compileFrame(spec, { shot: 'medium shot', angle: 'eye level' }, CTX);
    assert.ok(!/young man in the black t-shirt/.test(third), 'a player who is not drawn is never named: the model would draw him');
    assert.match(third, /glances past the viewer toward the tavern/);
    const named = { ...spec, description: 'Roland watches the newsboy.', people: [{ name: 'Newspaper Boy', side: 'center', action: 'standing', gaze: 'Roland' }] };
    const [absent] = compileFrame(named, { shot: 'medium shot' }, CTX);
    assert.ok(!/armoured watchman/.test(absent), 'somebody who is not drawn is "someone", not a label');
    assert.match(absent, /someone watches the newsboy|Someone watches the newsboy/);
    assert.match(absent, /toward someone outside the picture/);
    const meet = { kind: 'character', description: 'x', people: [{ name: 'alex', side: 'left', action: 'stepping off the cart', gaze: 'Newspaper Boy' }, { name: 'Newspaper Boy', side: 'right', action: 'waiting', gaze: 'the viewer' }] };
    const [m] = compileFrame(meet, { shot: 'medium shot' }, CTX);
    assert.match(m, /The young man in the black t-shirt and the newsboy face each other with a few steps of open space between them\./);
    const close = { ...meet, people: [meet.people[0], { ...meet.people[1], action: 'standing beside him' }] };
    assert.ok(!/face each other/.test(compileFrame(close, { shot: 'medium shot' }, CTX)[0]), 'side by side when the text says so');
    const [wrist] = compileFrame({ kind: 'character', description: 'x', people: [{ name: 'Newspaper Boy', action: 'standing', gaze: '' }] }, { shot: 'medium shot' }, { ...CTX, cast: CAST.map((c) => (c.name === 'Newspaper Boy' ? { ...c, outfit: 'grey flat cap, red scrunchie on wrist' } : c)) });
    assert.match(wrist, /red scrunchie on one wrist/);
});


// ---------------------------------------------------------------- 1.04: general logic of a frame

test('1.04 gaze: a person holding something still looks at the PERSON, never at the cup', () => {
    const ron = { name: 'Roland', gaze: 'alex', action: 'holding a steaming cup', cast: findPerson(CAST, 'Roland'), label: 'the armoured watchman' };
    const me = { name: 'alex', cast: findPerson(CAST, 'alex'), label: 'the young man in the black t-shirt' };
    const sentence = gazeSentence(ron, [ron, me], { personaName: 'alex', cast: CAST });
    assert.match(sentence, /even while the hands are busy/);
    assert.match(sentence, /his eyes on that person's face/);
    const [text] = compileFrame({ kind: 'character', description: 'Roland sits beside alex over a cup.', people: [
        { name: 'Roland', side: 'left', action: 'holding a steaming cup, talking', expression: 'calm', gaze: 'alex' },
        { name: 'alex', side: 'right', action: 'sitting, listening', expression: 'curious', gaze: 'Roland' }] }, { shot: 'medium shot' }, CTX);
    assert.match(text, /are in one open space, in plain view of each other\./);
    const [glass] = compileFrame({ kind: 'character', description: 'Roland talks to alex through the window of the cell door.', people: [
        { name: 'Roland', side: 'left', action: 'standing', expression: 'calm', gaze: 'alex' },
        { name: 'alex', side: 'right', action: 'standing', expression: 'calm', gaze: 'Roland' }] }, { shot: 'medium shot' }, CTX);
    assert.ok(!/one open space/.test(glass), 'a barrier the story puts there on purpose is not denied');
});

test('1.04 gaze: a named core ("Roland") or a name the cast knows under another form still finds the person', () => {
    const ron = { name: 'Roland', gaze: 'the newsboy', cast: findPerson(CAST, 'Roland'), label: 'the armoured watchman' };
    const boy = { name: 'Newspaper Boy', cast: findPerson(CAST, 'Newspaper Boy'), label: 'the newsboy' };
    assert.match(gazeSentence(ron, [ron, boy], { personaName: 'alex', cast: CAST }), /looks at the newsboy, his eyes on that person's face/);
    const me = { name: 'alex', gaze: 'Roland', cast: findPerson(CAST, 'alex'), label: 'the young man in the black t-shirt' };
    const watch = { name: 'Guard Roland', cast: findPerson(CAST, 'Roland'), label: 'the armoured watchman' };
    assert.match(gazeSentence(me, [me, watch], { personaName: 'alex', cast: CAST }), /looks at the armoured watchman/);
});

test('1.04 sentences: a trailing comma never glues two sentences; "cowboy" is not a boy', () => {
    const [t] = compileFrame({ kind: 'character', description: 'A quiet moment,', people: [{ name: 'Roland', side: 'center', action: 'standing still,', expression: 'calm;', gaze: 'the viewer' }] }, { shot: 'medium shot' }, CTX);
    assert.ok(!/,\./.test(t) && !/;\./.test(t), t);
    const cowboy = { ...CAST[1], name: 'Cowboy Bill', label: 'the cowboy', look: 'cowboy in his forties, stubble' };
    const [c] = compileFrame({ kind: 'character', description: 'x', people: [{ name: 'Cowboy Bill', side: 'center', action: 'standing', expression: 'calm', gaze: 'the viewer' }] }, { shot: 'medium shot' }, { ...CTX, cast: [...CAST, cowboy] });
    assert.ok(!/is a boy/.test(c), 'a cowboy is a grown man');
});

test('1.04 figures: the same person listed twice is drawn once, with both entries merged', () => {
    const figs = frameFigures({ kind: 'character', people: [
        { name: 'Roland', side: 'left', action: 'standing', expression: '', gaze: '' },
        { name: 'Guard Roland', side: 'left', action: 'standing', expression: 'stern', gaze: 'alex' }] }, CAST, { personaName: 'alex' });
    assert.equal(figs.length, 1);
    assert.equal(figs[0].expression, 'stern');
    assert.equal(figs[0].gaze, 'alex');
});

test('1.04 absent people: someone who is not in the frame is "someone"; the player is "the viewer"', () => {
    const figures = frameFigures({ kind: 'character', people: [{ name: 'Newspaper Boy', side: 'center', action: 'standing', expression: '', gaze: '' }] }, CAST, { personaName: 'alex' });
    const pairs = framePairs(namePairs(CAST, SET), CAST, figures, { personaName: 'alex' });
    assert.equal(replaceNames('Roland hands alex a coin', pairs), 'Someone hands the viewer a coin');
    assert.equal(replaceNames("Roland's hand", pairs), "Someone's hand");
    const drawn = framePairs(namePairs(CAST, SET), CAST, figures, { personaName: 'alex', farAway: [findPerson(CAST, 'Roland')] });
    assert.equal(replaceNames('Roland watches', drawn), 'The armoured watchman watches', 'a person seen far away keeps the label');
    const spec = { kind: 'character', description: 'Roland watches the newsboy.', people: [{ name: 'Newspaper Boy', side: 'center', action: 'counting coins alex gave him', expression: 'happy', gaze: 'alex' }] };
    const [out] = compileFrame(spec, { shot: 'medium shot' }, CTX);
    assert.ok(!/armoured watchman|young man in the black/.test(out), out);
});

test('1.04 quality check: gaze and barrier are checked, labels match loosely, findings are named', () => {
    const exp = frameExpectation({ kind: 'character', description: 'x', people: [
        { name: 'Roland', side: 'left', action: 'holding a cup, talking', expression: 'calm', gaze: 'Newspaper Boy' },
        { name: 'Newspaper Boy', side: 'right', action: 'listening', expression: 'calm', gaze: 'Roland' }] }, { shot: 'medium shot' }, CTX);
    assert.match(exp.text, /Gaze: "the armoured watchman" must be looking at the face of "the newsboy"/);
    assert.match(exp.text, /Space: .*no wall, pillar, door frame, window or divider/);
    assert.equal(exp.together, true);
    const answer = { figures: [
        { label: 'Armoured Watchman', present: true, count: 1, matches_look: true, note: '', gaze_ok: false },
        { label: 'The newsboy', present: true, count: 1, matches_look: true, note: '', gaze_ok: true }], barrier: true, illogical: '', extra_main_figures: 0, lettering: 'none', defects: '', action_shown: true, background: 'full scene', panels: 1, heads: [] };
    const verdict = judge(answer, exp);
    assert.equal(verdict.pass, false);
    assert.ok(verdict.reasons.includes('the armoured watchman does not look at the newsboy'), verdict.reasons.join('|'));
    assert.ok(verdict.reasons.includes('a wall or divider stands between the two people'));
    assert.equal(judge({ ...answer, figures: answer.figures.map((f) => ({ ...f, gaze_ok: true })), barrier: false }, exp).pass, true);
    assert.match(judge({ ...answer, figures: answer.figures.map((f) => ({ ...f, gaze_ok: true })), barrier: false, illogical: 'a cup floats beside his head' }, exp).reasons.join(), /illogical: a cup floats/);
    assert.equal(labelKey('The armoured Watchmen!'), labelKey('armoured watchmen'));
    assert.equal(findByLabel([{ label: 'the man' }], 'someone else', true).label, 'the man');
    assert.equal(findByLabel([{ label: 'a' }, { label: 'b' }], 'c', true), undefined);
    assert.match(frameCheckRequest('data:image/jpeg;base64,AAA', { text: 'An insert.' }).messages[0].content, /face intentionally outside an insert close-up is not a cut-off-head defect/);
});

test('1.04 balloons: a speaker under another form of the name still finds the head', () => {
    const located = new Map([['guard roland', { x: 0.3, y: 0.2 }]]);
    assert.deepEqual(locatedFor(located, 'Roland'), { x: 0.3, y: 0.2 });
    assert.equal(locatedFor(located, 'Elaine'), null);
});

test('1.04 insert: a contact with another object is drawn from the side, not held up for display', () => {
    const [contact] = compileFrame({ kind: 'insert', description: 'His gauntlet presses the brass latch against the door.', interaction: 'The gauntlet touches the brass latch on the door.', people: [{ name: 'Roland' }] }, { shot: 'close-up' }, CTX);
    assert.match(contact, /hands at the point of contact, seen from a side three-quarter angle/);
    assert.doesNotMatch(contact, /held in front of his body/);
});

test('1.04 speech removal: a label with its own "in the ..." is never cut in half (the speaker was dressed in the listener\'s shirt)', () => {
    const pairs = [{ label: 'the young man in the black t-shirt' }];
    assert.equal(stripSpeechSafe('the armoured watchman talks to the young man in the black t-shirt over a cup.', pairs), 'the armoured watchman over a cup.');
    assert.equal(stripSpeechSafe('Mira tells the young man in the black t-shirt about the train, blushing.', pairs), 'Mira, blushing.');
    assert.equal(stripSpeechSafe('The young man in the black t-shirt smiles, telling Mira about the train while waving', pairs), 'The young man in the black t-shirt smiles, while waving');
    const [t] = compileFrame({ kind: 'character', description: 'Roland talks to alex over a cup.', people: [{ name: 'Roland', side: 'left', action: 'talking to alex', expression: 'calm', gaze: 'alex' }, { name: 'alex', side: 'right', action: 'listening', expression: 'calm', gaze: 'Roland' }] }, { shot: 'medium shot' }, CTX);
    assert.ok(!/armoured watchman in the black t-shirt/.test(t), t);
});

test('1.04 prompt: nothing is named that the picture must not show (CFG 1 draws what the prompt mentions)', () => {
    const spec = { kind: 'character', description: 'Roland and alex talk.', people: [{ name: 'Roland', side: 'left', action: 'standing', expression: 'calm', gaze: 'alex' }, { name: 'alex', side: 'right', action: 'standing', expression: 'calm', gaze: 'Roland' }] };
    for (const [camera, s] of [[{ shot: 'medium shot' }, spec], [{ shot: 'close-up', angle: 'pov' }, { ...spec, people: [spec.people[0]] }], [{ shot: 'wide shot' }, { ...spec, kind: 'establishing' }], [{ shot: 'close-up' }, { kind: 'insert', description: 'coins', people: [{ name: 'Roland' }] }], [{ shot: 'close-up' }, { kind: 'insert', description: 'a key', people: [] }]]) {
        const [text] = compileFrame(s, camera, CTX);
        const bad = text.replace(/World:[^.]*\./, '').match(/\b(?:never|not|no|nothing|nobody|without|rather than)\b/i);
        assert.equal(bad, null, `negation "${bad?.[0]}" in: ${text}`);
    }
});

test('1.04 quality check: a picture left half on white paper is a major fault, measured in pixels', () => {
    const exp = { labels: ['the newsboy'], kind: 'character', forCrop: false };
    const ok = { figures: [{ label: 'the newsboy', present: true, count: 1, matches_look: true, note: '', gaze_ok: true }], barrier: false, illogical: '', extra_main_figures: 0, lettering: 'none', defects: '', action_shown: true, background: 'full scene', panels: 1, heads: [] };
    assert.equal(judge({ ...ok, white_share: 0.03, white_corner: 0.1 }, exp).pass, true);
    const white = judge({ ...ok, white_share: 0.27, white_corner: 0.95 }, exp);
    assert.equal(white.pass, false);
    assert.equal(white.major, true, 'a new seed at once, not a kept picture');
    assert.match(white.reasons[0], /large white area \(27%/);
    assert.equal(judge({ ...ok, white_share: 0.27, white_corner: 0.1 }, exp).pass, true, 'a white wall with a full scene around it is fine');
    assert.equal(judge({ ...ok, white_share: 0.27, white_corner: 0.95 }, { ...exp, kind: 'insert' }).pass, true, 'inserts are judged on their own');
});

test('1.04 insert: hands that hold something on a table are drawn from the side across it, never "handed to the viewer"', () => {
    const [held] = compileFrame({ kind: 'insert', description: 'Both hands wrap around a warm mug on the table.', people: [{ name: 'Newspaper Boy', action: 'clasps the mug on the table' }] }, { shot: 'close-up' }, CTX);
    assert.match(held, /the newsboy's hands on the table, seen from the side across the table, his forearms resting on its edge\. Only his own hands and forearms are in the picture\. Both hands wrap around a warm mug/);
    const [nothing] = compileFrame({ kind: 'insert', description: 'A hand rests on a hilt.', people: [{ name: 'Roland', action: 'hand on the hilt' }] }, { shot: 'close-up' }, CTX);
    assert.match(nothing, /seen from the front: the hands are held in front of his body/);
});

test('1.04 contact: the other side of a hand-over is in the frame (the vendor handed the daisies to Mira because alex was not there)', () => {
    const cast = [{ name: 'alex' }, { name: 'Mira Hayashi' }, { name: 'Old Flower Vendor' }];
    const beat = { kind: 'character', camera: { shot: 'medium shot', angle: 'eye level' }, interaction: "The flower vendor's hand presses the daisies into alex's palm.", people: [{ name: 'Old Flower Vendor', side: 'left', action: 'x', expression: 'y', gaze: 'Mira Hayashi' }, { name: 'Mira Hayashi', side: 'right', action: 'x', expression: 'y', gaze: 'the viewer' }] };
    const out = withContactPartners(beat, cast);
    assert.deepEqual(out.people.map((p) => p.name), ['Old Flower Vendor', 'Mira Hayashi', 'alex']);
    assert.equal(out.people[2].side, 'center');
    assert.deepEqual(out.characters, ['Old Flower Vendor', 'Mira Hayashi', 'alex']);
    assert.equal(withContactPartners({ ...beat, camera: { angle: 'pov' } }, cast).people.length, 2, 'a first-person frame is the player\'s own hand');
    assert.equal(withContactPartners({ ...beat, kind: 'insert' }, cast).people.length, 2, 'inserts show hands only');
    assert.equal(withContactPartners({ ...beat, interaction: '' }, cast).people.length, 2);
    assert.equal(withContactPartners({ ...beat, interaction: "Mira's hand grabs the vendor's sleeve." }, cast).people.length, 2, 'both are already in it');
});

test('1.04 quality check: a person doing something else than described (plate swapped between two people) is reported', () => {
    const exp = { labels: ['the cook', 'the girl'], kind: 'character', forCrop: false };
    const base = { barrier: false, illogical: '', extra_main_figures: 0, lettering: 'none', defects: '', action_shown: true, background: 'full scene', panels: 1, heads: [] };
    const fig = (label, extra = {}) => ({ label, present: true, count: 1, matches_look: true, minor_only: false, note: '', doing_ok: true, gaze_ok: true, ...extra });
    const r = judge({ ...base, figures: [fig('the cook', { doing_ok: false, note: 'holds a mug, the girl holds the plate' }), fig('the girl')] }, exp);
    assert.ok(r.reasons.some((x) => /the cook is not doing what was described \(holds a mug/.test(x)), r.reasons.join('|'));
    assert.equal(r.major, false, 'one more seed, not three');
    assert.equal(judge({ ...base, figures: [fig('the cook'), fig('the girl')] }, exp).pass, true);
});

test('1.04 quality check: a missing jacket or bag is a small fault (one more seed), a wrong person or main garment is a big one', () => {
    const exp = { labels: ['the girl'], kind: 'character', forCrop: false };
    const base = { barrier: false, illogical: '', extra_main_figures: 0, lettering: 'none', defects: '', action_shown: true, background: 'full scene', panels: 1, heads: [] };
    const small = judge({ ...base, figures: [{ label: 'the girl', present: true, count: 1, matches_look: false, minor_only: true, note: 'no jacket', gaze_ok: true }] }, exp);
    assert.equal(small.pass, false);
    assert.equal(small.major, false);
    const big = judge({ ...base, figures: [{ label: 'the girl', present: true, count: 1, matches_look: false, minor_only: false, note: 'brown apron instead of a tank top', gaze_ok: true }] }, exp);
    assert.equal(big.major, true);
});

test('1.04 world: only the era reaches the image prompt, never a list of objects to draw', () => {
    assert.equal(eraPhrase('Contemporary modern day; smartphones, modern commuter trains, electric appliances, stainless steel espresso machines, and plastic transit cards'), 'World: Contemporary modern day.');
    assert.equal(eraPhrase('late-medieval fantasy, no gunpowder'), 'World: late-medieval fantasy.');
    assert.equal(eraPhrase(''), '');
});

test('1.04 foreground player: "alex seated in the foreground seen from behind" becomes an over-the-shoulder frame, not a stray man', () => {
    const beat = { kind: 'character', camera: { shot: 'medium shot', angle: 'eye level' }, background: 'Alex seated partially in the foreground seen from behind his shoulder.', people: [{ name: 'Mira Hayashi', side: 'center', action: 'x', expression: 'y', gaze: 'the viewer' }] };
    const out = withPlayerInForeground(beat, 'alex');
    assert.equal(out.camera.angle, 'over the shoulder');
    assert.equal(out.background, '');
    assert.deepEqual(out.people.map((p) => p.name), ['Mira Hayashi', 'alex']);
    assert.equal(withPlayerInForeground({ ...beat, background: 'A crowd walks by.' }, 'alex').people.length, 1);
    assert.equal(withPlayerInForeground({ ...beat, camera: { angle: 'pov' } }, 'alex').people.length, 1);
    assert.equal(withPlayerInForeground(beat, '').people.length, 1);
    const [a] = compileFrame({ kind: 'character', description: 'x', people: out.people }, { shot: 'medium shot', angle: 'over the shoulder' }, CTX);
    assert.match(a, /Over-the-shoulder shot from behind the young man in the black t-shirt/);
});

test('1.04 speech removal: "while she speaks" leaves no dangling "while she"', () => {
    assert.equal(stripSpeech('Mira looks up, pink blush dusting her cheeks while she speaks.'), 'Mira looks up, pink blush dusting her cheeks.');
});

const directorAsync = [async () => {
    const sent = [];
    const fake = {
        extensionSettings: {},
        ConnectionManagerRequestService: { sendRequest: async (id, messages, max, opts, override) => {
            sent.push({ messages, schema: override.json_schema.value });
            return { choices: [{ message: { content: JSON.stringify({ storyboard: 'x', setting: 'gate', cast: [{ name: 'Roland', sex: 'male', label: 'the watchman', look: 'l', outfit: 'o', outfit_changed: false }], places: [], dialogue: [{ line: 0, speaker: 'Roland', bubble_type: 'speech', text: '' }], beats: [{ new_panel: true, emphasis: 'main', kind: 'character', location: '', camera: { shot: 'medium shot', angle: 'eye level' }, description: 'x', background: '', people: [{ name: 'Roland', side: 'right', action: 'a', expression: 'e', gaze: 'the viewer' }], dialogue_indices: [0], intensity: 'calm', same_moment: false, sfx: '' }] }) } }] };
        } },
    };
    const scene = await parseScene(fake, 'p', '`Strange.` "Halt."', { characterName: 'N', userName: 'alex', knownCast: CAST, knownSet: SET, world: { summary: 'w', era_and_technology: 'e' }, sceneContext: { playerAction: 'I walk on.' } });
    const [call] = sent;
    assert.match(call.messages[0].content, /STORYBOARD \(write it first/);
    assert.match(call.messages[1].content, /KNOWN CAST[\s\S]*the armoured watchman/);
    assert.match(call.messages[1].content, /L0 \(thought\): Strange\./);
    assert.equal(scene.parserVersion, 4);
    assert.deepEqual(scene.dialogue.map((d) => d.bubble_type), ['thought', 'speech']);
    assert.deepEqual(scene.characters, [{ name: 'Roland', count_tag: '1boy', screen_position: 'right' }]);
    assert.ok(!SAFETY_NEGATIVE.split(', ').some((term) => call.messages[0].content.toLowerCase().includes(term)), 'no negative-prompt terms in the director prompt');
    passed++; console.log('ok - director call: world, cast, set and thoughts reach the director; the answer is completed');
}];
for (const t of directorAsync) await t();


{
    const look = 'Small round table, two bistro chairs, ceramic cups, glass window, warm pendant light';
    assert.equal(withoutHeldProps(look, 'Leans forward, both hands clutching the hot ceramic cup.'), 'Small round table, two bistro chairs, glass window, warm pendant light');
    assert.equal(withoutHeldProps(look, 'Leans forward, smiling.'), look, 'nothing held: scenery kept');
    assert.equal(withoutHeldProps('rows of glasses, stone bar', 'holds a glass'), 'stone bar');
    assert.equal(withoutHeldProps('two chairs, a table', 'holds a cup'), 'two chairs, a table');
    passed++; console.log('ok - scenery plural of the held object is dropped from the setting');
}


// ---------------------------------------------------------------- 1.06: logic rules, each from a saved prompt that broke it
const CAFE_CAST = uniqueLabels([
    { name: 'alex', role: 'player', sex: 'male', label: 'the dark-haired young man', look: 'young man, short dark brown hair, smooth face with no marks or scars', outfit: 'black cotton T-shirt, dark gray trousers', aliases: [] },
    { name: 'Mira Hayashi', sex: 'female', label: 'the twin-tailed red-haired college girl', look: 'red-orange hair in twin ponytails, amber eyes', outfit: 'white cropped tank top, denim shorts, black choker, scrunchie around one wrist, white layered streetwear jacket', aliases: [] },
    { name: 'Café Barista', sex: 'male', label: 'the slender young barista', look: 'slender young man', outfit: 'olive shirt, brown apron', aliases: [] },
]);
const CAFE_SET = mergeSet([], [{ name: 'Window Café Table', kind: 'place', label: 'the window table in the café', look: 'small round oak table, two bistro chairs, glass window overlooking streetlights, ceramic cups, warm pendant light' }]);
const CAFE = { style: 'natural', presets: DEFAULT_SETTINGS.promptPresets, cast: CAFE_CAST, setBook: CAFE_SET, world: { era_and_technology: 'Contemporary modern day' }, setting: 'a warm café at night', personaName: 'alex' };
// The first beat of the reply Alex showed (Mira chat, 2026-09-30 23:15): Mira was put in "background".
const CAFE_BEATS = [
    { kind: 'character', location: 'Window Café Table', camera: { shot: 'medium shot', angle: 'eye level' }, description: 'Alex sits opposite Mira with his forearms resting casually on the round tabletop.', interaction: '', background: 'Mira Hayashi seated across the table staring back at him in stunned silence.', people: [{ name: 'alex', side: 'center', action: 'leans forward slightly with elbows on the table', expression: 'calm', gaze: 'Mira Hayashi' }], dialogue_indices: [] },
    { kind: 'character', location: 'Window Café Table', camera: { shot: 'close-up', angle: 'eye level' }, description: 'Mira thrusts her hands into her jacket pockets.', interaction: '', background: '', people: [{ name: 'Mira Hayashi', side: 'center', action: 'shoves both hands deep into her jacket pockets', expression: 'wide eyes', gaze: 'the viewer' }], dialogue_indices: [] },
    { kind: 'character', location: 'Window Café Table', camera: { shot: 'medium shot', angle: 'over the shoulder' }, description: "Seen past Alex's shoulder, Mira leans over the table, glaring at him.", interaction: '', background: 'The Café Barista wiping down a counter in the distance.', people: [{ name: 'alex', side: 'left', action: 'sits upright, viewed from behind', expression: '', gaze: 'Mira Hayashi' }, { name: 'Mira Hayashi', side: 'right', action: 'leans forward over the table with one fist clenched', expression: 'gritted teeth', gaze: 'alex' }], dialogue_indices: [] },
];

test('1.06 space: the person a main figure talks to is drawn beside him, never "in the distance" (me outside, she inside)', () => {
    const scene = normalizeScene({ setting: 'a warm café at night', beats: CAFE_BEATS, cast: [] }, { userName: 'alex', cast: CAFE_CAST });
    const first = scene.beats[0];
    assert.deepEqual(first.people.map((p) => p.name), ['alex', 'Mira Hayashi'], 'Mira is a main figure');
    assert.equal(first.background, '');
    const [prompt] = compileFrame(first, first.camera, CAFE);
    assert.ok(!/in the distance|further away|seen from behind/i.test(prompt), prompt);
    assert.match(prompt, /sit facing each other across the same table, close together in one open space/);
    // Far people stay in the background: the barista "in the distance".
    assert.equal(scene.beats[2].background, 'The Café Barista wiping down a counter in the distance.');
    assert.deepEqual(scene.beats[2].people.map((p) => p.name), ['alex', 'Mira Hayashi']);
});

test('1.06 posture: a seated person stays seated in later frames, also the player seen from behind', () => {
    const scene = normalizeScene({ setting: 'a warm café at night', beats: CAFE_BEATS, cast: [] }, { userName: 'alex', cast: CAFE_CAST });
    assert.match(scene.beats[1].people[0].action, /^Still sitting on the chair, shoves both hands/);
    const [ots] = compileFrame(scene.beats[2], scene.beats[2].camera, CAFE);
    assert.match(ots, /Seen from behind, seated, the back of the head toward the viewer/);
    assert.match(ots, /Still sitting on the chair, leans forward over the table with one fist clenched/);
    // Standing up ends it; another place ends it.
    const moved = withPostureCarried([
        { location: 'café', people: [{ name: 'Mira', action: 'sits at the table' }] },
        { location: 'café', people: [{ name: 'Mira', action: 'stands up abruptly' }] },
        { location: 'café', people: [{ name: 'Mira', action: 'crosses her arms' }] },
        { location: 'station platform', people: [{ name: 'Mira', action: 'sits on a bench' }] },
        { location: 'street corner', people: [{ name: 'Mira', action: 'waves' }] },
    ]);
    assert.equal(moved[2].people[0].action, 'crosses her arms');
    assert.equal(moved[4].people[0].action, 'waves');
});

test('1.06 camera words written into what happens are dropped (the camera field says it)', () => {
    assert.equal(withoutCameraClause("Seen past Alex's shoulder, Mira leans over the table"), 'Mira leans over the table');
    assert.equal(withoutCameraClause("Over Alex's shoulder, Frieren stares deadpan"), 'Frieren stares deadpan');
    assert.equal(withoutCameraClause("Looking over the young man's shoulder, the guard points"), 'The guard points');
    assert.equal(withoutCameraClause("Extreme close-up on the guard's eyes, burning"), "The guard's eyes, burning");
    assert.equal(withoutCameraClause('Mira looks back over her shoulder'), 'Mira looks back over her shoulder', 'a body turning is not a camera');
});

test('1.06 pronouns of someone not drawn become the viewer (the player) or someone', () => {
    const girlOnly = { drawn: new Set(['female']), viewerSex: 'male' };
    assert.equal(withoutStrayPronouns('glaring intensely at him while she studies his face', girlOnly), 'glaring intensely at the viewer while she studies the viewer\'s face');
    assert.equal(withoutStrayPronouns('He smiles at her. Her hand shakes.', { drawn: new Set(['male']), viewerSex: 'male' }), 'He smiles at someone. Someone\'s hand shakes.');
    assert.equal(withoutStrayPronouns('He grins at him', { drawn: new Set(['male']), viewerSex: 'male' }), 'He grins at him', 'a man is drawn: nothing to resolve');
    const [pov] = compileFrame({ kind: 'character', description: 'Mira leans over the table, glaring at him.', people: [{ name: 'Mira Hayashi', side: 'center', action: 'glares', gaze: 'the viewer' }] }, { shot: 'medium shot', angle: 'pov' }, CAFE);
    assert.match(pov, /glaring at the viewer\./);
});

test('1.06 absences are not written (CFG 1 draws what a negation names)', () => {
    assert.equal(withoutAbsences('young man, smooth face with no marks or scars, short hair'), 'young man, smooth face, short hair');
    assert.equal(withoutAbsences('light skin, no facial marks, dark eyes'), 'light skin, dark eyes');
    assert.equal(withoutAbsences('Remains seated without turning her head, ignoring the dish'), 'Remains seated, ignoring the dish');
    const [p] = compileFrame(CAFE_BEATS[0], CAFE_BEATS[0].camera, CAFE);
    assert.ok(!/\b(?:no|without|never|not)\b/i.test(p), p);
    const [est] = compileFrame({ kind: 'establishing', people: [], background: '' }, { shot: 'wide shot' }, CAFE);
    assert.ok(!/nobody|no one/i.test(est));
});

test('1.06 outfit: the outer layer is written first, worn over the top (the jacket last in the list was never drawn)', () => {
    assert.equal(layeredOutfit('white cropped tank top, denim shorts, black choker, white layered streetwear jacket'), 'white layered streetwear jacket worn over white cropped tank top, denim shorts, black choker');
    assert.equal(layeredOutfit('black hoodie, jeans'), 'black hoodie, jeans');
    assert.equal(layeredOutfit('shirt, jacket tied around the waist'), 'shirt, jacket tied around the waist');
});

test('1.06 barrier: a window or table in the place name does not switch off "one open space"; "through the window" does', () => {
    const talk = (description, location = 'Window Café Table') => compileFrame({ kind: 'character', location, description, people: [
        { name: 'alex', side: 'left', action: 'standing', gaze: 'Mira Hayashi' }, { name: 'Mira Hayashi', side: 'right', action: 'leaning on the counter', gaze: 'alex' },
    ] }, { shot: 'medium shot' }, CAFE)[0];
    assert.match(talk('They talk across the table.'), /one open space|face each other/);
    assert.ok(!/one open space|face each other/.test(talk('Mira taps on the glass, talking to him through the window.')));
    assert.equal(withoutDividers('The café interior with wooden partitions and soft warm pendant lighting'), 'The café interior and soft warm pendant lighting');
    const [withDividers] = compileFrame({ ...CAFE_BEATS[0], background: 'The café interior with wooden partitions and soft pendant lighting', people: [
        { name: 'alex', side: 'left', action: 'sits', gaze: 'Mira Hayashi' }, { name: 'Mira Hayashi', side: 'right', action: 'sits', gaze: 'alex' },
    ] }, { shot: 'medium shot' }, CAFE);
    assert.ok(!/partition/i.test(withDividers), 'no divider named between two people who talk');
});

test('1.06 walking together is side by side, never "facing each other"', () => {
    const [walk] = compileFrame({ kind: 'character', description: 'They walk down the street.', people: [
        { name: 'alex', side: 'left', action: 'walking with hands in pockets', gaze: 'Mira Hayashi' }, { name: 'Mira Hayashi', side: 'right', action: 'walking half a step ahead', gaze: 'alex' },
    ] }, { shot: 'medium shot' }, CAFE);
    assert.match(walk, /walk side by side, turning their heads toward each other/);
    assert.ok(!/face each other/.test(walk));
});

test('1.06 over the shoulder means the player\'s shoulder: he is added, or the frame is eye level', () => {
    const beat = { kind: 'character', camera: { shot: 'medium shot', angle: 'over the shoulder' }, people: [{ name: 'Mira Hayashi', side: 'right', action: 'glares', gaze: 'the viewer' }] };
    const out = withShoulderOwner(beat, CAFE_CAST, 'alex');
    assert.deepEqual(out.people.map((p) => p.name), ['Mira Hayashi', 'alex']);
    const full = withShoulderOwner({ ...beat, people: [beat.people[0], { name: 'Café Barista' }, { name: 'x' }] }, CAFE_CAST, 'alex');
    assert.equal(full.camera.angle, 'eye level');
    // Walking away: the over-the-shoulder sentence does not also say she faces the viewer.
    const [away] = compileFrame({ kind: 'character', people: [{ name: 'alex', side: 'left', action: 'x', gaze: 'Mira Hayashi' }, { name: 'Mira Hayashi', side: 'right', action: 'walking briskly away, glancing back over her shoulder', gaze: 'alex' }] }, { shot: 'medium shot', angle: 'over the shoulder' }, CAFE);
    assert.ok(!/who faces the viewer/.test(away));
});

test('1.06 made-up names are not found in ordinary words ("the café window" is not the Café Barista)', () => {
    const out = withBackgroundPeople({ kind: 'character', background: 'The warm café window and the table.', people: [{ name: 'Mira Hayashi', side: 'center', action: 'slumps' }] }, CAFE_CAST, 'alex');
    assert.deepEqual(out.people.map((p) => p.name), ['Mira Hayashi']);
});

test('1.06 lettering: a close-up carrying a speech becomes an upper-body shot (balloons stay on the art)', () => {
    assert.equal(shotForWords({ shot: 'close-up', angle: 'eye level' }, 23).shot, 'medium shot');
    assert.equal(shotForWords({ shot: 'close-up' }, 12).shot, 'close-up');
    assert.equal(shotForWords({ shot: 'extreme close-up' }, 12).shot, 'close-up');
    const scene = { dialogue: [{ speaker: 'Mira Hayashi', text: 'Who hears someone drop a bomb like that and goes, so what is the roadmap, team, what kind of sociopath are you?' }], beats: [
        { new_panel: true, kind: 'character', camera: { shot: 'medium shot', angle: 'eye level' }, characters: ['alex'], people: [{ name: 'alex' }], dialogue_indices: [] },
        { new_panel: false, kind: 'character', camera: { shot: 'close-up', angle: 'eye level' }, characters: ['Mira Hayashi'], people: [{ name: 'Mira Hayashi' }], dialogue_indices: [0] },
    ] };
    const plan = planPanels(scene, { maxPanels: 6, maxImages: 5, playerName: 'alex' });
    assert.equal(plan[0].frames[1].camera.shot, 'medium shot');
});

test('1.06 the next part of a long speech is the speaker talking, not a copy of the whole frame', () => {
    const dialogue = [0, 1, 2, 3, 4, 5].map((i) => ({ speaker: 'Karen', text: `line ${i}` }));
    const specs = splitLongSpeech([{ kind: 'character', camera: { shot: 'full shot', angle: 'eye level' }, description: 'Karen spins toward the door.', people: [{ name: 'Karen', action: 'striding' }, { name: 'alex', action: 'scrambling' }], characters: ['Karen', 'alex'], dialogue_indices: [0, 1, 2, 3, 4, 5] }], dialogue);
    assert.equal(specs.length, 2);
    assert.deepEqual(specs[1].characters, ['Karen']);
    assert.equal(specs[1].description, '');
});

test('1.06 first-person insert: the player\'s own hands, seen as he sees them (not "an object on its own ... in his palm")', () => {
    const spec = { kind: 'insert', description: "Alex's smartphone vibrates in his palm.", people: [{ name: 'alex', action: 'grips the phone' }], characters: ['alex'] };
    const [p] = compileFrame(spec, { shot: 'close-up', angle: 'pov' }, CAFE);
    assert.match(p, /A first-person close-up: the viewer's own hands, coming in from the bottom edge/);
    assert.match(p, /The viewer's smartphone vibrates in the viewer's palm/);
    assert.match(frameExpectation(spec, { shot: 'close-up', angle: 'pov' }, CAFE).text, /bottom edge are the viewer's own/);
});

test('1.06 white paper around a drawing is found and cut off', () => {
    const n = 64;
    const mask = new Uint8Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (y < 10 || x < 8) mask[y * n + x] = 1;
    const box = contentBox(mask, n);
    assert.ok(box && Math.abs(box.y0 - 10 / 64) < 0.02 && Math.abs(box.x0 - 8 / 64) < 0.02 && box.x1 === 1 && box.y1 === 1);
    assert.equal(contentBox(new Uint8Array(n * n), n), null, 'nothing white: nothing to cut');
});

test('1.06 the lint finds nothing in the café reply after normalization', () => {
    const scene = normalizeScene({ setting: 'a warm café at night', beats: CAFE_BEATS, cast: [] }, { userName: 'alex', cast: CAFE_CAST });
    for (const beat of scene.beats) {
        const d = drawPlanFor({ spec: beat, camera: beat.camera, size: { width: 896, height: 1152 }, aspect: null, focusName: null }, { personaName: 'alex' });
        const [prompt] = compileFrame(d.spec, d.camera, CAFE);
        assert.deepEqual(lintFrame({ spec: d.spec, camera: d.camera, mode: d.mode, prompt, words: 0 }, { personaName: 'alex', cast: CAFE_CAST }), [], prompt);
    }
});


test('1.06 glass: two people face to face are drawn without the scenery\'s windows (a pane stood between them on 8 of 8 seeds)', () => {
    assert.equal(withoutGlass('Small circular table, large plate-glass window, warm pendant bulb, with stainless steel counter'), 'Small circular table, warm pendant bulb, with stainless steel counter');
    assert.equal(withoutGlass('a cozy coffee shop by the window at dusk with warm pendant lights and neon reflections on glass'), 'a cozy coffee shop at dusk with warm pendant lights');
    const [talk] = compileFrame({ kind: 'character', location: 'Window Café Table', people: [
        { name: 'alex', side: 'left', action: 'standing by the table', gaze: 'Mira Hayashi' }, { name: 'Mira Hayashi', side: 'right', action: 'seated', gaze: 'alex' },
    ] }, { shot: 'medium shot' }, CAFE);
    assert.ok(!/glass window/.test(talk), talk);
    const [alone] = compileFrame({ kind: 'character', location: 'Window Café Table', people: [{ name: 'Mira Hayashi', side: 'center', action: 'seated', gaze: 'the viewer' }] }, { shot: 'medium shot' }, CAFE);
    assert.match(alone, /glass window/, 'one person alone keeps the window');
});

test('1.06 a redraw changes the prompt, not only the seed: sides swap, and after a wall the glass goes', () => {
    const spec = { kind: 'character', people: [{ name: 'a', side: 'left' }, { name: 'b', side: 'right' }] };
    assert.equal(redrawVariant(spec, 0, []), spec);
    const v = redrawVariant(spec, 1, ['a wall or divider stands between the two people']);
    assert.deepEqual(v.people.map((p) => p.side), ['right', 'left']);
    assert.equal(v.clearSpace, true);
    const solo = { kind: 'character', people: [{ name: 'a', side: 'center' }] };
    assert.equal(redrawVariant(solo, 1, ['the action is not clearly shown']), solo);
});


test('1.06 distance words anywhere in the sentence keep a person far ("Across the room at the counter, the barista wipes...")', () => {
    const out = withBackgroundPeople({ kind: 'character', background: 'Across the room at the counter, the Café Barista wipes the espresso machine, glancing over.', people: [{ name: 'Mira Hayashi', side: 'center', action: 'sets the spoon down' }] }, CAFE_CAST, 'alex');
    assert.deepEqual(out.people.map((p) => p.name), ['Mira Hayashi']);
});


test('1.06 lowered eyes are lowered, not "off to one side"', () => {
    const [down] = compileFrame({ kind: 'character', people: [{ name: 'Mira Hayashi', side: 'center', action: 'slumps back in the chair', expression: 'eyes dropping to her lap', gaze: 'the viewer' }] }, { shot: 'medium shot' }, CAFE);
    assert.match(down, /Her head is lowered, her eyes cast down\./);
    const [shy] = compileFrame({ kind: 'character', people: [{ name: 'Mira Hayashi', side: 'center', action: 'slumps', expression: 'soft downcast eyes flicking upward', gaze: 'the viewer' }] }, { shot: 'medium shot' }, CAFE);
    assert.match(shy, /eyes looking up through her lashes/);
});


// ---------------------------------------------------------------- 1.07: first-person mode, cost line
test('1.07 first-person mode: the player is never drawn - frames with him become his view, frames of him alone go or show his hands', () => {
    const beats = [
        { new_panel: true, kind: 'character', camera: { shot: 'medium shot', angle: 'eye level' }, description: 'Alex sits down.', people: [{ name: 'alex', side: 'center', action: 'sits down, smiling' }], dialogue_indices: [0] },
        { new_panel: false, kind: 'character', camera: { shot: 'medium shot', angle: 'over the shoulder' }, description: 'Mira glares at him.', background: 'Alex seated in the foreground.', people: [{ name: 'alex', side: 'left', action: 'sits' }, { name: 'Mira Hayashi', side: 'right', action: 'glares', gaze: 'alex' }], dialogue_indices: [1] },
        { new_panel: false, kind: 'character', camera: { shot: 'medium shot', angle: 'eye level' }, description: 'Alex sets his cup down.', people: [{ name: 'alex', side: 'center', action: 'sets the cup down on the table' }], dialogue_indices: [] },
    ];
    const out = withPlayerUnseen(beats, CAFE_CAST, 'alex');
    assert.equal(out.length, 2, 'the frame of him only sitting is left out');
    assert.deepEqual(out[0].dialogue_indices, [0, 1], 'its lines move to the next frame');
    assert.equal(out[0].new_panel, true);
    assert.equal(out[0].camera.angle, 'pov');
    assert.equal(out[0].background, '');
    assert.equal(out[1].kind, 'insert');
    assert.equal(out[1].camera.angle, 'pov', 'his hands with the cup: a first-person insert');
    const scene = normalizeScene({ setting: 'café', beats, cast: [] }, { userName: 'alex', cast: CAFE_CAST, povMode: true });
    for (const beat of scene.beats) {
        const [prompt] = compileFrame(beat, beat.camera, CAFE);
        assert.ok(!/dark-haired young man|Over-the-shoulder/.test(prompt), prompt);
    }
    const [view] = compileFrame(scene.beats[0], scene.beats[0].camera, CAFE);
    assert.match(view, /glares at the viewer/);
    assert.match(systemPrompt({ povMode: true }), /FIRST-PERSON MODE/);
    assert.ok(!/FIRST-PERSON MODE/.test(systemPrompt({})));
});

test('1.07 first-person frames do not describe the player\'s own body (it drew a man in his place)', () => {
    const [p] = compileFrame({ kind: 'character', description: 'Alex sits opposite Mira with his forearms on the table. Mira stares back.', people: [{ name: 'alex', action: 'sits' }, { name: 'Mira Hayashi', side: 'center', action: 'stares', gaze: 'alex' }] }, { shot: 'medium shot', angle: 'pov' }, CAFE);
    assert.ok(!/The viewer sits/.test(p), p);
    assert.match(p, /stares back/);
});

test('1.07 cost line: this reply, by part, and the chat total', () => {
    const usage = { parser: { cost: 0.0112, calls: 1 }, world: null, vision: { cost: 0.0021, calls: 7 }, total: { cost: 0.0133, calls: 8 }, redrawn: false };
    assert.equal(costLine(usage, 0.2), 'This reply: $0.0133 (scene $0.0112, 7 picture checks $0.0021) - all pages of this chat: $0.2000');
    assert.match(costLine({ ...usage, redrawn: true, total: { cost: 0.0021 } }), /scene reused \(free\)/);
    assert.match(costLine({ total: { cost: null, promptTokens: 100, completionTokens: 20 } }), /120 tokens \(no price reported\)/);
    assert.equal(costLine(null), '');
});


test('1.07 posture is its own sentence right after who is in the picture (at the end of the action it lost: standing 4 of 4)', () => {
    const spec = { kind: 'character', location: 'Window Café Table', people: [{ name: 'Mira Hayashi', side: 'center', action: 'Still seated, leaning forward over the table with hands jammed in her pockets', gaze: 'the viewer' }] };
    const [p] = compileFrame(spec, { shot: 'medium shot' }, CAFE);
    assert.match(p, /One main figure: the twin-tailed red-haired college girl\. The twin-tailed red-haired college girl is sitting on a chair at the table\./);
    assert.match(frameExpectation(spec, { shot: 'medium shot' }, CAFE).text, /Posture: "the twin-tailed red-haired college girl" must be sitting/);
});

console.log(`\n${passed} tests passed`);

