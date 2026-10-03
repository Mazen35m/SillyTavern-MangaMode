"""MangaMode bridge: lets SillyTavern's MangaMode draw with a workflow saved in ComfyUI.

When a workflow is saved in ComfyUI (Ctrl+S), the web part below also stores ComfyUI's own runnable
("API") version of it in user/default/mangamode/ and - when the SillyTavern folder is set in
mangamode_bridge.json next to this file - copies it into SillyTavern's ComfyUI workflow folder as
"MangaMode - <name>.json" (plus "MangaMode - <name>.ui" for the editable version). SillyTavern's
own server reads it from there, so no browser has to talk to ComfyUI directly (ComfyUI refuses
requests from other pages, which is right).

mangamode_bridge.json:
    {"sillytavern": "C:\\path\\to\\SillyTavern"}      (the folder that holds start.bat)
The user folder "data/default-user/user/workflows" inside it is used; set "sillytavern_workflows"
instead to point at another user's workflows folder.
"""
import json
import os
import re

from aiohttp import web
import folder_paths
import server

WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

STORE = os.path.join(folder_paths.get_user_directory(), "default", "mangamode")
os.makedirs(STORE, exist_ok=True)
LOCAL_ORIGIN = re.compile(r"^https?://(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$")
routes = server.PromptServer.instance.routes
CONFIG = os.path.join(os.path.dirname(__file__), "mangamode_bridge.json")


def _tavern_dir():
    """SillyTavern's ComfyUI workflow folder, or None when it is not set or not found."""
    try:
        with open(CONFIG, encoding="utf-8") as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        return None
    folder = cfg.get("sillytavern_workflows") or (
        cfg.get("sillytavern") and os.path.join(cfg["sillytavern"], "data", "default-user", "user", "workflows"))
    return folder if folder and os.path.isdir(folder) else None


def _tavern_name(name):
    return "MangaMode - " + re.sub(r'[<>:"/\\|?*]', "_", name)


def _copy_to_tavern(name, api, ui):
    tavern = _tavern_dir()
    if not tavern:
        return False
    target = os.path.join(tavern, _tavern_name(name))
    with open(target + ".json", "w", encoding="utf-8") as f:
        json.dump(api, f, ensure_ascii=False, indent=1)
    if isinstance(ui, dict):
        with open(target + ".ui", "w", encoding="utf-8") as f:
            json.dump(ui, f, ensure_ascii=False)
    return True


def _sync_all():
    """At start: copy every workflow already stored here, so SillyTavern sees them without a re-save."""
    try:
        for f in os.listdir(STORE):
            if not f.endswith(".api.json"):
                continue
            base = os.path.join(STORE, f[: -len(".api.json")])
            with open(base + ".api.json", encoding="utf-8") as fh:
                api = json.load(fh)
            ui = None
            if os.path.exists(base + ".ui.json"):
                with open(base + ".ui.json", encoding="utf-8") as fh:
                    ui = json.load(fh)
            if not _copy_to_tavern(f[: -len(".api.json")].replace("__", "/"), api, ui):
                print("[MangaMode bridge] SillyTavern folder not set or not found - edit " + CONFIG)
                return
    except Exception as error:  # never stop ComfyUI from starting
        print("[MangaMode bridge] could not copy workflows to SillyTavern:", error)


_sync_all()


def _safe(name):
    name = str(name or "").strip().replace("\\", "/")
    if not name or name.startswith("/") or ".." in name.split("/"):
        return None
    return name


def _cors(request, response):
    origin = request.headers.get("Origin", "")
    if LOCAL_ORIGIN.match(origin):
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Vary"] = "Origin"
    return response


@routes.post("/mangamode/save")
async def mangamode_save(request):
    data = await request.json()
    name = _safe(data.get("name"))
    if not name or not isinstance(data.get("api"), dict):
        return web.json_response({"error": "name and api required"}, status=400)
    path = os.path.join(STORE, name.replace("/", "__"))
    try:
        with open(path + ".api.json", "w", encoding="utf-8") as f:
            json.dump(data["api"], f, ensure_ascii=False, indent=1)
        if isinstance(data.get("ui"), dict):
            with open(path + ".ui.json", "w", encoding="utf-8") as f:
                json.dump(data["ui"], f, ensure_ascii=False)
        tavern = _copy_to_tavern(name, data["api"], data.get("ui"))
    except OSError as error:  # disk full, folder locked: say so instead of an unexplained 500
        print("[MangaMode bridge] could not save " + name + ":", error)
        return web.json_response({"ok": False, "error": str(error)}, status=500)
    if not tavern:
        print("[MangaMode bridge] SillyTavern folder not set or not found - edit " + CONFIG)
    return web.json_response({"ok": True, "name": name, "sillytavern": bool(tavern)})


@routes.get("/mangamode/workflows")
async def mangamode_list(request):
    names = sorted(f[: -len(".api.json")].replace("__", "/") for f in os.listdir(STORE) if f.endswith(".api.json"))
    return _cors(request, web.json_response({"workflows": names}))


@routes.get("/mangamode/workflow")
async def mangamode_get(request):
    name = _safe(request.query.get("name"))
    if not name:
        return _cors(request, web.json_response({"error": "bad name"}, status=400))
    path = os.path.join(STORE, name.replace("/", "__"))
    if not os.path.exists(path + ".api.json"):
        return _cors(request, web.json_response({"error": "not found"}, status=404))
    with open(path + ".api.json", encoding="utf-8") as f:
        api = json.load(f)
    ui = None
    if os.path.exists(path + ".ui.json"):
        with open(path + ".ui.json", encoding="utf-8") as f:
            ui = json.load(f)
    return _cors(request, web.json_response({"name": name, "api": api, "ui": ui}))
