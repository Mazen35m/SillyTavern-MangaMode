// Run: node tests/moment-cards.test.mjs - moment cards, scene state, camera by facts, prompt text hygiene (pure logic).
import assert from 'node:assert/strict';
import { buildSchema, systemPrompt, parseScene } from '../scene-parser.js';
import { compileFrame, contactCamera, effectiveCamera } from '../prompt-builder.js';
import { planPanels } from '../director.js';
import { readMoment, momentCamera, withoutMoments, findKnownState, formatKnownState, cleanState, placeOnce, withoutPlaceholderPossessives, newWords, withoutDoubledLabels } from '../moment-cards.js';
import { matchPlace } from '../set-book.js';
import { effectivePresets, resolveAdapter } from '../model-adapters.js';
import { getSettings } from '../settings.js';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

const CAST = [
    { name: 'Nora', sex: 'female', label: 'the black-haired corporate woman', look: 'adult woman, sleek shoulder-length black hair, blue eyes', outfit: 'white silk blouse, black pencil skirt', aliases: [] },
    { name: 'Alex', sex: 'male', label: 'the slim dark-haired young man', look: 'young man, short dark hair', outfit: 'black t-shirt, dark trousers', aliases: [] },
];
const SET = [{ name: 'Kitchen', kind: 'place', label: 'the high-rise kitchen', look: 'white marble island, steel cabinets, glass windows' }];
const CARD = {
    facts: ['Nora leans over the kitchen island toward the phone in the young man\'s hands.', 'He pulls the phone against his chest.'],
    needs: ['hands', 'both people'],
    holding: [{ person: 'Alex', object: 'a smartphone', hand: 'right hand' }, { person: 'Nora', object: 'a gold wristwatch pinched between two fingers', hand: 'left hand' }],
    spots: [{ person: 'Nora', spot: 'beside the refrigerator near the doorway' }],
    invented: ['a small smirk'],
};
const spec = (extra = {}) => ({
    kind: 'character', location: 'Kitchen', camera: { shot: 'close-up', angle: 'eye level' }, light: 'bright morning sun', view: 'the island and the windows',
    description: 'Nora leans toward the phone.', interaction: '', background: '',
    people: [{ name: 'Nora', side: 'left', action: 'leans forward, one hand on the counter', expression: 'narrowed eyes, teasing smile', gaze: 'the viewer' }],
    characters: ['Nora'], ...extra,
});
const ctx = (over = {}) => {
    const settings = getSettings({});
    return { style: 'natural', presets: effectivePresets(settings), adapter: resolveAdapter(settings), cast: CAST, setBook: SET, world: null, setting: 'the high-rise kitchen in bright morning sun', personaName: 'Alex', povMode: true, pipeline: 'moment', ...over };
};

await test('the reader asks for cards and a state only in the moment pipeline, and the classic request is unchanged', () => {
    const classic = buildSchema({});
    const moment = buildSchema({ moment: true });
    assert.equal(JSON.stringify(classic), JSON.stringify(buildSchema({ moment: false })));
    assert.ok(!('state' in classic.properties) && !('moment' in classic.properties.beats.items.properties));
    assert.ok('state' in moment.properties && moment.required.includes('state'));
    const beat = moment.properties.beats.items;
    assert.equal(Object.keys(beat.properties)[0], 'moment', 'the card is written before the frame fields');
    assert.ok(beat.required.includes('moment'));
    const card = beat.properties.moment;
    assert.deepEqual(card.required, ['facts', 'needs', 'holding', 'spots', 'invented']);
    assert.ok(card.properties.needs.items.enum.includes('both people'));
    assert.ok(!systemPrompt({}).includes('MOMENT CARDS') && systemPrompt({ moment: true }).includes('MOMENT CARDS'));
    // strict mode: every object lists all its properties as required
    const walk = (node) => { if (node?.type === 'object') { assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort()); assert.equal(node.additionalProperties, false); Object.values(node.properties).forEach(walk); } if (node?.items) walk(node.items); };
    walk(moment);
});

await test('a card is cleaned: four facts at most, needs from the list, nothing invented inside the facts', () => {
    const c = readMoment({ moment: { facts: ['a', 'b', 'c', 'd', 'e', 'f'], needs: ['hands', 'nonsense', 'HANDS'], holding: [{ person: 'x', object: '', hand: 'right hand' }, { person: 'Nora', object: 'mug', hand: 'weird' }], spots: [{ person: '', spot: 'x' }], invented: [] } });
    assert.equal(c.facts.length, 4);
    assert.deepEqual(c.needs, ['hands']);
    assert.deepEqual(c.holding, [{ person: 'Nora', object: 'mug', hand: 'other' }]);
    assert.deepEqual(c.spots, []);
    const d = readMoment({ moment: { facts: ['She smiles with a small smirk at him.', 'She takes the phone.'], needs: [], holding: [], spots: [], invented: ['a small smirk'] } });
    assert.deepEqual(d.facts, ['She takes the phone.'], 'a choice is never presented as a story fact');
    assert.equal(readMoment({ moment: { facts: [] } }), null);
    assert.equal(readMoment({}), null);
    assert.equal(readMoment(null), null);
});

