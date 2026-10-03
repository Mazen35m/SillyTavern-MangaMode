// Pure geometry for one speaker's speech-group balloon: turns measured per-line text boxes into
// a cluster of overlapping ellipse "lobes" plus a single outer outline, and a shared tail shape.
// No DOM access here - bubbles.js is responsible for measuring text and drawing the SVG/HTML this
// module describes. Kept isolated from bubble-placement.js/image-analysis.js on purpose: this is
// only about how a group *looks*, never about where it goes.

export const GEOMETRY_CONFIG = {
    paddingV: 16,
    paddingVFactor: 0.30,
    paddingH: 20,
    paddingHFactor: 0.16,
    minRx: 42,
    minRy: 32,
    rxSlack: 1.08,
    rySlack: 1.15,
    // Lobes join at a narrow waist instead of sinking into one another. Two consecutive lines that
    // both hit the text wrap cap produce lobes of IDENTICAL rx, and two same-width ellipses
    // overlapped deeply read as two stacked ovals rather than one balloon - the shallow join reads
    // as two balloons touching, which is what the reference material actually does. Scales with lobe
    // size rather than being a fixed pixel gap. Below roughly 0.05 the numeric union search starts
    // to come back degenerate and the outline falls back to two separate ellipses.
    overlapFraction: 0.12,
    lobeOffsetFraction: 0.12,   // small alternating horizontal stagger, as a fraction of each lobe's own rx
    marginPad: 4,
    strokeWidth: 3,
    tailLength: 16,
    tailHalfWidth: 11,
    tailInset: 2,
    mergeSamples: 180,          // angular resolution for the numeric ellipse-union search - crisp, no blur
};

/**
 * @typedef {{rx: number, ry: number, cx: number, cy: number, textWidth: number, textHeight: number}} Lobe
 * @typedef {{lobes: Lobe[], segments: {x: number, y: number}[][], width: number, height: number}} GroupGeometry
 */

/**
 * @param {{width: number, height: number}[]} textBoxes Measured (rendered) text box per dialogue line, in order.
 * @param {typeof GEOMETRY_CONFIG} [config]
 * @returns {GroupGeometry | null} Null only if given zero text boxes.
 */
export function computeGroupGeometry(textBoxes, config = GEOMETRY_CONFIG) {
    const safeBoxes = (textBoxes || [])
        .map((b) => {
            const width = b?.width || 0;
            const height = b?.height || 0;
            if (!width || !height) {
                console.warn('[Manga Mode] zero-size text box, falling back to 1px - measurement likely failed upstream', b);
            }
            return { width: Math.max(1, width), height: Math.max(1, height) };
        });
    if (!safeBoxes.length) return null;

    const rawLobes = layoutLobes(safeBoxes, config);
    const segments = buildOutlineSegments(rawLobes, config);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const lobe of rawLobes) {
        minX = Math.min(minX, lobe.cx - lobe.rx);
        maxX = Math.max(maxX, lobe.cx + lobe.rx);
        minY = Math.min(minY, lobe.cy - lobe.ry);
        maxY = Math.max(maxY, lobe.cy + lobe.ry);
    }

    const margin = config.marginPad + config.strokeWidth;
    const offsetX = margin - minX;
    const offsetY = margin - minY;

    const lobes = rawLobes.map((lobe) => ({ ...lobe, cx: lobe.cx + offsetX, cy: lobe.cy + offsetY }));
    const translatedSegments = segments.map((seg) => seg.map((p) => ({ x: p.x + offsetX, y: p.y + offsetY })));

    return {
        lobes,
        segments: translatedSegments,
        width: (maxX - minX) + margin * 2,
        height: (maxY - minY) + margin * 2,
    };
}

