// The quality check: a vision model looks at every finished picture next to what the frame should
// show, and the frame is redrawn when it is clearly wrong (a main figure missing or doubled, the
// guard drawn without his armour, lettering across the picture, a floating head). The same answer
// gives each figure's head box, which is what close-ups are cropped to and what keeps balloons off
// faces - the old skin-colour search took half-timbered walls for faces.
import { requestJson } from './llm-request.js';

const SYSTEM = `You check pictures generated for a manga page against the description of the frame they are for. Judge only content, never art style or colour grading. Be strict about the listed main figures: each must appear exactly once and recognisably match their look and outfit. "matches_look" is false when a stated item is clearly different or missing (set "minor_only" when only a small accessory or outer layer is the difference) - another kind of armour or helmet, plate armour where cloth is stated (or the reverse), a weapon or piece of gear from their outfit that is missing, a clearly different colour of the main garment, a different hair colour, species features (animal ears, horns) missing, or a clearly different age - and "note" says what differs. Pose, action, gaze and objects they handle never make "matches_look" false; they belong to the key moment ("action_shown"). Do not mistake a hand gesture for a missing outfit item, and do not reject a small accessory merely because it is hidden by the pose or crop. Anything listed as taken off must not be worn. No other person may take a main role in the frame (small background people are fine when the frame allows them). Judge the key moment: a hand-over or contact must show both sides of it (both people, or both people's hands on the object); one open hand alone is not a hand-over. Objects must be as stated - material, colour and count (copper is not gold); a clearly wrong object means the key moment is not shown. Check each figure's "Doing:" line against what that very person does and holds (a plate set down by the cook must not be in the girl's hands). Check the gaze lines when given: a person who must look at another person's face but looks down at an object in their own hands, at the table or away is wrong. If two people share a scene they must stand in one open space: a wall, pillar, door frame, window pane or divider standing between them is wrong (unless the frame says so). Report anything plainly illogical (objects floating or cut through people, people inside walls or furniture, a limb holding nothing where an object is described, a person sitting on nothing). Report lettering (words, fake letters or numbers) and whether it is prominent or only small marks on background signs, and clear defects (a floating head, extra or missing limbs, a figure merged into another, disembodied hands or legs). For an insert close-up the hands and the object must be as the frame says and belong to the listed person (a person holding a mug on the table is not handing it to the viewer); any other hands - the viewer's own hands reaching in - are a defect. A face intentionally outside an insert close-up is not a cut-off-head defect; a partially cut-off head in an ordinary character frame is. Give a head box for every main figure you find: [ymin, xmin, ymax, xmax] on a 0-1000 scale, covering the whole head and hair.

HOW STRICT TO BE ON THE ACTION: the picture comes from an image model that cannot follow every detail, so be tolerant like an art director, not a proofreader. Set "doing_ok" and "action_shown" to false ONLY when the picture clearly contradicts the text: the wrong person does it, a different object is held, shown or missing, the opposite action is drawn, or the main event is simply absent from the picture. A pose, expression, angle or detail that is plausible for the text but not exactly as worded, or less dramatic than described, counts as shown (true). Do the same for "matches_look": false only when a stated key trait is clearly different. When unsure, answer true. An object that is cut off by the edge of the picture, partly hidden, or held just outside the frame is fine: never report "illogical" or "holds nothing" for hands that grip something that continues out of the picture. Report "illogical" only for what is plainly impossible (floating objects, merged bodies, limbs through walls).`;

