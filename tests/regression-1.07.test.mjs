// Regression tests for the faults found by the 1.07 audit.  Run: node tests/regression-1.07.test.mjs
// Pure logic only: no SillyTavern, no ComfyUI, nothing is drawn or paid.
//
// test(...)  must pass - exit code 1 if it does not.
// todo(...)  would be a confirmed fault not fixed yet (none left in 1.09): it is EXPECTED to fail.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { withPlayerUnseen, normalizeScene } from '../scene-parser.js';
import { planPanels, fitBudget } from '../director.js';
import { prepareCustomGraph, referenceValues } from '../custom-workflow.js';
import { sameName, uniqueLabels, mergeCast } from '../cast-book.js';
import { withoutStrayPronouns } from '../text-rules.js';
import { extractSpeechLines } from '../dialogue-lines.js';
import { judge } from '../vision-check.js';
import { completeBeats, withPlayerInForeground, parseScene } from '../scene-parser.js';
import { compileFrame } from '../prompt-builder.js';
import { withLedger, spentOf, chatSpent } from '../result-state.js';
import { addUsage } from '../llm-request.js';
import { costLine } from '../renderer.js';
import { ensureWorldBook } from '../world-book.js';
import { modelSignature, dropSheetsOfAnotherModel } from '../character-refs.js';
import { PROMPT_STYLES } from '../settings.js';
import { imagesDrawn } from '../director.js';
import { uniqueStamp, placeWords } from '../util.js';
import { jobKeyParts } from '../job-key.js';
import { keepLastGood } from '../result-state.js';
import { sameGraph, bridgeOutcome } from '../comfyui-bridge/web/graph-compare.js';
import { DEFAULT_SETTINGS } from '../settings.js';

let failed = 0;
let passed = 0;
const run = (name, fn, { expectFail = false } = {}) => {
    try {
        fn();
        if (expectFail) console.log(`now passes - change todo to test: ${name}`);
        else { passed++; console.log(`ok   - ${name}`); }
    } catch (error) {
        if (expectFail) { console.log(`todo - ${name}`); return; }
        failed++;
        console.log(`FAIL - ${name}\n       ${String(error.message).split('\n').slice(0, 3).join('\n       ')}`);
    }
};
const test = (name, fn) => run(name, fn);
const todo = (name, fn) => run(name, fn, { expectFail: true });
const atest = async (name, fn) => { try { await fn(); passed++; console.log(`ok   - ${name}`); } catch (error) { failed++; console.log(`FAIL - ${name}\n       ${String(error.message).split('\n').slice(0, 3).join('\n       ')}`); } };

// ---------------------------------------------------------------- helpers
const cast = [{ name: 'Alex', sex: 'male', role: 'player' }, { name: 'Alice', sex: 'female' }];
const beat = (o) => ({ kind: 'dialogue', description: 'x', characters: ['A', 'B'], camera: { shot: 'medium shot', angle: 'eye level' }, people: [], dialogue_indices: [], intensity: 'calm', same_moment: false, new_panel: true, emphasis: 'normal', ...o });
const talk = (n, words = 3) => ({ characters: [{ name: 'A', screen_position: 'left' }, { name: 'B', screen_position: 'right' }], dialogue: Array.from({ length: n }, (_, i) => ({ speaker: i % 2 ? 'B' : 'A', text: Array(words).fill('word').join(' ') })), camera: { shot: 'medium shot', angle: 'eye level' } });
const imagesOf = (plan) => plan.reduce((n, p) => n + (p.strategy === 'grid' ? p.frames.filter((f) => f.strategy === 'generate').length : (p.strategy === 'generate' ? 1 : 0)), 0);
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const SHOTS = ['wide shot', 'full shot', 'medium shot', 'close-up', 'extreme close-up'];
function randomScene(seed) {
    const r = rng(seed);
    const pick = (a) => a[Math.floor(r() * a.length)];
    const lines = 1 + Math.floor(r() * 8);
    const scene = talk(lines, 1 + Math.floor(r() * 30));
    const n = 1 + Math.floor(r() * 8);
    scene.beats = Array.from({ length: n }, (_, i) => beat({
        new_panel: i === 0 ? true : r() < 0.5,
        same_moment: i > 0 && r() < 0.4,
        camera: { shot: pick(SHOTS), angle: 'eye level' },
        emphasis: r() < 0.2 ? 'main' : 'normal',
        intensity: r() < 0.1 ? 'peak' : 'calm',
        dialogue_indices: Array.from({ length: Math.floor(r() * 3) }, () => Math.floor(r() * lines)).filter((v, k, a) => a.indexOf(v) === k).sort((x, y) => x - y),
    }));
    return scene;
}

