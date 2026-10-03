// Pure helpers of the MangaMode bridge (no ComfyUI imports, so they can be tested with node).

const linkKey = (l) => JSON.stringify(l);

/** What makes a node what it is: not its position or size, but its type, mode and settings. */
function essence(graph) {
    const nodes = (graph?.nodes || [])
        .map((n) => ({ id: n.id, type: n.type, mode: n.mode ?? 0, widgets: n.widgets_values ?? null }))
        .sort((a, b) => a.id - b.id);
    const links = (graph?.links || []).map(linkKey).sort();
    return JSON.stringify({ nodes, links });
}

/** True when the saved workflow and the graph on screen are the same graph (same content, not just the same node numbers). */
export function sameGraph(saved, onScreen) {
    return Boolean(saved && onScreen) && essence(saved) === essence(onScreen);
}

/**
 * Whether the runnable copy really reached SillyTavern. "[MangaMode bridge] ready" used to be printed
 * after any answer - also after HTTP 500, and when no SillyTavern folder is set.
 * @param {{ok: boolean, status: number}} response
 * @param {{ok?: boolean, sillytavern?: boolean}|null} body
 */
export function bridgeOutcome(response, body) {
    if (!response?.ok) return { ready: false, message: `ComfyUI answered HTTP ${response?.status ?? '?'} - the workflow was NOT stored for MangaMode.` };
    if (!body?.ok) return { ready: false, message: 'the bridge did not confirm the save.' };
    if (!body.sillytavern) return { ready: false, message: 'stored in ComfyUI, but SillyTavern\'s workflow folder is not set or not found - edit mangamode_bridge.json.' };
    return { ready: true, message: 'is ready for MangaMode.' };
}
