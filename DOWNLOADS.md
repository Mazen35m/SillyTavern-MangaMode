# Models and nodes you need

All files come from their official pages. Check each licence before you use or share a model.

## Image model (the tested setup: Anima Turbo)

Source: https://huggingface.co/circlestone-labs/Anima - open `split_files` and download these three files.

| File | Put it in |
|---|---|
| `anima-turbo-v1.1.safetensors` (diffusion model, Turbo = 8-12 steps at CFG 1) | `ComfyUI/models/diffusion_models` |
| `qwen_3_06b_base.safetensors` (text encoder) | `ComfyUI/models/text_encoders` |
| `qwen_image_vae.safetensors` (VAE) | `ComfyUI/models/vae` |

On an RTX 3070 (8 GB) this runs at about 6 s per picture. Any other model works too (SDXL, Illustrious, NoobAI, Pony, Flux,
Qwen-Image, Z-Image): pick its prompt style in the panel and fill in its files under Advanced settings, or use your own workflow.

Optional, slower but with better prompt following: `anima-aesthetic-v1.1.safetensors` from the same folder (30 steps, CFG 4-5).

## ComfyUI nodes

- **ComfyUI-Easy-Use** (for the detail pass): ComfyUI-Manager -> Install via Git URL, or https://github.com/yolain/ComfyUI-Easy-Use
- **ComfyUI-MangaMode-Bridge** (to use your own workflows): copy the `comfyui-bridge` folder of this repository to `ComfyUI/custom_nodes/`
  and rename it `ComfyUI-MangaMode-Bridge` (see the README).

## Optional: character reference pictures (IP-Adapter, For strong GPUs)

1. Install the node: in `ComfyUI/custom_nodes` run `git clone https://github.com/LuciferTC9527/ComfyUI-Anima_IP-Adapter`
   (or ComfyUI-Manager -> Install via Git URL).
2. Download `ip_adapter-Character_Reference-10.safetensors` (503 MB) from https://huggingface.co/LuciferTC/Anima-IP-Adapter/tree/main
   into `ComfyUI/models/ipadapter` (create the folder if it is missing).
3. The SigLIP2 encoder downloads itself the first time it is used.
4. Restart ComfyUI, drag `workflows/the true one + IP-Adapter.api.json` into ComfyUI, press Ctrl+S, then pick it under
   Workflow in Manga Mode and tick "Character reference pictures".
