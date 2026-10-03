// The scene director: turns one finished roleplay reply into a storyboard of manhwa frames.
//
// One structured call. The model first writes a short storyboard in plain prose - how a manhwa
// artist would picture the reply, moment by moment - and only then fills the frames from it
// (the schema asks for "storyboard" first, and the answer is generated in schema order). It reads
// the story's world book (world-book.js), its cast book (cast-book.js) and set book (set-book.js),
// so every person, place and object keeps one look for the whole story. Nothing about a story's
// look is written in this file: only how to read a reply and how a manga page is built.
import { requestJson } from './llm-request.js';
import { extractSpeechLines, formatSpeechLines, resolveDialogueRefs } from './dialogue-lines.js';
import { formatKnownSet } from './set-book.js';
import { formatKnownCast } from './cast-book.js';
import { formatWorld } from './world-book.js';
import { findPerson, sameName, mergeCast, uniqueLabels } from './cast-book.js';
import { samePlace } from './director.js';
import { FAR_WORDS, FOREGROUND_WORDS, LOOK_WORDS, UP, clausesOf, sentencesOf, postureOf, postureWords, withoutCameraClause } from './text-rules.js';

export const PARSER_TIMEOUT_MS = 120000;

const CAMERA = {
    type: 'object',
    properties: {
        shot: { type: 'string', enum: ['extreme close-up', 'close-up', 'medium shot', 'full shot', 'wide shot'] },
        angle: { type: 'string', enum: ['eye level', 'low angle', 'high angle', 'over the shoulder', 'pov', 'top-down view', 'ground-level view', 'dutch angle', 'from behind', 'profile view', 'through foreground'] },
    },
    required: ['shot', 'angle'],
    additionalProperties: false,
};

/** The answer's shape. Built per call: the balloon budget and thoughts change it. */
export function buildSchema({ maxImages = 10, innerThoughts = true } = {}) {
    const bubbleTypes = ['speech', 'shout', 'thought', 'narration', 'none', ...(innerThoughts ? ['inner'] : [])];
    const person = {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'Exactly as in "cast".' },
            side: { type: 'string', enum: ['left', 'center', 'right'], description: 'Where they stand in this frame.' },
            action: { type: 'string', description: 'Their ONE visible pose / what their body and hands do in this frame.' },
            expression: { type: 'string', description: 'Their face, in manga terms: 3-5 concrete visible signs of the feeling (brows, eyes, mouth, jaw, blush, sweat, tears, shadow over the eyes), never only the feeling word. For angle "from behind": the mood as the posture shows it.' },
            gaze: { type: 'string', description: 'WHO or WHAT the eyes are on: "the viewer" (eye contact with the player), another person in this frame by name, or a thing or place. While someone talks with, listens to or reacts to another person who is DRAWN in this frame, it is that person - never the cup, menu, phone or other thing in their hands. When the other person is the player (not drawn), eye contact is a beat, not a default: someone busy looks at their task, someone thinking or embarrassed looks away or past the viewer, someone angry or determined holds the look. A thing or place when the text says the look goes to it.' },
        },
        required: ['name', 'side', 'action', 'expression', 'gaze'],
        additionalProperties: false,
    };
    const beat = {
        type: 'object',
        properties: {
            new_panel: { type: 'boolean' },
            emphasis: { type: 'string', enum: ['main', 'normal', 'minor'] },
            kind: { type: 'string', enum: ['character', 'establishing', 'insert'] },
            location: { type: 'string', description: 'Set-book name of the place; empty = same as the frame before.' },
            camera: CAMERA,
            light: { type: 'string', description: 'The light of THIS frame in a short plain phrase: the hour or weather, the source, how bright, its colour - "dim blue moonlight through fog", "warm lamplight with deep shadows in the corners", "hard white noon sun", "only a phone flashlight in a dark room". Dark when the story is dark (night, a blackout, a cellar, a storm). The same light in every frame of one place unless the story changes it.' },
            view: { type: 'string', description: 'Which part of the place fills the background of THIS frame and what in it is lit or moving: a doorway, a window with rain on it, shelves, the street beyond, a lamp, steam. A short plain phrase, different from the frame before when the place allows it. "" for an insert.' },
            description: { type: 'string', description: 'One or two plain visual sentences: what happens in this frame. Names allowed; no clothing or hair; no speech verbs; no camera words (the camera field says how it is seen); only what is there, never what is absent or not happening.' },
            interaction: { type: 'string', description: 'When people connect in this frame (giving, taking, paying, holding the same thing, touching, grabbing, fighting): ONE concrete sentence of the contact - whose hand does what, where the hands and the object meet, the object as the text gives it (material, colour, count). "" when nobody connects (see INTERACTIONS).' },
            background: { type: 'string', description: 'Everyone else visible FURTHER BACK than the main figures (crowd, patrons, onlookers), each with how far away they are ("across the room", "in the distance") and what they do, or "" if nobody else is there. Never the person a main figure talks to, looks at or sits with.' },
            people: { type: 'array', items: person, description: 'The main figures of this frame (at most 3), including the person they talk to, sit with or touch whenever that person is in view. An insert: EVERY person whose hands are shown (both people in a hand-over). Empty for an empty establishing view.' },
            dialogue_indices: { type: 'array', items: { type: 'integer' } },
            intensity: { type: 'string', enum: ['calm', 'tense', 'peak'] },
            same_moment: { type: 'boolean' },
            sfx: { type: 'string' },
        },
        required: ['new_panel', 'emphasis', 'kind', 'location', 'camera', 'light', 'view', 'description', 'interaction', 'background', 'people', 'dialogue_indices', 'intensity', 'same_moment', 'sfx'],
        additionalProperties: false,
    };
    return {
        type: 'object',
        properties: {
            storyboard: { type: 'string', description: 'FIRST: how a manhwa artist pictures this reply, moment by moment (see STORYBOARD).' },
            setting: { type: 'string', description: 'The reply\'s main location as a short visual phrase with the time of day and light. No names.' },
            cast: {
                type: 'array',
                description: 'Every person drawn in any frame, once each (see PEOPLE).',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        sex: { type: 'string', enum: ['male', 'female', 'other'] },
                        label: { type: 'string', description: 'New people only: a short unique visual handle with no name in it. Known people: "".' },
                        look: { type: 'string', description: 'New people only: permanent look - only what they have, never what they lack ("no scars"). Known people: "".' },
                        outfit: { type: 'string', description: 'New people: full outfit. Known people: the new outfit only if this reply changes it, else "".' },
                        outfit_changed: { type: 'boolean' },
                        outfit_from_beat: { type: 'integer', description: 'Known people whose outfit changes in this reply: the 0-based position, in your beats list, of the FIRST beat that shows the new outfit (earlier beats show the old one). 0 when the new outfit is worn from the start of the reply or the outfit did not change.' },
                        same_as: { type: 'string', description: 'When this is someone the known cast lists under another name (a guard now called by his name), that known name; else "".' },
                    },
                    required: ['name', 'sex', 'label', 'look', 'outfit', 'outfit_changed', 'outfit_from_beat', 'same_as'],
                    additionalProperties: false,
                },
            },
            places: {
                type: 'array',
                description: 'Places and recurring objects shown that are NOT in the known set, each once.',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        kind: { type: 'string', enum: ['place', 'object'] },
                        label: { type: 'string', description: 'What it is, with no name in it ("the tavern", "the market street", "the old sword").' },
                        look: { type: 'string', description: '12-30 words of fixed visual facts: materials, colours, shapes, layout. No people, weather or time of day.' },
                    },
                    required: ['name', 'kind', 'label', 'look'],
                    additionalProperties: false,
                },
            },
            dialogue: {
                type: 'array',
                description: 'Every numbered balloon once, in order, plus any line not in the list (see DIALOGUE).',
                items: {
                    type: 'object',
                    properties: {
                        line: { type: 'integer', description: 'The balloon number, or -1 for a line not in the list.' },
                        speaker: { type: 'string' },
                        bubble_type: { type: 'string', enum: bubbleTypes },
                        text: { type: 'string', description: 'Empty for a numbered balloon; the words of a line not in the list.' },
                    },
                    required: ['line', 'speaker', 'bubble_type', 'text'],
                    additionalProperties: false,
                },
            },
            beats: { type: 'array', items: beat, description: `The frames, in reading order. At most ${maxImages}.` },
        },
        required: ['storyboard', 'setting', 'cast', 'places', 'dialogue', 'beats'],
        additionalProperties: false,
    };
}

