import { renderBubblesOverlay } from './bubbles.js';
import { formatUsage } from './llm-request.js';
import { spentOf } from './result-state.js';

export const BUTTON_CLASS = 'manga_generate_btn';
const PANEL_CLASS = 'manga_panel';

/**
 * Injects the manual "Generate manga panel" button into a rendered message, if not already present.
 * Never modifies core templates; purely additive DOM insertion into the existing `.extraMesButtons` container.
 * @param {JQuery<HTMLElement>} messageElement The `.mes` element for this message.
 */
export function injectMangaButton(messageElement) {
    if (!messageElement || !messageElement.length) return;
    if (messageElement.attr('is_user') === 'true' || messageElement.attr('is_system') === 'true') return;
    if (messageElement.find(`.${BUTTON_CLASS}`).length) return;

    const button = $('<div>', {
        class: `mes_button ${BUTTON_CLASS} fa-solid fa-image`,
        title: 'Generate manga panel',
    });

    messageElement.find('.extraMesButtons').append(button);
}

/**
 * Renders a collapsible block with the raw scene JSON and the exact prompts sent to the image backend.
 * @param {JQuery<HTMLElement>} panel The manga panel container to append into.
 * @param {object} manga The `mes.extra.manga` object.
 */
function appendDebugBlock(panel, manga) {
    if (!manga.scene && !manga.positivePrompt && !manga.negativePrompt) return;

    const details = $('<details>', { class: 'manga_debug' });
    details.append($('<summary>').text('Manga debug info'));

    if (manga.promptStyle) {
        details.append($('<div>', { class: 'manga_debug_label' }).text(`Prompt style: ${manga.promptStyle}${manga.modelProfile ? ` - model profile: ${manga.modelProfile}` : ''}`));
        details.append($('<div>', { class: 'manga_debug_label' }).text(`Model adapter: ${manga.modelAdapter || 'anima'} - look: ${manga.styleProfile || 'webtoon-color'} - planning: ${manga.pipeline || 'classic'}${manga.momentCards ? ' (moment cards used)' : ''}${manga.directVersion ? ` v${manga.directVersion}` : ''}`));
        if (manga.pipelineNote) details.append($('<div>', { class: 'manga_debug_label' }).text(manga.pipelineNote));
        const frames = (manga.scene?.beats || []).map((b, i) => (b.direct ? `Frame ${i + 1} (${b.direct.shot}, ${b.direct.angle}): ${b.direct.moment}\n  visible: ${(b.direct.shows?.people || []).map((p) => `${p.name} [${(p.parts || []).join(', ')}]${p.looks_at ? ` looks at ${p.looks_at}` : ''}`).join('; ') || '-'}; objects: ${(b.direct.shows?.objects || []).join(', ') || '-'}; place: ${b.direct.shows?.place || '-'} ${b.direct.place_name || ''}` : null)).filter(Boolean);
        if (frames.length) {
            details.append($('<div>', { class: 'manga_debug_label' }).text('Frames as the reader wrote them:'));
            details.append($('<pre>', { class: 'manga_debug_pre' }).text(frames.join('\n')));
        }
        const cards = (manga.scene?.beats || []).map((b, i) => (b.moment ? `Frame ${i + 1}: ${(b.moment.facts || []).join(' / ')}\n  needs: ${(b.moment.needs || []).join(', ') || '-'}; holding: ${(b.moment.holding || []).map((h) => `${h.person} ${h.object} (${h.hand})`).join('; ') || '-'}; spots: ${(b.moment.spots || []).map((x) => `${x.person} ${x.spot}`).join('; ') || '-'}; invented: ${(b.moment.invented || []).join(', ') || '-'}` : null)).filter(Boolean);
        if (cards.length) {
            details.append($('<div>', { class: 'manga_debug_label' }).text('Moment cards (what each picture must show):'));
            details.append($('<pre>', { class: 'manga_debug_pre' }).text(cards.join('\n')));
        }
    }
    if (manga.world) {
        details.append($('<div>', { class: 'manga_debug_label' }).text(`World book: ${manga.world.summary || ''} (${manga.world.era_and_technology || ''})`));
    }
    if (manga.scene?.storyboard) {
        details.append($('<div>', { class: 'manga_debug_label' }).text('Storyboard (how the director pictured this reply):'));
        details.append($('<pre>', { class: 'manga_debug_pre' }).text(manga.scene.storyboard));
    }
    if (manga.cast?.length) {
        details.append($('<div>', { class: 'manga_debug_label' }).text('Cast book (every person is drawn from this):'));
        details.append($('<pre>', { class: 'manga_debug_pre' }).text(manga.cast.map((p) => `${p.name} = ${p.label}\n  look: ${p.look || '-'}\n  wearing: ${p.outfit || '-'}`).join('\n')));
    }
    if (manga.generation) {
        const g = manga.generation;
        details.append($('<div>', { class: 'manga_debug_label' }).text(`ComfyUI: ${g.attempts} attempt(s)${g.timeouts ? `, ${g.timeouts} timeout(s)` : ''}, ${g.seconds}s`));
    }
    if (manga.usage?.total) {
        const u = manga.usage;
        const parts = [u.parser ? `Scene parser: ${formatUsage(u.parser)}` : 'Scene parser: not called (redrawn from the saved scene)'];
        if (u.world) parts.push(`world book: ${formatUsage(u.world)}`);
        if (u.vision) parts.push(`quality check: ${formatUsage(u.vision)}`);
        const redrawn = u.redrawn ? ' Paid once, when the scene was first parsed - redrawing reuses the saved scene and costs nothing.' : '';
        details.append($('<div>', { class: 'manga_debug_label' }).text(`LLM cost of this panel set - ${parts.join('; ')}. (The roleplay reply itself is billed separately.)${redrawn}`));
    }
    if (globalThis.MangaModeStats) {
        const st = globalThis.MangaModeStats;
        details.append($('<div>', { class: 'manga_debug_label' }).text(`Session ComfyUI stats: ${st.requests} requests, ${st.timeouts} timeouts, ${st.retries} retries (${st.retrySuccesses} recovered), ${st.failures} failures`));
    }
    if (manga.scene) {
        details.append($('<div>', { class: 'manga_debug_label' }).text('Scene JSON (from parser):'));
        details.append($('<pre>', { class: 'manga_debug_pre' }).text(JSON.stringify(manga.scene, null, 2)));
    }
    if (Array.isArray(manga.panels) && (manga.panels.length > 1 || manga.panels.some((p) => p.frames))) {
        details.append($('<div>', { class: 'manga_debug_label' }).text('Visual Director plan:'));
        const plan = manga.panels.map((p) => ({
            panel: p.index,
            strategy: p.strategy,
            kind: p.kind || undefined,
            fromPanel: p.fromPanel,
            fullBleed: p.fullBleed || undefined,
            camera: p.camera,
            size: p.width ? `${p.width}x${p.height}` : undefined,
            layout: p.layout ? `${p.layout.template}, height ${p.layout.aspect}x width` : undefined,
            dialogue: p.dialogue,
            seconds: p.generation?.seconds,
            quality: p.frames ? undefined : p.quality,
            prompt: p.frames ? undefined : p.promptChunks,
            frames: p.frames?.map((f) => ({
                frame: f.frame,
                strategy: f.strategy,
                kind: f.kind || undefined,
                emphasis: f.emphasis || undefined,
                camera: f.camera,
                area: f.rect ? `${Math.round(f.rect.share * 100)}%` : undefined,
                size: f.width ? `${f.width}x${f.height}` : undefined,
                dialogue: f.dialogue,
                seconds: f.generation?.seconds,
                quality: f.quality,
                prompt: f.promptChunks,
            })),
        }));
        details.append($('<pre>', { class: 'manga_debug_pre' }).text(JSON.stringify(plan, null, 2)));
    }
    if (manga.positivePrompt) {
        details.append($('<div>', { class: 'manga_debug_label' }).text('Positive prompt (sent to ComfyUI):'));
        details.append($('<pre>', { class: 'manga_debug_pre' }).text(manga.positivePrompt));
    }
    if (manga.negativePrompt) {
        details.append($('<div>', { class: 'manga_debug_label' }).text('Negative prompt (sent to ComfyUI):'));
        details.append($('<pre>', { class: 'manga_debug_pre' }).text(manga.negativePrompt));
    }

    panel.append(details);
}