// ---------------------------------------------------------------- Phase 1: money and lost results
const trueOne = () => JSON.parse(fs.readFileSync(new URL('../workflows/the true one + IP-Adapter.api.json', import.meta.url), 'utf8'));
const seedsOf = (g) => Object.values(g).flatMap((n) => ['seed', 'noise_seed'].filter((k) => k in (n.inputs || {})).map((k) => n.inputs[k]));
const sizesOf = (g) => Object.values(g).filter((n) => n.inputs && 'batch_size' in n.inputs).map((n) => [n.inputs.width, n.inputs.height]);

test('#1 no reference: the seed of the request reaches the graph', () => {
    const a = seedsOf(prepareCustomGraph(trueOne(), { prompt: 'p', negative: 'n', seed: 111, width: 832, height: 1216, refs: [] }));
    const b = seedsOf(prepareCustomGraph(trueOne(), { prompt: 'p', negative: 'n', seed: 222, width: 832, height: 1216, refs: [] }));
    assert.notDeepEqual(a, b);
    assert.ok(a.includes(111), `seeds were ${JSON.stringify(a)}`);
});
test('#1 no reference: the size of the request reaches the graph', () => {
    const g = prepareCustomGraph(trueOne(), { prompt: 'p', negative: 'n', seed: 5, width: 832, height: 1216, refs: [] });
    assert.deepEqual(sizesOf(g), [[832, 1216]]);
});
test('#1 no reference: the adapter is still taken out of the graph', () => {
    const g = prepareCustomGraph(trueOne(), { prompt: 'p', negative: 'n', seed: 5, width: 832, height: 1216, refs: [] });
    assert.ok(!Object.values(g).some((n) => /ip.?adapter/i.test(n.class_type || '')));
});
test('#1 with a reference: seed, size and adapter weight are all set', () => {
    const g = prepareCustomGraph(trueOne(), { prompt: 'p', negative: 'n', seed: 111, width: 832, height: 1216, refs: ['data:a', 'data:b'], referenceStrength: 0.6 });
    assert.ok(seedsOf(g).includes(111));
    assert.deepEqual(sizesOf(g), [[832, 1216]]);
    assert.ok(Object.values(g).some((n) => /ip.?adapter/i.test(n.class_type || '')));
});
test('#2 a reference strength of 0 stays 0', () => {
    assert.equal(referenceValues(['a', 'b'], 0).reference_weight, 0);
    assert.equal(referenceValues(['a', 'b'], 0.6).reference_weight, 0.6);
    assert.equal(referenceValues(['a', 'b'], undefined).reference_weight, 1);
});

