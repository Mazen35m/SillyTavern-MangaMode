// Logic rules every frame prompt must keep. Each rule is a way a prompt can make the image model
// draw something wrong no matter how good the model is. Used by the tests over sample
// storyboards and by the unit tests. Pure.
import { frameFigures } from '../prompt-builder.js';
import { findPerson } from '../cast-book.js';
import { withoutCameraClause } from '../text-rules.js';

const norm = (t) => String(t || '').trim().toLowerCase();
const esc = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const has = (text, word) => new RegExp(`(?<![\\p{L}])${esc(word)}(?![\\p{L}])`, 'iu').test(String(text || ''));

export const NEAR = /\b(?:across (?:the|a|from)|opposite|beside|next to|in front of|facing|at the (?:same )?(?:table|counter|bar|desk)|sitting with|seated with|leaning toward|close to)\b/i;
export const FAR = /\b(?:in the distance|far away|further away|far off|far end|down the (?:street|road|hall|corridor)|across the (?:room|hall|street|square|courtyard|field|plaza)|behind the counter|at the counter|by the counter)\b/i;
const MALE = /\b(?:he|him|his|himself)\b/i;
const FEMALE = /\b(?:she|her|hers|herself)\b/i;

function sexesIn(list) {
    return new Set(list.map((c) => c?.sex).filter(Boolean));
}

/**
 * @param {object} f One frame from framesOf(): { spec, original, camera, mode, prompt, words }
 * @param {{personaName: string, cast: object[]}} ctx
 * @returns {{rule: string, detail: string}[]}
 */