/**
 * Phase 4: the vertical webtoon strip - one `.manga_image_wrap` per panel, stacked top to bottom
 * (vertical scroll is time), each with its own gutters and its own balloon overlay built from the
 * dialogue lines the director assigned to it. A legacy single-image record renders as one panel
 * carrying all dialogue.
 */
function appendStrip(container, scene, panels, showBubbles, identities = [], webtoon = false) {
    const strip = $('<div>', { class: webtoon ? 'manga_strip manga_webtoon' : 'manga_strip' });
    container.append(strip);
    const dialogue = Array.isArray(scene?.dialogue) ? scene.dialogue : [];
    for (const p of panels) {
        if (!p?.imageUrl) continue;
        if (Array.isArray(p.frames) && p.frames.length > 1 && p.layout) {
            appendGridPanel(strip, scene, p, showBubbles, identities, dialogue, webtoon);
            continue;
        }
        const wrap = $('<div>', { class: 'manga_image_wrap' });
        if (p.fullBleed) wrap.addClass('manga_full_bleed');
        if (p.strategy) wrap.attr('data-strategy', p.strategy);
        wrap.append($('<img>', { class: 'manga_image', src: p.imageUrl }));
        // Attached before bubbles are built: text is measured with offsetWidth, which is 0 while
        // the subtree is detached from the document.
        strip.append(wrap);
        const panelScene = Array.isArray(p.dialogue)
            ? { ...scene, dialogue: p.dialogue.map((i) => dialogue[i]).filter(Boolean) }
            : scene;
        renderBubblesOverlay(wrap, panelScene, showBubbles, { identities, visibleNames: Array.isArray(p.characters) ? p.characters : null, shot: p.camera?.shot || '', sfx: p.sfx || '', focusSide: p.focusSide || null, heads: p.heads || null });
    }
}

