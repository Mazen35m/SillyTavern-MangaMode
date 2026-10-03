import { computeOccupancyMap, hairColorOf, locateColor, locateFaces, focalCentroid, skinToneOf } from './image-analysis.js';
import { placeBubbleGroups, trimGutters, headZones, locatedFor } from './bubble-placement.js';
import { sameName } from './cast-book.js';
import {
    GEOMETRY_CONFIG,
    computeGroupGeometry,
    toShoutGeometry,
    computeTailShape,
    segmentsToPathData,
    polygonPointsAttr,
} from './bubble-geometry.js';

const OVERLAY_CLASS = 'manga_bubbles_overlay';
const BUBBLE_TYPES = ['speech', 'thought', 'narration', 'shout', 'inner'];
const SHOUT_DIRECTION = /\b(shout|shouts|shouting|yell|yells|yelling|scream|screams|screaming|roar|roars|bellow|bellows|cries out|howl)/i;
const TAIL_SIDES = ['left', 'center', 'right'];
const SVG_NS = 'http://www.w3.org/2000/svg';
// A balloon covering more busy artwork than this triggers a gutter expansion.
const BUSY_COVERAGE = 0.33;

const BODY_FILL = '#ffffff';
const BODY_STROKE = '#000000';

// Arabic, Syriac, Thaana, Hebrew and the Arabic presentation forms.
const RTL_PATTERN = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;

// Defence in depth: the scene parser is told to keep markdown out of dialogue, but a stray emphasis
// marker rendered literally inside a balloon is an obvious, ugly tell - so strip paired markers here
// too. Only markers wrapping content are removed, never lone punctuation inside the words.
const MARKDOWN_PAIRS = [
    /\*\*\*(.+?)\*\*\*/g,
    /\*\*(.+?)\*\*/g,
    /\*(.+?)\*/g,
    /__(.+?)__/g,
    /~~(.+?)~~/g,
    /`(.+?)`/g,
];

/**
 * @param {string} text
 * @returns {string}
 */
function stripInlineMarkdown(text) {
    let out = String(text);
    for (const pattern of MARKDOWN_PAIRS) out = out.replace(pattern, '$1');
    return out.trim();
}

const SPLIT_AFTER = /[,;:،؛—–]$|\.\.\.$|…$/;
const SPLIT_BEFORE = /^(and|but|or|yet|so|because|before|after|when|while|which|that|until|unless|though|although|where)$/i;

/**
 * Splits one over-long dialogue line into balloon-sized pieces - split only, never altered: the
 * pieces joined with single spaces are the original words. Prefers a punctuation or clause
 * boundary near the middle, falls back to the middle word. The scene parser is asked to do this
 * already; this is the guarantee when it doesn't (live: 29- and 31-word entries).
 * @param {string} text
 * @param {number} [maxWords]
 * @returns {string[]}
 */
export function splitLongLine(text, maxWords = 18) {
    const words = String(text).trim().split(/\s+/).filter(Boolean);
    if (words.length <= maxWords) return [words.join(' ')];
    const mid = words.length / 2;
    let best = -1;
    let bestDistance = Infinity;
    for (let i = 3; i <= words.length - 3; i++) {
        const boundary = SPLIT_AFTER.test(words[i - 1]) || SPLIT_BEFORE.test(words[i]);
        const distance = Math.abs(i - mid) + (boundary ? 0 : words.length); // any boundary beats none
        if (distance < bestDistance) {
            bestDistance = distance;
            best = i;
        }
    }
    if (best < 0) best = Math.round(mid);
    return [...splitLongLine(words.slice(0, best).join(' '), maxWords), ...splitLongLine(words.slice(best).join(' '), maxWords)];
}

/**
 * Arabic (and other RTL-script) text needs `dir="rtl"` per-line for correct shaping/direction -
 * this is independent of the page's own language, since English and Arabic lines can coexist.
 * @param {string} text
 * @returns {boolean}
 */
function isRtlText(text) {
    return RTL_PATTERN.test(text);
}

/**
 * Finds the scene character a dialogue line's speaker refers to, by case-insensitive name match.
 * @param {string} speaker
 * @param {object[]} characters
 * @returns {object | null}
 */