const SCHEMA = {
    type: 'object',
    properties: {
        seen: { type: 'string', description: 'One or two sentences: what is actually in the picture.' },
        panels: { type: 'integer', description: 'How many separate pictures the image is divided into by panel borders or white gutters, like a comic strip (1 = one continuous picture).' },
        figures: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    label: { type: 'string', description: 'The main figure\'s label as given.' },
                    present: { type: 'boolean' },
                    count: { type: 'integer', description: 'How many times this figure appears (0, 1, 2...).' },
                    matches_look: { type: 'boolean', description: 'Look and outfit recognisably match.' },
                    note: { type: 'string' },
                    minor_only: { type: 'boolean', description: 'Only meaningful when matches_look is false: true when the ONLY differences are a missing or different accessory, outer layer (jacket, cape, coat), hat, bag or other small item while the person, face, hair, body and main garments clearly match; false when the person, hair, species, age or main garments differ.' },
                    doing_ok: { type: 'boolean', description: 'true when this figure does what its "Doing:" line says; false when what they do or hold is clearly different or swapped with another person (the wrong person holds the plate, a mug instead of a dish, hands full of something else).' },
                    gaze_ok: { type: 'boolean', description: 'true when this figure looks where its "Gaze:" line says (or no Gaze line names it); false when the eyes are on an object, the floor or someone else.' },
                },
                required: ['label', 'present', 'count', 'matches_look', 'note', 'minor_only', 'doing_ok', 'gaze_ok'],
                additionalProperties: false,
            },
        },
        barrier: { type: 'boolean', description: 'true when a wall, pillar, door frame, window pane, partition or other divider stands between two people who should share one open space (see the Space line); false otherwise.' },
        illogical: { type: 'string', description: 'ONLY plainly impossible or illogical content (floating objects, people inside walls or furniture, an object held that is not described). "" when there is none.' },
        extra_main_figures: { type: 'integer', description: 'People in a main role who are not listed.' },
        lettering: { type: 'string', enum: ['none', 'small background signs', 'prominent'], description: '"prominent" = words or fake letters on the main subject, on something held up to the viewer, or large enough to read as text; small marks on distant shop signs are "small background signs".' },
        defects: { type: 'string', description: 'ONLY clear anatomy defects: a floating or cut-off head, extra or missing limbs, merged figures, disembodied limbs. Never look/outfit mismatches (those go in figures) or framing preferences. "" when there are none.' },
        action_shown: { type: 'boolean', description: 'The key moment (or, without one, what happens) is recognisably shown: for a hand-over or contact, both sides of it are in the picture.' },
        background: { type: 'string', enum: ['full scene', 'partly blank', 'blank or white'], description: 'Is the setting drawn behind the figures to the edges of the picture, or is the background empty/white?' },
        score: { type: 'integer', description: '0-10: how well the picture serves the frame.' },
        heads: {
            type: 'array',
            items: {
                type: 'object',
                properties: { label: { type: 'string' }, box: { type: 'array', items: { type: 'integer' } } },
                required: ['label', 'box'],
                additionalProperties: false,
            },
        },
    },
    required: ['seen', 'panels', 'figures', 'barrier', 'illogical', 'extra_main_figures', 'lettering', 'defects', 'action_shown', 'background', 'score', 'heads'],
    additionalProperties: false,
};

/** The checker's instructions (exported so tools/checker-study.js can test a changed wording on labelled pictures). */
export const FRAME_CHECK_SYSTEM = SYSTEM;

/** The same request for live checks and repeatable, blind offline evaluation. */
export function frameCheckRequest(imageUrl, expectation, system = SYSTEM) {
    return {
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: [{ type: 'text', text: `${expectation.text}\n\nCheck the picture against this frame.` }, { type: 'image_url', image_url: { url: imageUrl } }] },
        ],
        maxTokens: 1500,
        schema: { name: 'frame_check', description: 'Check of a generated manga frame.', value: SCHEMA, strict: true },
    };
}

/** A check that has not answered in this time is skipped (the picture is kept unchecked). */
export const VISION_TIMEOUT_MS = 60000;

function withTimeout(promise, ms, what) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms); })])
        .finally(() => clearTimeout(timer));
}

async function loadPicture(url) {
    const img = new Image();
    // decode() can wait forever in a background tab; onload does not.
    await withTimeout(new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error(`could not load ${url}`)); img.src = url; }), 30000, 'Loading the picture');
    return img;
}

/** A downscaled JPEG data URL of an image (about 1,300 input tokens at 640 px). */
export async function imageDataUrl(url, max = 640, img = null) {
    img = img || await loadPicture(url);
    const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * s);
    canvas.height = Math.round(img.naturalHeight * s);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
}

/**
 * The whitest corner of a picture: the share of pure-white pixels in its whitest corner block
 * (a fifth of each side). Anima sometimes leaves a frame's corner blank white, like a sticker;
 * the checker model rarely reports it, a pixel count always does.
 */
export function whiteCornerShare(img) {
    const n = 64;
    const canvas = document.createElement('canvas');
    canvas.width = n;
    canvas.height = n;
    const g = canvas.getContext('2d');
    g.drawImage(img, 0, 0, n, n);
    const d = g.getImageData(0, 0, n, n).data;
    const b = 13;
    let best = 0;
    for (const [cx, cy] of [[0, 0], [n - b, 0], [0, n - b], [n - b, n - b]]) {
        let white = 0;
        for (let y = cy; y < cy + b; y++) {
            for (let x = cx; x < cx + b; x++) {
                const i = (y * n + x) * 4;
                if (d[i] >= 242 && d[i + 1] >= 242 && d[i + 2] >= 242) white++;
            }
        }
        best = Math.max(best, white / (b * b));
    }
    return best;
}