// Must match `.manga_strip .manga_image_wrap` padding in style.css: frames on the panel's top or
// bottom edge may put balloons in that gutter, as single panels do.
const GRID_GUTTER_PX = 72;

/**
 * A panel of 2-3 frames in a manga layout. Each frame is its own box with its own balloon overlay,
 * so its lines sit on (or just outside) the frame they belong to; a frame on the panel's top or
 * bottom edge extends its balloon area into that gutter. The panel's gutters never grow (the frames
 * are positioned against them), so `data-gutter-grown` is set up front.
 */
function appendGridPanel(strip, scene, p, showBubbles, identities, dialogue, webtoon = false) {
    const aspect = Number(p.layout.aspect) || 1;
    const wrap = $('<div>', { class: 'manga_image_wrap manga_grid_wrap', 'data-strategy': 'grid', 'data-gutter-grown': '1' });
    const grid = $('<div>', { class: 'manga_grid' }).css('aspect-ratio', `1 / ${aspect}`);
    wrap.append(grid);
    strip.append(wrap);
    for (const f of p.frames) {
        const r = f.rect;
        if (!r || !f.imageUrl) continue;
        // Webtoon mode has no white gutters around a page of frames.
        const extTop = !webtoon && r.touchesTop ? GRID_GUTTER_PX : 0;
        const extBottom = !webtoon && r.touchesBottom ? GRID_GUTTER_PX : 0;
        // Lettering scales with the frame: a small detail frame gets smaller balloons.
        const share = Number(r.share) || 0.3;
        const host = $('<div>', { class: 'manga_frame_host' }).css({
            left: `${r.x0 * 100}%`,
            width: `${(r.x1 - r.x0) * 100}%`,
            top: `calc(${(r.y0 / aspect) * 100}% - ${extTop}px)`,
            height: `calc(${((r.y1 - r.y0) / aspect) * 100}% + ${extTop + extBottom}px)`,
            fontSize: `${Math.min(1.05, 0.8 + share * 0.5).toFixed(2)}em`,
        });
        const frame = $('<div>', { class: 'manga_frame' }).css({ top: `${extTop}px`, bottom: `${extBottom}px` });
        if (f.kind) frame.attr('data-kind', f.kind);
        frame.append($('<img>', { class: 'manga_image', src: f.imageUrl }));
        host.append(frame);
        grid.append(host);
        const frameScene = { ...scene, dialogue: (f.dialogue || []).map((i) => dialogue[i]).filter(Boolean) };
        renderBubblesOverlay(host, frameScene, showBubbles, { identities, visibleNames: Array.isArray(f.characters) ? f.characters : null, shot: f.camera?.shot || '', sfx: f.sfx || '', focusSide: f.focusSide || null, heads: f.heads || null });
    }
    if (!webtoon) trimUnusedGridGutters(wrap, grid);
}