function matchCharacter(speaker, characters) {
    if (!speaker || !Array.isArray(characters)) return null;
    const normalized = speaker.trim().toLowerCase();
    // The exact name first; else the same person under another form of the name ("Roland" for "Guard
    // Roland"): an unmatched speaker got a tail that pointed at nobody.
    return characters.find((c) => typeof c?.name === 'string' && c.name.trim().toLowerCase() === normalized)
        || characters.find((c) => typeof c?.name === 'string' && sameName(c.name, speaker))
        || null;
}

/**
 * Builds one simple bubble DOM element - used for narration captions, and as the degraded-mode
 * fallback if a speech group's SVG geometry fails to build. Not used for normal speaker dialogue
 * (see `buildSvgSpeechGroup`).
 * @param {string} text
 * @param {'speech'|'thought'|'narration'} bubbleType
 * @returns {JQuery<HTMLElement>}
 */
function buildBubbleElement(text, bubbleType) {
    const bubble = $('<div>', {
        class: `manga_bubble manga_bubble_${bubbleType}`,
        dir: isRtlText(text) ? 'rtl' : 'ltr',
    });
    bubble.append($('<span>', { class: 'manga_bubble_text' }).text(text));
    return bubble;
}

/**
 * Measures each line's natural rendered text box, using the exact same class/constraints
 * (`.manga_bubble_lobe_text`, including its `max-width` wrap limit) the final text will render
 * with, so wrapping never differs between measurement and the real thing.
 * @param {JQuery<HTMLElement>} container Live, in-DOM element to measure inside (styles must apply).
 * @param {string[]} lines
 * @returns {{width: number, height: number}[]}
 */
function measureLobeTextBoxes(container, lines) {
    const measureHost = $('<div>', { class: 'manga_bubble_measure_host' }).appendTo(container);
    const boxes = lines.map((text) => {
        const span = $('<span>', {
            class: 'manga_bubble_lobe_text',
            dir: isRtlText(text) ? 'rtl' : 'ltr',
        }).text(text).appendTo(measureHost);
        // getBoundingClientRect (fractional) rather than offsetWidth (rounded to an integer):
        // a rounded-down width is sometimes a fraction of a pixel narrower than the real text, and
        // since the final span is sized from this number, that fraction makes short lines wrap.
        const r = span[0].getBoundingClientRect();
        return { width: Math.ceil(r.width), height: Math.ceil(r.height) };
    });
    measureHost.remove();
    return boxes;
}

/**
 * Which dashed pattern (if any) the group's SVG outline stroke uses - mirrors the old per-bubble
 * speech/thought/unmatched-speaker distinction, now expressed as one stroke property on the whole
 * group instead of a class per bubble.
 * @param {{matched: boolean, bubbleType: string}} group
 * @returns {string}
 */
function strokeDasharrayFor(group) {
    // An inferred inner thought (never said aloud): a dotted outline, so it cannot be mistaken for speech.
    if (group.bubbleType === 'inner') return '0.1 6';
    if (!group.matched) return '2 4';
    if (group.bubbleType === 'thought') return '6 4';
    return 'none';
}

/**
 * Builds one speaker's speech group as a single SVG balloon (merged lobe outline + shared tail)
 * with HTML text laid on top. Throws on any unexpected geometry failure - callers must catch and
 * fall back, per `buildSpeechGroupElement`.
 * @param {JQuery<HTMLElement>} overlay Live container to temporarily measure text in.
 * @param {{texts: string[], bubbleType: string, hintSide: string|null, matched: boolean}} group
 * @returns {{el: JQuery<HTMLElement>, matched: boolean, setTail: (tailSide: string|null) => void}}
 */