/**
 * The share of pure-white pixels over the whole picture. A drawing the model left half on a white
 * page (a figure cut out on white, an inset picture beside empty paper) has a quarter or more; a
 * scene with a white wall or a white shirt has a little. Measured, never asked of the checker.
 */
export function whiteShare(img) {
    const n = 64;
    const canvas = document.createElement('canvas');
    canvas.width = n;
    canvas.height = n;
    const g = canvas.getContext('2d');
    g.drawImage(img, 0, 0, n, n);
    const d = g.getImageData(0, 0, n, n).data;
    let white = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] >= 242 && d[i + 1] >= 242 && d[i + 2] >= 242) white++;
    return white / (n * n);
}

/** Pure-white cells of a picture on an n x n grid (1 = white). */
export function whiteMask(img, n = 64) {
    const canvas = document.createElement('canvas');
    canvas.width = n;
    canvas.height = n;
    const g = canvas.getContext('2d');
    g.drawImage(img, 0, 0, n, n);
    const d = g.getImageData(0, 0, n, n).data;
    const mask = new Uint8Array(n * n);
    for (let i = 0; i < n * n; i++) mask[i] = d[i * 4] >= 242 && d[i * 4 + 1] >= 242 && d[i * 4 + 2] >= 242 ? 1 : 0;
    return mask;
}

/**
 * The picture without the white paper around it: each edge moves in while its row or column is
 * mostly white. {x0, y0, x1, y1} in fractions, or null when there is no white edge to cut (or the
 * drawing left is too small to keep). Pure.
 */
export function contentBox(mask, n = 64, { edgeWhite = 0.5, minArea = 0.5 } = {}) {
    if (!mask || mask.length !== n * n) return null;
    const row = (y, x0, x1) => { let w = 0; for (let x = x0; x < x1; x++) w += mask[y * n + x]; return w / Math.max(1, x1 - x0); };
    const col = (x, y0, y1) => { let w = 0; for (let y = y0; y < y1; y++) w += mask[y * n + x]; return w / Math.max(1, y1 - y0); };
    let x0 = 0; let y0 = 0; let x1 = n; let y1 = n;
    for (let moved = true; moved && x1 - x0 > 4 && y1 - y0 > 4;) {
        moved = false;
        if (row(y0, x0, x1) >= edgeWhite) { y0++; moved = true; }
        if (row(y1 - 1, x0, x1) >= edgeWhite) { y1--; moved = true; }
        if (col(x0, y0, y1) >= edgeWhite) { x0++; moved = true; }
        if (col(x1 - 1, y0, y1) >= edgeWhite) { x1--; moved = true; }
    }
    const box = { x0: x0 / n, y0: y0 / n, x1: x1 / n, y1: y1 / n };
    const area = (box.x1 - box.x0) * (box.y1 - box.y0);
    if (area >= 0.97 || area < minArea) return null;
    return box;
}

/** The model the check runs on: a cheaper vision model through OpenRouter, else the profile's own. */
export function visionOverride(context, settings) {
    const profile = (context?.extensionSettings?.connectionManager?.profiles || []).find((p) => p?.id === settings.connectionProfileId);
    return profile?.api === 'openrouter' && settings.visionModel ? { model: settings.visionModel } : {};
}

/** A label compared loosely: case, articles, punctuation and a trailing plural s do not matter. Pure. */
export function labelKey(label) {
    return String(label || '').toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/^\s*(?:the|a|an)\s+/, '').replace(/\s+/g, ' ').trim().replace(/s$/, '');
}

/** The checker's entry for a label: exact, else by loose key, else (one of one) the only entry. Pure. */
export function findByLabel(list, label, only = false) {
    const items = Array.isArray(list) ? list : [];
    const low = String(label || '').toLowerCase();
    return items.find((x) => String(x?.label || '').toLowerCase() === low)
        || items.find((x) => labelKey(x?.label) === labelKey(label))
        || (only && items.length === 1 ? items[0] : undefined);
}

/**
 * Pass/fail from the checker's answer, decided in code (the model's own score is advisory). Pure.
 * @returns {{pass: boolean, reasons: string[]}}
 */