export function systemPrompt({ maxPanels = 6, maxImages = 10, innerThoughts = true, povMode = false } = {}) {
    return `You are the storyboard artist of a manhwa (webtoon) adaptation of an interactive story. You receive ONE reply that a roleplay AI already wrote, and you plan how that reply is drawn: which moments get a frame, who is in each frame, what they do, and how the camera sees it. You never write story, never continue it and never change what happens.

STORYBOARD (write it first, in "storyboard")
- 4-10 plain sentences, before anything else. Picture the reply as a reader would: the place and its life, every visible moment in order, who stands where, the emotional high point, and what the player does or says in their own message (the CONTEXT block). Decide which moments get a frame and why. Then fill every other field from this storyboard.

FAITHFUL TO THE TEXT
- Draw exactly what the text states or clearly implies. Never escalate ("rests both hands flat on the table" is resting, not slamming), never add a gesture, action or prop the text does not give, never soften or leave out what it does give.
- The surroundings are part of the story: crowds, onlookers moving away, patrons, animals, weather, light, props. Put the people around the main figures in "background" whenever the text has them there.
- Clothes and gear stay as they are until the text changes them: armour stays on, a sword stays at the hip, a hood stays up. The player's own clothes change only when a message shows the player changing them.
- "action", "expression" and "description" mention clothing only as the person's outfit states it (no visor on an open-face helmet, no cloak that is not in the outfit).

PEOPLE
- The known cast (below) lists everyone already drawn in this story, with a fixed label, look and outfit. Use those names exactly. Do not re-describe them: "label" and "look" stay "", "outfit" is filled only when this reply changes what they wear (then "outfit_changed" is true). When the change happens in the middle of the reply, "outfit_from_beat" is the 0-based position of the first beat that shows the new outfit; the beats before it keep the old one.
- When the reply names someone the known cast already has under a descriptive name (the "off-duty guard" is now "Guard Roland"), it is the same person: put them in "cast" under the new name with "same_as" set to the known name, and leave label/look/outfit "" unless the outfit changed.
- Every person who appears in a frame and is NOT in the known cast is added to "cast" once, with:
  - "name": the text's name for them, or a short descriptive name if unnamed ("Wolf-eared Grocer").
  - "label": a short visual handle with no name in it, unique in the whole cast, made from what always stays true of them - their body, face, hair, species and role, never a pose, a passing state or clothes that can come off ("the grey-bearded watchman", "the wolf-eared old grocer"; not "the leaning guard", not "the guard in a steel breastplate").
  - "look": species/people (drawn the way the world book says), apparent age, build, face, hair, eyes, skin, permanent marks - what the text states, and where it is silent a choice that fits this world, committed to.
  - "outfit": what they wear now, from the text; where the text is silent, what a person of their role wears in this world (see "How people dress here"). One concrete colour per garment; armour, weapons and gear included.
- Draw every person at the age the text gives them; never make anyone look younger than the text says.

FRAMES ("beats")
- ONE FRAME PER VISUAL MOMENT, in reading order: every sentence of narration that shows something new (a gesture, a glance, a reaction, someone arriving, the crowd reacting) is a frame. A long reply usually needs 6-10 frames; a short one 1-3. At most ${maxImages} frames.
- The player: the FIRST frame shows what the player's own message does. When the player's message is a statement, decision, offer or threat that drives the scene, give the player a frame of their own saying it (face and gesture; the player's words are never lettered, so no balloon).
- "new_panel": true starts a new panel; false adds the frame to the panel before it. A continuous exchange in one place is ONE panel of 3-5 frames; a single-frame panel is for a big moment or a new place. At most ${maxPanels} panels. The first frame always has "new_panel": true. One "main" (drawn biggest) per panel; "minor" for a small reaction or detail frame.
- "kind": "character" when people are the subject; "establishing" when the PLACE is the subject (arriving, a new place, time passing, the text dwelling on the surroundings) - the people in it are small, in "background" or "people"; "insert" for a close-up of hands or an object that matters.
- CAMERA like a manhwa director, not like a news broadcast. Two fields: "shot" (how far) and "angle" (where the camera stands and how it is tilted).
  SHOT: extreme close-up for eyes, a mouth, a trembling hand; close-up for a face reaction; medium shot for gestures and talking; full shot for anything about legs or feet (running, skidding, kicking, kneeling, falling, walking away) and whole-body poses; wide shot for where people stand, the crowd and the place.
  ANGLE - each has a job, pick the one that serves the feeling of the moment: "eye level" (calm, ordinary); "low angle" (power, threat, pride, someone towering); "high angle" (smallness, shyness, fear, defeat); "ground-level view" (extreme low: a fall, a stomp, a looming figure, a dramatic entrance); "top-down view" (a map-like look at a crowd, a table, a fight, a person alone in a big space); "dutch angle" (tilted horizon: unease, a lie, a threat, dizziness - at most once per reply); "from behind" (the person's back to the viewer: walking away, facing a view, hiding a reaction, entering a place - the face is not seen, so \"expression\" is the mood of the posture); "profile view" (a person seen from the side: thinking, looking out of a window, a quiet moment, speaking to someone beside the viewer); "through foreground" (shot past a doorway, plant, railing, shelf or hand in the foreground, like a witness: hesitation, eavesdropping, distance between people); \"over the shoulder\" and \"pov\" as described below.
  VARIETY IS REQUIRED. In a reply of 3 or more frames use at least 3 different shot sizes or angles, never the same shot size three times in a row, and in a reply of 4 or more frames at least one frame is NOT a face looking at the viewer: a from-behind or profile shot, a reaction of someone else, a wide shot where the people are part of the place, or - sparingly - an establishing view or an insert. A good page of manhwa breathes: close, then wide, then a face.
  PEOPLE STAY THE HEART OF THE PAGE: at least half of the frames of a reply show a person (kind \"character\"). Establishing views and inserts TOGETHER are at most one frame in three (two in a reply of 6 or more), never two in a row. Only a reply in which nobody but the player is present may lean on the place. When the reply has another character, that character is drawn in most frames - reacting, talking, moving - not replaced by their hands, their feet or the scenery they stand in.
  INSERTS are only for a hand or object the text dwells on (a letter, a weapon, a coin, a door handle). Never an insert of the player's own feet, legs or body. Never an insert of hands doing something that needs a whole body (lifting, carrying, climbing, running): draw that person at medium distance instead.
  EVERY FRAME HAS ITS OWN BACKGROUND ("view"): one place is never the same picture twice. Say which part of it this frame looks at - the door end of a hall, a window with the evening outside, the shelf above the stove, the street behind a gate - and what is lit or moving there. Turn the camera inside the place from frame to frame instead of repeating the view that the whole place description gives.
  LIGHT ("light"): every frame says what it is lit by - the hour or weather, the source, how bright, its colour. The light follows the story: night, a blackout, a cellar, a storm, a single candle or phone flashlight are DARK and low-key (say "dark", "dim", "deep shadows" plainly); a sunny morning is bright. Keep the same light in every frame of one place and change it only when the story does (a lamp lit, a door opened onto daylight). The mood of the scene is carried by its light as much as by faces.
  THE PLACE LIVES: when the reply starts a scene, changes place, or the text dwells on weather, light, noise, a crowd, a street or the details of a room, give it ONE frame of its own (kind \"establishing\", people small) that shows what moves there - people passing, steam, rain, a cat on a wall, curtains in the wind - and let the later frames keep that light and those props.
- "people": the main figures of the frame (at most 3), each with "side", ONE clear pose in "action", a face in "expression", and "gaze". For a frame with ONE person vary "side" like a photographer: "left" or "right" puts the figure in that third of the picture and leaves open space on the other side, room for what they look at or move toward; "center" is for a confrontation or a portrait. Never the same side three frames in a row. Follow the text exactly for who looks at whom. When a character looks at the player and the player is not in the frame, their gaze is "the viewer" (the reader is the player). Camera angle "pov" = through the player's eyes (the player is not in "people"); "over the shoulder" = the player seen from behind in the foreground (the player IS in "people").
- ACTING: a feeling is shown, never just named. The face MOVES from frame to frame: the same person never gets the same expression in two frames in a row - a smile grows, falters, turns shy or sharp; surprise becomes worry; the body changes with it. "expression" lists 3-5 visible signs of THIS emotion in THIS person (brows, eyes, mouth, jaw, blush, sweat, tears, a shadow over the eyes), and "action" carries the body (posture, hands, distance, what they do with what they hold). Resentment is lowered brows, a sidelong glare, a set jaw, a thin mouth, hunched shoulders, white knuckles on a mug; shyness is a lowered chin, eyes sliding aside, a hand at the neck; contempt is one raised brow, a half-smile, a tilted head; grief is a slack mouth, wet eyes, arms drawn in. The more the text says about a feeling, the more the frame shows it, and the people around react to it (a hush, a step back, eyes turned away).
- EYE CONTACT IS A BEAT, NOT A DEFAULT. When the text says where someone looks, follow it. Where it is silent and the other person is the player (not drawn), vary the gaze like a real person: someone who talks while busy (carrying, cooking, drawing, fixing, walking) looks at what they do and glances up; someone remembering, thinking or embarrassed looks away, down or past the viewer; someone angry, determined or flirting holds the look. Use "the viewer" in at most about half of the frames of one person; otherwise name the thing or place the eyes are on. (When the other person is drawn in the frame, GAZE AND SPACE below applies: they look at each other's faces.)
- WHO IS NEAR IS A MAIN FIGURE: the person a main figure talks to, sits across from, stands next to or touches is in "people" whenever the camera can see them - never in "background". "background" is only for people further back, with how far ("in the distance", "across the room").
- POSTURE: say it in "action" in every frame - people sitting at a table stay seated ("still sitting on the chair, leaning forward") until the text has them stand up.
- WRITE ONLY WHAT IS THERE: the image model draws every thing a sentence names, so never write what is absent or does not happen ("no scars", "without looking", "not holding anything"): write what is visible instead.
- GAZE AND SPACE: two people who talk, argue or react to each other look at EACH OTHER'S FACES, even while their hands handle something (pouring, holding a cup, reading a menu): the object goes in "action", the eyes go to the person in "gaze". Somebody who is not in "people" or "background" of this frame is never mentioned in "description", "action" or "interaction" (the picture would draw them) - write what happens to the people who ARE in it. Put people who talk in one open space: never describe a wall, pillar, door frame, window or panel between them unless the text places one there.
- "background": everyone else visible in this frame and what they do, or "" when nobody else is there.
- INTERACTIONS: a moment where people connect through touch or an object (giving, taking, paying, handing over, holding the same thing, shaking hands, grabbing, pushing, striking) is ONE frame that shows BOTH sides of the contact: a medium shot of both people seen from the side, or an insert with both people's hands on the object. Never split it into two frames of one person each, and never use a face close-up for it (a close-up is cut to the face, so hands and objects are lost). Fill "interaction" with the contact in one sentence ("the merchant's fingers close over the three silver coins lying on the traveller's open palm"; "both of them hold the sealed letter, the old woman's grip not letting go yet").
- SHOW WHAT IS LOOKED AT: when the text dwells on something a character looks at or inspects (strange clothes or shoes, a wound, a weapon, coins, a letter, a mark on someone), follow their reaction with an insert of that thing as they see it - the reader must see what surprised them. When the thing is on the player, the insert shows that part of the player (their shoes and trousers, their empty hands) with no face.
- ONLOOKERS: people who stop to watch the main action (passers-by, a guard observing, companions reacting) are drawn watching it - seen from behind or from the side with the person they watch further away, or in "background" behind the main figures - never lined up facing the viewer like a group photo. Their "gaze" is the person they watch; a puzzled, suspicious or startled onlooker gets a manga reaction mark in "sfx" ("?", "?!", "!", "...").
- SHOW FEELINGS AS BODY: a feeling the text gives (hesitating, reluctant, nervous, suspicious, proud, ashamed) becomes something the picture shows in that frame - a grip that does not let go, white knuckles, a hand pulled back, a sidelong glance, a forced smile, shoulders drawn up, a step back. Put it in "action" and "expression", never only in words like "hesitantly".
- OBJECTS keep what the text says about them - material, colour, count, size ("three silver coins", never "gold coins"; "a sealed letter", never "a book").
- "description": one or two plain visual sentences, present tense. No clothing or hair (the cast has them). No speech verbs (says, asks, tells, shouts, whispers, talking, conversation): describe the open mouth, the face, the gesture instead - speech is lettered later. No camera words ("seen past his shoulder", "from behind") - "camera" says how the frame is seen.
- Printed things (a newspaper, a sign, a letter, a screen) are drawn as objects: say what they look like, never what they read - the image model cannot letter, so the picture must not need readable text.
- "sfx": a short sound effect or reaction mark for a sound or jolt in the text ("THUD", "clatter", "?!"), else "". "intensity": "peak" only for a first appearance, a decisive blow, a death or an emotional climax. "same_moment": true only for a closer view of the very same instant as the frame before.
- "location": the set-book name of the place (known, or one you add to "places"); "" when it is the same place as the frame before.

SET BOOK
- Places and recurring objects (a tavern, a street, a ship, a sword, a car) must look the same in every frame and reply. Each is described ONCE in "places" (name, kind, label, look) the first time it appears; after that only its name is used. A place is a whole setting the story returns to, never a spot inside one. Never re-add or change a known entry.

DIALOGUE
- The message's quoted lines and its thoughts (text in \`backticks\`, marked "(thought)") are already cut into numbered balloons (L0, L1, ...). In "dialogue", give EVERY numbered balloon exactly once, in order, as {"line": N, "text": ""} with its "speaker" and "bubble_type" (speech, shout, thought, narration). Never merge, split, reorder or retype them. A numbered quote that is not said aloud (a title, a sign, a quoted word) gets bubble_type "none".
- A line that is NOT in the list goes in "text" with "line": -1: speech the message wrote without quotation marks, cut into balloons of 8-15 words at natural boundaries, word for word.${innerThoughts ? `
- INNER THOUGHTS: where the narration states what a character feels but does not say, you MAY add one very short first-person thought (2-6 words) with bubble_type "inner" and "line": -1. At most 2 per reply, never for the player.` : ''}
- Put every balloon in the frame where it is said or thought ("dialogue_indices", indices into your "dialogue" array, in order). At most 3 balloons per frame: a long speech is spread over several frames, each with what the speaker does while saying that part. A shouted line and a calm line are never in the same frame (the face changes). The player's own lines are never balloons.${povMode ? POV_MODE_RULES : ''}`;
}