export function lintFrame(f, { personaName = '', cast = [], povMode = false } = {}) {
    const out = [];
    const add = (rule, detail) => out.push({ rule, detail });
    const prompt = String(f.prompt || '');
    const spec = f.spec || {};
    const cam = f.camera || {};
    const kind = spec.kind || 'character';
    const pov = cam.angle === 'pov';
    const figures = frameFigures(spec, cast, { personaName, pov });
    const figureEntries = figures.map((x) => x.cast);

    // 1. A person described as near (across the table) is never sent "into the distance".
    if (/in the distance|further away/i.test(prompt) && NEAR.test(`${spec.background || ''} ${spec.description || ''}`)) {
        add('near-person-sent-far', 'the prompt puts someone in the distance whom the frame places across the table / beside them');
    }
    // 2. The only main figure is never turned away from the reader to face someone in the background.
    if (figures.length === 1 && kind === 'character' && /seen from behind at a three-quarter angle/i.test(prompt)) {
        add('only-figure-turned-away', 'the one main figure is drawn from behind');
    }
    // 3. A known person named in the background with near words must be a main figure.
    for (const c of cast) {
        if (!c?.name || figureEntries.includes(c)) continue;
        const bg = String(spec.background || '');
        if ([c.name, ...(c.aliases || [])].some((n) => has(bg, n)) && NEAR.test(bg)) add('near-person-in-background', `${c.name} is in the background but placed near the main figure`);
    }
    // 4. Posture stated for the person is kept in the prompt (over-the-shoulder replaced it).
    for (const p of spec.people || []) {
        const said = String(p.action || '');
        const posture = /\b(?:sits?|sitting|seated|sat)\b/i.test(said) ? 'seated' : /\b(?:kneel\w*|knelt)\b/i.test(said) ? 'kneeling' : /\b(?:lies|lying|lay)\b/i.test(said) ? 'lying' : '';
        if (!posture) continue;
        const entry = findPerson(cast, p.name);
        if (pov && personaName && norm(p.name) === norm(personaName)) continue;
        const re = posture === 'seated' ? /\b(?:sits?|sitting|seated|sat)\b/i : posture === 'kneeling' ? /\b(?:kneel\w*|knelt)\b/i : /\b(?:lies|lying|lay)\b/i;
        if (!re.test(prompt)) add('posture-lost', `${entry?.label || p.name}: "${posture}" is in the story but not in the prompt`);
    }
    // 5. Pronouns of a sex nobody drawn has point at someone who is not in the picture.
    const drawnSexes = sexesIn(figureEntries);
    const bgPeople = cast.filter((c) => !figureEntries.includes(c) && [c.name, ...(c.aliases || [])].some((n) => has(spec.background || '', n)));
    for (const c of bgPeople) drawnSexes.add(c.sex);
    const text = prompt.replace(/\bOver-the-shoulder shot from behind[^.]*\./, '');
    if (kind !== 'establishing' && MALE.test(text) && !drawnSexes.has('male') && !drawnSexes.has('other')) add('stray-pronoun', `"${text.match(MALE)[0]}" but no man is drawn`);
    if (kind !== 'establishing' && FEMALE.test(text) && !drawnSexes.has('female') && !drawnSexes.has('other')) add('stray-pronoun', `"${text.match(FEMALE)[0]}" but no woman is drawn`);
    // 6. A camera direction written into what happens (the frame's own camera says it).
    const desc = String(spec.description || '');
    if (withoutCameraClause(desc) !== desc.trim()) add('camera-words-in-description', `description: "${desc.slice(0, 90)}"`);
    // 7. Two people who talk share one open space (the sentence was switched off by a place name).
    if (figures.length === 2 && kind === 'character' && cam.angle !== 'over the shoulder') {
        const [a, b] = figures;
        const looks = (x, y) => [y.name, y.cast?.name, ...(y.cast?.aliases || [])].some((n) => n && has(x.gaze || '', n));
        if ((looks(a, b) || looks(b, a)) && !/open space|face each other|side by side|facing each other/i.test(prompt) && !/\b(?:through|behind)\s+(?:a|an|the)?\s*(?:window|glass|bars|screen|door)|video call|phone call/i.test(`${desc} ${a.action || ''} ${b.action || ''}`)) {
            add('shared-space-missing', 'two people who look at each other, and nothing keeps a wall or window from being drawn between them');
        }
    }
    // 8. Lettering that does not fit: a face close-up with a speech.
    const shot = f.plannedShot || cam.shot;
    if ((shot === 'close-up' && f.words > 16) || (shot === 'extreme close-up' && f.words > 8)) add('closeup-overloaded', `${f.words} words of lettering on a ${shot}`);
    // 9. A cast member who is not drawn is named by label (the model draws him).
    for (const c of cast) {
        if (!c?.label || figureEntries.includes(c) || bgPeople.includes(c)) continue;
        if (has(prompt, c.label)) add('absent-person-named', `${c.label} is named but not in the frame`);
    }
    // 10. Negations: at CFG 1 the model draws what a negation names.
    const neg = prompt.match(/\b(?:no|not|never|without|nobody|nothing|none)\b|n't\b/i);
    if (neg) add('negation', `"${prompt.slice(Math.max(0, neg.index - 30), neg.index + 30)}"`);
    // 11. One person twice.
    const count = prompt.match(/(?:Two|Three) main figures: ([^.]*)\./);
    if (count) {
        const labels = count[1].split(/,\s*|\s+and\s+/).map(norm);
        if (new Set(labels).size < labels.length) add('duplicate-figure', count[1]);
    }
    // 12. An outer layer listed after the rest of the outfit is dropped by the model.
    for (const m of prompt.matchAll(/wearing ([^.;]*)/g)) {
        const items = m[1].split(/,\s*/);
        const outer = items.findIndex((t) => /\b(jacket|coat|hoodie|cardigan|blazer|cloak|cape|overcoat|parka|windbreaker)\b/i.test(t));
        if (outer > 1 && !/\bover\b/i.test(items[outer])) add('outer-layer-last', `"${items[outer]}" comes after ${outer} other items`);
    }
    // 14. Glass or a divider named in a frame of two people who talk: drawn as a pane between them.
    const scenery = [(prompt.match(/Setting: [^:]*:([^]*?)\. The background is/) || [])[1] || '', (prompt.match(/Around them: ([^.]*)\./) || [])[1] || ''].join(' ');
    if (figures.length === 2 && kind === 'character' && /open space|face each other|facing each other/i.test(prompt) && /\b(?:windows?|plate-?glass|window-?panes?|panes?|glass|partitions?|dividers?)\b/i.test(scenery)) {
        add('glass-between-talkers', 'two people face to face, and the scenery names glass or a divider');
    }
    // 15. "Over the shoulder" with nobody's shoulder: a stranger's shoulder gets drawn.
    if (/Over-the-shoulder view\./.test(prompt)) add('stray-shoulder', 'over-the-shoulder camera without the player in the frame');
    // 13. A first-person frame never shows the player - in first-person mode, no frame does.
    const player = personaName ? findPerson(cast, personaName) : null;
    if ((pov || povMode) && player?.label && has(prompt, player.label)) add('pov-shows-player', player.label);
    if (povMode && /Over-the-shoulder shot from behind/.test(prompt)) add('pov-shows-player', 'over-the-shoulder frame in first-person mode');
    return out;
}
