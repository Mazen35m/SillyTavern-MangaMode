// Run: node tests/direct-path.test.mjs - the Direct path (experiment): schema, validation, selective fixed data, assembly, retry.
// Uses invented story data and fake reader answers only (no LLM, no chat data).
import assert from 'node:assert/strict';
import { DIRECT_RULES, findObject, buildDirectSchema, directSystemPrompt, validateDirect, checkDirect, visibleData, assembleDirectFrame, parseDirect, parseDirectScene, directToScene, directExpectation, frameOfBeat, cleanDirectState, formatDirectState, findKnownDirectState, directUserPrompt, DIRECT_GUIDE } from '../direct-path.js';
import { repairLabelRuns, saidOnce } from '../direct-text.js';
import { planPanels } from '../director.js';
import { sceneProblem } from '../scene-parser.js';
import { findKnownCast, mergeCast, uniqueLabels, oneOutfit } from '../cast-book.js';
import { findKnownSet, mergeSet } from '../set-book.js';
import { getSettings } from '../settings.js';
import { effectivePresets } from '../model-adapters.js';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

const CAST = [
    { name: 'Rowan', sex: 'male', label: 'the tall young swordsman in the dark green cloak', look: 'human, 26 years old, tall lean build, short dark brown hair, green eyes, tanned skin', outfit: 'dark green hooded cloak, leather chest armour over a grey tunic, a silver wristwatch, brown boots', aliases: [] },
    { name: 'Marta', sex: 'female', label: 'the old innkeeper in the flour-dusted apron', look: 'human, 64 years old, short stout build, grey hair in a bun, brown eyes, weathered skin', outfit: 'faded blue dress, flour-dusted white apron', aliases: [] },
    { name: 'Sam', sex: 'male', label: 'the slim dark-haired student', look: 'human, 20 years old, slim build, black hair, brown eyes, olive skin', outfit: 'grey hoodie, blue jeans, white sneakers', aliases: [] },
];
const SET = [
    { name: 'The Gilded Boar', kind: 'place', label: 'the tavern', look: 'dark oak beams, a long wooden counter, rows of pewter mugs, barrels, flickering oil lamps' },
    { name: 'sealed letter', kind: 'object', label: 'the sealed letter', look: 'a folded cream parchment with a red wax seal' },
];
const presets = { natural: { prefix: 'masterpiece, best quality', suffix: 'vibrant full color' } };
const frame = (over = {}) => ({
    moment: 'Rowan holds the sealed letter out across the counter while Marta takes hold of the other end, both of them gripping the folded parchment and looking at each other, the red wax seal between their fingers.',
    shot: 'medium shot', angle: 'eye level', kind: 'character', new_panel: true, emphasis: 'normal',
    shows: { people: [{ name: 'Rowan', parts: ['upper body'], looks_at: 'Marta' }, { name: 'Marta', parts: ['upper body'], looks_at: 'Rowan' }], objects: ['sealed letter'], place: 'brief' },
    place_name: 'The Gilded Boar', light: 'warm oil lamplight, dim', dialogue_indices: [], ...over,
});
const answer = (frames) => ({ frames, dialogue: [], new_cast: [], new_places: [], state: { place: 'The Gilded Boar', light: 'lamplight', holding: [] } });
const books = { cast: CAST, setBook: SET, maxFrames: 10, personaName: 'Sam' };

await test('the schema keeps the answer order and the frame fields', () => {
    const s = buildDirectSchema({ maxFrames: 4 });
    assert.deepEqual(s.required, ['frames', 'dialogue', 'new_cast', 'new_places', 'state']);
    assert.equal(s.properties.frames.maxItems, 4);
    assert.deepEqual(s.properties.frames.items.properties.shows.properties.place.enum, ['none', 'brief', 'full']);
});

await test('the guide is requirements only: no model-specific or anti-failure wording', () => {
    assert.ok(DIRECT_GUIDE.length < 4500);
    assert.ok(!/anima|tag|score_|never draw|do not draw|failure/i.test(DIRECT_GUIDE));
    const p = directSystemPrompt({ maxFrames: 6, povMode: true });
    assert.match(p, /at most 6 frames/);
    assert.match(p, /FIRST PERSON/);
});