test('#3 maxImages=1: a close-up that lettering widens is not a second image', () => {
    const scene = { ...talk(2, 25), beats: [beat({ dialogue_indices: [0] }), beat({ same_moment: true, camera: { shot: 'close-up', angle: 'eye level' }, dialogue_indices: [1] })] };
    assert.ok(imagesOf(planPanels(scene, { maxImages: 1, maxPanels: 6 })) <= 1);
});
test('#3 property: the plan never draws more images than maxImages (400 random replies)', () => {
    const bad = [];
    for (let seed = 1; seed <= 400; seed++) {
        const maxImages = 1 + (seed % 6);
        const maxPanels = 1 + (seed % 5);
        const n = imagesOf(planPanels(randomScene(seed), { maxImages, maxPanels }));
        if (n > maxImages) bad.push(`seed ${seed}: ${n} images > ${maxImages}`);
    }
    assert.equal(bad.length, 0, `${bad.length} over budget, e.g. ${bad.slice(0, 3).join('; ')}`);
});
test('#4 maxPanels=3: the heaviest-frame split cannot make a fourth panel', () => {
    const specs = [beat({ dialogue_indices: [0] }), beat({ dialogue_indices: [1] }), beat({ new_panel: false, dialogue_indices: [2, 3, 4, 5] }), beat({ new_panel: false, dialogue_indices: [6] })];
    assert.ok(fitBudget(specs, { maxPanels: 3, maxImages: 10 }).length <= 3);
});
test('#4 property: the plan never has more panels than maxPanels (400 random replies)', () => {
    const bad = [];
    for (let seed = 1; seed <= 400; seed++) {
        const maxPanels = 1 + (seed % 5);
        const n = planPanels(randomScene(seed), { maxImages: 10, maxPanels }).length;
        if (n > maxPanels) bad.push(`seed ${seed}: ${n} panels > ${maxPanels}`);
    }
    assert.equal(bad.length, 0, `${bad.length} over budget, e.g. ${bad.slice(0, 3).join('; ')}`);
});
test('#5 a closer crop is cut from the panel right before it, grids included', () => {
    // Three places so the pages are not packed together: P0 single, P1 a grid of two, P2 a closer look at the grid's last frame.
    const scene = { ...talk(3, 3), beats: [
        beat({ location: 'kitchen table', dialogue_indices: [0] }),
        beat({ location: 'garden path', dialogue_indices: [1] }), beat({ location: 'garden path', new_panel: false, dialogue_indices: [] }),
        beat({ location: 'harbor dock', same_moment: true, camera: { shot: 'close-up', angle: 'eye level' }, dialogue_indices: [2] }),
    ] };
    const plan = planPanels(scene, { maxImages: 10, maxPanels: 6, splitDialogueThreshold: 99 });
    assert.deepEqual(plan.map((p) => p.strategy), ['generate', 'grid', 'reframe']);
    assert.equal(plan[2].fromPanel, 1, 'was cut from the older single picture (panel 0) in 1.07');
});
const base = { ...DEFAULT_SETTINGS, customWorkflow: { enabled: true, name: 'wf' } };
const keyOf = (s, extra) => JSON.stringify(jobKeyParts('hello', s, extra));
test('#15 every setting that changes the pictures changes the job key', () => {
    const k0 = keyOf(base);
    for (const [name, change] of Object.entries({
        characterReference: { characterReference: !base.characterReference },
        detailPass: { detailPass: !base.detailPass },
        faceTouchUp: { faceTouchUp: !base.faceTouchUp },
        parserReasoning: { parserReasoning: 'high' },
        fullBleedCooldown: { fullBleedCooldown: 3 },
        playerPov: { playerPov: !base.playerPov },
    })) assert.notEqual(keyOf({ ...base, ...change }), k0, `${name} does not change the key`);
});
test('#15 with character reference on, its strengths and LoRA change the job key', () => {
    const on = { ...base, characterReference: true };
    const k0 = keyOf(on);
    for (const [name, change] of Object.entries({
        referenceLora: { referenceLora: 'other.safetensors' },
        referenceLoraStrength: { referenceLoraStrength: 0.9 },
        referenceStrength: { referenceStrength: 0.4 },
        ipAdapterStrength: { ipAdapterStrength: 0.9 },
    })) assert.notEqual(keyOf({ ...on, ...change }), k0, `${name} does not change the key`);
});
test('#15 with character reference off, its strengths cannot change a picture and do not change the key', () => {
    const k0 = keyOf(base);
    assert.equal(keyOf({ ...base, ipAdapterStrength: 0.9, referenceStrength: 0.4 }), k0);
});
test('#15 the content of the workflow changes the job key, its name alone does not hide it', () => {
    assert.notEqual(keyOf(base, { workflowSig: 'aaa' }), keyOf(base, { workflowSig: 'bbb' }));
});
test('#15 settings that only change the view do not change the job key', () => {
    const k0 = keyOf(base);
    for (const change of [{ debug: true }, { showSpeechBubbles: false }, { revealTextByDefault: true }, { showCost: false }, { autoGenerate: false }, { referenceSheets: { x: 1 } }])
        assert.equal(keyOf({ ...base, ...change }), k0, JSON.stringify(change));
});
test('#15 default settings keep the key the 1.07 code made (saved pages stay fresh)', () => {
    const k = jobKeyParts('hello', { ...DEFAULT_SETTINGS }, {});
    assert.equal(k.length, 13, 'a new trailing item appears only when a setting is non-default');
});

test('#15 legacy mode gives byte for byte the key 1.07 made, so saved pages stay fresh', () => {
    // The 1.07 computeParamsHash, copied here as it was.
    const old107 = (text, raw) => JSON.stringify([
        'pipeline:8:3', text, raw.connectionProfileId, raw.promptStyle, raw.promptPresets, raw.comfy,
        raw.sceneContext ? 1 : 0, `${raw.maxPanels}:${raw.splitDialogueThreshold}:${raw.maxImages}:${raw.innerThoughts ? 1 : 0}`,
        raw.fullModeMa ? 'full' : '', raw.playerPov ? 'pov' : '',
        raw.qualityCheck ? `qc:${raw.visionModel}:${raw.maxRedraws}` : '',
        raw.customWorkflow?.enabled ? `wf:${raw.customWorkflow.name}` : '', '',
    ]);
    const s = { ...base, qualityCheck: true, characterReference: true, ipAdapterStrength: 0.9, detailPass: false };
    assert.equal(JSON.stringify(jobKeyParts('hello', s, { pipeline: '8:3', workflowSig: 'abc', legacy: true })), old107('hello', s));
});
test('#18 a failed redraw keeps the last good result and says why', () => {
    const good = { status: 'done', paramsHash: 'old', panels: [{ imageUrl: '/a.png' }], usage: { total: { cost: 0.1 } } };
    const failedRun = { status: 'error', paramsHash: 'new', error: 'ComfyUI timed out', usage: { total: { cost: 0.02 } } };
    const out = keepLastGood(good, failedRun);
    assert.equal(out.status, 'done');
    assert.equal(out.panels[0].imageUrl, '/a.png');
    assert.equal(out.lastError.message, 'ComfyUI timed out');
    assert.equal(out.lastError.paramsHash, 'new');
});
test('#18 with no earlier good result the failure is shown as it is', () => {
    const failedRun = { status: 'error', paramsHash: 'new', error: 'x' };
    assert.equal(keepLastGood(null, failedRun), failedRun);
    assert.equal(keepLastGood({ status: 'error' }, failedRun), failedRun);
});
test('#18 a successful result is never replaced by the old one', () => {
    const ok = { status: 'done', paramsHash: 'new', panels: [{ imageUrl: '/b.png' }] };
    assert.equal(keepLastGood({ status: 'done', panels: [{ imageUrl: '/a.png' }] }, ok), ok);
});

