// How one planned frame is drawn: which picture is generated (its spec, camera and size) and how it
// is cut afterwards. Pure, so the exact prompts a reply produces can be listed and checked without
// drawing anything (the tests run it on sample storyboards).
import { contactCamera } from './prompt-builder.js';

export const CLOSE_SHOTS = new Set(['close-up', 'extreme close-up']);

const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/**
 * @param {{spec: object, camera: object, size: {width: number, height: number}, aspect: number|null, focusName?: string}} frame
 * @param {{personaName?: string}} options
 * @returns {{mode: 'closeByCrop'|'wideCrop'|'plain', spec: object, camera: object, width: number, height: number, focus?: string, detailCamera?: object, refNames: string[]}}
 */
export function drawPlanFor({ spec, camera, size, aspect, focusName }, { personaName = '' } = {}) {
    camera = contactCamera(spec, camera);
    const people = (spec?.characters || []).length;
    // A close-up of a person is drawn as an upper-body picture and cut to the head the quality check
    // found (asked for a close-up directly, Anima drew whole bodies and second copies of the person).
    if (CLOSE_SHOTS.has(camera?.shot) && people >= 1 && spec?.kind !== 'insert' && spec?.kind !== 'establishing') {
        const focus = (spec.characters || []).find((n) => same(n, focusName)) || spec.characters[0];
        const playerDropped = !same(focus, personaName) && (spec.characters || []).some((n) => same(n, personaName));
        const solo = { ...spec, characters: [focus], people: (spec.people || []).filter((p) => same(p?.name, focus)), background: '', interaction: '' };
        const angle = playerDropped || camera.angle === 'over the shoulder' ? 'pov' : camera.angle;
        return { mode: 'closeByCrop', spec: solo, camera: { ...camera, angle, shot: 'medium shot', forCrop: true }, width: 1024, height: 1024, focus, detailCamera: { ...camera, angle }, refNames: [focus] };
    }
    // One reference picture pulls every face toward it, so it is used only when one face shows:
    // the player seen from behind (over the shoulder) or not in the picture (pov) does not count.
    const hidesPlayer = camera?.angle === 'over the shoulder' || camera?.angle === 'pov';
    const refNames = (spec?.characters || []).filter((n) => !(hidesPlayer && same(n, personaName)));
    // A tall, narrow frame is drawn wider and cut to shape around the heads.
    if (aspect && aspect < 0.72 && people >= 1 && spec?.kind !== 'establishing') {
        const pixels = size.width * size.height;
        const drawAspect = people >= 2 ? 1 : 0.85;
        const snap = (v) => Math.min(1664, Math.max(512, Math.round(v / 64) * 64));
        const width = snap(Math.sqrt(pixels * drawAspect));
        const height = snap(pixels / width);
        return { mode: 'wideCrop', spec, camera, width, height, refNames };
    }
    return { mode: 'plain', spec, camera, width: size.width, height: size.height, refNames };
}

/**
 * The frame as it is drawn again after a failed check. At CFG 1 a new seed alone redraws nearly the
 * same picture (8 seeds of one prompt gave 8 copies of the same composition, the same glass pane
 * between the two people), so a redraw changes the prompt: two or more people swap sides (a mirrored
 * composition), and after a wall or divider between them, every glass and divider word is left out
 * of the scenery (clearSpace). A frame of one person is returned unchanged. Pure.
 */
export function redrawVariant(spec, attempt, reasons = []) {
    if (!attempt || !spec) return spec;
    const people = Array.isArray(spec.people) ? spec.people : [];
    const wall = (reasons || []).some((r) => /wall or divider|barrier|partition|glass/i.test(String(r)));
    if (people.length < 2 && !wall) return spec;
    const flip = (side) => (side === 'left' ? 'right' : side === 'right' ? 'left' : side);
    return {
        ...spec,
        ...(people.length >= 2 && attempt % 2 === 1 ? { people: people.map((p) => ({ ...p, side: flip(p.side) })) } : {}),
        ...(wall ? { clearSpace: true } : {}),
    };
}

/**
 * A close-up of hands that the quality check rejected twice is not shown: the image model draws a second pair of hands,
 * a torso, a handoff nobody wrote (1.12 live test, "two hands lift a box": checked twice, shown anyway). The same
 * moment is drawn once more as an ordinary medium shot of the person doing it. Only for an insert that HAS a person
 * (a hand-over keeps both people); an insert of an object alone has nobody to draw. Pure.
 * @returns {{spec: object, camera: object}|null}
 */
export function fallbackFromInsert(spec, camera) {
    if (spec?.kind !== 'insert') return null;
    const people = (spec.people || []).filter((p) => p?.name);
    if (!people.length) return null;
    const own = camera?.angle === 'pov' ? 'pov' : (camera?.angle && camera.angle !== 'over the shoulder' ? camera.angle : 'eye level');
    return {
        spec: { ...spec, kind: 'character', characters: (spec.characters || people.map((p) => p.name)), people },
        camera: { shot: 'medium shot', angle: own },
    };
}