await test('every guide rule carries the failure it came from and its test; the guide holds exactly those rules', () => {
    for (const r of DIRECT_RULES) {
        assert.ok(r.id && r.text && r.failure && r.test, `${r.id} is missing its record`);
        assert.match(r.failure, /\(tuning/);
        assert.ok(DIRECT_GUIDE.includes(r.text));
    }
    assert.equal(DIRECT_GUIDE.split('\n- ').length - 1 >= DIRECT_RULES.length, true);
});

await test('a good answer has no problems', () => {
    assert.deepEqual(validateDirect(answer([frame()]), books), []);
});

await test('problems are named, never repaired', () => {
    const bad = answer([frame({ moment: 'Too short.', shows: { people: [{ name: 'Marta', parts: ['hands'] }], objects: [], place: 'full' }, place_name: 'Nowhere Keep', shot: 'huge' })]);
    const p = validateDirect(bad, books).join('\n');
    assert.match(p, /"moment" has 2 words/);
    assert.match(p, /"shot" "huge"/);
    assert.match(p, /Nowhere Keep/);
    assert.equal(bad.frames[0].moment, 'Too short.');
});

await test('a person named in the moment but not listed as visible is a problem', () => {
    const f = frame({ shows: { people: [{ name: 'Rowan', parts: ['hands'] }], objects: [], place: 'none' } });
    assert.match(validateDirect(answer([f]), books).join('\n'), /names Marta, who is not in shows.people/);
});

await test('people added in new_cast and places in new_places count as known', () => {
    const f = frame({ moment: 'Tess leans over the counter and points at the sealed letter with one finger while Rowan watches her closely, his hand resting on the wood beside the letter and the lamps flickering above.', shows: { people: [{ name: 'Tess', parts: ['upper body'] }, { name: 'Rowan', parts: ['hands'] }], objects: [], place: 'brief' }, place_name: 'Cellar Door' });
    const a = answer([f]);
    a.new_cast = [{ name: 'Tess', sex: 'female', label: 'the red-haired barmaid', look: 'human, 22 years old, red hair', outfit: 'green dress' }];
    a.new_places = [{ name: 'Cellar Door', kind: 'place', label: 'the cellar door', look: 'a low iron-banded door' }];
    assert.deepEqual(validateDirect(a, books), []);
});

await test('fixed data follows what is visible: hands bring the watch, not the boots', () => {
    const hands = visibleData(CAST[0], ['hands']);
    assert.match(hands.outfit, /wristwatch/);
    assert.ok(!/boots|cloak|armour/.test(hands.outfit));
    assert.ok(!/green eyes|short dark brown hair/.test(hands.look));
    assert.match(hands.look, /26 years old|tanned skin|human/);
    const face = visibleData(CAST[0], ['face']);
    assert.match(face.look, /green eyes/);
    assert.ok(!/boots|wristwatch/.test(face.outfit));
    const whole = visibleData(CAST[0], ['whole body']);
    assert.match(whole.outfit, /boots/);
    assert.match(whole.outfit, /wristwatch/);
});

await test('the same shot gets different data when different things are visible', () => {
    const a = assembleDirectFrame(frame({ shot: 'close-up', shows: { people: [{ name: 'Rowan', parts: ['hands'] }], objects: [], place: 'none' }, moment: 'Rowan taps the glass of his silver wristwatch with one finger, the wrist turned toward the camera, his hand and forearm filling the picture and the cuff of his sleeve just visible above the watch.' }), { cast: CAST, setBook: SET, presets, personaName: 'Sam' });
    const b = assembleDirectFrame(frame({ shot: 'close-up', shows: { people: [{ name: 'Rowan', parts: ['face'] }], objects: [], place: 'none' }, moment: 'Rowan looks straight ahead with a calm, patient expression, his eyes fixed on something just beside the camera and his head slightly tilted to one side while the lamps glow behind him.' }), { cast: CAST, setBook: SET, presets, personaName: 'Sam' });
    assert.match(a.prompt, /wristwatch/);
    assert.ok(!/Setting:/.test(a.prompt));
    assert.match(b.prompt, /green eyes/);
    assert.ok(!/Setting:/.test(b.prompt));
});

await test('assembly: prefix, camera, moment with labels, setting, light, object look, identity, suffix - no patches', () => {
    const { prompt, parts } = assembleDirectFrame(frame(), { cast: CAST, setBook: SET, presets, personaName: 'Sam' });
    assert.ok(prompt.startsWith('masterpiece, best quality'));
    assert.ok(prompt.endsWith('vibrant full color'));
    assert.ok(!/Rowan|Marta/.test(prompt), 'names are swapped for labels');
    assert.match(prompt, /the tall young swordsman in the dark green cloak holds the sealed letter/i);
    assert.match(prompt, /Setting: the tavern: dark oak beams, a long wooden counter, rows of pewter mugs\./);
    assert.ok(!/barrels/.test(prompt), 'a brief place carries only its first three items');
    assert.match(prompt, /Lighting: warm oil lamplight, dim\./);
    assert.match(prompt, /The sealed letter: a folded cream parchment with a red wax seal\./);
    assert.ok(!/main figures?|From left to right|one single continuous picture|painted edge to edge/.test(prompt), 'no model patches');
    assert.equal(parts.people.length, 2);
});

await test('the player is "the viewer"; their own hands carry their look, not their face', () => {
    const f = frame({ moment: 'Sam hands the sealed letter across the counter, his own hand reaching in from the bottom edge toward Marta, who holds out her palm to take it while looking at him over the counter.', shows: { people: [{ name: 'Sam', parts: ['hands'] }, { name: 'Marta', parts: ['upper body'] }], objects: ['sealed letter'], place: 'brief' } });
    const { prompt } = assembleDirectFrame(f, { cast: CAST, setBook: SET, presets, personaName: 'Sam' });
    assert.ok(!/\bSam\b/.test(prompt));
    assert.match(prompt, /the viewer hands the sealed letter/i);
    assert.match(prompt, /The viewer's own hands \(/);
    assert.ok(!/black hair/.test(prompt));
});

await test('the player may be listed without a cast entry (own hands): accepted, nothing attached', () => {
    const f = frame({ moment: 'Sam holds out the sealed letter with his own hand toward Marta, who reaches over the counter to take it, her fingers closing on the folded parchment while she looks up at him.', shows: { people: [{ name: 'Sam', parts: ['hands'] }, { name: 'Marta', parts: ['upper body'] }], objects: [], place: 'none' } });
    const noSam = { ...books, cast: CAST.filter((c) => c.name !== 'Sam') };
    assert.deepEqual(validateDirect(answer([f]), noSam), []);
    const { prompt } = assembleDirectFrame(f, { cast: noSam.cast, setBook: SET, presets, personaName: 'Sam' });
    assert.match(prompt, /The viewer's own hands\./);
});

await test('objects are found by the reader\'s own name, never by a loose word overlap; unknown objects are a visible problem', () => {
    const set = [...SET, { name: 'Designer Handbag and Volvo Keys', kind: 'object', label: 'the bag and keys', look: 'a black tote with a key fob' }, { name: 'Sleek Luxury Volvo', kind: 'object', label: 'the sleek luxury car', look: 'a dark grey sedan' }];
    assert.equal(findObject('Sealed Letter', set).name, 'sealed letter');
    assert.equal(findObject('Volvo Sedan', set), null);
    assert.equal(findObject('Designer Sunglasses', set), null);
    assert.equal(findObject('Sleek Luxury Volvo', set).name, 'Sleek Luxury Volvo');
    assert.equal(findObject('Luxury Volvo', set).name, 'Sleek Luxury Volvo');
    const f = frame({ shows: { people: [{ name: 'Rowan', parts: ['upper body'] }, { name: 'Marta', parts: ['upper body'] }], objects: ['Volvo Sedan'], place: 'none' } });
    assert.match(validateDirect(answer([f]), { ...books, setBook: set }).join('\n'), /object "Volvo Sedan" in shows.objects is not in the known set/);
});

await test('the same object listed twice prints once; the doubled label is cleaned; an outfit piece loses a leading "and"', () => {
    const f = frame({ moment: 'Marta snatches the folded cream sealed letter from Rowan across the counter, her fingers closing on the folded parchment while she looks at him with a small, satisfied smile.', shows: { people: [{ name: 'Marta', parts: ['upper body'] }, { name: 'Rowan', parts: ['hands'] }], objects: ['sealed letter', 'Sealed Letter'], place: 'none' } });
    const cast = CAST.map((c) => (c.name === 'Rowan' ? { ...c, outfit: 'dark green cloak, brown boots, and a silver wristwatch' } : c));
    const { prompt } = assembleDirectFrame(f, { cast, setBook: SET, presets, personaName: 'Sam' });
    assert.equal(prompt.split('The sealed letter:').length - 1, 1);
    assert.ok(!/folded cream the sealed letter/.test(prompt));
    assert.ok(!/wearing and /.test(prompt));
    assert.match(prompt, /wearing a silver wristwatch/);
});

await test('a word repeated by the name swap is said once', () => {
    const set = [...SET, { name: 'Coffee Cup', kind: 'object', label: 'the ceramic coffee cup', look: 'a white ceramic office mug' }];
    const f = frame({ moment: 'Rowan sets down his ceramic Coffee Cup on the counter while Marta watches him with a patient look, her hands folded on the apron and the lamps flickering softly over the beams above them.', shows: { people: [{ name: 'Rowan', parts: ['upper body'] }, { name: 'Marta', parts: ['face'] }], objects: ['Coffee Cup'], place: 'none' } });
    const { prompt } = assembleDirectFrame(f, { cast: CAST, setBook: set, presets, personaName: 'Sam' });
    assert.ok(!/ceramic ceramic/.test(prompt));
    assert.match(prompt, /his ceramic coffee cup/);
});

await test('parseDirect retries once with the problems listed, then returns the fixed answer and the summed usage', async () => {
    const calls = [];
    const first = answer([frame({ moment: 'Short.' })]);
    const second = answer([frame()]);
    const ctx = {};
    const replies = [{ content: first, usage: { promptTokens: 100, completionTokens: 50, cost: 0.001 } }, { content: second, usage: { promptTokens: 120, completionTokens: 60, cost: 0.002 } }];
    const out = await parseDirect(ctx, 'p1', 'Rowan holds out the letter.', { knownCast: CAST, knownSet: SET, userName: 'Sam', characterName: 'Narrator', requestJson: async (...args) => { calls.push(args); return replies[calls.length - 1]; } });
    assert.equal(calls.length, 2);
    assert.match(calls[1][2].at(-1).content, /"moment" has 1 words|has 1 words/);
    assert.equal(out.usage.promptTokens, 220);
    assert.equal(out.attempts.length, 2);
});

await test('parseDirect throws a visible error when the retry is still wrong', async () => {
    const bad = { content: answer([frame({ moment: 'Short.' })]), usage: { promptTokens: 1, completionTokens: 1, cost: 0 } };
    await assert.rejects(() => parseDirect({}, 'p1', 'x', { knownCast: CAST, knownSet: SET, userName: 'Sam', requestJson: async () => bad }), /problems/);
});

// ================================================================== closing (1.1): the scene, the state, sentence repair, gaze, owner

const LABELLED = [
    { label: 'the sleek travel mug', own: 'matte black ceramic' },
    { label: 'the designer sunglasses', own: 'black oversized' },
    { label: 'the high-rise underground garage', own: 'dim concrete' },
    { label: 'the voluptuous black-haired businesswoman', own: 'blue eyes and a pencil skirt' },
];

await test('sentence repair: adjectives in front of a swapped label move behind its article, words are said once', () => {
    const fix = (t) => repairLabelRuns(t, LABELLED);
    assert.equal(fix('Her sleek black the sleek travel mug rests there.'), 'Her sleek travel mug rests there.');
    assert.equal(fix('She slides modern oversized black the designer sunglasses onto her nose.'), 'She slides the modern designer sunglasses onto her nose.');
    assert.equal(fix('In the dim, cavernous the high-rise underground garage, a car waits.'), 'In the cavernous high-rise underground garage, a car waits.');
    assert.equal(fix('A stunned the voluptuous black-haired businesswoman stares.'), 'A stunned voluptuous black-haired businesswoman stares.');
    assert.equal(fix('He glares at angry the voluptuous black-haired businesswoman.'), 'He glares at the angry voluptuous black-haired businesswoman.');
    assert.equal(saidOnce('his ceramic ceramic cup'), 'his ceramic cup');
});

await test('sentence repair never touches a verb, a conjunction or a comma that ends a clause', () => {
    const fix = (t) => repairLabelRuns(t, LABELLED);
    for (const ok of [
        'They carry the sleek travel mug.',
        'She holds the sleek travel mug.',
        'She clutches her tote and the sleek travel mug, gesturing.',
        'The viewer looks at the voluptuous black-haired businesswoman standing there.',
        'Having flung the door open, the voluptuous black-haired businesswoman pauses.',
        'With poised authority, the sleek travel mug dangling from her wrist.',
    ]) assert.equal(fix(ok), ok, ok);
    // after a possessive the label's own article goes; an adjective the look does not say is kept
    assert.equal(fix('lifts the viewer\'s gray the sleek travel mug'), 'lifts the viewer\'s gray sleek travel mug');
    // idempotent
    const once = fix('Her sleek black the sleek travel mug rests, dim, cavernous the high-rise underground garage.');
    assert.equal(fix(once), once);
});

await test('sentence repair: every saved-answer style defect is gone from an assembled prompt (R4)', () => {
    const set = [...SET, { name: 'Travel Mug', kind: 'object', label: 'the sleek travel mug', look: 'matte black ceramic travel mug with a steel lid' }];
    const f = frame({ moment: 'Rowan clenches his sleek black Travel Mug in his right hand while Marta watches him closely, her sharp eyes narrowed, the lamps flickering softly over the counter and the rows of pewter mugs behind them.', shows: { people: [{ name: 'Rowan', parts: ['upper body'], looks_at: 'Marta' }, { name: 'Marta', parts: ['upper body'], looks_at: 'Rowan' }], objects: ['Travel Mug'], place: 'none' } });
    const { prompt } = assembleDirectFrame(f, { cast: CAST, setBook: set, presets, personaName: 'Sam' });
    assert.ok(!/black the|sleek black the|the sleek the|sleek sleek/.test(prompt), prompt);
    assert.match(prompt, /clenches his sleek travel mug in his right hand/);
});

await test('the guide carries the closing rules R4-R6, each with its failure and its test, and the schema asks for looks_at and outfit changes', () => {
    for (const id of ['R4-known-names', 'R5-owner-of-the-body-part', 'R6-camera-fields']) assert.ok(DIRECT_RULES.some((r) => r.id === id), id);
    const s = buildDirectSchema({});
    const person = s.properties.frames.items.properties.shows.properties.people.items;
    assert.deepEqual(person.required, ['name', 'parts', 'looks_at']);
    assert.deepEqual(s.properties.new_cast.items.required.slice(-3), ['outfit_changed', 'outfit_from_frame', 'same_as']);
    assert.match(DIRECT_GUIDE, /looks_at/);
    assert.ok(DIRECT_GUIDE.length < 6500, `the guide has ${DIRECT_GUIDE.length} characters`);
    assert.ok(!/anima|score_|never draw|do not draw/i.test(DIRECT_GUIDE));
});

await test('checkDirect: data errors stay errors; what the picture would lose is advice (gaze, owner, shot word); first person never lists the face', () => {
    const noGaze = frame({ shows: { people: [{ name: 'Rowan', parts: ['upper body'], looks_at: '' }, { name: 'Marta', parts: ['upper body'], looks_at: 'Rowan' }], objects: [], place: 'none' } });
    let r = checkDirect(answer([noGaze]), books);
    assert.deepEqual(r.problems, []);
    assert.match(r.advice.join('\n'), /say what Rowan looks at/);
    const owner = frame({ moment: 'Rowan holds the sealed letter out across the counter while Marta takes hold of the other end with one hand, both of them gripping the folded parchment and looking at each other closely.' });
    assert.match(checkDirect(answer([owner]), books).advice.join('\n'), /whose is "one hand"/);
    const fine = frame({ moment: 'Rowan holds the sealed letter out across the counter while Marta takes hold of the other end with her left hand, her right hand on the counter, both of them gripping the folded parchment and looking at each other.' });
    assert.deepEqual(checkDirect(answer([fine]), books).advice, []);
    const shot = frame({ moment: 'Close-up of Rowan holding the sealed letter out across the counter while Marta takes hold of the other end, both of them gripping the folded parchment and looking at each other closely.' });
    assert.match(checkDirect(answer([shot]), books).advice.join('\n'), /camera words belong only in "shot" and "angle"/);
    const pov = frame({ moment: 'Marta looks straight at the viewer while holding out her open palm for the sealed letter, her fingers spread, the lamps flickering above the beams and the rows of pewter mugs behind her on the counter.', shows: { people: [{ name: 'Sam', parts: ['face', 'hands'], looks_at: '' }, { name: 'Marta', parts: ['upper body'], looks_at: 'the camera' }], objects: [], place: 'none' } });
    assert.match(checkDirect(answer([pov]), { ...books, povMode: true }).problems.join('\n'), /first person: the player is the camera/);
    assert.deepEqual(checkDirect(answer([pov]), { ...books, povMode: false }).problems, []);
    assert.deepEqual(validateDirect(answer([noGaze]), books), [], 'validateDirect names data errors only');
});

await test('gaze: the reader\'s looks_at becomes a sentence only when the moment says nothing about eyes', () => {
    const silent = frame({ moment: 'Rowan holds the sealed letter out across the counter while Marta takes hold of the other end with her left hand, both of them gripping the folded parchment tightly between them.' });
    const a = assembleDirectFrame(silent, { cast: CAST, setBook: SET, presets, personaName: 'Sam' }).prompt;
    assert.match(a, /The tall young swordsman in the dark green cloak looks at the old innkeeper in the flour-dusted apron\./);
    assert.match(a, /The old innkeeper in the flour-dusted apron looks at the tall young swordsman in the dark green cloak\./);
    const said = frame();
    assert.ok(!/ looks at the (?:old|tall)/.test(assembleDirectFrame(said, { cast: CAST, setBook: SET, presets, personaName: 'Sam' }).prompt.replace(/looking at each other/g, '')), 'the moment already says it');
    const camera = frame({ moment: silent.moment, shows: { people: [{ name: 'Rowan', parts: ['face'], looks_at: 'the camera' }], objects: [], place: 'none' } });
    assert.match(assembleDirectFrame(camera, { cast: CAST, setBook: SET, presets, personaName: 'Sam' }).prompt, /looks straight at the viewer\./);
    const closed = frame({ moment: silent.moment, shows: { people: [{ name: 'Rowan', parts: ['face'], looks_at: 'eyes closed' }], objects: [], place: 'none' } });
    assert.match(assembleDirectFrame(closed, { cast: CAST, setBook: SET, presets, personaName: 'Sam' }).prompt, /'s eyes are closed\./);
    const away = frame({ moment: silent.moment, shows: { people: [{ name: 'Rowan', parts: ['face'], looks_at: 'away' }], objects: [], place: 'none' } });
    assert.match(assembleDirectFrame(away, { cast: CAST, setBook: SET, presets, personaName: 'Sam' }).prompt, /looks away\./);
    const hands = frame({ moment: silent.moment, shows: { people: [{ name: 'Rowan', parts: ['hands'], looks_at: 'Marta' }], objects: [], place: 'none' } });
    assert.ok(!/looks at/.test(assembleDirectFrame(hands, { cast: CAST, setBook: SET, presets, personaName: 'Sam' }).prompt), 'no face visible: no gaze sentence');
});

await test('style is separate from the model: the preset of the chosen prompt style is used; the player is an ordinary person when first person is off', () => {
    const tags = { natural: presets.natural, tags: { prefix: 'masterpiece', suffix: 'cel shading' } };
    const f = frame({ moment: 'Sam hands the sealed letter across the counter to Marta, who takes it with her right hand while Marta looks at him over the counter, the lamps flickering above the beams.', shows: { people: [{ name: 'Sam', parts: ['upper body'], looks_at: 'Marta' }, { name: 'Marta', parts: ['upper body'], looks_at: 'Sam' }], objects: [], place: 'none' } });
    const a = assembleDirectFrame(f, { cast: CAST, setBook: SET, presets: tags, style: 'tags', personaName: 'Sam', pov: false }).prompt;
    assert.ok(a.startsWith('masterpiece') && a.endsWith('cel shading'));
    assert.match(a, /the slim dark-haired student hands the sealed letter/i);
    assert.ok(!/the viewer/i.test(a));
    const b = assembleDirectFrame(f, { cast: CAST, setBook: SET, presets: tags, personaName: 'Sam' }).prompt;
    assert.ok(b.startsWith('masterpiece, best quality'), 'default style is natural');
    assert.match(b, /the viewer hands the sealed letter/i);
});

await test('a person who changes clothes in the reply wears the old clothes before the frame that shows the new ones', () => {
    const cast = mergeCast(CAST, [{ name: 'Rowan', sex: 'male', label: '', look: '', outfit: 'a white linen shirt and grey trousers', outfit_changed: true, outfit_from_beat: 2 }]);
    const f = frame({ moment: 'Rowan stands at the counter with his hands flat on the wood while Marta pours him a drink from a jug, the lamps flickering above the beams and the whole tavern quiet around them.', shows: { people: [{ name: 'Rowan', parts: ['whole body'], looks_at: 'Marta' }], objects: [], place: 'none' } });
    const early = assembleDirectFrame(f, { cast, setBook: SET, presets, personaName: 'Sam', frameIndex: 1 }).prompt;
    const late = assembleDirectFrame(f, { cast, setBook: SET, presets, personaName: 'Sam', frameIndex: 2 }).prompt;
    assert.match(early, /leather chest armour/);
    assert.match(late, /white linen shirt/);
    assert.ok(!/leather chest armour/.test(late));
});

await test('state: place, light and who holds what are kept; a state saved by the moment-cards planner is still read', () => {
    const s = cleanDirectState({ place: 'The Gilded Boar', light: 'lamplight', holding: [{ person: 'Rowan', object: 'sealed letter', hand: 'right hand' }, { person: '', object: 'x', hand: '' }, { person: 'Marta', object: 'jug', hand: 'weird' }] });
    assert.deepEqual(s.holding, [{ person: 'Rowan', object: 'sealed letter', hand: 'right hand' }, { person: 'Marta', object: 'jug', hand: '' }]);
    assert.equal(s.place, 'The Gilded Boar');
    assert.equal(formatDirectState(s), '- place: The Gilded Boar\n- light: lamplight\n- Rowan holds sealed letter (right hand)\n- Marta holds jug');
    assert.equal(cleanDirectState({ place: '', light: '', holding: [] }), null);
    const old = cleanDirectState({ objects: [{ object: 'phone', where: 'in Alex\'s left hand' }], spots: [{ person: 'Alex', spot: 'at the island' }], light: 'bright' });
    assert.match(formatDirectState(old), /phone: in Alex's left hand/);
    const chat = [{ extra: { manga: { scene: { state: { place: 'Cellar', light: 'dark', holding: [] } } } } }, { is_user: true }, {}];
    assert.equal(findKnownDirectState(chat, 2).place, 'Cellar');
    assert.equal(findKnownDirectState(chat, 0), null);
});

const REPLY = {
    frames: [
        frame({ new_panel: true, dialogue_indices: [0] }),
        frame({ moment: 'Marta tucks the sealed letter into her apron pocket with her right hand and wipes the counter with a cloth in her left while Rowan watches her closely, the lamps flickering above the rows of pewter mugs behind them.', shot: 'close-up', angle: 'low angle', emphasis: 'peak', new_panel: true, dialogue_indices: [1, 2], shows: { people: [{ name: 'Marta', parts: ['upper body'], looks_at: 'Rowan' }], objects: [], place: 'none' } }),
    ],
    dialogue: [{ line: 0, speaker: 'Rowan', bubble_type: 'speech', text: 'For you.' }, { line: 1, speaker: 'Marta', bubble_type: 'speech', text: 'At last.' }, { line: 2, speaker: 'Marta', bubble_type: 'thought', text: 'He is late.' }],
    new_cast: [{ name: 'Tess', sex: 'female', label: 'the red-haired barmaid', look: 'human, 22 years old, red hair', outfit: 'green dress', outfit_changed: false, outfit_from_frame: 0, same_as: '' }],
    new_places: [{ name: 'Cellar Door', kind: 'place', label: 'the cellar door', look: 'a low iron-banded door' }],
    state: { place: 'The Gilded Boar', light: 'warm lamplight', holding: [{ person: 'Marta', object: 'sealed letter', hand: 'right hand' }] },
};

await test('directToScene: one beat per frame as the reader wrote it, nothing added; the planner, the books and the balloons read it', () => {
    const scene = directToScene(REPLY, { knownCast: CAST, personaName: 'Sam' });
    assert.equal(sceneProblem(scene), null);
    assert.equal(scene.parserVersion, 6);
    assert.equal(scene.pipeline, 'direct');
    assert.equal(scene.beats.length, 2);
    assert.deepEqual(scene.beats[0].characters, ['Rowan', 'Marta']);
    assert.equal(scene.beats[1].intensity, 'peak');
    assert.equal(scene.beats[1].emphasis, 'main');
    assert.equal(scene.beats[0].direct.moment, REPLY.frames[0].moment);
    assert.deepEqual(scene.beats.map((b) => b.frameIndex), [0, 1]);
    assert.equal(scene.state.holding[0].object, 'sealed letter');
    assert.equal(scene.setting, 'The Gilded Boar');
    assert.deepEqual(scene.beats.map((b) => b.people), [[], []], 'no per-person poses are invented');
    // the continuity books read the scene exactly like an earlier planner's
    const chat = [{ extra: { manga: { scene } } }, { is_user: true, mes: 'x' }, {}];
    assert.ok(findKnownCast(chat, 2, CAST.slice(0, 1)).some((p) => p.name === 'Tess'));
    assert.ok(findKnownSet(chat, 2).some((e) => e.name === 'Cellar Door'));
    // the saved scene survives the chat file and plans the same way
    const saved = JSON.parse(JSON.stringify(scene));
    const plan = planPanels(saved, { maxPanels: 4, maxImages: 4, playerName: 'Sam', seed: 'x', fullBleedCooldown: 0, sinceFullBleed: Infinity, defaultSize: { width: 896, height: 1152 }, splitDialogueThreshold: 5 });
    const lines = plan.flatMap((p) => p.dialogue).sort();
    assert.deepEqual(lines, [0, 1, 2], 'every balloon exactly once');
    for (const step of plan) {
        const spec = step.spec;
        assert.ok(frameOfBeat(spec, step.camera), 'every planned step has a Direct frame to draw from');
    }
});

await test('the planned camera, not the reader\'s, is what the prompt says (lettering can widen a close-up)', () => {
    const scene = directToScene(REPLY, { knownCast: CAST, personaName: 'Sam' });
    const f = frameOfBeat(scene.beats[1], { shot: 'medium shot', angle: 'low angle' });
    const ctx = { cast: mergeCast(CAST, REPLY.new_cast), setBook: mergeSet(SET, REPLY.new_places), presets, personaName: 'Sam', frameIndex: 1 };
    const { prompt } = assembleDirectFrame(f, ctx);
    assert.match(prompt, /A medium shot\. Seen from a low angle\./);
    assert.ok(!/A close-up\./.test(prompt));
});

await test('redraw: a saved scene gives exactly the same prompts as the fresh one (no reader call, no randomness)', () => {
    const scene = directToScene(REPLY, { knownCast: CAST, personaName: 'Sam' });
    const saved = JSON.parse(JSON.stringify(scene));
    const ctx = { cast: uniqueLabels(mergeCast(CAST, REPLY.new_cast)), setBook: mergeSet(SET, REPLY.new_places), presets, personaName: 'Sam' };
    const prompts = (sc) => sc.beats.map((b) => assembleDirectFrame(frameOfBeat(b, b.camera), { ...ctx, frameIndex: b.frameIndex }).prompt);
    assert.deepEqual(prompts(saved), prompts(scene));
});

await test('directExpectation: the checker is told the figures, what happens and where each looks; the viewer\'s own hands are not a defect', () => {
    const scene = directToScene(REPLY, { knownCast: CAST, personaName: 'Sam' });
    const ctx = { cast: uniqueLabels(mergeCast(CAST, REPLY.new_cast)), setBook: mergeSet(SET, REPLY.new_places), personaName: 'Sam', pov: true };
    const e = directExpectation(scene.beats[0], scene.beats[0].camera, ctx);
    assert.match(e.text, /Main figures \(exactly 2\)/);
    assert.match(e.text, /What happens: The tall young swordsman in the dark green cloak holds the sealed letter/);
    assert.deepEqual(e.labels, ['the tall young swordsman in the dark green cloak', 'the old innkeeper in the flour-dusted apron']);
    assert.equal(e.gazes.length, 2);
    assert.match(e.text, /Gaze: "the tall young swordsman in the dark green cloak" must be looking at the face of "the old innkeeper/);
    assert.equal(e.kind, 'character');
    const own = frame({ moment: 'Sam holds out the sealed letter with his own hand toward Marta, who reaches over the counter to take it, her fingers closing on the folded parchment while she looks up at him.', shows: { people: [{ name: 'Sam', parts: ['hands'], looks_at: '' }, { name: 'Marta', parts: ['upper body'], looks_at: 'the camera' }], objects: [], place: 'none' } });
    const sc2 = directToScene({ ...REPLY, frames: [own], dialogue: [], state: null }, { knownCast: CAST, personaName: 'Sam' });
    const e2 = directExpectation(sc2.beats[0], sc2.beats[0].camera, ctx);
    assert.match(e2.text, /first-person view/);
    assert.match(e2.text, /Main figures \(exactly 1\)/);
    assert.deepEqual(e2.gazes, [{ label: 'the old innkeeper in the flour-dusted apron', target: 'the viewer' }]);
});

await test('the reader sees the state, the known cast and the known set of the earlier replies (continuity across replies)', () => {
    const scene = directToScene(REPLY, { knownCast: CAST, personaName: 'Sam' });
    const chat = [{ extra: { manga: { scene } } }, { is_user: true, mes: 'x' }, {}];
    const prompt = directUserPrompt('Rowan nods.', { characterName: 'Narrator', userName: 'Sam', knownCast: findKnownCast(chat, 2, CAST), knownSet: findKnownSet(chat, 2), knownState: findKnownDirectState(chat, 2) });
    assert.match(prompt, /- place: The Gilded Boar/);
    assert.match(prompt, /- Marta holds sealed letter \(right hand\)/);
    assert.match(prompt, /Tess/);
    assert.match(prompt, /Cellar Door/);
});

await test('parseDirect: advice alone asks for one retry; the retry is used when it is no worse; what remains is kept as a warning, never an error', async () => {
    const noGaze = answer([frame({ shows: { people: [{ name: 'Rowan', parts: ['upper body'], looks_at: '' }, { name: 'Marta', parts: ['upper body'], looks_at: 'Rowan' }], objects: [], place: 'none' } })]);
    const calls = [];
    const stubborn = async (...a) => { calls.push(a); return { content: noGaze, usage: { promptTokens: 10, completionTokens: 5, cost: 0.001 } }; };
    const out = await parseDirect({}, 'p', 'x', { knownCast: CAST, knownSet: SET, userName: 'Sam', requestJson: stubborn });
    assert.equal(calls.length, 2);
    assert.match(calls[1][2].at(-1).content, /say what Rowan looks at/);
    assert.equal(out.problems.length, 0);
    assert.equal(out.advice.length, 1);
    assert.equal(out.usage.promptTokens, 20);
    const scene = await parseDirectScene({}, 'p', 'x', { knownCast: CAST, knownSet: SET, userName: 'Sam', requestJson: stubborn });
    assert.equal(scene.warnings.length, 1);
    assert.equal(scene.__usage.promptTokens, 20);
    assert.ok(!Object.keys(scene).includes('__usage'));
    // a failing retry never throws away a first reading that only had advice
    let n2 = 0;
    const flaky = async () => { if (n2++) throw new Error('503'); return { content: noGaze, usage: { promptTokens: 10, completionTokens: 5, cost: 0.001 } }; };
    const warn = console.warn; console.warn = () => {};
    const kept = await parseDirect({}, 'p', 'x', { knownCast: CAST, knownSet: SET, userName: 'Sam', requestJson: flaky });
    console.warn = warn;
    assert.equal(kept.advice.length, 1);
    // ... but a first reading with a data error does
    let n3 = 0;
    const broken = async () => { if (n3++) throw new Error('503'); return { content: answer([frame({ moment: 'Short.' })]), usage: { promptTokens: 1, completionTokens: 1, cost: 0 } }; };
    await assert.rejects(() => parseDirect({}, 'p', 'x', { knownCast: CAST, knownSet: SET, userName: 'Sam', requestJson: broken }), /503/);
    // a retry that breaks something the first reading had right is not used
    let n4 = 0;
    const worse = async () => ({ content: n4++ ? answer([frame({ moment: 'Short.' })]) : noGaze, usage: { promptTokens: 1, completionTokens: 1, cost: 0 } });
    const first = await parseDirect({}, 'p', 'x', { knownCast: CAST, knownSet: SET, userName: 'Sam', requestJson: worse });
    assert.equal(first.problems.length, 0);
});

await test('a person named twice in one sentence: the repeated possessive becomes the pronoun', async () => {
    const people = [{ label: 'the old innkeeper', sex: 'female' }, { label: 'the tall swordsman', sex: 'male' }];
    const fix = (t) => repairLabelRuns(t, people);
    assert.equal(fix("The old innkeeper rests the old innkeeper's right hand on the counter while the old innkeeper's left hand holds the old innkeeper's apron."),
        'The old innkeeper rests her right hand on the counter while her left hand holds her apron.');
    // a different person of the other sex does not stop it
    assert.match(fix("The tall swordsman raises the tall swordsman's cup toward the old innkeeper."), /raises his cup toward the old innkeeper/);
    // one mention per sentence stays as it is
    assert.equal(fix("The old innkeeper's right hand rises. The old innkeeper's left hand rests."), "The old innkeeper's right hand rises. The old innkeeper's left hand rests.");
    // two people with the same pronoun: unclear who is meant, so nothing is guessed
    const two = [{ label: 'the old innkeeper', sex: 'female' }, { label: 'the young maid', sex: 'female' }];
    const same = "The young maid takes the old innkeeper's hand and the old innkeeper's apron.";
    assert.equal(repairLabelRuns(same, two), same);
});

await test('a bible outfit with an "alternatively" second outfit keeps the first only', async () => {
    assert.equal(oneOutfit('White silk blouse, black pencil skirt and a silver wristwatch; alternatively a deep red silk lounging robe tied at the waist'),
        'White silk blouse, black pencil skirt and a silver wristwatch');
    assert.equal(oneOutfit('grey hoodie, blue jeans, or sometimes a black coat'), 'grey hoodie, blue jeans');
    assert.equal(oneOutfit('dark green hooded cloak, leather armour'), 'dark green hooded cloak, leather armour');
    assert.equal(oneOutfit(''), '');
    // it applies to the world book's people and to every reply's people
    const cast = findKnownCast([], 0, [{ name: 'Anna', role: 'card', sex: 'female', label: 'the businesswoman', look: 'human, 35', outfit: 'white blouse; alternatively a red robe' }]);
    assert.equal(cast[0].outfit, 'white blouse');
});

console.log(`${n} tests passed`);