function buildSvgSpeechGroup(overlay, group) {
    const textBoxes = measureLobeTextBoxes(overlay, group.texts);
    const baseGeometry = computeGroupGeometry(textBoxes, GEOMETRY_CONFIG);
    if (!baseGeometry) throw new Error('empty geometry');
    const geometry = group.bubbleType === 'shout' ? toShoutGeometry(baseGeometry) : baseGeometry;

    const groupEl = $('<div>', { class: 'manga_bubble_group' }).css({
        width: `${geometry.width}px`,
        height: `${geometry.height}px`,
    });

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'manga_bubble_svg');
    svg.setAttribute('width', String(geometry.width));
    svg.setAttribute('height', String(geometry.height));
    svg.setAttribute('viewBox', `0 0 ${geometry.width} ${geometry.height}`);

    const bodyPath = document.createElementNS(SVG_NS, 'path');
    bodyPath.setAttribute('d', segmentsToPathData(geometry.segments));
    bodyPath.setAttribute('fill', BODY_FILL);
    bodyPath.setAttribute('stroke', BODY_STROKE);
    bodyPath.setAttribute('stroke-width', String(GEOMETRY_CONFIG.strokeWidth));
    bodyPath.setAttribute('stroke-dasharray', strokeDasharrayFor(group));
    bodyPath.setAttribute('stroke-linejoin', 'round');
    if (group.bubbleType === 'inner') bodyPath.setAttribute('stroke-linecap', 'round');
    svg.appendChild(bodyPath);

    const tailOuter = document.createElementNS(SVG_NS, 'polygon');
    tailOuter.setAttribute('fill', BODY_STROKE);
    const tailInner = document.createElementNS(SVG_NS, 'polygon');
    tailInner.setAttribute('fill', BODY_FILL);
    svg.appendChild(tailOuter);
    svg.appendChild(tailInner);

    const textLayer = $('<div>', { class: 'manga_bubble_text_layer' });
    geometry.lobes.forEach((lobe, i) => {
        const text = group.texts[i];
        $('<span>', {
            class: `manga_bubble_lobe_text${group.bubbleType === 'inner' ? ' manga_inner_text' : ''}`,
            dir: isRtlText(text) ? 'rtl' : 'ltr',
        }).text(text).css({
            left: `${lobe.cx - lobe.textWidth / 2}px`,
            top: `${lobe.cy - lobe.textHeight / 2}px`,
            width: `${lobe.textWidth}px`,
        }).appendTo(textLayer);
    });

    groupEl.append(svg, textLayer);

    const setTail = (tailSide, tailUp = false) => {
        if (!group.matched || !tailSide) {
            tailOuter.setAttribute('points', '');
            tailInner.setAttribute('points', '');
            return;
        }
        const tail = computeTailShape(geometry, tailSide, GEOMETRY_CONFIG, tailUp);
        if (!tail) return;
        tailOuter.setAttribute('points', polygonPointsAttr(tail.outer));
        tailInner.setAttribute('points', polygonPointsAttr(tail.inner));
    };

    return { el: groupEl, matched: group.matched, setTail };
}

/**
 * Degraded-mode fallback if `buildSvgSpeechGroup` throws for any reason: plain stacked oval divs
 * (the pre-SVG bubble style), no shared tail. Never blocks rendering, never drops dialogue text.
 * @param {{texts: string[], bubbleType: string, matched: boolean}} group
 * @returns {{el: JQuery<HTMLElement>, matched: boolean, setTail: (tailSide: string|null) => void}}
 */
function buildFallbackGroupElement(group) {
    const groupEl = $('<div>', { class: 'manga_bubble_group manga_bubble_group_fallback' });
    for (const text of group.texts) {
        const bubbleEl = buildBubbleElement(text, group.bubbleType);
        bubbleEl.addClass('manga_bubble_no_tail');
        groupEl.append(bubbleEl);
    }
    return { el: groupEl, matched: false, setTail: () => {} };
}

/** A narration caption: rectangular box, no tail, positioned like any other group. */
function buildCaptionElement(text) {
    const groupEl = $('<div>', { class: 'manga_bubble_group manga_caption_group' });
    const caption = buildBubbleElement(text, 'narration');
    caption.addClass('manga_bubble_no_tail');
    groupEl.append(caption);
    return { el: groupEl, matched: false, setTail: () => {} };
}

/**
 * @param {JQuery<HTMLElement>} overlay
 * @param {{texts: string[], bubbleType: string, hintSide: string|null, matched: boolean}} group
 */