/**
 * First-person mode: the player is never drawn. Appended only when the setting is on; the code
 * enforces it too (withPlayerUnseen), this only makes the storyboard fit it.
 */
const POV_MODE_RULES = `

FIRST-PERSON MODE - these rules override anything above that conflicts with them:
- The whole story is seen through the player's eyes. The player is NEVER drawn: no frame of the player from outside, no "over the shoulder", the player never in "background".
- The player is not in the "people" of any frame, except an insert of the player's own hands (holding a phone, taking a cup) - then the player is the only person in "people" and the angle is "pov".
- Use angle "pov" for the plain view through the player's eyes and for the player's own hands; the player is not drawn in ANY frame, so every other angle is free too. The player's eyes are the camera, and the camera moves: looking up or down at someone ("low angle", "high angle"), past an object ("through foreground"), turning the head to the place (kind "establishing"), glancing down at their own hands (insert), watching someone leave ("from behind"), seeing a person from the side ("profile view"). A first-person story is still staged like a manhwa, not like a video call.
- A person who looks AT the player looks at "the viewer"; a person who only talks to the player is not always looking at them (see EYE CONTACT).
- The player's own actions are shown by what the player sees: their hands, what they hold, how the others react.`;

function userPrompt(messageText, { characterName, userName, world, knownCast, knownSet, sceneContext, speechLines }) {
    const blocks = [];
    if (world) blocks.push('WORLD BOOK (how this story looks):', formatWorld(world), '');
    blocks.push('KNOWN CAST (use these names; their looks are fixed):', knownCast?.length ? formatKnownCast(knownCast, { personaName: userName }) : '(nobody yet)', '');
    blocks.push('KNOWN SET (places and objects already drawn; reuse these names):', knownSet?.length ? formatKnownSet(knownSet) : '(none yet)', '');
    if (sceneContext?.previousReply) blocks.push('CONTEXT ONLY - the end of the previous reply (who/where continuity):', '"""', sceneContext.previousReply, '"""', '');
    if (sceneContext?.playerAction) blocks.push(`CONTEXT - the player's (${userName}) own message, which this reply answers:`, '"""', sceneContext.playerAction, '"""', '');
    blocks.push(`Reply written by: ${characterName}`, `The player is: ${userName}`, '', 'MESSAGE:', '"""', messageText, '"""', '');
    if (speechLines?.length) blocks.push('BALLOONS - the message\'s quoted lines and thoughts, already cut; refer to them by number:', formatSpeechLines(speechLines), '');
    blocks.push(`Storyboard this message as manhwa frames, following the schema exactly. ${sceneContext?.playerAction ? `The first frame shows what the player (${userName}) does or says in their own message. ` : ''}The context blocks only tell you who is who, where they are and what the player is doing; never draw events that happen only in the context.`);
    return blocks.join('\n');
}