/**
 * One shared tail for the whole group, anchored on whichever lobe's outer edge best matches
 * `tailSide` (see `pickAnchorLobe`) - not necessarily the last-spoken lobe. Returns two small
 * triangles (outer outline color, inner fill color, inset by ~`strokeWidth`) - the same
 * double-triangle technique used for the previous per-bubble tail, just computed from the ellipse
 * geometry instead of hardcoded CSS offsets.
 * @param {GroupGeometry} geometry
 * @param {'left'|'center'|'right'} tailSide
 * @param {typeof GEOMETRY_CONFIG} [config]
 * @returns {{outer: {x: number, y: number}[], inner: {x: number, y: number}[]} | null}
 */
export function computeTailShape(geometry, tailSide, config = GEOMETRY_CONFIG, up = false) {
    if (!geometry || !geometry.lobes.length) return null;

    const anchor = pickAnchorLobe(geometry.lobes, tailSide, up);

    // Tails point down by default; `up` flips them for a balloon sitting in the gutter BELOW its
    // panel, whose tail has to reach back up into the art toward the speaker.
    const angleDeg = up
        ? (tailSide === 'left' ? 235 : tailSide === 'right' ? 305 : 270)
        : (tailSide === 'left' ? 125 : tailSide === 'right' ? 55 : 90);
    const t = (angleDeg * Math.PI) / 180;

    const base = {
        x: anchor.cx + anchor.rx * Math.cos(t),
        y: anchor.cy + anchor.ry * Math.sin(t),
    };

    // Outward normal of the ellipse at `base`.
    const nx = Math.cos(t) / anchor.rx;
    const ny = Math.sin(t) / anchor.ry;
    const nLen = Math.hypot(nx, ny) || 1;
    const normal = { x: nx / nLen, y: ny / nLen };
    const perp = { x: -normal.y, y: normal.x };

    const build = (halfWidth, length, inset) => {
        const b = { x: base.x - normal.x * inset, y: base.y - normal.y * inset };
        const apex = { x: b.x + normal.x * length, y: b.y + normal.y * length };
        const left = { x: b.x + perp.x * halfWidth, y: b.y + perp.y * halfWidth };
        const right = { x: b.x - perp.x * halfWidth, y: b.y - perp.y * halfWidth };
        return [left, apex, right];
    };

    return {
        outer: build(config.tailHalfWidth, config.tailLength, config.tailInset),
        inner: build(Math.max(2, config.tailHalfWidth - config.strokeWidth * 2), Math.max(2, config.tailLength - config.strokeWidth * 2), config.tailInset),
    };
}

/**
 * Which lobe the shared tail attaches to: the one whose *outer edge* best matches the resolved
 * tail direction, not simply the last-spoken (lowest) lobe - a speaker's tail can legitimately
 * belong to an earlier, upper lobe if that's the one actually sitting toward the speaker's side.
 * @param {Lobe[]} lobes
 * @param {'left'|'center'|'right'} tailSide
 * @returns {Lobe}
 */
function pickAnchorLobe(lobes, tailSide, up = false) {
    if (tailSide === 'left') {
        return lobes.reduce((best, l) => (l.cx - l.rx < best.cx - best.rx ? l : best));
    }
    if (tailSide === 'right') {
        return lobes.reduce((best, l) => (l.cx + l.rx > best.cx + best.rx ? l : best));
    }
    // 'center': no horizontal extremity to chase - the lobe on the side the tail exits from (the
    // lowest normally, the highest when the tail points back up) is the natural anchor.
    return lobes.reduce((best, l) => (up ? (l.cy < best.cy ? l : best) : (l.cy > best.cy ? l : best)));
}

/** @param {{x: number, y: number}[][]} segments */
export function segmentsToPathData(segments) {
    return segments
        .filter((seg) => seg.length >= 2)
        .map((seg) => {
            const [first, ...rest] = seg;
            return `M${fmt(first.x)},${fmt(first.y)} ${rest.map((p) => `L${fmt(p.x)},${fmt(p.y)}`).join(' ')} Z`;
        })
        .join(' ');
}

/** @param {{x: number, y: number}[]} points */
export function polygonPointsAttr(points) {
    return points.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(' ');
}