/**
 * Once every frame has placed its balloons, a page gutter no balloon went into shrinks back to a
 * thin margin (a page with every balloon inside its frames used to sit between two 72px white bands).
 * Frames and their balloons are positioned against the grid, so they move with it.
 */
function trimUnusedGridGutters(wrap, grid) {
    const images = grid.find('img.manga_image').toArray();
    const loaded = images.map((img) => (img.complete && img.naturalWidth ? Promise.resolve() : new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
    })));
    // Balloons are placed per frame after its image loads; judge the gutters only once every
    // balloon has its final spot (data-placed), else a gutter still waiting for a balloon was kept
    // or an empty one was left (a 140px blank strip under a page, 08h52 #22).
    const check = (tries) => {
        const gridEl = grid[0];
        if (!gridEl?.isConnected) return;
        const groups = wrap.find('.manga_bubble_group').toArray();
        if (groups.some((el) => el.dataset.placed !== '1') && tries > 0) {
            setTimeout(() => check(tries - 1), 250);
            return;
        }
        const g = gridEl.getBoundingClientRect();
        const balloons = groups.map((el) => el.getBoundingClientRect());
        const usesTop = balloons.some((r) => r.top < g.top - 1);
        const usesBottom = balloons.some((r) => r.bottom > g.bottom + 1);
        const thin = '14px';
        if (!usesTop) wrap[0].style.paddingTop = thin;
        if (!usesBottom) wrap[0].style.paddingBottom = thin;
    };
    Promise.all(loaded).then(() => setTimeout(() => check(24), 120));
}

function getOrCreatePanel(messageElement) {
    let panel = messageElement.find(`.${PANEL_CLASS}`);
    if (!panel.length) {
        panel = $('<div>', { class: PANEL_CLASS });
        const mesText = messageElement.find('.mes_text').first();
        if (mesText.length) {
            mesText.before(panel);
        } else {
            messageElement.find('.mes_block').first().prepend(panel);
        }
    }
    return panel;
}

/**
 * Renders the current manga state (from `mes.extra.manga`) for one message into its DOM element.
 * Reads only local/cached data; never triggers generation.
 * @param {object} message Chat message object (`context.chat[messageId]`).
 * @param {JQuery<HTMLElement>} messageElement The `.mes` element for this message.
 * @param {object} options
 * @param {boolean} options.revealed Whether the underlying text should be shown alongside the image.
 * @param {boolean} [options.debugEnabled] Whether to render the scene JSON / prompt debug block, if data is cached.
 * @param {boolean} [options.showBubbles] Whether to render the speech bubble overlay, if dialogue is cached.
 * @param {(revealed: boolean) => void} options.onToggleReveal Called when the user clicks the reveal/hide toggle.
 * @param {() => void} options.onRetry Called when the user clicks retry on an errored panel.
 */