const refAnswer = { figures: [{ label: 'the guard', present: true, count: 1, matches_look: true, head: { x0: .4, y0: .1, x1: .6, y1: .25 } }], background: 'blank or white', white_share: 0.62, white_corner: 1, panels: 1, extra_main_figures: 0, defects: 'none', illogical: 'none', heads: [{ label: 'the guard', box: [400, 100, 600, 250] }] };
test('#6 a reference sheet on a plain white background is not a failure for being white', () => {
    const v = judge(refAnswer, { text: 'x', labels: ['the guard'], kind: 'character', forCrop: true, reference: true });
    assert.ok(!v.reasons.some((r) => /blank background|white area/i.test(r)), v.reasons.join('; '));
});
test('#6 an ordinary frame that is mostly white is still a failure', () => {
    const v = judge(refAnswer, { text: 'x', labels: ['the guard'], kind: 'character', forCrop: true });
    assert.ok(v.reasons.some((r) => /blank background|white area/i.test(r)));
});

const node = (id, type, w) => ({ id, type, widgets_values: w });
test('#21 the saved graph and the one on screen are compared by content, not by node ids', () => {
    const saved = { nodes: [node(1, 'KSampler', [1, 'fixed', 10]), node(2, 'CLIPTextEncode', ['a cat'])] };
    const same = { nodes: [node(2, 'CLIPTextEncode', ['a cat']), node(1, 'KSampler', [1, 'fixed', 10])] };
    const edited = { nodes: [node(1, 'KSampler', [1, 'fixed', 30]), node(2, 'CLIPTextEncode', ['a cat'])] };
    assert.equal(sameGraph(saved, same), true);
    assert.equal(sameGraph(saved, edited), false, 'same node ids but another step count must not match');
});
test('#22 the bridge reports success only when ComfyUI answered 2xx and the file went to SillyTavern', () => {
    assert.equal(bridgeOutcome({ ok: true, status: 200 }, { ok: true, sillytavern: true }).ready, true);
    assert.equal(bridgeOutcome({ ok: false, status: 500 }, null).ready, false);
    const notCopied = bridgeOutcome({ ok: true, status: 200 }, { ok: true, sillytavern: false });
    assert.equal(notCopied.ready, false);
    assert.match(notCopied.message, /SillyTavern/);
});

