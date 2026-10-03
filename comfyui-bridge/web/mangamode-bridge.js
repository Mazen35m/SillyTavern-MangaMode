// MangaMode bridge: every time a workflow is saved (Ctrl+S / Save / Save As), also store ComfyUI's
// own runnable version of it for SillyTavern's MangaMode. The normal save is untouched.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { sameGraph, bridgeOutcome } from "./graph-compare.js";

app.registerExtension({
    name: "MangaMode.Bridge",
    async setup() {
        const original = api.storeUserData.bind(api);
        api.storeUserData = async function (file, data, options) {
            const result = await original(file, data, options);
            try {
                const m = typeof file === "string" && file.match(/^workflows\/(.+)\.json$/);
                if (m && !m[1].startsWith(".")) {
                    const saved = typeof data === "string" ? JSON.parse(data) : data;
                    const prompt = await app.graphToPrompt();
                    // Only when the saved file is the graph on screen (the one just saved): the same nodes with
                    // the same settings - node numbers alone said "same" for a different step count or prompt.
                    if (saved && sameGraph(saved, prompt.workflow)) {
                        const response = await api.fetchApi("/mangamode/save", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ name: m[1], api: prompt.output, ui: prompt.workflow }),
                        });
                        let body = null;
                        try { body = await response.json(); } catch { /* an error page, not JSON */ }
                        const outcome = bridgeOutcome(response, body);
                        if (outcome.ready) console.info(`[MangaMode bridge] "${m[1]}" ${outcome.message}`);
                        else console.warn(`[MangaMode bridge] "${m[1]}": ${outcome.message}`);
                    } else {
                        console.warn(`[MangaMode bridge] "${m[1]}" was saved, but the graph on screen differs from the saved file - not stored for MangaMode. Press Ctrl+S again.`);
                    }
                }
            } catch (error) {
                console.warn("[MangaMode bridge] Could not store the runnable version:", error);
            }
            return result;
        };
    },
});