await test('the camera is chosen by what shows the facts, and only ever widened', () => {
    const s = (needs, shot, kind = 'character') => ({ kind, moment: { facts: ['f'], needs, holding: [], spots: [], invented: [] } , camera: { shot } });
    assert.equal(momentCamera(s(['hands'], 'close-up'), { shot: 'close-up', angle: 'eye level' }).shot, 'medium shot');
    assert.equal(momentCamera(s(['both people'], 'extreme close-up'), { shot: 'extreme close-up', angle: 'pov' }).shot, 'medium shot');
    assert.equal(momentCamera(s(['whole body'], 'medium shot'), { shot: 'medium shot', angle: 'eye level' }).shot, 'full shot');
    assert.equal(momentCamera(s(['faces'], 'close-up'), { shot: 'close-up', angle: 'eye level' }).shot, 'close-up', 'a face the story wants close stays close');
    assert.equal(momentCamera(s(['hands'], 'wide shot'), { shot: 'wide shot', angle: 'eye level' }).shot, 'wide shot', 'never narrowed');
    assert.equal(momentCamera(s(['hands'], 'close-up', 'insert'), { shot: 'close-up' }).shot, 'close-up', 'an insert was chosen on purpose');
    const noCard = { kind: 'character', camera: { shot: 'close-up' } };
    assert.deepEqual(momentCamera(noCard, { shot: 'close-up', angle: 'eye level' }), { shot: 'close-up', angle: 'eye level' });
    // the same decision reaches the drawing and the prompt
    const sp = spec({ moment: CARD });
    assert.equal(contactCamera(sp, sp.camera).shot, 'medium shot');
    assert.equal(effectiveCamera(sp, sp.camera).shot, 'medium shot');
});