export function judge(answer, expectation) {
    const reasons = [];
    const minorLook = []; // a missing jacket or bag: worth one more seed, never three
    const figures = Array.isArray(answer?.figures) ? answer.figures : [];
    for (const label of expectation?.labels || []) {
        const f = findByLabel(figures, label, (expectation?.labels || []).length === 1);
        if (!f || !f.present || f.count === 0) reasons.push(`${label} missing`);
        else if (f.count > 1) reasons.push(`${label} drawn ${f.count} times`);
        else if (f.matches_look === false && f.minor_only === true) minorLook.push(`${label} differs in a small detail (${f.note || 'accessory or outer layer'})`);
        else if (f.matches_look === false) reasons.push(`${label} does not match their look (${f.note || 'look/outfit'})`);
    }
    // Where the eyes go and what stands between two people: the two things a frame is most often
    // wrong about without any figure missing.
    for (const g of expectation?.gazes || []) {
        const f = findByLabel(figures, g.label, (expectation?.labels || []).length === 1);
        if (f && f.gaze_ok === false) reasons.push(`${g.label} does not look at ${g.target === 'the viewer' ? 'the camera' : g.target}`);
    }
    if (expectation?.together && answer?.barrier === true) reasons.push('a wall or divider stands between the two people');
    // The point of the frame: a hand-over drawn as one open hand, a newspaper nobody is holding.
    if (answer?.action_shown === false && expectation?.contact) reasons.push('the key moment is not shown');
    // A tall canvas sometimes came back as a strip of two panels (a sequence of actions).
    if (Number(answer?.panels) > 1) reasons.push(`split into ${Number(answer.panels)} panels`);
    // A white background is the point of a character reference sheet (the in-context model is trained on
    // one person on plain white) and not a fault of an insert: only ordinary frames are judged on it.
    // (1.07 judged the sheet like a frame, rejected it three times and dropped the character's reference.)
    const plainBackgroundOk = expectation?.kind === 'insert' || Boolean(expectation?.reference);
    // Figures floating on white happened with spots inside a bigger setting (a booth in a tavern).
    if (!plainBackgroundOk && answer?.background === 'blank or white') reasons.push('blank background');
    // Half the picture left as white paper: measured in pixels (the checker model rarely reports it).
    // A big white area together with a white corner, or with the checker's own "blank" remark, is a
    // major fault: the redraw gets a new seed at once.
    if (!plainBackgroundOk && Number(answer?.white_share) >= 0.12 && (Number(answer?.white_corner) >= 0.5 || answer?.background !== 'full scene')) reasons.push(`a large white area (${Math.round(Number(answer.white_share) * 100)}% of the picture)`);
    // A close-up base is cut to one head anyway: someone else in it does not matter.
    // With people allowed in the background, a checker often counts them as main figures: worth
    // one more seed then, not three (see the minor faults below).
    const extra = expectation?.kind === 'character' && !expectation.forCrop && Number(answer?.extra_main_figures) > 0 ? `${answer.extra_main_figures} unlisted main figure(s)` : '';
    if (extra && !expectation.crowd) reasons.push(extra);
    if (String(answer?.illogical || '').trim() && !/^(none|no\b|n\/a)/i.test(String(answer.illogical).trim())) reasons.push(`illogical: ${answer.illogical}`);
    if (String(answer?.defects || '').trim() && !/^(none|no\b|n\/a)/i.test(String(answer.defects).trim())) reasons.push(`defect: ${answer.defects}`);
    if (expectation?.forCrop && expectation.labels?.[0] && !headOf(answer, expectation.labels[0])) reasons.push(`no head found for ${expectation.labels[0]}`);
    // Lettering is a minor fault: worth one redraw, not three (a newspaper tends to come back
    // with print whatever the seed).
    const major = reasons.length > 0;
    reasons.push(...minorLook);
    for (const label of expectation?.labels || []) {
        const f = findByLabel(figures, label, (expectation?.labels || []).length === 1);
        if (f && f.doing_ok === false && f.present !== false) reasons.push(`${label} is not doing what was described${f.note ? ` (${f.note})` : ''}`);
    }
    if (extra && expectation.crowd) reasons.push(extra);
    if (answer?.action_shown === false && !expectation?.contact) reasons.push('the action is not clearly shown');
    if ((answer?.lettering === 'prominent' || answer?.lettering === true) && !expectation?.writing) reasons.push('prominent lettering in the picture');
    // White corners around a scene (a "sticker" look): also worth one more seed.
    if (!plainBackgroundOk && (answer?.background === 'partly blank' || Number(answer?.white_corner) >= 0.6)) reasons.push('partly blank background');
    return { pass: reasons.length === 0, major, reasons };
}