// ---------------------------------------------------------------- faults of the audit that were fixed after 1.08
const frameOf = (description, people) => beat({ description, people });
test('#7 every label is unique', () => {
    const labels = uniqueLabels([{ label: 'the guard', sex: 'male' }, { label: 'the second guard', sex: 'male' }, { label: 'the guard', sex: 'male' }]).map((p) => p.label);
    assert.equal(new Set(labels).size, labels.length);
});
test('#8 people with different titles are different people', () => {
    assert.equal(sameName('Old Merchant', 'Young Merchant'), false);
    assert.equal(sameName('Lord Harlan', 'Lady Harlan'), false);
    assert.equal(mergeCast([{ name: 'Old Merchant', sex: 'male', label: 'the old merchant', look: 'grey beard', outfit: 'robe' }], [{ name: 'Young Merchant', sex: 'male', label: 'the young merchant', look: 'black hair', outfit: 'vest' }]).length, 2);
});
test('#11 quotes of two speakers are not joined into one balloon', () => {
    const lines = extractSpeechLines('"Hey," Bob said.\n"you came," Alice said, smiling.').map((l) => l.text);
    assert.ok(!lines.some((t) => /Hey, you/.test(t)), JSON.stringify(lines));
});
test('#12 an object pronoun is not turned into a possessive', () => {
    assert.doesNotMatch(withoutStrayPronouns('Alice hands him a cup.', { drawn: new Set(['female']), viewerSex: 'male' }), /viewer's a cup/);
});
test('#23 POV never returns a frame that draws the player', () => {
    const frames = withPlayerUnseen([frameOf('Alex smiles', [{ name: 'Alex', action: 'smiles' }])], cast, 'Alex');
    assert.ok(!frames.some((f) => (f.people || []).some((p) => p.name === 'Alex') && f.camera?.angle !== 'pov'));
});
test('#24 naming an object is not a hands insert', () => {
    for (const t of ['Alex walks past a sword display', 'Alex reaches the village at dawn', 'Alex takes a seat by the fire', 'Alex walks to the place where it began'])
        assert.notEqual(withPlayerUnseen([frameOf(t, [{ name: 'Alex', action: t }])], cast, 'Alex')[0].kind, 'insert', t);
});
test('#30 all background mentions of the player go in one pass', () => {
    const out = withPlayerUnseen([beat({ people: [{ name: 'Alice', action: 'talks' }], background: 'Alex waits at the door. Alex rests at the distant counter.' })], cast, 'Alex')[0].background;
    assert.doesNotMatch(out, /Alex/);
});
test('#31 turning POV off brings the dropped frames back', () => {
    const scene = { parserVersion: 4, setting: 'tavern', characters: [], dialogue: [], beats: [beat({ people: [{ name: 'Alex', side: 'left', action: 'smiles' }], dialogue_indices: [0] }), beat({ people: [{ name: 'Alice', side: 'right', action: 'nods' }], dialogue_indices: [1] })] };
    const on = normalizeScene(structuredClone(scene), { userName: 'Alex', cast, povMode: true });
    const off = normalizeScene(structuredClone(on), { userName: 'Alex', cast, povMode: false });
    assert.equal(off.beats.length, scene.beats.length);
    assert.ok(!off.povMode);
});


// ---------------------------------------------------------------- 1.09: the rest of the audit
const castBook = (extra = []) => [
    { name: 'Alex', sex: 'male', role: 'player', label: 'the young man', look: 'short dark hair', outfit: 'black t-shirt' },
    { name: 'Alice', sex: 'female', label: 'the red-haired woman', look: 'long red hair, green eyes', outfit: 'grey jacket and jeans' },
    { name: 'Bob', sex: 'male', label: 'the tall guard', look: 'tall, grey beard', outfit: 'chainmail' },
    ...extra,
];
const ctxOf = (cast, extra = {}) => ({ style: PROMPT_STYLES.NATURAL, presets: DEFAULT_SETTINGS.promptPresets, cast: uniqueLabels(cast), setBook: [], world: { era_and_technology: 'Medieval fantasy' }, setting: 'a tavern', personaName: 'Alex', ...extra });
const spec = (o) => ({ kind: 'character', location: 'tavern', camera: { shot: 'medium shot', angle: 'eye level' }, description: '', interaction: '', background: '', people: [], dialogue_indices: [], new_panel: true, ...o });

test('#9 a change of clothes in the middle of a reply: frames before it show the old outfit, frames after it the new one', () => {
    const merged = mergeCast(castBook(), [{ name: 'Alice', sex: 'female', label: '', look: '', outfit: 'a blue silk dress', outfit_changed: true, outfit_from_beat: 1, same_as: '' }]);
    const cast = uniqueLabels(merged);
    const scene = { parserVersion: 4, setting: 'tavern', characters: [], dialogue: [], beats: [
        spec({ description: 'Alice waits.', people: [{ name: 'Alice', side: 'center', action: 'waits' }] }),
        spec({ description: 'Alice returns.', people: [{ name: 'Alice', side: 'center', action: 'returns' }] }),
    ] };
    const out = normalizeScene(scene, { userName: 'Alex', cast });
    const [first] = compileFrame(out.beats[0], { shot: 'full shot', angle: 'eye level' }, ctxOf(cast));
    const [second] = compileFrame(out.beats[1], { shot: 'full shot', angle: 'eye level' }, ctxOf(cast));
    assert.match(first, /grey jacket/i); assert.doesNotMatch(first, /blue silk dress/i);
    assert.match(second, /blue silk dress/i);
});
test('#9 the per-reply outfit marks are not carried into the next reply', () => {
    const merged = mergeCast(castBook(), [{ name: 'Alice', sex: 'female', label: '', look: '', outfit: 'a blue silk dress', outfit_changed: true, outfit_from_beat: 2, same_as: '' }]);
    assert.equal(merged.find((p) => p.name === 'Alice').outfitFromBeat, 2);
    const next = mergeCast(merged, []);
    assert.equal(next.find((p) => p.name === 'Alice').outfitBefore, undefined);
});
test('#13 the player moved to the foreground takes out his own clause, not the whole background', () => {
    const out = withPlayerInForeground(spec({ people: [{ name: 'Alice', side: 'left', action: 'talks' }], background: 'Alex seated in the foreground, a crowd of stalls lines the market, a fountain splashes.' }), 'Alex');
    assert.equal(out.playerMovedToForeground, true);
    assert.match(out.background, /stalls/);
    assert.doesNotMatch(out.background, /Alex/);
});
await atest('#14 the director completes the reply with the whole cast: an over-the-shoulder frame keeps its owner', async () => {
    const answer = { storyboard: 'x', setting: 'gate', cast: [{ name: 'Roland', sex: 'male', label: 'the watchman', look: 'l', outfit: 'o', outfit_changed: false, outfit_from_beat: 0, same_as: '' }], places: [], dialogue: [],
        beats: [{ kind: 'character', description: 'Roland glares.', location: 'gate', camera: { shot: 'medium shot', angle: 'over the shoulder' }, people: [{ name: 'Roland', side: 'right', action: 'glares', expression: '', gaze: 'Alex' }], interaction: '', background: '', dialogue_indices: [], new_panel: true, emphasis: 'normal', intensity: 'calm', same_moment: false }] };
    const fake = { extensionSettings: {}, ConnectionManagerRequestService: { sendRequest: async () => ({ choices: [{ message: { content: JSON.stringify(answer) } }], usage: {} }) } };
    const scene = await parseScene(fake, 'p', 'Roland glares.', { characterName: 'N', userName: 'Alex', knownCast: uniqueLabels(castBook()), knownSet: [], world: { summary: 'w', era_and_technology: 'e' } });
    assert.equal(scene.beats[0].camera.angle, 'over the shoulder');
    assert.ok(scene.beats[0].people.some((p) => p.name === 'Alex'));
});
test('#28 seating: the seat named by the description is the seat; no chair is made up', () => {
    const c = ctxOf(castBook());
    const floor = compileFrame(spec({ description: 'Alice sits on the floor.', people: [{ name: 'Alice', side: 'center', action: 'Sitting, hands in her lap' }] }), { shot: 'medium shot', angle: 'eye level' }, c)[0];
    assert.match(floor, /is sitting on the floor/i);
    assert.doesNotMatch(floor, /on a chair/i);
    const plain = compileFrame(spec({ description: 'Alice waits.', people: [{ name: 'Alice', side: 'center', action: 'Sitting, hands in her lap' }] }), { shot: 'medium shot', angle: 'eye level' }, c)[0];
    assert.doesNotMatch(plain, /chair/i);
});
test('#29 a pronoun in a sentence that names another person of the cast is that person, not the viewer', () => {
    const frame = spec({ description: 'Alice sees the tall guard in the distance and smiles at him.', background: 'The tall guard stands far away at the gate.', people: [{ name: 'Alice', side: 'center', action: 'smiles' }] });
    const [p] = compileFrame(frame, { shot: 'medium shot', angle: 'eye level' }, ctxOf(castBook()));
    assert.match(p, /smiles at him/i);
    assert.doesNotMatch(p, /smiles at the viewer/i);
});

test('#26 the chat cost never goes down after a redraw: every attempt is in the ledger', () => {
    const first = withLedger(null, { parser: { cost: 0.1 }, total: { cost: 0.12, calls: 3 }, redrawn: false }, 't1');
    const second = withLedger(first, { parser: { cost: 0.1 }, total: { cost: 0.03, calls: 2 }, redrawn: true }, 't2');
    assert.equal(spentOf(first).known.toFixed(2), '0.12');
    assert.equal(spentOf(second).known.toFixed(2), '0.15');
    const chat = [{ extra: { manga: { usage: first } } }, { extra: { manga: { usage: second } } }];
    assert.equal(chatSpent(chat).known.toFixed(2), '0.27');
});
test('#26 a reply saved by 1.07 (no ledger) starts the ledger with its one total', () => {
    const legacy = { total: { cost: 0.0191, calls: 11 } };
    const next = withLedger(legacy, { total: { cost: 0.002, calls: 1 }, redrawn: true }, 't');
    assert.equal(spentOf(next).known.toFixed(4), '0.0211');
});
test('#27 a price the provider did not report is not zero: it is counted and shown', () => {
    const sum = addUsage({ cost: 0.1, calls: 1 }, { cost: null, calls: 1 });
    assert.equal(sum.cost, null);
    assert.equal(sum.knownCost, 0.1);
    assert.equal(sum.unpriced, 1);
    const usage = withLedger(null, { total: sum, parser: { cost: 0.1 } }, 't');
    const s = spentOf(usage);
    assert.equal(s.known, 0.1);
    assert.equal(s.unpriced, 1);
    assert.match(costLine({ total: sum }, chatSpent([{ extra: { manga: { usage } } }])), /known \(\+1 call without a reported price\)/);
});

await atest('#19 two chats with identical world sources each get their own saved world book', async () => {
    const world = { summary: 's', era_and_technology: 'e', cast: [] };
    const make = (id) => ({ chatMetadata: {}, getCurrentChatId: () => id, getCharacterCardFields: () => ({ description: 'the same world' }), characters: [], chat: [], name1: 'M', name2: 'N', extensionSettings: {}, saved: 0, saveMetadata: async function () { this.saved++; }, ConnectionManagerRequestService: { sendRequest: async () => ({ choices: [{ message: { content: JSON.stringify(world) } }], usage: {} }) } });
    const a = make('chat A');
    const b = make('chat B');
    await Promise.all([ensureWorldBook(a, 'p'), ensureWorldBook(b, 'p')]);
    assert.ok(a.chatMetadata.mangaWorld?.world, 'chat A');
    assert.ok(b.chatMetadata.mangaWorld?.world, 'chat B got no world book (it shared the job of chat A)');
    assert.equal(b.saved, 1);
});
test('#20 reference sheets of another model are dropped when the model changes, and kept when it does not', () => {
    const s = { comfy: { family: 'split', unet: 'model-a.safetensors' }, referenceLora: 'x', customWorkflow: { enabled: false }, referenceSheets: { 'alice|1': { full: '/a.png' } } };
    dropSheetsOfAnotherModel(s);
    assert.ok(s.referenceSheets['alice|1'], 'first use after an upgrade keeps them');
    dropSheetsOfAnotherModel(s);
    assert.ok(s.referenceSheets['alice|1'], 'same model keeps them');
    s.comfy.unet = 'model-b.safetensors';
    dropSheetsOfAnotherModel(s);
    assert.deepEqual(s.referenceSheets, {});
    assert.notEqual(modelSignature(s), modelSignature({ ...s, comfy: { ...s.comfy, unet: 'model-c.safetensors' } }));
});

test('#24 hands that do something are still a first-person hands insert', () => {
    for (const t of ['Alex holds the cup out to her', 'Alex takes the coin from the table', 'Alex sets the cup down', 'Alex reaches for the door handle'])
        assert.equal(withPlayerUnseen([frameOf(t, [{ name: 'Alex', action: t }])], cast, 'Alex')[0].kind, 'insert', t);
});
test('#31 the raw frames survive: POV on, off, on again gives the same pictures as on directly', () => {
    const scene = { parserVersion: 4, setting: 'tavern', characters: [], dialogue: [], beats: [beat({ people: [{ name: 'Alex', side: 'left', action: 'smiles' }], dialogue_indices: [0] }), beat({ people: [{ name: 'Alice', side: 'right', action: 'nods' }], dialogue_indices: [1] })] };
    const run = (sc, pov) => normalizeScene(structuredClone(sc), { userName: 'Alex', cast, povMode: pov });
    const on1 = run(scene, true);
    const off = run(on1, false);
    const on2 = run(off, true);
    assert.equal(off.beats.length, 2);
    assert.deepEqual(on2.beats, on1.beats);
    assert.equal(off.rawBeats, undefined);
});
test('#31 normalizeScene is idempotent in both modes (a redraw never changes the result again)', () => {
    const scene = { parserVersion: 4, setting: 'tavern', characters: [], dialogue: [], beats: [beat({ people: [{ name: 'Alex', side: 'left', action: 'smiles' }], background: 'Alex waits. Alex rests at the counter.', dialogue_indices: [0] }), beat({ people: [{ name: 'Alice', side: 'right', action: 'nods' }], dialogue_indices: [1] })] };
    for (const pov of [true, false]) {
        const once = normalizeScene(structuredClone(scene), { userName: 'Alex', cast, povMode: pov });
        assert.deepEqual(normalizeScene(structuredClone(once), { userName: 'Alex', cast, povMode: pov }), once, `pov=${pov}`);
    }
});
test('#23 every frame of the reply shows the player alone: the view in front of him is drawn, not the player', () => {
    const out = withPlayerUnseen([beat({ description: 'Alex smiles', people: [{ name: 'Alex', action: 'smiles' }], dialogue_indices: [0, 1] })], cast, 'Alex');
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'establishing');
    assert.deepEqual(out[0].people, []);
    assert.deepEqual(out[0].dialogue_indices, [0, 1], 'no balloon is lost');
});
test('#7 labels stay unique with many people (and an explicit "second" is respected)', () => {
    const labels = uniqueLabels(Array.from({ length: 12 }, () => ({ label: 'the guard', sex: 'male' }))).map((p) => p.label);
    assert.equal(new Set(labels).size, 12);
    const mixed = uniqueLabels([{ label: 'the second guard', sex: 'male' }, { label: 'the guard', sex: 'male' }, { label: 'the guard', sex: 'male' }]).map((p) => p.label);
    assert.equal(new Set(mixed).size, 3);
});
test('#8 one title against none is still the same person', () => {
    assert.equal(sameName('Guard Roland', 'Roland'), true);
    assert.equal(sameName('the old merchant', 'Old Merchant'), true);
});
test('#12 "her" is an object before an article and a possessive before a noun', () => {
    const t = (x) => withoutStrayPronouns(x, { drawn: new Set(['male']), viewerSex: 'female' });
    assert.equal(t('Bob gives her a cup.'), 'Bob gives the viewer a cup.');
    assert.equal(t('Bob looks at her face.'), "Bob looks at the viewer's face.");
});
test('#11 a gesture in asterisks still lets one speaker\'s sentence continue', () => {
    assert.deepEqual(extractSpeechLines('"Here," *she shoves the glass at you* "drink it."').map((l) => l.text), ['Here, drink it.']);
});