/**
 * Fills fields older code reads from the director's answer: every beat's `characters` (names of
 * its people), its location (carried from the frame before), and the scene-level `characters`
 * list (name, count tag, screen side) used for balloon tails and focus. Pure.
 */
// Words that are titles, not names ("Guard Roland" is recognised as "Roland", never as "Guard").
const TITLE_WORDS = new Set(['guard', 'sir', 'lady', 'lord', 'captain', 'old', 'young', 'the', 'mr', 'mrs', 'miss', 'dr']);

/**
 * The names a cast entry is called by in a text: full name and aliases, plus the capitalised core
 * words of a real name ("Roland" of "Guard Roland"). A descriptive name made up for someone unnamed
 * ("Café Barista", "Flower Vendor") has no core: its words are ordinary words ("the café window"
 * named the barista and put him at the table). Pure.
 */
function namesOf(entry) {
    return [...fullNamesOf(entry), ...coresOf(entry)];
}

function fullNamesOf(entry) {
    return [...new Set([entry?.name, ...(entry?.aliases || [])].map((n) => String(n || '').trim()).filter(Boolean))];
}

function coresOf(entry) {
    const own = `${entry?.label || ''} ${entry?.look || ''} ${entry?.outfit || ''}`.toLowerCase();
    const out = [];
    for (const n of fullNamesOf(entry)) {
        const words = n.split(/\s+/).filter((w) => /^\p{Lu}/u.test(w) && w.length >= 3 && !TITLE_WORDS.has(w.toLowerCase()));
        if (words.length < 2 && !(words.length === 1 && words[0] !== n)) continue;
        if (words.some((w) => own.includes(w.toLowerCase())) || words.every((w) => COMMON_NOUN.test(w))) continue;
        out.push(...words);
    }
    return [...new Set(out)];
}

