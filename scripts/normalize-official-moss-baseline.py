import json,pathlib,hashlib,importlib.util,sys,copy
sys.dont_write_bytecode=True
root=pathlib.Path('runtime/official-moss');root.mkdir(exist_ok=True)
# This utility only adds explicit name metadata to a separate reproduction copy.
# It never writes a source workflow or guesses processing values.
raw=pathlib.Path('runtime/moss-upstream.json');w=json.loads(raw.read_text());local=json.loads(pathlib.Path('runtime/user/default/workflows/image_moss_image_base_t2i.json').read_text());normalized=copy.deepcopy(w);trace=[]
localbodies=[local]+local.get('definitions',{}).get('subgraphs',[]);bodies=[normalized]+normalized.get('definitions',{}).get('subgraphs',[]);assert len(localbodies)==len(bodies);defs={d['id']:d for d in normalized['definitions']['subgraphs']}
for body,known in zip(bodies,localbodies):
 existing={n['id']:n for n in known['nodes']}
 for node in body['nodes']:
  vals=node.get('widgets_values');
  if not isinstance(vals,list)or node['type']in['MarkdownNote','Note']:continue
  if node['type']in defs:
   names=[i['name']for i in defs[node['type']]['inputs']if i['type']not in ['IMAGE']]
   metadata=[{'name':i['name'],'type':i['type'],'link':None,'widget':{'name':i['name']}}for i in defs[node['type']]['inputs']if i['name']in names]
   basis='official subgraph declared input order'
  else:
   knownnode=existing[node['id']];assert knownnode['type']==node['type'];names=list(knownnode.get('widgets_values_named',{}));metadata=[i for i in knownnode['inputs']if isinstance(i.get('widget'),dict)];basis='same node/class named-widget mapping from existing normalized official copy; count equality required'
  assert len(vals)==len(names),(node['id'],names,vals)
  node['widgets_values_named']=dict(zip(names,vals));inputs={i['name']:i for i in node.get('inputs',[])}
  for meta in metadata:
   if meta['name']not in inputs:node.setdefault('inputs',[]).append(copy.deepcopy(meta))
  trace.append({'body':body.get('id'),'node':node['id'],'class':node['type'],'mapping_basis':basis,'names':names,'values_preserved':list(node['widgets_values_named'].values())==vals})
for original_body, normalized_body in zip([w]+w.get('definitions',{}).get('subgraphs',[]), bodies):
 assert original_body.get('links') == normalized_body.get('links')
 for original_node, normalized_node in zip(original_body['nodes'], normalized_body['nodes']):
  assert original_node['id'] == normalized_node['id'] and original_node['type'] == normalized_node['type']
  assert original_node.get('widgets_values') == normalized_node.get('widgets_values')
  assert all(i in normalized_node.get('inputs',[]) for i in original_node.get('inputs',[]))
spec=importlib.util.spec_from_file_location('cv',pathlib.Path('scripts/comfy-ui2api.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);conv=m.convert(normalized)
(root/'official-ui.json').write_bytes(raw.read_bytes());(root/'normalized-ui.json').write_text(json.dumps(normalized,indent=2));(root/'api.json').write_text(json.dumps(conv.prompt,indent=2));(root/'mapping.json').write_text(json.dumps({'source':'https://raw.githubusercontent.com/Comfy-Org/workflow_templates/46e060ea88eb07adecf07197ec384c54a70e030c/templates/image_moss_image_base_t2i.json','source_sha256':hashlib.sha256(raw.read_bytes()).hexdigest(),'reference_normalized_copy_sha256':hashlib.sha256(pathlib.Path('runtime/user/default/workflows/image_moss_image_base_t2i.json').read_bytes()).hexdigest(),'trace':trace,'warnings':conv.warnings,'api_sha256':hashlib.sha256((root/'api.json').read_bytes()).hexdigest()},indent=2));print('warnings',conv.warnings);print('sampler',conv.prompt['18_7']);print('prompt',conv.prompt['18_17']);print('expander seed',conv.prompt['18_11']['inputs'].get('sampling_mode.seed'))
