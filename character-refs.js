// Character reference sheets for Anima-InContext-Character.
//
// Text alone let a character's face, hair and outfit drift from frame to frame. Each known
// character (card and persona) now gets a small reference sheet once - a full-body picture on a
// white background and a face cut from it - and every frame that shows them is drawn with those
// pictures attached (image-generator.js addCharacterReference). A sheet is keyed by the look it
// was drawn from, so a changed outfit (the persona puts on a hoodie) gets a new sheet.
import { generatePanelImage, refinePanelImage } from './image-generator.js';
import { createCropPanel, cropToHead } from './panel-crop.js';
import { headOf } from './vision-check.js';
import { skinToneOf } from './image-analysis.js';

/** Small stable hash for cache keys. */
function hashText(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
}

/** The outfit a sheet shows: what the story has them wearing now, else the card's default. */
export function sheetOutfit(identity) {
    return String(identity?.currentOutfit || identity?.appearance?.defaultOutfit || '').trim();
}

/** Cache key: name + the look the sheet was drawn from (traits, outfit, background). */
export function referenceKey(identity, background = '') {
    const traits = String(identity?.appearance?.physicalTraits || '').trim();
    return `${String(identity?.name || '').toLowerCase()}|${hashText(`${traits}|${sheetOutfit(identity)}${background ? `|${background}` : ''}`)}`;
}

/** 1girl / 1boy from the traits (the sheet's prompt needs the right noun). */
export function countTagOf(identity, fallback = '1girl') {
    const t = String(identity?.appearance?.physicalTraits || '').toLowerCase();
    if (/\b(woman|girl|female|lady|she)\b/.test(t)) return '1girl';
    if (/\b(man|boy|male|guy|he)\b/.test(t)) return '1boy';
    return fallback;
}

/**
 * The scene + beat a reference sheet is drawn from: one person alone, facing the viewer, neutral,
 * on plain white (what the in-context model was trained with). Pure.
 */
export function sheetScene(identity, countTag, background = 'plain white studio background') {
    const name = identity.name;
    const scene = {
        setting: background,
        environment: ['even soft light'],
        characters: [{ name, count_tag: countTag, outfit: sheetOutfit(identity), visual_tags: '', screen_position: 'center' }],
    };
    const spec = {
        kind: 'character',
        description: `A character reference picture: one person standing alone in the middle of a ${background.replace(/ studio background$/, ' background')}, the whole body from head to feet filling most of the picture height, nothing else in the picture.`,
        characters: [name],
        people: [{ name, side: 'center', action: 'Standing straight and facing the viewer, relaxed neutral pose, arms at the sides', expression: 'calm, neutral', gaze: 'the viewer' }],
        location: background,
    };
    return { scene, spec };
}

async function toBase64(url) {
    const blob = await (await fetch(url)).blob();
    return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error('Could not read a reference picture.'));
        reader.readAsDataURL(blob);
    });
}

async function exists(url) {
    try {
        const r = await fetch(url, { method: 'HEAD' });
        return r.ok;
    } catch {
        return false;
    }
}

/** The model a reference sheet was drawn with: a sheet of another model is not the same picture. */
export function modelSignature(settings) {
    const c = settings?.comfy || {};
    return [c.family || 'checkpoint', c.unet || c.checkpoint || '', c.loras || '', settings?.referenceLora || '', settings?.customWorkflow?.enabled ? settings.customWorkflow.name : ''].join('|');
}

/**
 * Sheets drawn with one model were reused after the model was changed (their faces and style belong to the
 * old one), and a failed look stayed failed. A change of model clears both. The first time (a page saved by 1.07
 * has no record) the current model is taken to be the one that drew them.
 */
export function dropSheetsOfAnotherModel(settings) {
    const now = modelSignature(settings);
    if (settings.referenceSheetsModel && settings.referenceSheetsModel !== now) {
        settings.referenceSheets = {};
        failedSheets.clear();
    }
    settings.referenceSheetsModel = now;
}

/** Forgets the looks whose sheets failed three times (the settings button "reset references"). */
export function resetReferenceFailures() {
    failedSheets.clear();
}

/** Looks whose sheets came out wrong three times in this session. */
const failedSheets = new Set();

/**
 * The reference sheet of one character, drawn once and cached in the settings.
 * @returns {Promise<{full: string, face: string} | null>}
 */
const sheetsInProgress = new Map();