/**
 * The cost line under a page: what this reply's Manga Mode LLM calls cost (provider figures), split
 * by part, and the chat's total. Pure.
 */
export function costLine(usage, chatTotal = null) {
    if (!usage) return '';
    const money = (v) => (Number.isFinite(v) ? `$${v < 1 ? v.toFixed(4) : v.toFixed(2)}` : '?');
    const parts = [];
    if (usage.redrawn) parts.push('scene reused (free)');
    else if (usage.parser) parts.push(`scene ${money(usage.parser.cost)}`);
    if (usage.world?.calls) parts.push(`world book ${money(usage.world.cost)}`);
    if (usage.vision?.calls) parts.push(`${usage.vision.calls} picture check${usage.vision.calls > 1 ? 's' : ''} ${money(usage.vision.cost)}`);
    const total = usage.total?.cost;
    let head = Number.isFinite(total) ? `This reply: ${money(total)}` : `This reply: ${(usage.total?.promptTokens || 0) + (usage.total?.completionTokens || 0)} tokens (no price reported)`;
    // Every attempt at this reply (redraws, failed runs): the last run alone hides what the earlier ones cost.
    const spent = spentOf(usage);
    const all = spent.attempts > 1 ? ` - all ${spent.attempts} attempts: ${money(spent.known)}${spent.unpriced ? ` known (+${spent.unpriced} call${spent.unpriced > 1 ? 's' : ''} without a reported price)` : ''}` : '';
    let chat = '';
    if (Number.isFinite(chatTotal)) chat = ` - all pages of this chat: ${money(chatTotal)}`;
    else if (chatTotal && Number.isFinite(chatTotal.known)) {
        // A price the provider did not report is not zero: the total is the KNOWN cost, and says how much is missing.
        chat = chatTotal.unpriced
            ? ` - all pages of this chat: ${money(chatTotal.known)} known (+${chatTotal.unpriced} call${chatTotal.unpriced > 1 ? 's' : ''} without a reported price)`
            : ` - all pages of this chat: ${money(chatTotal.known)}`;
    }
    return `${head}${parts.length ? ` (${parts.join(', ')})` : ''}${all}${chat}`;
}

