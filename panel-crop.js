// Phase 4: produces "reframe" / "split" panels - a closer crop of an already generated image -
// without another ComfyUI run. The crop is saved as its own image file so the renderer, image
// analysis and bubble placement treat it exactly like a generated panel.
import { uniqueStamp } from './util.js';
import { computeOccupancyMap, focalCentroid, locateColor, locateFaces } from './image-analysis.js';

const SIDE_RANGE = { left: [0, 0.6], center: [0.2, 0.8], right: [0.4, 1] };

function loadImage(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`Could not load ${url} for cropping`));
        img.src = url;
    });
}

/**
 * Crop rectangle (fractions of the source image) for a closer framing on one side of the frame.
 * Pure function so it can be unit tested.
 * @param {{x: number, y: number} | null} focal Busiest point on that side (0..1), or null.
 * @param {number} srcAspect Source width / height.
 * @param {string} shot Target shot ('close-up' | 'extreme close-up' | 'medium shot').
 */
export function computeCropRect(focal, srcAspect, shot, targetAspect = null, head = null) {
    // Sized to the located head when we have it: a figure drawn small (the model often ignores
    // "close-up") still ends up as a real head-and-shoulders crop.
    if (head && focal && head.spreadY > 0) {
        const aspect = targetAspect || (shot === 'extreme close-up' ? 1.5 : shot === 'close-up' ? 1 : 0.8);
        const headH = Math.min(0.6, Math.max(0.05, head.spreadY * 3.2));
        let h = Math.min(1, headH * (shot === 'extreme close-up' ? 1.5 : shot === 'close-up' ? 3.0 : 4.8));
        let w = (h * aspect) / srcAspect;
        if (w > 1) { h = h / w; w = 1; }
        const hy = Number.isFinite(head.y) ? head.y : focal.y;
        const hx = Number.isFinite(head.x) ? head.x : focal.x;
        const cy = hy + headH * (shot === 'extreme close-up' ? 0.3 : shot === 'close-up' ? 0.75 : 1.4);
        const x0 = Math.min(Math.max(hx - w / 2, 0), 1 - w);
        const y0 = Math.min(Math.max(cy - h / 2, 0), 1 - h);
        return { x0, y0, x1: x0 + w, y1: y0 + h };
    }
    // Fraction of the source WIDTH the crop keeps; the crop's own aspect depends on the shot, unless
    // the crop must fill a frame of a given shape (a frame inside a multi-frame panel).
    const keep = shot === 'extreme close-up' ? 0.5 : shot === 'close-up' ? 0.6 : 0.75;
    const cropAspect = targetAspect || (shot === 'extreme close-up' ? 1.5 : shot === 'close-up' ? 1 : 0.8);
    let w = keep;
    let h = (w * srcAspect) / cropAspect; // in fractions of source height
    if (h > 1) { w = w / h; h = 1; }
    const fx = focal ? focal.x : 0.5;
    // Faces sit above the busiest point of a figure, so aim the crop a little higher.
    const fy = focal ? Math.max(0, focal.y - 0.12) : 0.35;
    const x0 = Math.min(Math.max(fx - w / 2, 0), 1 - w);
    const y0 = Math.min(Math.max(fy - h / 2, 0), 1 - h);
    return { x0, y0, x1: x0 + w, y1: y0 + h };
}

/**
 * The head to frame, in the hair-centroid form computeCropRect expects ({x, y, spreadY}, y near
 * the top of the head). Pure so it can be unit tested.
 * - Faces near the top of the picture are candidates (lower clumps are hands and arms).
 * - Hair of the speaker's colour right above/around a face picks that face.
 * - Otherwise the face nearest the side the speaker should be on; one face is just taken.
 * - No faces: the hair clump if it sits in the upper part of the picture, else null.
 */
export function pickHead(faces, hair, sideX = 0.5) {
    // Wood, sand and bare arms are skin-coloured too, in smaller clumps: a real face is about the
    // biggest clump near the top (a porch post beside Vanessa's face won on the side hint alone).
    const near = (faces || []).filter((f) => f.y < faces[0].y + 0.12);
    const biggest = Math.max(0, ...near.map((f) => f.share || 0));
    const top = near.filter((f) => !biggest || (f.share || 0) >= biggest * 0.6);
    let face = null;
    if (top.length && hair) face = top.find((f) => Math.abs(f.x - hair.x) < 0.15 && hair.y < f.y + 0.08) || null;
    if (!face && top.length) face = top.reduce((a, b) => (Math.abs(b.x - sideX) < Math.abs(a.x - sideX) ? b : a));
    if (face) {
        // A face clump's vertical spread is about the face height / 3.4; the top of the head is
        // about a third of a face above the face centre.
        return { x: face.x, y: face.y - face.spreadY * 3.2 * 0.3, spreadY: face.spreadY };
    }
    if (hair && hair.y < 0.55) return hair;
    return null;
}