// Words that are ordinary nouns when a made-up name uses them ("Market Commoner", "Passerby Woman").
const COMMON_NOUN = /^(?:café|cafe|market|flower|town|city|street|shop|tavern|inn|bar|guild|station|train|passerby|commoner|vendor|merchant|barista|waiter|waitress|clerk|cook|chef|guard|soldier|knight|priest|woman|man|girl|boy|kid|child|old|young|elderly|stranger|customer|patron|driver|officer|nurse|doctor|teacher|student|maid|butler|servant|farmer|hunter|beast|monster|wolf)$/i;

const mentioned = (text, entry) => {
    const t = String(text || '');
    const esc = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return fullNamesOf(entry).some((n) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(n)}(?![\\p{L}\\p{N}])`, 'iu').test(t))
        // A core counts only written as a name (capitalised, not starting a sentence of ordinary words).
        || coresOf(entry).some((n) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(n)}(?![\\p{L}\\p{N}])`, 'u').test(t));
};

/**
 * A contact (handing over, grabbing, touching) has two sides, and the picture can only draw the sides
 * that are in it: "the vendor presses the daisies into alex's palm" in a frame of the vendor and
 * Mira was drawn as the vendor handing them to MIRA. Any known person the contact names who is not in
 * the frame is added to it, on the other side, looking at the first person - except the player of a
 * first-person frame (the viewer's own hand) and an insert (hands only). Pure.
 */
export function withContactPartners(beat, cast = []) {
    const text = String(beat?.interaction || '').trim();
    if (!text || beat?.kind === 'insert' || beat?.camera?.angle === 'pov') return beat;
    const people = Array.isArray(beat.people) ? [...beat.people] : [];
    if (!people.length || people.length >= 3) return beat;
    const named = (cast || []).filter((c) => mentioned(text, c) && !people.some((p) => namesOf(c).some((n) => String(p?.name || '').toLowerCase() === n.toLowerCase())));
    if (!named.length) return beat;
    const sideOf = (s) => (s === 'left' ? 'right' : s === 'right' ? 'left' : 'center');
    const added = [];
    for (const c of named.slice(0, 3 - people.length)) {
        const used = new Set([...people, ...added].map((p) => p.side));
        const first = people[0];
        const side = [sideOf(first.side), 'left', 'right', 'center'].find((s) => !used.has(s)) || 'center';
        added.push({ name: c.name, side, action: 'on the other side of the contact described above, hands and body turned toward it', expression: 'natural', gaze: first.name });
    }
    const all = [...people, ...added];
    return { ...beat, people: all, characters: all.map((p) => p.name), contactPartnersAdded: added.map((p) => p.name) };
}

/**
 * A background that says the player sits "in the foreground, seen from behind" is an over-the-shoulder
 * shot. As background text it became "the viewer seated in the foreground": the image model drew a
 * second man there, in the wrong clothes (live test 2026-09-30). The player then becomes a real
 * figure of an over-the-shoulder frame - drawn from behind, from his own look - and the sentence goes.
 * Pure.
 */
export function withPlayerInForeground(beat, userName) {
    const bg = String(beat?.background || '');
    const name = String(userName || '').trim();
    const people = Array.isArray(beat?.people) ? beat.people : [];
    if (!name || !bg || !people.length || people.length >= 3 || beat?.kind === 'insert' || beat?.camera?.angle === 'pov') return beat;
    if (!mentioned(bg, { name }) || !/\b(?:behind|shoulder|foreground|back of)\b/i.test(bg)) return beat;
    if (people.some((p) => String(p?.name || '').toLowerCase() === name.toLowerCase())) return beat;
    const first = people[0];
    const side = first.side === 'left' ? 'right' : 'left';
    const all = [...people, { name, side, action: 'seen from behind in the near foreground, back of the head toward the viewer', expression: '', gaze: first.name }];
    // Only the clause about the player goes: the rest of the background (the crowd, the stalls) stays
    // (1.07 emptied the whole background).
    const rest = withoutMentions(bg, { name });
    return { ...beat, camera: { ...(beat.camera || {}), angle: 'over the shoulder' }, background: rest, people: all, characters: all.map((q) => q.name), playerMovedToForeground: true };
}

/**
 * A known person the background names who is NOT far away (no distance words: "seated across the
 * table staring back at him") is in the frame, near the main figure - the director put the person the
 * main figure talks to in "background". Drawn from there, the prompt sent her "into the distance" and
 * turned the only main figure's back to the reader, and the picture put her behind a window, a room
 * away (live test 2026-09-30). Such a person becomes a main figure; the player there, in a first-person
 * frame, is the viewer and leaves the text. People with distance words stay in the background. Pure.
 */
export function withBackgroundPeople(beat, cast = [], userName = '') {
    const bg = String(beat?.background || '').trim();
    if (!bg || beat?.kind === 'insert' || beat?.kind === 'establishing') return beat;
    const people = Array.isArray(beat.people) ? [...beat.people] : [];
    if (!people.length) return beat;
    let background = bg;
    const promoted = [];
    for (const c of cast || []) {
        if (!c?.name || !mentioned(background, c)) continue;
        if (people.some((p) => namesOf(c).some((n) => sameName(p?.name, n)))) continue;
        const clause = clausesOf(background).find((x) => mentioned(x, c)) || background;
        // Far is judged on the whole sentence: "Across the room at the counter, the barista wipes..."
        // keeps its distance words outside the barista's own clause.
        const whole = sentencesOf(background).find((x) => mentioned(x, c)) || background;
        if (FAR_WORDS.test(whole)) continue;
        const isPlayer = userName && sameName(c.name, userName);
        if (isPlayer && beat?.camera?.angle === 'pov') { background = dropClause(background, clause); continue; }
        if (isPlayer && FOREGROUND_WORDS.test(clause)) continue; // withPlayerInForeground's case
        if (people.length >= 3) continue;
        const name = namesOf(c).find((n) => new RegExp(`(?<![\\p{L}])${escapeRe(n)}(?![\\p{L}])`, 'iu').test(clause)) || c.name;
        const action = clause.replace(new RegExp(`^(?:the\\s+)?${escapeRe(name)}(?:['’]s)?\\s*,?\\s*`, 'iu'), '').trim() || 'there with them';
        const first = people[0];
        const side = [first.side === 'left' ? 'right' : first.side === 'right' ? 'left' : 'right', 'left', 'right', 'center'].find((x) => !people.some((p) => p.side === x)) || 'center';
        const looks = LOOK_WORDS.test(clause) || namesOf(c).some((n) => new RegExp(`(?<![\\p{L}])${escapeRe(n)}(?![\\p{L}])`, 'iu').test(String(first.gaze || '')));
        people.push({ name: c.name, side, action, expression: '', gaze: looks ? first.name : '' });
        promoted.push(c.name);
        background = dropClause(background, clause);
    }
    if (!promoted.length && background === bg) return beat;
    return { ...beat, people, characters: people.map((p) => p.name), background, backgroundPromoted: promoted };
}