// ---------------------------------------------------------------- 1.10: Webtoon mode
const linesOf = (plan) => plan.flatMap((p) => (p.strategy === 'grid' ? p.frames.flatMap((f) => f.dialogue) : p.dialogue));
test('webtoon: the plan is a scroll of single full-width pictures - no grid, no packed pages (400 random replies)', () => {
    const bad = [];
    for (let seed = 1; seed <= 400; seed++) {
        const maxImages = 1 + (seed % 8);
        const plan = planPanels(randomScene(seed), { maxImages, maxPanels: 1 + (seed % 5), webtoon: true });
        if (plan.some((p) => p.strategy === 'grid' || p.frames)) bad.push(`seed ${seed}: grid panel`);
        if (imagesDrawn(plan) > maxImages) bad.push(`seed ${seed}: ${imagesDrawn(plan)} images > ${maxImages}`);
    }
    assert.equal(bad.length, 0, `${bad.length} bad, e.g. ${bad.slice(0, 3).join('; ')}`);
});
test('webtoon: maxPanels is not a limit (the image budget is): five beats stay five pictures', () => {
    const scene = { ...talk(5, 3), beats: Array.from({ length: 5 }, (_, i) => beat({ location: `place ${i}`, dialogue_indices: [i] })) };
    const plan = planPanels(scene, { maxImages: 10, maxPanels: 2, webtoon: true, splitDialogueThreshold: 99 });
    assert.equal(plan.length, 5);
    assert.ok(plan.every((p) => p.strategy === 'generate'));
});
test('no balloon is ever lost: every dialogue line is in exactly one panel, in both modes (400 random replies)', () => {
    const bad = [];
    for (const webtoon of [false, true]) for (let seed = 1; seed <= 400; seed++) {
        const scene = randomScene(seed);
        const n = scene.dialogue.length;
        const got = linesOf(planPanels(scene, { maxImages: 1 + (seed % 6), maxPanels: 1 + (seed % 5), webtoon })).slice().sort((a, b) => a - b);
        const want = Array.from({ length: n }, (_, i) => i);
        if (JSON.stringify(got) !== JSON.stringify(want)) bad.push(`${webtoon ? 'webtoon' : 'pages'} seed ${seed}: lines ${JSON.stringify(got)} for ${n}`);
    }
    assert.equal(bad.length, 0, `${bad.length} bad, e.g. ${bad.slice(0, 3).join('; ')}`);
});
test('webtoon: the setting is part of the job key only when it is on (saved pages stay fresh)', () => {
    const k0 = keyOf(base);
    assert.notEqual(keyOf({ ...base, webtoonMode: true }), k0);
    assert.equal(keyOf({ ...base, webtoonMode: false }), k0);
    assert.equal(jobKeyParts('hello', { ...DEFAULT_SETTINGS }, {}).length, 13);
});
test('webtoon: the stylesheet, renderer and balloons all know the mode (no white bands)', () => {
    const css = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
    assert.match(css, /\.manga_strip\.manga_webtoon[\s\S]*padding: 0/);
    assert.match(css, /\.manga_webtoon \.manga_image_wrap\.manga_full_bleed/);
    const renderer = fs.readFileSync(new URL('../renderer.js', import.meta.url), 'utf8');
    assert.match(renderer, /manga_strip manga_webtoon/);
    assert.match(renderer, /!webtoon && r\.touchesTop/);
    const bubbles = fs.readFileSync(new URL('../bubbles.js', import.meta.url), 'utf8');
    assert.match(bubbles, /closest\('\.manga_webtoon'\)/);
    assert.match(bubbles, /!webtoon && worst > BUSY_COVERAGE/);
    assert.match(fs.readFileSync(new URL('../settings.html', import.meta.url), 'utf8'), /id="manga_webtoon_mode"/);
});
test('pictures saved in the same millisecond get different file names', () => {
    const names = new Set(Array.from({ length: 5000 }, () => uniqueStamp()));
    assert.equal(names.size, 5000);
});
test('place words: any script, accents ignored, short non-Latin words kept', () => {
    assert.deepEqual(placeWords('Café Lumière'), ['cafe', 'lumiere']);
    assert.deepEqual(placeWords('مقهى الحي'), ['مقهى', 'الحي']);
    assert.deepEqual(placeWords('the old tavern', new Set(['the', 'old'])), ['tavern']);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
