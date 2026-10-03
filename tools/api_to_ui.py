"""Turn a ComfyUI API-format graph into a UI workflow file (what the ComfyUI editor opens).

Usage: python3 api_to_ui.py api.json out.json [layout.json]
Only the node types MangaMode uses are known; widget order follows each node's INPUT_TYPES.
"""
import json
import sys

WIDGETS = {
    'UNETLoader': ['unet_name', 'weight_dtype'],
    'CLIPLoader': ['clip_name', 'type', 'device'],
    'VAELoader': ['vae_name'],
    'LoraLoaderModelOnly': ['lora_name', 'strength_model'],
    'CLIPTextEncode': ['text'],
    'ConditioningConcat': [],
    'EmptyLatentImage': ['width', 'height', 'batch_size'],
    'KSampler': ['seed', '__control', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'],
    'VAEDecode': [],
    'VAEEncode': [],
    'SaveImage': ['filename_prefix'],
    'LoadImage': ['image', '__upload'],
    'ImageScale': ['upscale_method', 'width', 'height', 'crop'],
    'AnimaRefEncode': ['target_width', 'target_height'],
    'AnimaRefLatentBatch': ['fit_mode'],
    'AnimaInContextApply': ['strength', 'start_percent', 'end_percent', 'cond_only', 'fit_mode', 'ref_timestep'],
}
OUTPUTS = {
    'UNETLoader': [('MODEL', 'MODEL')], 'CLIPLoader': [('CLIP', 'CLIP')], 'VAELoader': [('VAE', 'VAE')],
    'LoraLoaderModelOnly': [('MODEL', 'MODEL')], 'CLIPTextEncode': [('CONDITIONING', 'CONDITIONING')],
    'ConditioningConcat': [('CONDITIONING', 'CONDITIONING')], 'EmptyLatentImage': [('LATENT', 'LATENT')],
    'KSampler': [('LATENT', 'LATENT')], 'VAEDecode': [('IMAGE', 'IMAGE')], 'VAEEncode': [('LATENT', 'LATENT')],
    'SaveImage': [], 'LoadImage': [('IMAGE', 'IMAGE'), ('MASK', 'MASK')], 'ImageScale': [('IMAGE', 'IMAGE')],
    'AnimaRefEncode': [('LATENT', 'LATENT')], 'AnimaRefLatentBatch': [('LATENT', 'LATENT')],
    'AnimaInContextApply': [('MODEL', 'MODEL')],
}
INPUT_TYPES = {
    'model': 'MODEL', 'clip': 'CLIP', 'vae': 'VAE', 'positive': 'CONDITIONING', 'negative': 'CONDITIONING',
    'conditioning_to': 'CONDITIONING', 'conditioning_from': 'CONDITIONING', 'latent_image': 'LATENT',
    'samples': 'LATENT', 'images': 'IMAGE', 'image': 'IMAGE', 'pixels': 'IMAGE', 'mask': 'MASK',
    'ref_latent': 'LATENT', 'ref_latent_1': 'LATENT', 'ref_latent_2': 'LATENT',
}
SIZES = {'CLIPTextEncode': [420, 220], 'KSampler': [300, 262], 'LoadImage': [300, 320]}


def convert(api, layout, groups):
    ids = {k: i + 1 for i, k in enumerate(api.keys())}
    nodes, links = [], []
    link_id = 0
    out_links = {}
    for key, node in api.items():
        for name, value in node['inputs'].items():
            if isinstance(value, list) and len(value) == 2 and isinstance(value[0], str):
                link_id += 1
                src = ids[value[0]]
                links.append([link_id, src, value[1], ids[key], name, INPUT_TYPES.get(name, '*')])
                out_links.setdefault((src, value[1]), []).append(link_id)
    for order, (key, node) in enumerate(api.items()):
        t = node['class_type']
        nid = ids[key]
        widgets = []
        for w in WIDGETS.get(t, []):
            if w == '__control':
                widgets.append('fixed')
            elif w == '__upload':
                widgets.append('image')
            else:
                widgets.append(node['inputs'].get(w))
        inputs = []
        slot_of = {}
        for name, value in node['inputs'].items():
            if isinstance(value, list) and len(value) == 2 and isinstance(value[0], str):
                slot_of[name] = len(inputs)
                lid = next(l[0] for l in links if l[3] == nid and l[4] == name)
                inputs.append({'name': name, 'type': INPUT_TYPES.get(name, '*'), 'link': lid})
        for l in links:
            if l[3] == nid:
                l[4] = slot_of[l[4]]
        outputs = []
        for slot, (name, typ) in enumerate(OUTPUTS.get(t, [])):
            outputs.append({'name': name, 'type': typ, 'links': out_links.get((nid, slot), []), 'slot_index': slot})
        pos = layout.get(key, [100 + 360 * (order % 6), 100 + 300 * (order // 6)])
        nodes.append({
            'id': nid, 'type': t, 'pos': pos, 'size': SIZES.get(t, [300, 100]), 'flags': {}, 'order': order, 'mode': 0,
            'inputs': inputs, 'outputs': outputs, 'properties': {'Node name for S&R': t},
            'widgets_values': widgets, 'title': node.get('_meta', {}).get('title'),
        })
        if not nodes[-1]['title']:
            del nodes[-1]['title']
    return {
        'last_node_id': len(nodes), 'last_link_id': link_id, 'nodes': nodes, 'links': links,
        'groups': groups, 'config': {}, 'extra': {'ds': {'scale': 0.65, 'offset': [60, 60]}}, 'version': 0.4,
    }


if __name__ == '__main__':
    api = json.load(open(sys.argv[1], encoding='utf-8'))
    extra = json.load(open(sys.argv[3], encoding='utf-8')) if len(sys.argv) > 3 else {}
    ui = convert(api, extra.get('layout', {}), extra.get('groups', []))
    json.dump(ui, open(sys.argv[2], 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('nodes', len(ui['nodes']), 'links', len(ui['links']))