/** The head box of a label as fractions {x0,y0,x1,y1}, or null. Pure. */
export function headOf(answer, label) {
    const h = findByLabel(answer?.heads, label, (answer?.figures || []).length === 1);
    const b = h?.box;
    if (!Array.isArray(b) || b.length !== 4 || b.some((v) => !Number.isFinite(Number(v)))) return null;
    const [y0, x0, y1, x1] = b.map((v) => Math.min(1000, Math.max(0, Number(v))) / 1000);
    if (x1 - x0 < 0.01 || y1 - y0 < 0.01) return null;
    return { x0, y0, x1, y1 };
}

/**
 * Checks one finished picture against its frame.
 * @returns {Promise<{answer: object, pass: boolean, reasons: string[], usage: object|null}>}
 */
export async function checkFrame(context, settings, imageUrl, expectation, options = {}) {
    const img = await loadPicture(imageUrl);
    const url = await imageDataUrl(imageUrl, 640, img);
    let whiteCorner = 0;
    let white = 0;
    let paperBox = null;
    try { whiteCorner = whiteCornerShare(img); white = whiteShare(img); paperBox = contentBox(whiteMask(img)); } catch { /* a tainted canvas: skip the count */ }
    const request = frameCheckRequest(url, expectation, options.system || SYSTEM);
    const { content, usage } = await requestJson(context, settings.connectionProfileId, request.messages,
        request.maxTokens, request.schema, { reasoningEffort: 'minimal', label: 'The quality check', override: visionOverride(context, settings), signal: AbortSignal.timeout(VISION_TIMEOUT_MS) });
    const verdict = judge({ ...content, white_corner: whiteCorner, white_share: white }, expectation);
    return { answer: content, ...verdict, usage, contentBox: paperBox };
}

/** A reason without its label and bracketed detail, to compare what two looks complained about. Pure. */
function reasonKind(reason) {
    return String(reason || '').toLowerCase().replace(/\(.*$/, '').replace(/^the [^"]*?(?= (?:missing|drawn|does|is)\b)/, '').replace(/\s+/g, ' ').trim();
}

/**
 * Two looks at the same finished picture. A cheap vision model is not consistent: the same correct picture was passed
 * and failed on different runs of the same check (1.12 measurements: 2 of 5 and 3 of 5 passes on pictures that match the
 * character). A redraw costs seconds of the graphics card and a second check, a confirming look costs about a
 * second and a fraction of a cent. So a failed first look is final only when the second look fails too, for at least one
 * reason in common (two looks that complain about different things are noise, not a fault). When both fail, the fault
 * is "major" (an immediate redraw with a new seed) only if both looks found a major one. Pure.
 * @param {{pass: boolean, major?: boolean, reasons: string[], answer?: object}} first
 * @param {{pass: boolean, major?: boolean, reasons: string[], answer?: object}|null} second
 */
export function confirmVerdict(first, second) {
    if (!first || first.pass || !second) return first;
    if (second.pass) return { ...second, pass: true, major: false, reasons: [], overruled: first.reasons };
    const kinds = new Set((first.reasons || []).map(reasonKind));
    const common = (second.reasons || []).filter((r) => kinds.has(reasonKind(r)));
    if (!common.length) return { ...second, pass: true, major: false, reasons: [], overruled: [...(first.reasons || []), ...(second.reasons || [])] };
    return { ...second, pass: false, major: Boolean(first.major && second.major), reasons: common };
}

/** Heads of the answer, converted into the coordinates of a crop of the same picture. Pure. */
export function headsInCrop(answer, crop) {
    const out = [];
    for (const h of answer?.heads || []) {
        const box = headOf(answer, h.label);
        if (!box) continue;
        const w = crop.x1 - crop.x0;
        const hgt = crop.y1 - crop.y0;
        const b = { x0: (box.x0 - crop.x0) / w, y0: (box.y0 - crop.y0) / hgt, x1: (box.x1 - crop.x0) / w, y1: (box.y1 - crop.y0) / hgt };
        if (b.x1 <= 0 || b.y1 <= 0 || b.x0 >= 1 || b.y0 >= 1) continue;
        out.push({ label: h.label, box: { x0: Math.max(0, b.x0), y0: Math.max(0, b.y0), x1: Math.min(1, b.x1), y1: Math.min(1, b.y1) } });
    }
    return out;
}

/** All heads of an answer as {label, box} in picture fractions. Pure. */
export function headsOf(answer) {
    return (answer?.heads || []).map((h) => ({ label: h.label, box: headOf(answer, h.label) })).filter((h) => h.box);
}