await test('the prompt of a frame with a card says the facts, who holds what, and where people are', () => {
    const sp = spec({ moment: CARD, people: [spec().people[0], { name: 'Alex', side: 'right', action: 'steps back', expression: 'wary', gaze: 'Nora' }], characters: ['Nora', 'Alex'] });
    const text = compileFrame(sp, sp.camera, ctx({ povMode: false }))[0];
    assert.match(text, /The key moment, clearly visible: The black-haired corporate woman leans over the (high-rise )?kitchen island toward the phone in the (slim dark-haired )?young man's hands\./);
    assert.match(text, /He pulls the phone against his chest\./);
    assert.match(text, /He holds a smartphone in his right hand\./);
    assert.match(text, /She is beside the refrigerator near the doorway\./);
    const known = compileFrame({ ...sp, moment: { ...CARD, spots: [{ person: 'Nora', spot: 'at the kitchen island' }] } }, sp.camera, ctx({ povMode: false }))[0];
    assert.doesNotMatch(known, /She is at the kitchen island/, 'a spot the prompt already says is not repeated');
    assert.doesNotMatch(text, /small smirk/, 'invented details are not facts and are not in the key moment');
    // without a card (a storyboard from before cards) or in the classic pipeline: the old text
    const old = compileFrame({ ...sp, moment: undefined }, sp.camera, ctx({ povMode: false }))[0];
    const classic = compileFrame(sp, sp.camera, ctx({ povMode: false, pipeline: 'classic' }))[0];
    assert.doesNotMatch(old, /The key moment/);
    assert.doesNotMatch(classic, /The key moment/);
});

await test('the classic pipeline plans from a storyboard as if it had no cards', () => {
    const scene = { beats: [spec({ moment: CARD, new_panel: true })] };
    assert.ok(!('moment' in withoutMoments(scene).beats[0]));
    assert.ok('moment' in scene.beats[0], 'the saved storyboard keeps its cards');
    assert.equal(withoutMoments({ beats: [{ a: 1 }] }).beats[0].a, 1);
});

await test('a first-person insert of the player\'s hands says what they hold', () => {
    const sp = spec({ kind: 'insert', camera: { shot: 'close-up', angle: 'pov' }, people: [{ name: 'Alex', side: 'center', action: 'holds out a mug', expression: '', gaze: '' }], characters: ['Alex'], location: 'Kitchen',
        moment: { facts: ['He holds out the mug.'], needs: ['hands', 'an object'], holding: [{ person: 'Alex', object: 'a steel travel mug', hand: 'right hand' }, { person: 'Alex', object: 'a set of car keys', hand: 'left hand' }], spots: [], invented: [] } });
    const text = compileFrame(sp, sp.camera, ctx())[0];
    assert.match(text, /The viewer's hands hold a steel travel mug in the right hand and a set of car keys in the left hand\./);
});

await test('the place is said once, and "someone\'s" is not left in a sentence', () => {
    assert.equal(placeOnce('the modern apartment foyer: polished floor, white recessed spotlights', 'the modern apartment foyer in the morning under bright recessed ceiling lights', 'clean white ceiling spotlights and morning daylight'), 'in the morning under bright recessed ceiling lights');
    assert.equal(placeOnce('the luxury high-rise kitchen: White marble', 'Modern luxury the luxury high-rise kitchen in bright morning sunlight', 'crisp morning sunlight'), '');
    assert.equal(placeOnce('the cafe: bricks', '', ''), '');
    assert.equal(withoutPlaceholderPossessives("taps the watch on someone's wrist", 'her'), 'taps the watch on her wrist');
    assert.equal(withoutPlaceholderPossessives("taps the watch on someone's wrist", null), 'taps the watch on the wrist');
    assert.equal(withoutPlaceholderPossessives("holds someone's phone"), 'holds a phone');
    const sp = spec({ moment: undefined, description: "Nora taps the watch on someone's wrist." });
    assert.doesNotMatch(compileFrame(sp, sp.camera, ctx())[0], /someone's/i);
    const classic = compileFrame(sp, sp.camera, ctx({ pipeline: 'classic' }))[0];
    assert.match(classic, /someone's|wrist/i, 'classic wording is untouched');
    const place = compileFrame(spec({ moment: undefined }), { shot: 'medium shot', angle: 'eye level' }, ctx({ setting: 'the high-rise kitchen in bright morning sun', cast: CAST }))[0];
    assert.equal((place.match(/high-rise kitchen/g) || []).length, 1, 'one mention of the place');
});

await test('the scene state is carried from reply to reply', () => {
    const state = { objects: [{ object: 'phone', where: 'held by Alex, right hand' }, { object: 'travel mug', where: 'on the sink' }], spots: [{ person: 'Nora', spot: 'at the front door' }], light: 'bright morning sun' };
    assert.deepEqual(cleanState(state), state);
    assert.equal(cleanState({}), null);
    assert.equal(cleanState({ objects: [{ object: '', where: 'x' }], spots: [], light: '' }), null);
    const chat = [{ extra: { manga: { scene: { state } } } }, { mes: 'user' }, { extra: { manga: { scene: {} } } }, { mes: 'user again' }];
    assert.deepEqual(findKnownState(chat, 3), state, 'the last earlier reply that had a state');
    assert.equal(findKnownState(chat, 0), null);
    assert.match(formatKnownState(state), /- phone: held by Alex, right hand\n- travel mug: on the sink\n- Nora is at the front door\n- light: bright morning sun/);
    assert.equal(formatKnownState(null), '');
});

await test('parsing with cards: the request carries the schema, the rules and the state; the scene keeps both', async () => {
    const sent = [];
    const answer = {
        storyboard: 'x', setting: 'kitchen', cast: [], places: [], dialogue: [],
        beats: [{ moment: CARD, new_panel: true, emphasis: 'main', kind: 'character', location: '', camera: { shot: 'close-up', angle: 'eye level' }, light: 'sun', view: 'island', description: 'x', interaction: '', background: '', people: [{ name: 'Nora', side: 'left', action: 'a', expression: 'e', gaze: 'the viewer' }], dialogue_indices: [], intensity: 'calm', same_moment: false, sfx: '' }],
        state: { objects: [{ object: 'phone', where: 'held by Alex' }], spots: [], light: 'sun' },
    };
    const fake = { extensionSettings: {}, ConnectionManagerRequestService: { sendRequest: async (id, messages, max, opts, override) => { sent.push({ messages, schema: override.json_schema.value }); return { choices: [{ message: { content: JSON.stringify(answer) } }] }; } } };
    const scene = await parseScene(fake, 'p', 'Nora leans over.', { characterName: 'Nora', userName: 'Alex', knownCast: CAST, knownSet: SET, world: null, moment: true, knownState: { objects: [{ object: 'travel mug', where: 'on the sink' }], spots: [], light: '' } });
    const [call] = sent;
    assert.match(String(call.messages[0].content), /MOMENT CARDS/);
    assert.match(call.messages[1].content, /STATE \(how the previous reply ended[\s\S]*travel mug: on the sink/);
    assert.ok(call.schema.properties.state);
    assert.equal(scene.parserVersion, 5);
    assert.deepEqual(scene.beats[0].moment.facts, CARD.facts);
    assert.deepEqual(scene.state.objects, [{ object: 'phone', where: 'held by Alex' }]);
    // classic
    sent.length = 0;
    const classic = await parseScene(fake, 'p', 'Nora leans over.', { characterName: 'Nora', userName: 'Alex', knownCast: CAST, knownSet: SET, world: null });
    assert.doesNotMatch(String(sent[0].messages[0].content), /MOMENT CARDS/);
    assert.ok(!sent[0].schema.properties.state);
    assert.equal(classic.parserVersion, 4);
});

await test('a card widens the planned shot: a hand gesture asked as a close-up is planned as a medium shot', () => {
    const scene = { setting: 'kitchen', cast: [], beats: [{ ...spec({ moment: CARD }), new_panel: true, emphasis: 'main', dialogue_indices: [], intensity: 'calm', same_moment: false, sfx: '' }], dialogue: [], characters: [{ name: 'Nora', count_tag: '1girl', screen_position: 'left' }] };
    const plan = planPanels(scene, { playerName: 'Alex' });
    assert.equal(plan[0].camera.shot, 'medium shot');
    const classic = planPanels(withoutMoments(scene), { playerName: 'Alex' });
    assert.equal(classic[0].camera.shot, 'close-up', 'without the card the director\'s shot stands');
    assert.ok(newWords('a b c', 'a') >= 0);
});

await test('a location the reader did not list is not matched to another place on one shared word', () => {
    const book = [{ name: 'Luxury High-Rise Kitchen', kind: 'place', label: 'the high-rise kitchen', look: 'white marble island, steel cabinets' }, { name: 'Volvo Interior', kind: 'place', label: 'the car interior', look: 'black leather seats' }];
    assert.equal(matchPlace('Sleek Luxury Volvo', book, { strict: true })?.name, 'Volvo Interior', 'half of the entry name is shared');
    assert.equal(matchPlace('Sleek Luxury Volvo', [book[0]], { strict: true }), null, 'one word of three, one word of four: not the kitchen');
    assert.equal(matchPlace('Sleek Luxury Volvo', [book[0]])?.name, 'Luxury High-Rise Kitchen', 'classic matching is unchanged');
    assert.equal(matchPlace('Kitchen', [book[0]], { strict: true })?.name, 'Luxury High-Rise Kitchen', 'a short name inside a long entry still matches');
    const audiObject = { name: 'Sleek Luxury Volvo', kind: 'object', label: 'the sedan', look: 'dark grey Volvo sedan with black leather interior' };
    assert.equal(matchPlace('Sleek Luxury Volvo', [book[0], audiObject], { strict: true })?.name, 'Sleek Luxury Volvo', 'an object used as a location by its exact name is that place');
    assert.equal(matchPlace('Sleek Luxury Volvo', [book[0], audiObject])?.name, 'Luxury High-Rise Kitchen', 'classic matching is unchanged');
    const car = spec({ location: 'Sleek Luxury Volvo', moment: undefined, view: 'the windshield and the garage ramp' });
    const text = compileFrame(car, car.camera, ctx({ setBook: [book[0]], setting: 'Inside a luxury car cockpit leaving a dim garage' }))[0];
    assert.doesNotMatch(text, /marble|kitchen|island/i, 'the kitchen does not leak into the car');
    assert.match(text, /Setting: Sleek Luxury Volvo, inside a luxury car cockpit/);
});

await test('an object named twice (the reader\'s words and its label) is named once', () => {
    const mug = { name: 'Travel Mug', kind: 'object', label: 'the sleek travel mug', look: 'Matte black stainless steel travel coffee mug with a brushed silver rim' };
    assert.equal(withoutDoubledLabels('A hand pushes the matte black the sleek travel mug across the marble.', [mug]), 'A hand pushes the sleek travel mug across the marble.');
    assert.equal(withoutDoubledLabels('He holds the stainless steel the sleek travel mug.', [mug]), 'He holds the sleek travel mug.');
    assert.equal(withoutDoubledLabels('She taps the lid of the sleek travel mug.', [mug]), 'She taps the lid of the sleek travel mug.', 'a label alone is untouched');
    assert.equal(withoutDoubledLabels('The cold the sleek travel mug.', [mug]), 'The cold the sleek travel mug.', 'words that are not the object\'s own are not removed');
});

console.log(`${n} tests passed`);