function fmt(n) {
    return Math.round(n * 100) / 100;
}

/**
 * Stacks lobes top-to-bottom with a proportional overlap and a small alternating horizontal
 * stagger, in an untranslated local coordinate space (first lobe centered at x=0).
 */
function layoutLobes(textBoxes, config) {
    const lobes = [];
    for (let i = 0; i < textBoxes.length; i++) {
        const box = textBoxes[i];
        const paddingV = Math.max(config.paddingV, box.height * config.paddingVFactor);
        const paddingH = Math.max(config.paddingH, box.width * config.paddingHFactor);
        const rx = Math.max(config.minRx, ((box.width + paddingH * 2) / 2) * config.rxSlack);
        const ry = Math.max(config.minRy, ((box.height + paddingV * 2) / 2) * config.rySlack);

        let cx, cy;
        if (i === 0) {
            cx = 0;
            cy = ry;
        } else {
            const prev = lobes[i - 1];
            const step = (prev.ry + ry) * (1 - config.overlapFraction);
            cy = prev.cy + step;
            cx = rx * config.lobeOffsetFraction * (i % 2 === 0 ? 1 : -1);

            // The step above only keeps this lobe a sane distance from its IMMEDIATE predecessor -
            // that's the intentional partial overlap that makes adjacent lobes read as one merged
            // balloon. With 3+ lobes of uneven size, that alone isn't enough: a later, smaller lobe
            // is never checked against anything but lobes[i - 1], so it can still end up colliding
            // with an earlier, non-adjacent lobe. Only adjacent pairs are meant to overlap (and are
            // the only pairs `buildOutlineSegments` merges) - so push this lobe down further, once
            // per earlier non-adjacent lobe, until it clears each of them with NO overlap at all.
            for (let j = 0; j < i - 1; j++) {
                const other = lobes[j];
                const minGap = other.ry + ry;
                if (cy - other.cy < minGap) {
                    cy = other.cy + minGap;
                }
            }
        }

        lobes.push({ rx, ry, cx, cy, textWidth: box.width, textHeight: box.height });
    }
    return lobes;
}

/**
 * Builds the outer-outline segment list for a lobe stack: a single ellipse for one lobe, a true
 * numerically-merged outline for each overlapping consecutive pair (falling back to two separate
 * ellipses only if that pair's merge search comes back degenerate), chained across the whole
 * group. Adjacent merged pieces share a lobe, so the *fill* always reads as one connected shape
 * (nonzero fill-rule) even on the rare pair where the merge itself falls back.
 */
function buildOutlineSegments(lobes, config) {
    if (lobes.length === 1) return [ellipsePolyline(lobes[0])];

    const segments = [];
    for (let i = 0; i < lobes.length - 1; i++) {
        const merged = mergeTwoEllipses(lobes[i], lobes[i + 1], config.mergeSamples);
        if (merged) {
            segments.push(merged);
        } else {
            segments.push(ellipsePolyline(lobes[i]));
            segments.push(ellipsePolyline(lobes[i + 1]));
        }
    }
    return segments;
}

function ellipsePolyline(e, samples = 180) {
    const pts = [];
    for (let i = 0; i < samples; i++) {
        pts.push(pointOnEllipse(e, (i / samples) * Math.PI * 2));
    }
    return pts;
}

function pointOnEllipse(e, t) {
    return { x: e.cx + e.rx * Math.cos(t), y: e.cy + e.ry * Math.sin(t) };
}

function isInsideEllipse(e, x, y) {
    const dx = (x - e.cx) / e.rx;
    const dy = (y - e.cy) / e.ry;
    return dx * dx + dy * dy <= 1;
}

/**
 * The arc of `eSelf` that lies outside `eOther` - one contiguous run for the typical
 * partial-overlap case. Returns the full ellipse if there's no overlap at all, or null if `eSelf`
 * is entirely inside `eOther` (degenerate - caller falls back to separate ellipses).
 */