export function renderMangaPanel(message, messageElement, { revealed, inProgress = true, debugEnabled = false, showBubbles = true, cost = null, stale = false, webtoon = false, onToggleReveal, onRetry, onRedraw }) {
    if (!messageElement || !messageElement.length) return;

    let manga = message?.extra?.manga;
    const mesText = messageElement.find('.mes_text').first();

    if (!manga || !manga.status || manga.status === 'idle') {
        messageElement.find(`.${PANEL_CLASS}`).remove();
        mesText.removeClass('manga-text-hidden');
        return;
    }

    const panel = getOrCreatePanel(messageElement);
    panel.empty();

    // A redraw that was interrupted (page reload, closed tab) left a 'generating' marker; the result it was
    // replacing travels with it, so the earlier pictures are shown again, not lost.
    if (manga.status === 'generating' && !inProgress && manga.previous) {
        manga = { ...manga.previous, lastError: { message: 'the redraw was interrupted before it finished' } };
    }

    if (manga.status === 'generating' && !inProgress) {
        // A 'generating' marker with no live job behind it: the page was reloaded or the job was
        // lost mid-way. Offer a retry instead of an endless spinner.
        panel.append($('<div>', { class: 'manga_status manga_error' }).text('Manga generation was interrupted.'));
        const retryButton = $('<div>', { class: 'menu_button manga_retry_btn' }).text('Retry');
        retryButton.on('click', () => onRetry?.());
        panel.append(retryButton);
        mesText.removeClass('manga-text-hidden');
        return;
    }

    if (manga.status === 'generating') {
        // Phase 4: panels already finished for this reply are shown while the rest generate.
        if (Array.isArray(manga.partialPanels) && manga.partialPanels.length) {
            appendStrip(panel, manga.scene, manga.partialPanels, showBubbles, manga.identities, webtoon);
        }
        const progress = manga.progress ? ` (panel ${Math.min(manga.progress.done + 1, manga.progress.total)} of ${manga.progress.total})` : '';
        panel.append($('<div>', { class: 'manga_status' }).text(`Generating manga...${progress}`));
        mesText.removeClass('manga-text-hidden');
        if (debugEnabled) appendDebugBlock(panel, manga);
        return;
    }

    if (manga.status === 'error') {
        panel.append($('<div>', { class: 'manga_status manga_error' }).text(`Manga generation failed: ${manga.error || 'unknown error'}`));
        const retryButton = $('<div>', { class: 'menu_button manga_retry_btn' }).text('Retry');
        retryButton.on('click', () => onRetry?.());
        panel.append(retryButton);
        mesText.removeClass('manga-text-hidden');
        if (debugEnabled) appendDebugBlock(panel, manga);
        return;
    }

    const donePanels = Array.isArray(manga.panels) && manga.panels.length
        ? manga.panels
        : (manga.imageUrl ? [{ imageUrl: manga.imageUrl, dialogue: null }] : []);
    if (manga.status === 'done' && donePanels.length) {
        appendStrip(panel, manga.scene, donePanels, showBubbles, manga.identities, webtoon);
        if (manga.lastError) {
            panel.append($('<div>', { class: 'manga_status manga_error' }).text(`The last redraw failed (${manga.lastError.message}); these are the earlier pictures.`));
            const again = $('<div>', { class: 'menu_button manga_retry_btn' }).text('Try again');
            again.on('click', () => onRetry?.());
            panel.append(again);
        }
        if (manga.status === 'done' && manga.pipeline && manga.pipeline !== 'direct' && manga.pipelineNote) {
            panel.append($('<div>', { class: 'manga_status' }).text(manga.pipelineNote));
        }
        if (stale) {
            // The text was edited after these pictures were drawn (with automatic drawing off nothing redraws them).
            panel.append($('<div>', { class: 'manga_status manga_error' }).text('The message was edited after these pictures were drawn - they show the old text.'));
            const redo = $('<div>', { class: 'menu_button manga_retry_btn' }).text('Draw again');
            redo.on('click', () => onRetry?.());
            panel.append(redo);
        }
        if (manga.panelErrors?.length) {
            panel.append($('<div>', { class: 'manga_status manga_error' }).text(`${manga.panelErrors.length} panel(s) could not be generated; their lines were moved to the previous panel.`));
        }

        const toggle = $('<div>', { class: 'menu_button manga_reveal_btn' }).text(revealed ? 'Hide text' : 'Show text');
        toggle.on('click', () => onToggleReveal?.(!revealed));
        const buttons = $('<div>', { class: 'manga_panel_buttons' }).append(toggle);
        if (manga.scene && onRedraw) {
            const redraw = $('<div>', { class: 'menu_button manga_redraw_btn', title: 'Draw the pictures again from the same frames and dialogue the reader wrote: no story-reader call. (The picture checker still runs, and still costs if it uses a paid model.) "Draw again" on the message reads the story again.' }).text('Redraw images');
            redraw.on('click', () => onRedraw());
            buttons.append(redraw);
        }
        panel.append(buttons);
        const line = cost ? costLine(manga.usage, cost.chatTotal) : '';
        if (line) panel.append($('<div>', { class: 'manga_cost', title: 'Manga Mode LLM calls only (provider figures). The roleplay reply itself is billed separately; ComfyUI is local and free.' }).text(line));

        mesText.toggleClass('manga-text-hidden', !revealed);
        if (debugEnabled) appendDebugBlock(panel, manga);
    }
}