function escapeRe(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The text without every phrase (sentence, or comma/semicolon part) that names the entry; the rest is kept.
 * "Alex seated in the foreground, a crowd of stalls lines the market" -> "a crowd of stalls lines the market".
 * Applying it again changes nothing. Pure.
 */
function withoutMentions(text, entry) {
    const pieces = String(text || '').split(/(?<=[.;!?])\s+|[,;]\s+/).map((x) => x.trim().replace(/[.,;\s]+$/, '')).filter(Boolean);
    return pieces.filter((x) => !mentioned(x, entry)).join(', ');
}

function dropClause(text, clause) {
    return String(text).replace(clause, '').replace(/^[\s,;.]+|[\s,;]+$/g, '').replace(/\s*([,;])\s*([,;.])/g, '$2').replace(/\s{2,}/g, ' ').trim();
}

/**
 * "over the shoulder" means over the PLAYER's shoulder (the schema says so). A frame that asks for it
 * without the player in it got a stray shoulder from nobody in particular: the player is added, seen
 * from behind; with no room for him (or no player), the frame is an ordinary eye-level view. Pure.
 */
export function withShoulderOwner(beat, cast = [], userName = '') {
    if (beat?.camera?.angle !== 'over the shoulder' || beat?.kind === 'insert') return beat;
    const people = Array.isArray(beat.people) ? beat.people : [];
    if (userName && people.some((p) => sameName(p?.name, userName))) return beat;
    const player = userName ? findPerson(cast, userName) : null;
    if (!player || !people.length || people.length >= 3) return { ...beat, camera: { ...beat.camera, angle: 'eye level' } };
    const first = people[0];
    const side = first.side === 'left' ? 'right' : 'left';
    const all = [...people, { name: player.name, side, action: 'seen from behind in the near foreground, back of the head toward the viewer', expression: '', gaze: first.name }];
    return { ...beat, people: all, characters: all.map((p) => p.name), shoulderOwnerAdded: true };
}

/** The posture a description gives one person ("Alex sits opposite Mira"). Pure. */
function postureInDescription(description, person, cast) {
    const entry = findPerson(cast, person?.name) || { name: person?.name };
    for (const sentence of String(description || '').split(/(?<=[.!?])\s+/)) {
        for (const n of namesOf(entry)) {
            const m = sentence.match(new RegExp(`(?<![\\p{L}])${escapeRe(n)}(?![\\p{L}])(?:['’]s)?\\s+(?:\\w+\\s+){0,3}?(sits?|sitting|seated|sat|kneel\\w*|knelt|lies|lying)\\b`, 'iu'));
            if (m) return postureOf(m[1]);
        }
    }
    return null;
}

/**
 * A body keeps its posture until the text changes it: two people seated at a café table were drawn
 * standing in every frame that did not repeat "sits" (live test 2026-09-30). Each person's last stated
 * posture (seated, kneeling, lying) is carried into their later frames in the same place until they
 * get up, walk or leave. Pure.
 */
/** "Still seated, leans forward over the table": the posture first - at the end of a long action it
 * lost to "leans over the table", which the model drew standing. Pure. */
function withPosture(action, posture) {
    const a = String(action || '').trim().replace(/[.,;\s]+$/, '');
    if (!a) return posture;
    return `${posture.charAt(0).toUpperCase()}${posture.slice(1)}, ${a.charAt(0).toLowerCase()}${a.slice(1)}`;
}

export function withPostureCarried(beats, cast = []) {
    const state = new Map();
    let place = null;
    return beats.map((beat) => {
        if (!beat || typeof beat !== 'object') return beat;
        if (place !== null && !samePlace(place, beat.location)) state.clear();
        place = beat.location;
        if (!Array.isArray(beat.people) || !beat.people.length) return beat;
        let changed = false;
        const people = beat.people.map((p) => {
            const key = String(findPerson(cast, p?.name)?.name || p?.name || '').toLowerCase();
            const own = String(p?.action || '');
            const said = postureOf(own);
            if (said) { state.set(key, said); return p; }
            if (UP.test(own)) { state.delete(key); return p; }
            const described = postureInDescription(beat.description, p, cast);
            if (described) {
                state.set(key, described);
                changed = true;
                return { ...p, action: withPosture(own, described) };
            }
            const carried = state.get(key);
            if (carried && beat.kind !== 'insert') {
                changed = true;
                return { ...p, action: withPosture(own, postureWords(carried)), postureCarried: carried };
            }
            return p;
        });
        return changed ? { ...beat, people } : beat;
    });
}

export function completeBeats(scene, { userName = '', cast = null, povMode = false } = {}) {
    if (!Array.isArray(scene?.beats)) return scene;
    const people = cast || scene.cast || [];
    let place = String(scene.setting || scene.scene || '').trim();
    const firstSide = new Map();
    // The beats as the director gave them, before first-person mode took frames out or changed cameras: a
    // redraw with the mode switched OFF starts from these (1.07 only had the already-reduced beats).
    const sourceBeats = Array.isArray(scene.rawBeats) && scene.rawBeats.length ? scene.rawBeats : scene.beats;
    const beats = sourceBeats.map((beat, beatIndex) => {
        if (!beat || typeof beat !== 'object') return beat;
        let out = withPlayerInForeground(withContactPartners({ ...beat }, people), userName);
        out = withShoulderOwner(withBackgroundPeople(out, people, userName), people, userName);
        const description = withoutCameraClause(out.description);
        if (description !== String(out.description || '').trim() && out.description) out = { ...out, description };
        if (!Array.isArray(out.characters) || out.backgroundPromoted || out.shoulderOwnerAdded) out.characters = (out.people || []).map((p) => p?.name).filter(Boolean);
        // A person who changes clothes in the middle of the reply is still in the old outfit before that beat.
        if (Array.isArray(out.people) && out.people.some((p) => p?.name)) {
            const people2 = out.people.map((p) => {
                const c = findPerson(people, p?.name);
                return c?.outfitBefore && c.outfitFromBeat > beatIndex && !p.outfit_override ? { ...p, outfit_override: c.outfitBefore } : p;
            });
            if (people2.some((p, i) => p !== out.people[i])) out = { ...out, people: people2 };
        }
        for (const p of out.people || []) if (p?.name && !firstSide.has(p.name.toLowerCase())) firstSide.set(p.name.toLowerCase(), p.side);
        const own = String(out.location || '').trim();
        if (own) place = own; else out.location = place;
        return out;
    });
    const castSex = new Map((people || []).map((c) => [String(c?.name || '').toLowerCase(), c?.sex]));
    const tag = (sex) => (sex === 'female' ? '1girl' : sex === 'male' ? '1boy' : '1other');
    const characters = Array.isArray(scene.characters) && scene.characters.length ? scene.characters : [...firstSide.keys()].map((key) => {
        const name = beats.flatMap((b) => b?.people || []).find((p) => String(p?.name || '').toLowerCase() === key)?.name || key;
        return { name, count_tag: tag(findPerson(people, name)?.sex ?? castSex.get(key)), screen_position: firstSide.get(key) || 'center' };
    });
    const drawn = povMode ? withPlayerUnseen(beats, people, userName) : beats;
    // The raw beats are kept only while first-person mode has changed something; with the mode off they are the beats.
    const { rawBeats: _oldRaw, povMode: _oldPov, ...rest } = scene;
    return { ...rest, beats: withPostureCarried(withComposition(withShotVariety(drawn)), people), characters, ...(povMode ? { povMode: true, rawBeats: beats } : {}) };
}

/** The shot a middle frame changes to when three frames in a row would have the same distance. */
const SHOT_STEP = { 'wide shot': 'medium shot', 'full shot': 'medium shot', 'medium shot': 'close-up', 'close-up': 'medium shot', 'extreme close-up': 'close-up' };

/**
 * Never three frames in a row at the same distance. The director is asked for it, but a model asked "vary the
 * camera" still gave three medium shots in a row in 1 reply of 4 (1.12 measurements), so the code keeps the promise:
 * the MIDDLE frame of such a run of people-frames moves one step (a reaction closer, or a wide view nearer). An insert,
 * an establishing view and a closer view of the same instant keep their shot. Applying it twice changes nothing. Pure.
 */
export function withShotVariety(beats) {
    if (!Array.isArray(beats) || beats.length < 3) return beats;
    const out = beats.slice();
    for (let i = 2; i < out.length; i++) {
        const shot = out[i - 2]?.camera?.shot;
        const middle = out[i - 1];
        if (!shot || middle?.camera?.shot !== shot || out[i]?.camera?.shot !== shot) continue;
        if ((middle.kind && middle.kind !== 'character') || middle.same_moment || !SHOT_STEP[shot]) continue;
        out[i - 1] = { ...middle, camera: { ...middle.camera, shot: SHOT_STEP[shot] } };
    }
    return out;
}

/**
 * Never three single-person frames in a row with the figure in the middle. Anima draws the figure dead centre unless told
 * otherwise (Gemini review of 1.14 replies: "the exact same centered, eye-level framing"; a same-seed test showed that a
 * "left third" sentence moves the figure and opens the space it looks into). The director is asked to vary "side"; the
 * code keeps the promise: the third centred frame of a run takes the side opposite to the last one used. Close-ups,
 * inserts, establishing views and frames with several people break a run. Applying it twice changes nothing. Pure.
 */
export function withComposition(beats) {
    if (!Array.isArray(beats) || beats.length < 3) return beats;
    let streak = 0;
    let last = 'right';
    return beats.map((b) => {
        const solo = b && (!b.kind || b.kind === 'character') && Array.isArray(b.people) && b.people.length === 1;
        if (!solo || /close-up/.test(b.camera?.shot || '')) { streak = 0; return b; }
        const side = b.people[0]?.side;
        if (side === 'left' || side === 'right') { streak = 0; last = side; return b; }
        if (++streak < 3) return b;
        streak = 0;
        last = last === 'left' ? 'right' : 'left';
        return { ...b, people: [{ ...b.people[0], side: last }] };
    });
}

/**
 * Why a parsed scene cannot be drawn, or null if it can. An empty `{}` (a truncated answer that
 * SillyTavern turned into an empty object) used to be drawn as the style words alone.
 */
export function sceneProblem(scene) {
    if (!scene || typeof scene !== 'object' || Array.isArray(scene)) return 'no object';
    const beats = Array.isArray(scene.beats) ? scene.beats.filter((b) => b && typeof b === 'object') : null;
    const people = Array.isArray(scene.characters) ? scene.characters : null;
    if (!beats && !people) return 'no beats';
    if (beats && !beats.length && !(people && people.length)) return 'an empty beat list';
    const hasWords = [scene.setting, scene.scene, scene.shared_description, scene.image_description]
        .some((v) => typeof v === 'string' && v.trim()) || (beats || []).some((b) => String(b.description || b.beat || '').trim());
    if (!hasWords) return 'nothing to draw (no description, setting or beat)';
    return null;
}

/**
 * Turns a finished reply into a storyboard scene.
 * @param {object} context SillyTavern.getContext()
 * @param {string} connectionProfileId
 * @param {string} messageText
 * @param {object} meta characterName, userName, world, knownCast, knownSet, sceneContext, maxPanels,
 *   maxImages, innerThoughts, reasoningEffort
 * @returns {Promise<object>} the scene (with a non-enumerable `__usage`)
 */
export async function parseScene(context, connectionProfileId, messageText, meta) {
    if (!connectionProfileId) throw new Error('No Connection Profile selected for the Manga Scene Parser. Set one in Manga Mode settings.');
    const budget = { maxPanels: meta.maxPanels || 6, maxImages: meta.maxImages || 10, innerThoughts: meta.innerThoughts !== false, povMode: Boolean(meta.povMode) };
    const speech = extractSpeechLines(messageText);
    const messages = [
        { role: 'system', content: systemPrompt(budget) },
        { role: 'user', content: userPrompt(messageText, { ...meta, speechLines: speech }) },
    ];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PARSER_TIMEOUT_MS);
    let result;
    try {
        result = await requestJson(context, connectionProfileId, messages, 12000, {
            name: 'manga_storyboard',
            description: 'Storyboard of one roleplay reply as manhwa frames.',
            value: buildSchema(budget),
            strict: true,
        }, { signal: controller.signal, reasoningEffort: meta.reasoningEffort || 'minimal', label: 'The scene director', cacheSystem: true });
    } catch (error) {
        if (controller.signal.aborted) throw new Error(`Scene director gave no answer within ${PARSER_TIMEOUT_MS / 1000}s (timed out).`);
        throw error;
    } finally {
        clearTimeout(timer);
    }
    let scene = resolveDialogueRefs(result.content, speech, { fallbackSpeaker: meta.characterName || '' });
    // With the whole cast (the people known before this reply AND the ones it adds): completed with the new
    // people only, the owner of an over-the-shoulder shot was not found and the frame was turned to eye level
    // for good, before the draw-time pass could have fixed it.
    const wholeCast = uniqueLabels(mergeCast(meta?.knownCast || [], scene.cast || []));
    scene = completeBeats({ ...scene, parserVersion: 4 }, { userName: meta?.userName, cast: wholeCast, povMode: Boolean(meta?.povMode) });
    const problem = sceneProblem(scene);
    if (problem) {
        const error = new Error(`The scene director returned an unusable scene: ${problem}.`);
        error.usage = result.usage;
        throw error;
    }
    Object.defineProperty(scene, '__usage', { value: result.usage, enumerable: false });
    return scene;
}