function buildSpeechGroupElement(overlay, group) {
    try {
        return buildSvgSpeechGroup(overlay, group);
    } catch (error) {
        console.warn('[Manga Mode] Speech-group geometry failed, using simple fallback bubbles:', error);
        return buildFallbackGroupElement(group);
    }
}

/**
 * Renders (or removes) the speech bubble overlay for a manga panel's image, from the cached scene's
 * `dialogue` array. Pure DOM rendering of already-cached data - never triggers generation and never
 * touches the underlying image file.
 *
 * Composition: consecutive dialogue lines from the same speaker are rendered as ONE speech group -
 * a single SVG balloon whose lobes (one per dialogue line) overlap into one connected outline, with
 * HTML text laid on top (see `buildSvgSpeechGroup` / bubble-geometry.js). Each group carries exactly
 * one shared tail. The dialogue data model itself is untouched - this only changes how consecutive
 * same-speaker entries are drawn.
 *
 * Placement: unchanged. Each group is still positioned by the candidate-region engine in
 * bubble-placement.js against the image-analysis.js occupancy map, using the group's outer DOM
 * bounding box (which the SVG's own `width`/`height` sets exactly) - screen_position is only ever a
 * weak tie-breaker there. Every group starts at a sane top-right default (via CSS) so bubbles are
 * never invisible/unplaced; that default is overwritten once the image loads and placement runs.
 * @param {JQuery<HTMLElement>} imageWrap The `.manga_image_wrap` element containing the `<img>`.
 * @param {object} scene The cached scene object (`mes.extra.manga.scene`).
 * @param {boolean} showBubbles Whether bubbles should be shown at all (the settings toggle).
 */