/** One sheet per look at a time: two frames drawn together must not both draw the same sheet. */
export function ensureReferenceSheet(context, settings, identity, options) {
    dropSheetsOfAnotherModel(settings);
    const key = referenceKey(identity, options?.background);
    if (!sheetsInProgress.has(key)) {
        sheetsInProgress.set(key, drawReferenceSheet(context, settings, identity, options).finally(() => sheetsInProgress.delete(key)));
    }
    return sheetsInProgress.get(key);
}

async function drawReferenceSheet(context, settings, identity, { promptFor, subFolder, countTag, background, checkSheet }) {
    settings.referenceSheets = settings.referenceSheets || {};
    const key = referenceKey(identity, background);
    if (failedSheets.has(key)) return null;
    // A person the story has not described yet has nothing to draw a sheet from.
    if (!String(identity?.appearance?.physicalTraits || '').trim() && !sheetOutfit(identity)) return null;
    const cached = settings.referenceSheets[key];
    if (cached?.full && cached?.face && await exists(cached.full) && await exists(cached.face)) return cached;

    const { scene, spec } = sheetScene(identity, countTag || countTagOf(identity), background);
    const chunks = promptFor(scene, spec, { shot: 'full shot', angle: 'eye level' });
    const label = identity.label || identity.name;
    // A sheet is the picture every later frame copies: it is checked like a frame (one person,
    // the right look, a head big enough to cut a face from) and drawn again when it is wrong - a
    // guard's sheet once came back as a tiny figure and an almost empty face.
    let full = null;
    let head = null;
    let good = !checkSheet;
    for (let attempt = 0; attempt < (checkSheet ? 3 : 1); attempt++) {
        const g = await generatePanelImage(context, { chunks, width: 832, height: 1216 }, settings, subFolder);
        if (!checkSheet) { full = g; break; }
        let check = null;
        try {
            check = await checkSheet(g.url, {
                text: `Frame kind: full shot - a character reference picture on a plain background.\nMain figures (exactly 1):\n- "${label}": ${identity?.appearance?.physicalTraits || ''}; wearing ${sheetOutfit(identity)}. Doing: standing, facing the viewer`,
                labels: [label], kind: 'character', forCrop: true, reference: true,
            });
        } catch (error) {
            console.warn('[Manga Mode] Reference sheet check failed; keeping the picture unchecked:', error);
            full = g;
            good = true;
            break;
        }
        const h = headOf(check.answer, label);
        const bigEnough = h && (h.y1 - h.y0) >= 0.07;
        if (check.pass && bigEnough) { full = g; head = h; good = true; break; }
    }
    // Three wrong sheets: no reference for this look (a wrong sheet would be copied into every
    // frame). Remembered for this session so it is not tried again for every frame.
    if (!good) {
        failedSheets.add(key);
        return null;
    }
    let crop;
    if (head) {
        crop = await cropToHead(context, full.url, head, { shot: 'close-up', aspect: 1, subFolder });
    } else {
        const tones = [skinToneOf(identity?.appearance?.physicalTraits)];
        crop = await createCropPanel(context, full.url, { side: 'center', shot: 'close-up', subFolder, aspect: 1, skinTones: tones });
    }
    let face = crop.url;
    try {
        const faceChunks = promptFor(scene, spec, { shot: 'close-up', angle: 'eye level' });
        face = (await refinePanelImage(context, { imageUrl: crop.url, chunks: faceChunks, aspect: 1, denoise: 0.35 }, settings, subFolder)).url;
    } catch (error) {
        console.warn('[Manga Mode] Reference face detail pass failed; using the plain crop:', error);
    }
    const sheet = { full: full.url, face, name: identity.name, createdAt: new Date().toISOString() };
    settings.referenceSheets[key] = sheet;
    context.saveSettingsDebounced();
    return sheet;
}

/**
 * Base64 reference pictures for the known characters visible in a frame (full body + face each,
 * at most `maxPeople` people). Unknown characters (no card) get none.
 */
export async function referencesFor(context, settings, names, identities, options) {
    const out = [];
    const seen = new Set();
    for (const name of names || []) {
        const key = String(name || '').toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const identity = identities.find((i) => String(i.name).toLowerCase() === key);
        if (!identity) continue;
        if (seen.size > (options.maxPeople || 2)) break;
        const sheet = await ensureReferenceSheet(context, settings, identity, { ...options, countTag: options.countTagFor?.(name) });
        if (!sheet) continue;
        out.push(await toBase64(sheet.full), await toBase64(sheet.face));
    }
    return out;
}