/**
 * The storyboard as it is drawn: the same completion the parser applies, run again at draw time, so
 * "Redraw images" on a saved storyboard gets every later fix too (it used to reuse the beats exactly
 * as they were completed when first parsed). Idempotent. Pure.
 */
export function normalizeScene(scene, { userName = '', cast = null, povMode = false } = {}) {
    if (!scene || typeof scene !== 'object') return scene;
    return completeBeats(scene, { userName, cast, povMode });
}

// The player's hands at work in a frame of the player alone: drawn first-person, not left out. A hand or a
// verb that handles something counts; the NAME of an object alone does not ("walks past a sword display",
// "reaches the village", "takes a seat", "walks to the place" are not hands at work - 1.07 drew them as hand
// close-ups because sword / book / phone / place / take / reach were on the list).
const OWN_HANDS = new RegExp([
    '\\b(?:hands?|fingers?|fingertips?|palms?|thumbs?|wrists?|knuckles?|fists?|grip(?:s|ped|ping)?|clutch\\w*|grasp\\w*)\\b',
    '\\b(?:holds?|holding|grabs?|grabbing|snatch\\w*|pours?|pouring|offers?|offering|types?|typing|taps?|tapping|scrolls?|scrolling|writes?|writing|draws? (?:a|the|his|her|your)\\s+(?:sword|blade|knife|dagger|weapon|bow)|unsheathes?|pulls? out|picks? (?:up|out)|(?:sets?|puts?|places?|lays?|slides?|pushes?|pulls?) (?:down|aside|away|back|out|up)\\b|(?:sets?|puts?|places?|lays?|slides?|pushes?|pulls?) (?:the|a|an|his|her|your)\\s+(?:[\\w-]+\\s+){1,2}?(?:down|aside|away|back|out|up|on|in|into|onto|across|over)\\b|hands? (?:over|out|it|them|him|her)|reach(?:es|ed|ing)? (?:for|out|into|toward|towards|across|over)|tak(?:es|ing) (?:the|a|an|his|her|your) (?!seat\\b|step\\b|breath\\b|look\\b|moment\\b|turn\\b|time\\b|chance\\b|rest\\b|nap\\b|bow\\b|walk\\b|stroll\\b|shot\\b|bite\\b|sip\\b|path\\b|road\\b|lead\\b|side\\b|position\\b|place\\b|spot\\b|stand\\b|stance\\b|route\\b|stairs\\b|stairway\\b|exit\\b|door\\b)\\w+)\\b',
].join('|'), 'i');