export function renderBubblesOverlay(imageWrap, scene, showBubbles, { identities = [], visibleNames = null, shot = '', sfx = '', focusSide = null, heads = null } = {}) {
    imageWrap.find(`.${OVERLAY_CLASS}`).remove();

    imageWrap.find('.manga_sfx').remove();
    if (showBubbles && sfx) renderSfx(imageWrap, sfx, focusSide);
    const dialogue = Array.isArray(scene?.dialogue) ? scene.dialogue : [];
    if (!showBubbles || !dialogue.length) return;

    const characters = Array.isArray(scene?.characters) ? scene.characters : [];

    const overlay = $('<div>', { class: OVERLAY_CLASS });

    // One group per unique speaker (matched character name, or the raw speaker string if
    // unmatched) - every dialogue line from that speaker becomes one lobe in the same speech
    // group. Bubble/lobe count always equals the number of dialogue entries; nothing here adds or
    // drops a line for layout purposes.
    // Capped at 2 lobes per merged balloon: past that, the pairwise-merge outline (see
    // bubble-geometry.js) starts drawing overlapping/crossing strokes through shared middle
    // lobes, and reference webtoon panels don't actually merge 3+ consecutive lines into one big
    // blob either - they just place separate bubbles near each other. A speaker's 3rd+
    // consecutive line starts a fresh group/balloon instead of being crammed into one cluster.
    const MAX_LOBES_PER_GROUP = 2;
    const groups = new Map();
    const groupOrder = [];
    const activeKeyForSpeaker = new Map();
    const chunkCountForSpeaker = new Map();
    let lastBaseKey = null;

    const pieces = [];
    for (const line of dialogue) {
        if (!line || typeof line.text !== 'string' || !line.text.trim()) continue;
        for (const piece of splitLongLine(line.text)) pieces.push({ ...line, text: piece });
    }

    for (const line of pieces) {
        // `line.direction` (delivery notes / stage directions) is deliberately NOT rendered - it
        // feeds the image prompt only. Printing it in a balloon is what makes generated comics read
        // as machine output rather than lettering.
        const lineText = stripInlineMarkdown(line.text);
        if (!lineText) continue;
        let bubbleType = BUBBLE_TYPES.includes(line.bubble_type) ? line.bubble_type : 'speech';
        // Shouting is drawn as a burst even when the parser only marked it "speech": an
        // exclamation delivered with a shouting direction ("she yells over the rain").
        if (bubbleType === 'speech' && /!/.test(lineText) && SHOUT_DIRECTION.test(String(line.direction || ''))) {
            bubbleType = 'shout';
        }

        if (bubbleType === 'narration') {
            // Captions are placed by the same engine as balloons, in reading order - a caption that
            // closes the reply belongs at the bottom, and a fixed top row used to collide with the
            // first balloon.
            lastBaseKey = null;
            const key = `narration#${groupOrder.length}`;
            groups.set(key, { texts: [lineText], bubbleType, hintSide: null, matched: false, speakerName: null, narration: true });
            groupOrder.push(key);
            continue;
        }

        const character = matchCharacter(line.speaker, characters);
        const baseKey = character
            ? `char:${character.name.trim().toLowerCase()}`
            : `speaker:${String(line.speaker || '').trim().toLowerCase()}`;

        // Only CONSECUTIVE lines of one speaker share a balloon. If someone else spoke (or a
        // narration caption came) in between, this is a new balloon later in the reading order -
        // merging it into the earlier one would put the reply before the line it answers.
        let key = lastBaseKey === baseKey ? activeKeyForSpeaker.get(baseKey) : null;
        lastBaseKey = baseKey;
        // A burst holds one line, and a shout never merges into a calm balloon (or vice versa).
        const maxLobes = bubbleType === 'shout' ? 1 : MAX_LOBES_PER_GROUP;
        if (!key || groups.get(key).texts.length >= maxLobes || groups.get(key).bubbleType !== bubbleType) {
            const chunkIndex = chunkCountForSpeaker.get(baseKey) || 0;
            key = `${baseKey}#${chunkIndex}`;
            chunkCountForSpeaker.set(baseKey, chunkIndex + 1);
            activeKeyForSpeaker.set(baseKey, key);
            groups.set(key, {
                texts: [],
                bubbleType,
                hintSide: character && TAIL_SIDES.includes(character.screen_position) ? character.screen_position : null,
                matched: !!character,
                speakerName: character ? character.name : null,
            });
            groupOrder.push(key);
        }
        groups.get(key).texts.push(lineText);
    }

    if (!groupOrder.length) return;

    imageWrap.append(overlay);

    // Group elements are built (and text measured) only now that `overlay` is live in the DOM, so
    // `.manga_bubble_lobe_text`'s CSS (font-size, max-width wrap limit) is actually in effect.
    const groupElements = new Map();
    for (const key of groupOrder) {
        const group = groups.get(key);
        const entry = group.narration ? buildCaptionElement(group.texts[0]) : buildSpeechGroupElement(overlay, group);
        entry.setTail(group.matched ? (group.hintSide || 'center') : null);
        groupElements.set(key, entry);
        overlay.append(entry.el);
    }

    if (!groupOrder.length) return;

    const imgEl = imageWrap.find('img.manga_image')[0];
    if (!imgEl) return;

    const people = visibleNames
        ? characters.filter((c) => visibleNames.some((n) => String(n).toLowerCase() === String(c?.name || '').toLowerCase()))
        : characters;
    const place = () => placeGroups(imgEl, overlay, groupOrder, groups, groupElements, { people, identities, shot, heads });
    // A picture that loads while its message is hidden (collapsed, another tab) has no size yet: placement
    // used to give up silently and leave every balloon at the default top-right corner for good. It now waits
    // until the panel has a size.
    const runPlacement = () => {
        const ready = () => overlay[0]?.clientWidth > 0 && overlay[0]?.clientHeight > 0 && imgEl.clientWidth > 0 && imgEl.clientHeight > 0;
        if (ready() || typeof ResizeObserver !== 'function') { place(); return; }
        const observer = new ResizeObserver(() => { if (ready()) { observer.disconnect(); place(); } });
        observer.observe(overlay[0]);
        observer.observe(imgEl);
        setTimeout(() => observer.disconnect(), 10 * 60 * 1000);
    };
    if (imgEl.complete && imgEl.naturalWidth > 0) {
        runPlacement();
    } else {
        imgEl.addEventListener('load', runPlacement, { once: true });
    }
}