/**
 * Crops `sourceUrl` toward `side` and uploads the result. Returns the new image's URL and the crop.
 * @param {import('../../st-context.js').default} context
 * @param {string} sourceUrl
 * @param {{side: string, shot: string, subFolder: string}} options
 */
export async function createCropPanel(context, sourceUrl, { side = 'center', shot = 'close-up', subFolder, hairColor = null, aspect = null, skinTones = ['light'] }) {
    const img = await loadImage(sourceUrl);
    const map = computeOccupancyMap(img);
    // Where the head is decides the crop. Skin clumps (faces) are the most reliable cue - hair
    // colour is fooled by scenery (yellow grass read as blonde hair gave a headless torso).
    const faces = locateFaces(img, 3, skinTones);
    const hair = hairColor ? locateColor(img, hairColor) : null;
    const sideX = side === 'left' ? 0.3 : side === 'right' ? 0.7 : 0.5;
    const head = pickHead(faces, hair, sideX);
    let focal = head ? { x: head.x, y: head.y + 0.1 } : focalCentroid(map, SIDE_RANGE[side] || SIDE_RANGE.center);
    // No head found: in an upper-body image the head is in the upper part - never aim the crop at
    // the chest (a close-up came out as a headless torso).
    if (!head && focal && /close-up/.test(shot)) focal = { x: focal.x, y: Math.min(focal.y, 0.34) };
    const rect = computeCropRect(focal, img.naturalWidth / img.naturalHeight, shot, aspect, head);

    const url = await cropAndUpload(context, img, rect, subFolder);
    return { url, crop: rect };
}

