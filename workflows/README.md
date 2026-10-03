# Workflow archive

Every ComfyUI graph MangaMode has used, or that was tested for it, is kept here. Nothing is deleted.

File name: `NNN_YYYY-MM-DD_<model>_<reason>.json`. Each file carries a `_meta` block (reason, model, key settings) and the graph in ComfyUI API format under `prompt`.

| # | Date | Model | Reason | Status |
|---|------|-------|--------|--------|
| 000 | 2026-09-23 | illustriousXL_v01 | Baseline single-prompt txt2img, as shipped at d9d7bc2 | superseded if a later row says "adopted" |
| 001 | 2026-09-23 | illustriousXL_v01 / any SDXL | Per-person prompt chunks + ConditioningConcat (fixes multi-character bleeding) | kept for SDXL profiles (tags style) |
| L01 | 2026-09-23 | illustriousXL_v01 | Regional prompting, ConditioningSetAreaPercentage (e1 D) | rejected |
| L02 | 2026-09-23 | illustriousXL_v01 | Regional prompting, ConditioningSetMask (e1 E) | rejected |
| L03 | 2026-09-23 | illustriousXL_v01 | 001 + half-frame masks at 0.5/0.8 (e6) | rejected |
| 002 | 2026-09-23 | template (split files) | UNETLoader + CLIPLoader + VAELoader family, MangaMode's own graph (ComfyUI's Anima blueprint used only as a reference for loader types) | validated on ComfyUI 0.33.0 |
| 003 | 2026-09-23 | anima-turbo-v1.1 | 002 with the benchmark-chosen settings: natural style, er_sde/simple, 10 steps, CFG 1 | adopted (default profile) |
| 004 | 2026-09-23 | illustriousXL_v01 | Loadable copy of the current live profile's graph (checkpoint family), rebuilt from `image-generator.js` + the saved profile settings and auto-arranged by ComfyUI's own `app.loadApiJson`, so it opens directly from ComfyUI's Workflows sidebar or drag-and-drop, no manual node wiring | for manual testing in the ComfyUI editor only - MangaMode itself never reads this file |
| 005 | 2026-09-23 | oneObsession_v24 | Same as 004, One Obsession v24's profile (checkpoint family, its own sampler/CFG/quality tags) | for manual testing only |
| 006 | 2026-09-23 | anima-turbo-v1.1 | Same as 004, the Anima Turbo profile (split files: UNETLoader + CLIPLoader + VAELoader) | for manual testing only |

004-006 are also saved directly into ComfyUI's own workflow list (`ComfyUI/user/default/workflows/`), under their readable names (`illustrious-xl-v01-tags.json`, `one-obsession-v24-tags.json`, `anima-turbo-v1.1-natural.json`) - open them from ComfyUI's Workflows sidebar rather than drag-and-drop. They use a 2-person example prompt (Seraphina + alex) so the graph is representative; MangaMode's real per-message prompt varies by scene. Unlike 000-003 (API-format, `{node_id: {...}}`, what MangaMode's own code sends to ComfyUI - not directly openable in the editor), 004-006 are ComfyUI's own UI graph format with node positions, so they open in the editor with no conversion step and no manual node building. Regenerate them with `node __gen_workflows_tmp.mjs`-style script (see docs/experiments.md) any time a profile's settings change, so they never drift from what MangaMode actually sends.

## the true one + IP-Adapter.api.json (ready for the Anima IP-Adapter)

"The true one" with the Anima IP-Adapter (github.com/LuciferTC9527/ComfyUI-Anima_IP-Adapter)
between the model and the sampler. An "easy loadImageBase64" node holds `%reference%`: MangaMode
puts the character sheet of the one known person in the frame there and sets the adapter's
strength (Manga Mode -> Character reference strength); frames without one known person get a grey
picture at strength 0. Needs the node pack and `ip_adapter-Character_Reference-10.safetensors` in
`ComfyUI/models/ipadapter` (see DOWNLOADS.md). To use it: drag this file into ComfyUI, press
Ctrl+S and name it, pick it under Workflow in Manga Mode, and tick "Character reference pictures".