/**
 * Measures each group's actual rendered size, runs the occupancy analysis + placement engine
 * (both unchanged), and applies the results. Any failure at any step leaves groups at their
 * default/fallback position rather than throwing or hiding dialogue.
 * @param {HTMLImageElement} imgEl
 * @param {string[]} groupOrder
 * @param {Map<string, {texts: string[], bubbleType: string, hintSide: string|null, matched: boolean}>} groups
 * @param {Map<string, {el: JQuery<HTMLElement>, matched: boolean, setTail: (tailSide: string|null) => void}>} groupElements
 */
/**
 * Finds each visible person in the actual image by their distinctive hair colour (from the card's
 * canonical traits, or the scene's stated look). The scene's screen_position is written before the
 * image exists and is often mirrored; the image decides where the speaker really is. With two
 * people and only one found, the other is taken to be on the opposite side.
 * @returns {Map<string, {x: number, y: number}>} lower-cased name -> image-fraction point
 */
function locatePeople(imgEl, people, identities, occupancyMap, faces = []) {
    const found = new Map();
    const byName = new Map((identities || []).map((i) => [String(i.name).toLowerCase(), i]));
    // Faces near the top, and not much smaller than the biggest (wood and arms are skin-coloured).
    const near = faces.filter((f) => f.y < faces[0].y + 0.12);
    const biggest = Math.max(0, ...near.map((f) => f.share || 0));
    const top = near.filter((f) => !biggest || (f.share || 0) >= biggest * 0.6);
    for (const person of people) {
        const key = String(person?.name || '').toLowerCase();
        const identity = byName.get(key);
        const color = hairColorOf(identity?.appearance?.physicalTraits) || hairColorOf(person?.visual_tags) || hairColorOf(person?.appearance);
        if (!color) continue;
        const point = locateColor(imgEl, color);
        if (!point) continue;
        // Colour far from every face is scenery (yellow grass read as blonde hair).
        if (top.length && !top.some((f) => Math.abs(f.x - point.x) < 0.18 && point.y < f.y + 0.1)) continue;
        found.set(key, point);
    }
    // Two different people found at nearly the same spot means the colour search is confused.
    const points = [...found.values()];
    if (points.length === 2 && Math.abs(points[0].x - points[1].x) < 0.12) found.clear();
    // Anyone not found by colour gets a free face: by stated side, else the one nearest the middle.
    const free = top.filter((f) => ![...found.values()].some((p) => Math.abs(p.x - f.x) < 0.15));
    for (const person of people) {
        const key = String(person?.name || '').toLowerCase();
        if (found.has(key) || !free.length) continue;
        const want = person?.screen_position === 'left' ? 0 : person?.screen_position === 'right' ? 1 : 0.5;
        const face = free.reduce((a, b) => (Math.abs(b.x - want) < Math.abs(a.x - want) ? b : a));
        free.splice(free.indexOf(face), 1);
        found.set(key, { x: face.x, y: face.y - face.spreadY, spreadY: face.spreadY });
    }
    if (people.length === 2 && found.size === 1) {
        const [knownName, known] = [...found.entries()][0];
        const other = people.find((p) => String(p?.name || '').toLowerCase() !== knownName);
        const range = known.x < 0.5 ? [0.5, 1] : [0, 0.5];
        const focal = focalCentroid(occupancyMap, range);
        if (other && focal) found.set(String(other.name).toLowerCase(), { x: focal.x, y: Math.max(0, focal.y - 0.15) });
    }
    return found;
}