/** Cuts `rect` (fractions) out of a loaded image, scales a small cut up, uploads it; returns its URL. */
async function cropAndUpload(context, img, rect, subFolder) {
    const sx = Math.round(rect.x0 * img.naturalWidth);
    const sy = Math.round(rect.y0 * img.naturalHeight);
    const sw = Math.round((rect.x1 - rect.x0) * img.naturalWidth);
    const sh = Math.round((rect.y1 - rect.y0) * img.naturalHeight);
    // Scale the crop back up to roughly the source width so it displays at the same size as its
    // neighbours (it is softer than a generated panel - the documented trade-off of this strategy).
    const scale = Math.min(2.2, Math.max(1, 900 / Math.max(sw, sh)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(sw * scale);
    canvas.height = Math.round(sh * scale);
    const ctx2d = canvas.getContext('2d');
    ctx2d.imageSmoothingQuality = 'high';
    ctx2d.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/png').split(',')[1];

    const response = await fetch('/api/images/upload', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({ image: data, format: 'png', ch_name: subFolder, filename: `manga_crop_${uniqueStamp()}` }),
    });
    if (!response.ok) throw new Error('Failed to save the cropped panel.');
    const { path } = await response.json();
    return path;
}

/**
 * The horizontal centre a narrow cut of a wider image should keep: the faces near the top (the
 * people), else the middle. Pure.
 */
export function peopleCenterX(faces) {
    const near = (faces || []).filter((f) => f.y < faces[0].y + 0.12);
    const biggest = Math.max(0, ...near.map((f) => f.share || 0));
    const keep = near.filter((f) => !biggest || (f.share || 0) >= biggest * 0.6);
    if (!keep.length) return 0.5;
    const xs = keep.map((f) => f.x);
    return (Math.min(...xs) + Math.max(...xs)) / 2;
}

/**
 * A narrow frame is drawn wider and cut down to its shape here. Asked for a tall narrow picture,
 * Anima fills the height with a second copy of the person (08h52 #10: two Vanessas in one frame).
 */
export async function createAspectCrop(context, sourceUrl, { aspect, subFolder, skinTones = ['light'] }) {
    const img = await loadImage(sourceUrl);
    const src = img.naturalWidth / img.naturalHeight;
    let rect;
    if (aspect < src) {
        const w = aspect / src;
        const cx = peopleCenterX(locateFaces(img, 3, skinTones));
        const x0 = Math.min(Math.max(cx - w / 2, 0), 1 - w);
        rect = { x0, y0: 0, x1: x0 + w, y1: 1 };
    } else {
        const h = src / aspect;
        rect = { x0: 0, y0: 0, x1: 1, y1: h };
    }
    const url = await cropAndUpload(context, img, rect, subFolder);
    return { url, crop: rect };
}

/**
 * Crop rectangle around a head box found by the quality check ({x0,y0,x1,y1} fractions): head and
 * shoulders for a close-up, the eyes and face for an extreme close-up. Pure.
 */
export function headCropRect(head, srcAspect, shot, targetAspect = null) {
    const aspect = targetAspect || (shot === 'extreme close-up' ? 1.5 : shot === 'close-up' ? 0.9 : 0.8);
    const headH = Math.max(0.04, head.y1 - head.y0);
    const factor = shot === 'extreme close-up' ? 1.25 : shot === 'close-up' ? 2.6 : 4.5;
    let h = Math.min(1, headH * factor);
    let w = (h * aspect) / srcAspect;
    if (w > 1) { h /= w; w = 1; }
    const cx = (head.x0 + head.x1) / 2;
    const top = shot === 'extreme close-up' ? head.y0 + headH * 0.1 : head.y0 - headH * 0.3;
    const x0 = Math.min(Math.max(cx - w / 2, 0), 1 - w);
    const y0 = Math.min(Math.max(top, 0), 1 - h);
    return { x0, y0, x1: x0 + w, y1: y0 + h };
}

/** Crops a picture to a head box and uploads the crop. */
export async function cropToHead(context, sourceUrl, head, { shot = 'close-up', aspect = null, subFolder }) {
    const img = await loadImage(sourceUrl);
    const rect = headCropRect(head, img.naturalWidth / img.naturalHeight, shot, aspect);
    const url = await cropAndUpload(context, img, rect, subFolder);
    return { url, crop: rect };
}

/** Cuts a wider picture to a narrower shape, centred on the given x (the people's heads). */
export async function cropToAspect(context, sourceUrl, { aspect, centerX = 0.5, subFolder }) {
    const img = await loadImage(sourceUrl);
    const src = img.naturalWidth / img.naturalHeight;
    let rect;
    if (aspect < src) {
        const w = aspect / src;
        const x0 = Math.min(Math.max(centerX - w / 2, 0), 1 - w);
        rect = { x0, y0: 0, x1: x0 + w, y1: 1 };
    } else {
        const h = src / aspect;
        rect = { x0: 0, y0: 0, x1: 1, y1: h };
    }
    const url = await cropAndUpload(context, img, rect, subFolder);
    return { url, crop: rect };
}

/**
 * The square around a head that a face touch-up redraws: the head grown by `grow` for hair, neck
 * and a little background, kept inside the picture. Fractions of the picture. Pure.
 * @param {{x0:number,y0:number,x1:number,y1:number}} head
 * @param {number} srcAspect width / height of the picture
 */
export function faceRegion(head, srcAspect, grow = 1.9) {
    const wpx = (head.x1 - head.x0) * srcAspect;
    const hpx = head.y1 - head.y0;
    const side = Math.min(Math.max(wpx, hpx) * grow, Math.min(srcAspect, 1));
    const w = side / srcAspect;
    const h = side;
    const cx = (head.x0 + head.x1) / 2;
    const cy = (head.y0 + head.y1) / 2;
    const x0 = Math.min(Math.max(cx - w / 2, 0), 1 - w);
    const y0 = Math.min(Math.max(cy - h / 2, 0), 1 - h);
    return { x0, y0, x1: x0 + w, y1: y0 + h };
}

/** Cuts a region out as its own picture (scaled up like other crops). */
export async function cropRegion(context, sourceUrl, rect, { subFolder }) {
    const img = await loadImage(sourceUrl);
    return cropAndUpload(context, img, rect, subFolder);
}

/**
 * Pastes a redrawn region back into the picture with soft edges (so no seam shows) and saves the
 * result as a new picture. `rect` is the region's place in fractions of the base picture.
 */
export async function pasteRegion(context, baseUrl, patchUrl, rect, { subFolder, feather = 0.16 }) {
    const [base, patch] = await Promise.all([loadImage(baseUrl), loadImage(patchUrl)]);
    const W = base.naturalWidth;
    const H = base.naturalHeight;
    const x = Math.round(rect.x0 * W);
    const y = Math.round(rect.y0 * H);
    const w = Math.round((rect.x1 - rect.x0) * W);
    const h = Math.round((rect.y1 - rect.y0) * H);
    const soft = document.createElement('canvas');
    soft.width = w;
    soft.height = h;
    const s = soft.getContext('2d');
    s.imageSmoothingQuality = 'high';
    s.drawImage(patch, 0, 0, w, h);
    // Fade the patch out toward its edges: a blurred inner rectangle used as the alpha mask.
    const edge = Math.max(2, Math.round(Math.min(w, h) * feather));
    const mask = document.createElement('canvas');
    mask.width = w;
    mask.height = h;
    const m = mask.getContext('2d');
    m.filter = `blur(${Math.round(edge / 2)}px)`;
    m.fillStyle = '#fff';
    m.fillRect(edge, edge, w - 2 * edge, h - 2 * edge);
    s.globalCompositeOperation = 'destination-in';
    s.drawImage(mask, 0, 0);
    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    const o = out.getContext('2d');
    o.drawImage(base, 0, 0);
    o.drawImage(soft, x, y);
    const data = out.toDataURL('image/png').split(',')[1];
    const response = await fetch('/api/images/upload', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({ image: data, format: 'png', ch_name: subFolder, filename: `manga_faces_${uniqueStamp()}` }),
    });
    if (!response.ok) throw new Error('Failed to save the touched-up picture.');
    return (await response.json()).path;
}