/**
 * First-person mode, enforced on the storyboard: the player is never drawn. A frame with the player
 * and others is seen through the player's eyes (angle pov); "over the shoulder" becomes pov; a frame
 * of the player alone becomes a first-person insert of the player's own hands when the hands do
 * something, else it is left out (its lines move to the frame before it); the player named in a
 * background is taken out of it. Pure.
 */
export function withPlayerUnseen(beats, cast = [], userName = '') {
    const player = userName ? (findPerson(cast, userName) || { name: userName }) : null;
    if (!player) return beats;
    const isPlayer = (name) => namesOf(player).some((n) => sameName(name, n)) || sameName(name, userName);
    const out = [];
    for (const beat of beats) {
        if (!beat || typeof beat !== 'object') { out.push(beat); continue; }
        const people = Array.isArray(beat.people) ? beat.people : [];
        const mine = people.filter((p) => isPlayer(p?.name));
        let b = { ...beat };
        // The player named in the background (seated in the foreground, standing further away).
        // Everything that names the player goes, in one pass (1.07 took out the first clause only, and a second
        // pass took out the next: the result depended on how often it was applied).
        if (b.background && mentioned(b.background, player)) b.background = withoutMentions(b.background, player);
        if (!mine.length) {
            if (b.camera?.angle === 'over the shoulder') b.camera = { ...b.camera, angle: 'pov' };
            out.push(b);
            continue;
        }
        const others = people.filter((p) => !isPlayer(p?.name));
        if (others.length || b.kind === 'establishing') {
            b = { ...b, camera: { ...(b.camera || {}), angle: b.kind === 'establishing' ? (b.camera?.angle || 'eye level') : 'pov' } };
            if (b.kind === 'establishing') { b.people = others; b.characters = others.map((p) => p.name); }
            out.push(b);
            continue;
        }
        // The player alone.
        const text = `${b.description || ''} ${mine.map((p) => p.action || '').join(' ')} ${b.interaction || ''}`;
        if (b.kind === 'insert' || OWN_HANDS.test(text)) {
            out.push({ ...b, kind: 'insert', camera: { shot: 'close-up', angle: 'pov' }, people: mine.slice(0, 1), characters: [mine[0].name], background: '', playerSeenFirstPerson: true });
            continue;
        }
        // Nothing of the player's to see: the frame goes, its lines go to the frame before (or after).
        const lines = Array.isArray(b.dialogue_indices) ? b.dialogue_indices : [];
        const previous = out.filter((x) => x && !x.dropForPov).pop();
        if (lines.length && previous) previous.dialogue_indices = [...(previous.dialogue_indices || []), ...lines];
        out.push({ ...b, dropForPov: true, carryLines: lines.length && !previous ? lines : [] });
    }
    // Lines (and a panel start) of a dropped first frame go to the next frame.
    const kept = [];
    let carry = [];
    let panel = false;
    for (const b of out) {
        if (b?.dropForPov) { carry = [...carry, ...(b.carryLines || [])]; panel = panel || Boolean(b.new_panel); continue; }
        if (carry.length || panel) {
            kept.push({ ...b, dialogue_indices: [...carry, ...(b.dialogue_indices || [])], new_panel: panel || b.new_panel });
            carry = [];
            panel = false;
        } else kept.push(b);
    }
    if (carry.length && kept.length) kept[kept.length - 1].dialogue_indices = [...(kept[kept.length - 1].dialogue_indices || []), ...carry];
    if (kept.length) return kept;
    // Nothing of the player's is left to show. The original frames used to come back here - with the player in
    // them, drawn from outside, exactly what first-person mode must never do. Instead: the view in front of him.
    const first = beats.find((x) => x && typeof x === 'object') || {};
    const lines = beats.flatMap((x) => (x && Array.isArray(x.dialogue_indices) ? x.dialogue_indices : []));
    const place = String(first.location || '').trim();
    return [{
        ...first,
        kind: 'establishing',
        description: place ? `The view in front of the viewer: ${place.replace(/\.$/, '')}.` : 'The view in front of the viewer.',
        camera: { shot: 'wide shot', angle: 'eye level' },
        people: [],
        characters: [],
        background: '',
        interaction: '',
        dialogue_indices: lines,
        new_panel: true,
        povFallback: true,
    }];
}