function placeGroups(imgEl, overlay, groupOrder, groups, groupElements, { people = [], identities = [], grownBy = null, shot = '', heads = null } = {}) {
    const overlayEl = overlay[0];
    if (!overlayEl) return;

    // Placement works in STRIP space (artwork + the white gutter bands above/below it), which is
    // exactly the overlay's own box - not image space. `imageRect` tells the engine where the art
    // sits inside that strip so it can treat the gutters as free, usable bubble space.
    const stripWidth = overlayEl.clientWidth;
    const stripHeight = overlayEl.clientHeight;
    if (!stripWidth || !stripHeight) return;
    if (!imgEl.clientWidth || !imgEl.clientHeight) return;

    const oRect = overlayEl.getBoundingClientRect();
    const iRect = imgEl.getBoundingClientRect();
    const imageRect = {
        x0: (iRect.left - oRect.left) / stripWidth,
        y0: (iRect.top - oRect.top) / stripHeight,
        x1: (iRect.right - oRect.left) / stripWidth,
        y1: (iRect.bottom - oRect.top) / stripHeight,
    };

    let occupancyMap = null;
    try {
        occupancyMap = computeOccupancyMap(imgEl);
    } catch (error) {
        console.warn('[Manga Mode] Bubble placement image analysis threw, using hint-only fallback:', error);
    }

    let located = new Map();
    let faces = [];
    // Heads the quality check found in this very picture: exact, where the skin-colour search
    // took timber walls for faces. Used instead of the search whenever the frame has them.
    const known = Array.isArray(heads) ? heads.filter((h) => h?.box) : [];
    if (known.length) {
        faces = known.map((h) => {
            const b = h.box;
            const spreadY = (b.y1 - b.y0) / 3.4;
            return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, spreadY, share: (b.x1 - b.x0) * (b.y1 - b.y0) };
        }).sort((a, b) => a.y - b.y);
        for (const h of known) {
            if (!h.name) continue;
            const b = h.box;
            located.set(String(h.name).toLowerCase(), { x: (b.x0 + b.x1) / 2, y: b.y0 + (b.y1 - b.y0) * 0.3, spreadY: (b.y1 - b.y0) / 3.4 });
        }
    }
    if (!known.length) try {
        const byName = new Map((identities || []).map((i) => [String(i.name).toLowerCase(), i]));
        const tones = [...new Set(people.map((p) => skinToneOf(`${byName.get(String(p?.name || '').toLowerCase())?.appearance?.physicalTraits || ''}, ${p?.visual_tags || ''}`)))];
        faces = locateFaces(imgEl, 3, tones.length ? tones : ['light']);
    } catch {
        faces = [];
    }
    if (people.length >= 1 && !known.length) {
        try {
            located = locatePeople(imgEl, people, identities, occupancyMap, faces);
        } catch (error) {
            console.warn('[Manga Mode] Could not locate speakers in the image:', error);
        }
    }
    // Every face found in the picture is kept clear too - also ones the scene did not name.
    const avoid = [...headZones(people, located, shot), ...faces.map((f) => {
        const r = Math.max(0.06, f.spreadY * 2.4);
        return { x0: f.x - r, x1: f.x + r, y0: f.y - r * 1.2, y1: f.y + r };
    })];

    const placementGroups = groupOrder.map((key) => {
        const entry = groupElements.get(key);
        const group = groups.get(key);
        const point = group.speakerName ? locatedFor(located, group.speakerName) : null;
        return {
            id: key,
            width: entry.el[0].offsetWidth,
            height: entry.el[0].offsetHeight,
            hintSide: point ? (point.x < 0.4 ? 'left' : point.x > 0.6 ? 'right' : 'center') : group.hintSide,
            // Image-space point of the speaker's head, converted to strip space by the engine.
            target: point ? { x: point.x, y: point.y } : null,
        };
    });

    let placements;
    try {
        placements = placeBubbleGroups({ stripWidth, stripHeight, imageRect, groups: placementGroups, occupancyMap, avoid });
    } catch (error) {
        console.warn('[Manga Mode] Bubble placement scoring failed, keeping default position:', error);
        return;
    }

    // No clean space in the frame: webtoons move the balloon out of the panel rather than onto the
    // subject. Grow this panel's gutters once and place again, so the gutter can take it.
    const worst = Math.max(0, ...[...placements.values()].map((p) => p.coverage || 0));
    // Webtoon mode has no gutters: balloons stay on the picture, never in a white band around it.
    const webtoon = Boolean(imgEl.closest('.manga_webtoon'));
    if (!webtoon && worst > BUSY_COVERAGE && !imgEl.closest('.manga_image_wrap')?.dataset.gutterGrown) {
        const wrapEl = imgEl.closest('.manga_image_wrap');
        if (wrapEl) {
            const tallest = Math.max(...placementGroups.map((g) => g.height));
            const style = getComputedStyle(wrapEl);
            const grow = Math.ceil(tallest + 16);
            const baseTop = parseFloat(style.paddingTop);
            const baseBottom = parseFloat(style.paddingBottom);
            wrapEl.style.paddingTop = `${baseTop + grow}px`;
            wrapEl.style.paddingBottom = `${baseBottom + grow}px`;
            wrapEl.dataset.gutterGrown = '1';
            placeGroups(imgEl, overlay, groupOrder, groups, groupElements, { people, identities, shot, heads, grownBy: { grow, baseTop, baseBottom } });
            return;
        }
    }

    // A grown gutter that ended up holding no balloon is just dead white space: give it back.
    let shiftY = 0;
    if (grownBy) {
        const wrapEl = imgEl.closest('.manga_image_wrap');
        const artTop = imageRect.y0 * stripHeight;
        const artBottom = imageRect.y1 * stripHeight;
        const placed = groupOrder.map((key) => ({ p: placements.get(key), h: groupElements.get(key)?.el[0].offsetHeight || 0 })).filter((x) => x.p);
        const usesTop = placed.some(({ p }) => p.top < artTop - 1);
        const usesBottom = placed.some(({ p, h }) => p.top + h > artBottom + 1);
        const trimmed = trimGutters({ usesTop, usesBottom, ...grownBy });
        if (wrapEl) {
            wrapEl.style.paddingTop = `${trimmed.top}px`;
            wrapEl.style.paddingBottom = `${trimmed.bottom}px`;
        }
        shiftY = trimmed.shiftY;
    }
    // Any gutter holding no balloon shrinks to a thin page margin: two empty 40px gutters stacked
    // between panels read as a hole in the page.
    const wrapForTrim = imgEl.closest('.manga_image_wrap');
    if (!webtoon && wrapForTrim && !imgEl.closest('.manga_frame')) {
        const topNow = parseFloat(wrapForTrim.style.paddingTop || getComputedStyle(wrapForTrim).paddingTop) || 0;
        const bottomNow = parseFloat(wrapForTrim.style.paddingBottom || getComputedStyle(wrapForTrim).paddingBottom) || 0;
        const artTop = imageRect.y0 * stripHeight;
        const artBottom = imageRect.y1 * stripHeight;
        const placed = groupOrder.map((key) => ({ p: placements.get(key), h: groupElements.get(key)?.el[0].offsetHeight || 0 })).filter((x) => x.p);
        const THIN = 12;
        if (!placed.some(({ p }) => p.top < artTop - 1) && topNow > THIN) {
            wrapForTrim.style.paddingTop = `${THIN}px`;
            shiftY -= topNow - THIN;
        }
        if (!placed.some(({ p, h }) => p.top + h > artBottom + 1) && bottomNow > THIN) {
            wrapForTrim.style.paddingBottom = `${THIN}px`;
        }
    }

    for (const key of groupOrder) {
        const placement = placements.get(key);
        if (!placement) continue;

        const entry = groupElements.get(key);
        entry.el.css({ left: `${placement.left}px`, top: `${placement.top + shiftY}px`, right: 'auto' });
        entry.el.attr('data-placed', '1');

        if (entry.matched) {
            entry.setTail(placement.tailSide, placement.tailUp);
        }
    }
}

/**
 * A sound effect / reaction mark ("THUNK", "?!") lettered over the art, manga style: big, bold,
 * tilted, outlined - in the upper corner away from the speaker's side.
 */
function renderSfx(host, text, focusSide) {
    const clean = stripInlineMarkdown(String(text || '')).slice(0, 24);
    if (!clean) return;
    const side = focusSide === 'left' ? 'right' : 'left';
    const el = $('<div>', { class: `manga_sfx manga_sfx_${side}` }).text(clean);
    const img = host.find('img.manga_image')[0];
    const frame = img ? $(img).parent() : host;
    frame.append(el);
    // A single panel's wrap has gutters that grow when balloons move off the art; the effect must
    // stay on the picture (a "tap" floated in the white gutter above it), so it follows the image.
    if (img && frame.hasClass('manga_image_wrap')) {
        const place = () => el.css('top', `${img.offsetTop + Math.round(img.offsetHeight * 0.05)}px`);
        place();
        img.addEventListener('load', place);
        if (typeof ResizeObserver === 'function') new ResizeObserver(place).observe(frame[0]);
    }
}