function outerArcPoints(eSelf, eOther, samples) {
    const inside = new Array(samples);
    for (let i = 0; i < samples; i++) {
        const p = pointOnEllipse(eSelf, (i / samples) * Math.PI * 2);
        inside[i] = isInsideEllipse(eOther, p.x, p.y);
    }

    if (inside.every((v) => v)) return null;
    if (inside.every((v) => !v)) return ellipsePolyline(eSelf, samples);

    let start = -1;
    for (let i = 0; i < samples; i++) {
        if (!inside[i] && inside[(i - 1 + samples) % samples]) { start = i; break; }
    }
    if (start === -1) return null;

    const pts = [];
    for (let k = 0; k < samples; k++) {
        const i = (start + k) % samples;
        if (inside[i]) break;
        pts.push(pointOnEllipse(eSelf, (i / samples) * Math.PI * 2));
    }
    return pts.length >= 2 ? pts : null;
}

/**
 * True union outline of two overlapping ellipses: `eSelf`'s outer arc stitched to `eOther`'s outer
 * arc at their two crossing points, found numerically (sample + bisection-free linear search, fine
 * enough at `samples` resolution for on-screen bubble sizes) rather than via a closed-form quartic
 * solve. Crisp polyline, no blur/filter. Returns null (caller falls back to two separate ellipses)
 * if either arc search is degenerate or the resulting loop doesn't actually close up.
 */
function mergeTwoEllipses(e0, e1, samples) {
    const seg0 = outerArcPoints(e0, e1, samples);
    const seg1 = outerArcPoints(e1, e0, samples);
    if (!seg0 || !seg1 || seg0.length < 2 || seg1.length < 2) return null;

    const last0 = seg0[seg0.length - 1];
    const distToFirst1 = distance(last0, seg1[0]);
    const distToLast1 = distance(last0, seg1[seg1.length - 1]);
    const orderedSeg1 = distToLast1 < distToFirst1 ? [...seg1].reverse() : seg1;

    const loop = [...seg0, ...orderedSeg1];

    const gap = distance(loop[loop.length - 1], loop[0]);
    const maxRadius = Math.max(e0.rx, e0.ry, e1.rx, e1.ry);
    if (gap > maxRadius * 0.5) return null;

    return loop;
}

function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Shout balloon: the same outline, turned into a spiky burst. Spikes point away from the outline's
 * centre at regular arc-length intervals; the geometry grows by `amp` on every side so the spikes
 * never get clipped, and lobes (where the text sits) move with it.
 * @param {GroupGeometry} geometry
 * @param {{amp?: number, spacing?: number}} [options]
 * @returns {GroupGeometry}
 */
export function toShoutGeometry(geometry, { amp = 9, spacing = 16 } = {}) {
    const shift = amp;
    const segments = geometry.segments.map((seg) => {
        const pts = seg.map((p) => ({ x: p.x + shift, y: p.y + shift }));
        const c = pts.reduce((a, p) => ({ x: a.x + p.x / pts.length, y: a.y + p.y / pts.length }), { x: 0, y: 0 });
        const out = [];
        let acc = 0;
        let spike = true;
        for (let i = 0; i < pts.length; i++) {
            const a = pts[i];
            const b = pts[(i + 1) % pts.length];
            acc += Math.hypot(b.x - a.x, b.y - a.y);
            if (acc < spacing / 2) continue;
            acc = 0;
            const dx = a.x - c.x;
            const dy = a.y - c.y;
            const len = Math.hypot(dx, dy) || 1;
            const k = spike ? amp : -amp * 0.2;
            out.push({ x: a.x + (dx / len) * k, y: a.y + (dy / len) * k });
            spike = !spike;
        }
        return out.length >= 6 ? out : pts;
    });
    return {
        ...geometry,
        segments,
        lobes: geometry.lobes.map((l) => ({ ...l, cx: l.cx + shift, cy: l.cy + shift })),
        width: geometry.width + shift * 2,
        height: geometry.height + shift * 2,
    };
}
