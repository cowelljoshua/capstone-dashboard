'use strict';

let publishedData;
const publishedManifest = fetch('./manifest.json').then(async response => {
  if (!response.ok) throw new Error('Could not load the published dashboard.');
  publishedData = await response.json();
  return publishedData;
});
function publishedKey(path) {
  const url = new URL(path, location.origin);
  const category = url.searchParams.get('category');
  return url.pathname + (category ? '?category=' + encodeURIComponent(category) : '');
}
function publishedAsset(path) {
  const file = publishedData?.assets[publishedKey(path)];
  return file ? new URL(file, document.baseURI).href : '#';
}
// Hardcoded chart links are also resolved through the same snapshot allowlist.
new MutationObserver(() => {
  document.querySelectorAll('a[href^="/api/"]').forEach(link => {
    const file = publishedData?.assets[publishedKey(link.getAttribute('href'))];
    if (file) link.href = new URL(file, document.baseURI).href;
    else link.remove();
  });
}).observe(document.documentElement, {childList:true, subtree:true});
document.addEventListener('click', event => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (['new-run','new-revision','edit-family','edit-revision','rename','duplicate','folder','start','stop','set-marker','refresh-imports','publish-dashboard'].includes(action)) {
    event.preventDefault(); event.stopImmediatePropagation();
  }
}, true);
const crcTable=Array.from({length:256},(_,value)=>{
  for(let bit=0;bit<8;bit++)value=(value&1)?0xedb88320^(value>>>1):value>>>1;
  return value>>>0;
});
async function publishedZip(button) {
  const manifest=await publishedManifest, members=manifest.bundles[button.dataset.bundle];
  if(!members)throw new Error('This download is unavailable.');
  const locals=[],central=[];let offset=0;
  const header=size=>new Uint8Array(size), encoder=new TextEncoder();
  for(const member of members){
    const response=await fetch(new URL(member.asset,document.baseURI));
    if(!response.ok)throw new Error('Could not download '+member.name);
    const data=new Uint8Array(await response.arrayBuffer()), name=encoder.encode(member.name);
    let crc=0xffffffff;for(const byte of data)crc=crcTable[(crc^byte)&255]^(crc>>>8);crc=(crc^0xffffffff)>>>0;
    const local=header(30),lv=new DataView(local.buffer);
    lv.setUint32(0,0x04034b50,true);lv.setUint16(4,20,true);lv.setUint16(6,0x800,true);lv.setUint16(12,33,true);
    lv.setUint32(14,crc,true);lv.setUint32(18,data.length,true);lv.setUint32(22,data.length,true);lv.setUint16(26,name.length,true);
    locals.push(local,name,data);
    const record=header(46),cv=new DataView(record.buffer);
    cv.setUint32(0,0x02014b50,true);cv.setUint16(4,20,true);cv.setUint16(6,20,true);cv.setUint16(8,0x800,true);cv.setUint16(14,33,true);
    cv.setUint32(16,crc,true);cv.setUint32(20,data.length,true);cv.setUint32(24,data.length,true);cv.setUint16(28,name.length,true);cv.setUint32(42,offset,true);
    central.push(record,name);offset+=local.length+name.length+data.length;
  }
  const centralSize=central.reduce((sum,part)=>sum+part.length,0),end=header(22),ev=new DataView(end.buffer);
  ev.setUint32(0,0x06054b50,true);ev.setUint16(8,members.length,true);ev.setUint16(10,members.length,true);ev.setUint32(12,centralSize,true);ev.setUint32(16,offset,true);
  const run=button.dataset.bundle.split('/')[3],category=new URL(button.dataset.bundle,location.origin).searchParams.get('category') || 'all';
  saveBlob(new Blob([...locals,...central,end],{type:'application/zip'}),run+'-'+category+'.zip');
}
document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-bundle]');if(!button)return;
  event.preventDefault();event.stopImmediatePropagation();button.disabled=true;
  try{toast('Preparing download…');await publishedZip(button);toast('Download ready.');}
  catch(error){toast(error.message,true);}finally{button.disabled=false;}
},true);


const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const enc = encodeURIComponent;
const main = $('#main');
const dialog = $('#dialog');
const state = {projects:[], project:null, runs:[], families:[], revisions:[], catalogRevisions:[], closedFamilies:new Set(), openRevisions:new Set(), selected:new Set(), preview:null, detail:null, tab:'solve', results:null, outputs:[], previews:null, previewError:null, monitor:null, chartFilter:'all', charts:new Map(), live:true, pending:false, page:1, size:10, sort:'newest', search:'', status:'all', marker:'all', comparison:null, generation:0};
const urlState = new URLSearchParams(location.search);
state.view='runs';
state.search = urlState.get('q') || ''; state.status = urlState.get('status') || 'all'; state.page = Math.max(1,Number(urlState.get('page')) || 1); state.sort = urlState.get('sort') || 'newest'; state.marker = urlState.get('marker') || 'all';
const chartDefaults = [
  {id:'force',title:'Contact force',x_label:'Time (ms)',y_label:'Force (kN)'},
  {id:'velocity',title:'Velocity',x_label:'Time (ms)',y_label:'Velocity (m/s)'},
  {id:'travel',title:'Travel',x_label:'Time (ms)',y_label:'Travel (mm)'},
  {id:'compression',title:'Compression',x_label:'Time (ms)',y_label:'Compression (mm)'},
  {id:'regional_p99',title:'Regional P99',x_label:'Time (ms)',y_label:'Stress (MPa)'},
  {id:'energy',title:'Energy',x_label:'Time (ms)',y_label:'Energy (J)'}
];
const colors = ['#2878b5','#df832b','#9170ba','#37876c','#b65353','#54718c','#a07332','#397987'];
let pollTimer, toastTimer, lastFocus, newRunDraft, familyGeneration = 0;

async function api(path, options = {}) {
  if (options.method && options.method !== 'GET') throw new Error('This is a published snapshot.');
  const manifest = await publishedManifest;
  const url = new URL(path, location.origin);
  const file = manifest.endpoints[url.pathname];
  if (!file) throw new Error('This information is not in the published snapshot.');
  const response = await fetch(file);
  if (!response.ok) throw new Error('Could not load the published snapshot.');
  let data = await response.json();
  if (Array.isArray(data)) {
    for (const key of ['project_id','family_id']) {
      if (url.searchParams.has(key)) data = data.filter(item => String(item[key]) === url.searchParams.get(key));
    }
  }
  const rewrite = value => {
    if (typeof value === 'string' && value.startsWith('/api/')) return publishedAsset(value);
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,rewrite(item)]));
    return value;
  };
  return rewrite(data);
}
function list(data) { return Array.isArray(data) ? data : (data.items || data.runs || data.families || data.revisions || data.projects || data.outputs || []); }
function toast(message, error = false) { const host=$('#toast'); host.textContent=message; host.classList.toggle('error',error);host.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{host.hidden=true;},5500); }
function badge(status) { const value=String(status || 'draft');return `<span class="badge ${esc(value.toLowerCase())}">${esc(value.charAt(0).toUpperCase()+value.slice(1))}</span>`; }
function format(value, digits=1) { return value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : new Intl.NumberFormat('en-US',{maximumFractionDigits:digits}).format(Number(value)); }
function bytes(value) { return value == null ? '—' : `${format(value / 1024**3,1)} GB`; }
function duration(seconds) { if(seconds == null || !Number.isFinite(Number(seconds))) return '—';if(seconds<60)return `${Math.round(seconds)} s`;if(seconds<3600)return `${Math.floor(seconds/60)} min ${Math.round(seconds%60)} s`;return `${Math.floor(seconds/3600)} h ${Math.floor(seconds%3600/60)} min`; }
function date(value) { if(!value)return '—';const d=new Date(value);return Number.isNaN(d.getTime())?'—':new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'America/New_York'}).format(d); }
function runName(run) { return run.name || `Run ${String(run.number || 0).padStart(3,'0')}`; }
function revisionLabel(run) {return run.revision_nickname || state.catalogRevisions.find(revision=>revision.id===run.revision_id)?.nickname || 'Unnamed design';}
function revisionTitle(revision) {return revision.nickname || 'Unnamed design';}
function runPath(run, suffix='') { return publishedAsset(`/api/runs/${enc(run.id)}${suffix}`); }
function preserveURL() { if(state.view==='stats'){history.replaceState({},'',`${location.pathname}?view=stats`);return;}const query=new URLSearchParams();if(state.project)query.set('project',state.project.id);if(state.search)query.set('q',state.search);if(state.status!=='all')query.set('status',state.status);if(state.marker!=='all')query.set('marker',state.marker);if(state.sort!=='newest')query.set('sort',state.sort);if(state.detail){query.set('run',state.detail.id);query.set('tab',state.tab);}history.replaceState({},'',`${location.pathname}${query.size?'?'+query:''}`); }
function menu(run) { return ''; }
function downloadLink(run,category,label) { return `<button class="small" data-bundle="/api/runs/${enc(run.id)}/export.zip${category?'?category='+category:''}">${esc(label)}</button>`; }
function downloads(run) { return `<div class="download-bar" aria-label="Run downloads">${downloadLink(run,'','All files ZIP')}<a class="button small" href="${runPath(run,'/report.pdf')}" download>PDF report</a><a class="button small" href="${runPath(run,'/report.html')}" download>Standalone HTML</a>${downloadLink(run,'images','Images')}${downloadLink(run,'graphs','Graphs')}${downloadLink(run,'animations','Animations')}${downloadLink(run,'reports','Reports')}${downloadLink(run,'data','Data')}</div>`; }
function keyValues(object) { if(typeof object!=='object'||object===null)return object?`<p class="mono">${esc(object)}</p>`:'<p class="muted">No settings saved.</p>';const entries=[];function walk(value,prefix='') { Object.entries(value || {}).forEach(([key,item])=>{ const label=(prefix?prefix+' · ':'')+key.replaceAll('_',' ');if(item&&typeof item==='object'&&!Array.isArray(item))walk(item,label);else entries.push([label,Array.isArray(item)?item.join(', '):item]);}); }walk(object);return entries.length?`<dl class="kv">${entries.map(([k,v])=>`<div class="kv-row"><dt>${esc(k)}</dt><dd>${esc(v === null || v === undefined ? '—' : v)}</dd></div>`).join('')}</dl>`:'<p class="muted">No settings saved.</p>'; }
function changesHTML(run) {const changes=run.changes || run.revision?.changes;return changes&&Object.keys(changes).length?keyValues(changes):'<p class="muted">No changes recorded.</p>';}
function mutationError(message) {let host=$('#mutation-error');if(!host){main.insertAdjacentHTML('afterbegin','<div id="mutation-error" class="error-state" role="status"></div>');host=$('#mutation-error');}host.textContent=message;}
function checksHTML(checks=[], warnings=[]) { const items=[...checks,...warnings.map(w=>typeof w==='string'?{label:w,status:'warning'}:{...w,status:'warning'})];return items.length?`<ul class="check-list">${items.map(c=>`<li>${badge(c.status || (c.passed === true?'passed':c.passed === false?'warning':'info'))}<span>${esc(typeof c==='string'?c:(c.label || c.name || c.message))}${c.detail?`<small> · ${esc(c.detail)}</small>`:''}</span></li>`).join('')}</ul>`:'<p class="muted">No checks available.</p>'; }
function metricsHTML(metrics=[]) {return metrics.length?`<div class="metrics">${metrics.map(m=>`<div><span class="metric-label">${esc(m.label || m.name)}</span><span class="metric-value">${typeof m.value==='number'?format(m.value,2):esc(m.value ?? '—')} <small>${esc(m.unit || '')}</small></span></div>`).join('')}</div>`:'<p class="muted" style="margin-bottom:20px">Metrics are not available for this run.</p>';}
function metricsOverview(metrics=[]) {return `${metricsHTML(metrics.slice(0,3))}${metrics.length>3?`<details class="form-section"><summary>More metrics (${metrics.length-3})</summary><div class="detail-body">${metricsHTML(metrics.slice(3))}</div></details>`:''}`;}
function checksOverview(checks=[],warnings=[]) {const count=warnings.length+checks.filter(c=>c.passed===false||['warning','failed'].includes(c.status)).length;return `<details class="form-section"><summary>Checks (${checks.length})${count?` · ${count} ${count===1?'warning':'warnings'}`:''}</summary><div class="detail-body">${checksHTML(checks,warnings)}</div></details>`;}

async function boot() {
  try {
    state.projects=list(await api('/api/projects'));
    state.project=state.projects.find(p=>String(p.id)===urlState.get('project')) || state.projects[0];
    if (!state.project) {main.innerHTML='<div class="empty"><h1>No projects</h1><p>Add a project to the local dashboard registry.</p></div>';return;}
    await loadProject(false);
    if(urlState.get('view')==='stats')await showStats();
    else if(urlState.get('run'))await openRun(urlState.get('run'),urlState.get('tab') || 'solve');
    updateSystem(); schedulePoll();
  } catch(error){ main.innerHTML=`<div class="error-state">${esc(error.message)} <button data-action="retry-boot">Retry</button></div>`; }
}
const markerChoices=[{id:'gray',label:'Unmarked'},{id:'favorite',label:'Favorite'},{id:'red',label:'Red'},{id:'orange',label:'Orange'},{id:'yellow',label:'Yellow'},{id:'green',label:'Green'},{id:'blue',label:'Blue'}];
function markerName(marker) {return markerChoices.find(choice=>choice.id===marker)?.label || 'Unmarked';}
function markerGlyph(marker='gray') {return `<span class="marker-glyph marker-${esc(marker)}" aria-hidden="true">${marker==='favorite'?'♥':''}</span>`;}
function markerPicker(run) { return `<span class="published-marker" title="${esc(markerName(run.marker))}">${markerGlyph(run.marker || 'gray')}</span>`; }
async function setMarker(run,marker) {
  if(state.pending)return;if((run.marker || 'gray')===marker){$$('.marker-picker[open]').forEach(d=>d.open=false);return;}
  state.pending=true;const buttons=$$('[data-action="set-marker"]');buttons.forEach(button=>button.disabled=true);
  try {const updated=await api(runPath(run),{method:'PATCH',body:JSON.stringify({marker})});state.runs=state.runs.map(item=>item.id===run.id?{...item,...updated,marker}:item);if(state.detail?.id===run.id){state.detail={...state.detail,...updated,marker};renderRun();}else{renderRows();const trigger=$$('[data-marker-trigger]').find(element=>element.dataset.markerTrigger===run.id);(trigger || $('#marker-filter'))?.focus();}toast(marker==='gray'?'Marker cleared.':`${markerName(marker)} marker saved.`);}
  catch(error){mutationError(error.message);}finally{state.pending=false;buttons.forEach(button=>{if(button.isConnected)button.disabled=false;});}
}
async function loadProject(render=true) {
  const token=++state.generation;
  const [runs,families,revisions]=await Promise.all([api(`/api/runs?project_id=${enc(state.project.id)}`),api(`/api/families?project_id=${enc(state.project.id)}`),api('/api/revisions')]);
  if(token!==state.generation)return;
  state.runs=list(runs);state.families=list(families);const familyIds=new Set(state.families.map(family=>family.id));state.catalogRevisions=list(revisions).filter(revision=>familyIds.has(revision.family_id));state.selected=new Set([...state.selected].filter(id=>state.runs.some(run=>run.id===id)));if(render || !state.detail){expandMatches();renderList();}
}
function filteredRuns() {return state.runs.filter(run=>`${runName(run)} ${revisionLabel(run)} ${run.settings?.notes || ''}`.toLowerCase().includes(state.search.toLowerCase()) && (state.status==='all'||run.status===state.status) && (state.marker==='all'||(run.marker || 'gray')===state.marker)).sort((a,b)=>state.sort==='oldest'?new Date(a.created_at)-new Date(b.created_at):state.sort==='name'?runName(a).localeCompare(runName(b)):new Date(b.created_at)-new Date(a.created_at));}
function expandMatches() {if(state.search||state.status!=='all'||state.marker!=='all'){filteredRuns().forEach(run=>{state.openRevisions.add(run.revision_id);state.closedFamilies.delete(run.family_id);});}}
function revisionMenu(revision) { return ''; }
function renderList() {
  main.className='';document.title='Capstone';
  main.innerHTML=`<div class="page-heading ${state.projects.length>1?'':'no-title'}">${state.projects.length>1?`<h1><select id="project-select" class="project-select" aria-label="Project">${state.projects.map(project=>`<option value="${esc(project.id)}" ${project.id===state.project.id?'selected':''}>${esc(project.name)}</option>`).join('')}</select></h1>`:''}<div class="actions"><details class="row-menu project-menu"><summary aria-label="Project actions">More ▾</summary><div class="menu-items"><button data-action="refresh-imports">Refresh imports</button><button data-action="publish-dashboard">Publish update</button></div></details><button class="primary" data-action="new-run">+ New run</button></div></div><div class="toolbar"><button id="compare-button" data-action="compare" ${state.selected.size<2?'disabled':''}>Compare (${state.selected.size})</button><span class="spacer"></span><div class="search"><input id="search" type="search" aria-label="Search families, revisions and runs" placeholder="Search…" value="${esc(state.search)}"><button id="clear-search" aria-label="Clear search" ${state.search?'':'hidden'}>×</button></div><select id="status-filter" class="filter" aria-label="Filter by status"><option value="all">All statuses</option>${[...new Set(['draft','running','completed','failed',...state.runs.map(run=>run.status)])].map(status=>`<option value="${esc(status)}" ${state.status===status?'selected':''}>${esc(status.charAt(0).toUpperCase()+status.slice(1))}</option>`).join('')}</select><select id="marker-filter" class="filter" aria-label="Filter by marker"><option value="all">All markers</option>${markerChoices.map(choice=>`<option value="${choice.id}" ${state.marker===choice.id?'selected':''}>${choice.label}</option>`).join('')}</select></div><div class="hierarchy-tools"><label><input id="select-matching" type="checkbox"> Select all</label><span id="run-count"></span><select id="run-sort" aria-label="Sort runs within revisions"><option value="newest">Newest runs first</option><option value="oldest">Oldest runs first</option><option value="name">Run name</option></select></div><div id="family-hierarchy"></div><section id="preview" aria-live="polite"></section>`;
  $('#run-sort').value=state.sort;renderRows();
}
function hierarchyRun(run) {
  return `<li class="hierarchy-run ${state.selected.has(run.id)?'selected ':''}"><input type="checkbox" data-select="${esc(run.id)}" aria-label="Compare ${esc(runName(run))}" ${state.selected.has(run.id)?'checked':''}>${markerPicker(run)}<div class="hierarchy-run-name"><button class="run-name" data-action="open-run" data-run="${esc(run.id)}">${esc(runName(run))}</button></div>${badge(run.status)}<time datetime="${esc(run.created_at)}">${date(run.created_at)}</time><div class="row-actions">${menu(run)}</div></li>`;
}
function hierarchyRevision(revision,runs,totalRuns) {
  const open=state.openRevisions.has(revision.id),count=runs.length===totalRuns.length?`${runs.length} ${runs.length===1?'run':'runs'}`:`${runs.length} of ${totalRuns.length} runs`;
  return `<section class="revision-group ${open?'is-expanded':''}"><div class="revision-line"><button class="revision-toggle" data-action="toggle-revision" data-revision="${esc(revision.id)}" aria-expanded="${open}" aria-controls="runs-${esc(revision.id)}"><span class="design-chevron" aria-hidden="true"></span><span class="design-name">${esc(revisionTitle(revision))}</span><span class="design-run-count">${count}</span></button>${revisionMenu(revision)}</div><ul id="runs-${esc(revision.id)}" class="revision-runs" aria-label="Runs for ${esc(revisionTitle(revision))}" ${open?'':'hidden'}>${runs.length?runs.map(hierarchyRun).join(''):'<li class="design-empty">No runs yet.</li>'}</ul></section>`;
}
function renderRows() {
  const host=$('#family-hierarchy');if(!host)return;
  const focused=document.activeElement,focusSelect=focused.dataset.select,focusAction=focused.dataset.action,focusFamily=focused.dataset.family,focusRevision=focused.dataset.revision;
  const runs=filteredRuns(),query=state.search.toLowerCase(),activeFilters=Boolean(query)||state.status!=='all'||state.marker!=='all';let familyCount=0,revisionCount=0;
  const cards=state.families.map(family=>{
    const familyRuns=state.runs.filter(run=>run.family_id===family.id),revisions=state.catalogRevisions.filter(revision=>revision.family_id===family.id).sort((a,b)=>Number(b.number)-Number(a.number));
    const visible=revisions.map(revision=>{const matching=runs.filter(run=>run.revision_id===revision.id),total=familyRuns.filter(run=>run.revision_id===revision.id),text=`${family.name} v${revision.number} ${revision.nickname || ''}`.toLowerCase();return {revision,matching,total,visible:matching.length>0||(!total.length&&state.status==='all'&&state.marker==='all'&&(!query||text.includes(query)))};}).filter(item=>item.visible);
    if(!visible.length&&activeFilters)return '';familyCount++;revisionCount+=visible.length;const open=!state.closedFamilies.has(family.id);
    return `<section class="family-card ${state.families.length===1?'single-family':''}" ${state.families.length===1?'aria-label="Designs"':`aria-labelledby="family-title-${esc(family.id)}"`}>${state.families.length>1?`<div class="family-line"><h2 id="family-title-${esc(family.id)}"><button class="family-toggle" data-action="toggle-family" data-family="${esc(family.id)}" aria-expanded="${open}" aria-controls="family-${esc(family.id)}"><span class="hierarchy-chevron" aria-hidden="true">${open?'▾':'▸'}</span><strong>${esc(family.name)}</strong><span class="muted">${visible.length} ${visible.length===1?'design':'designs'}</span></button></h2><button class="ghost small" data-action="edit-family" data-family="${esc(family.id)}" aria-label="Rename ${esc(family.name)}">Rename</button><details class="row-menu"><summary aria-label="More actions for ${esc(family.name)}" title="More">•••</summary><div class="menu-items"><button data-action="new-run" data-family="${esc(family.id)}">New run</button><button data-action="new-revision" data-family="${esc(family.id)}" ${revisions.length?`data-revision="${esc(revisions[0].id)}"`:''}>Add revision</button></div></details></div>`:''}<div id="family-${esc(family.id)}" class="family-revisions" ${state.families.length===1||open?'':'hidden'}>${visible.length?visible.map(item=>hierarchyRevision(item.revision,item.matching,item.total)).join(''):`<div class="empty">No revisions yet.<p><button class="small" data-action="new-revision" data-family="${esc(family.id)}">Add revision</button></p></div>`}</div></section>`;
  }).join('');
  host.innerHTML=cards||`<div class="panel empty">${activeFilters?'No matches.':'No families yet.'}${activeFilters?'':'<p>Add a design to create your first family.</p>'}<button data-action="${activeFilters?'clear-filters':'new-run'}">${activeFilters?'Clear filters':'+ New run'}</button></div>`;
  $('#run-count').textContent=`${runs.length} ${runs.length===1?'run':'runs'}`;
  const selected=runs.filter(run=>state.selected.has(run.id)).length;$('#select-matching').checked=runs.length>0&&selected===runs.length;$('#select-matching').indeterminate=selected>0&&selected<runs.length;
  $('#compare-button').textContent=`Compare (${state.selected.size})`;$('#compare-button').disabled=state.selected.size<2;preserveURL();
  if(focusSelect)$$('[data-select]',host).find(element=>element.dataset.select===focusSelect)?.focus();
  else if(focusAction&&['toggle-family','toggle-revision'].includes(focusAction))$$('[data-action]',host).find(element=>element.dataset.action===focusAction&&element.dataset.family===focusFamily&&element.dataset.revision===focusRevision)?.focus();
}

async function previewRun(id) {
  if(state.preview===id){state.preview=null;$('#preview').innerHTML='';renderRows();return;}
  state.preview=id;renderRows();$('#preview').innerHTML='<div class="preview-panel loading-state" role="status"><span class="spinner"></span> Loading preview…</div>';
  try {const [run,results]=await Promise.all([api(`/api/runs/${enc(id)}`),api(`/api/runs/${enc(id)}/results`)]);if(state.preview!==id||state.detail)return;
    $('#preview').innerHTML=`<div class="preview-panel"><div class="panel-heading"><h2>${esc(runName(run))}</h2><button class="ghost small" data-action="preview" data-run="${esc(id)}">Close preview ▴</button>${badge(run.status)}</div>${metricsOverview(results.metrics)}<div class="disclosures"><details><summary>Checks</summary><div class="detail-body">${checksHTML(results.checks,results.warnings)}</div></details><details><summary>Setup</summary><div class="detail-body">${keyValues(run.settings)}</div></details><details><summary>Changes</summary><div class="detail-body">${changesHTML(run)}</div></details></div><div class="actions"><button class="primary" data-action="open-run" data-run="${esc(id)}">Open run</button><button data-action="open-results" data-run="${esc(id)}">Results</button><button data-action="open-report" data-run="${esc(id)}">Report</button></div><details class="form-section"><summary>Downloads</summary>${downloads(run)}</details></div>`;
  } catch(error){if(state.preview===id)$('#preview').innerHTML=`<div class="error-state">${esc(error.message)} <button data-action="retry-preview" data-run="${esc(id)}">Retry</button></div>`;}
}

async function openRun(id,tab='solve') {
  state.view='runs';
  state.comparison=null;state.preview=null;state.detail={id};state.tab=['geometry','mesh','setup','solve','results','report'].includes(tab)?tab:'solve';state.results=null;state.monitor=null;state.outputs=[];state.previews=null;state.previewError=null;state.chartFilter='all';const token=++state.generation;
  main.innerHTML='<div class="loading-state" role="status"><span class="spinner"></span> Loading run…</div>';
  try {const data=await Promise.allSettled([api(`/api/runs/${enc(id)}`),api(`/api/runs/${enc(id)}/results`),api(`/api/runs/${enc(id)}/monitor`),api(`/api/runs/${enc(id)}/outputs`)]);if(token!==state.generation)return;if(data[0].status==='rejected')throw data[0].reason;state.detail=data[0].value;state.results=data[1].status==='fulfilled'?data[1].value:{charts:[],error:data[1].reason.message};state.monitor=data[2].status==='fulfilled'?data[2].value:null;state.outputs=data[3].status==='fulfilled'?list(data[3].value):[];renderRun();
  }catch(error){main.innerHTML=`<button class="ghost back-link" data-action="back">‹ ${state.projects.length>1?esc(state.project.name):'Designs'}</button><div class="error-state">${esc(error.message)} <button data-action="open-run" data-run="${esc(id)}">Retry</button></div>`;}
}
function renderRun() {
  const run=state.detail;main.className='workspace';document.title=`${runName(run)} · Capstone`;
  main.innerHTML=`<button class="ghost back-link" data-action="back">‹ ${state.projects.length>1?esc(state.project.name):'Designs'}</button><div class="run-heading"><h1>${esc(runName(run))}</h1>${markerPicker(run)}${badge(run.status)}<span class="run-subtitle">${esc(revisionLabel(run))}</span><span class="spacer"></span>${menu(run)}</div><div class="tabs" role="tablist" aria-label="Run workspace">${['geometry','mesh','setup','solve','results','report'].map(tab=>`<button role="tab" id="tab-${tab}" aria-selected="${state.tab===tab}" aria-controls="run-panel" tabindex="${state.tab===tab?0:-1}" data-tab="${tab}">${tab.charAt(0).toUpperCase()+tab.slice(1)}</button>`).join('')}</div><section id="run-panel" role="tabpanel" aria-labelledby="tab-${state.tab}"></section>`;renderRunPanel();preserveURL();
}
function renderRunPanel() {
  const run=state.detail,panel=$('#run-panel');panel.setAttribute('aria-labelledby',`tab-${state.tab}`);
  if(state.tab==='geometry') {
    panel.innerHTML=`<section class="panel"><div id="geometry-evidence" class="evidence-host"><div class="loading-state" role="status"><span class="spinner"></span> Loading geometry…</div></div></section><details class="panel results-extra"><summary>Design details</summary><div class="detail-body"><dl class="kv"><dt>Design</dt><dd>${esc(revisionLabel(run))}</dd><dt>CAD file</dt><dd class="mono">${esc(run.geometry_path || run.revision?.geometry_path || 'No geometry file recorded.')}</dd><dt>Changes</dt><dd>${changesHTML(run)}</dd></dl><div class="actions" style="margin-top:20px">${run.geometry_path?`<a class="button small" href="/api/revisions/${enc(run.revision_id)}/geometry" download>Download CAD</a>`:''}<button class="small" data-action="edit-family" data-family="${esc(run.family_id)}">Rename family</button><button class="small" data-action="edit-revision" data-revision="${esc(run.revision_id)}">Rename design</button><button class="small" data-action="new-revision" data-family="${esc(run.family_id)}" data-revision="${esc(run.revision_id)}">Add revision</button></div></div></details>`;
    loadEvidence('geometry');return;
  }
  if(state.tab==='mesh') {
    panel.innerHTML=`<section class="panel"><div id="mesh-evidence" class="evidence-host"><div class="loading-state" role="status"><span class="spinner"></span> Loading mesh…</div></div></section><details class="panel results-extra"><summary>Mesh settings & files</summary><div class="detail-body">${keyValues(run.settings?.mesh)}<p class="muted" style="margin:16px 0">The prepared deck controls the solve mesh.</p>${outputsHTML(state.outputs.filter(o=>o.category==='mesh'||/mesh/i.test(o.name)),run,'No other mesh files available.')}</div></details>`;
    loadEvidence('mesh');return;
  }
  if(state.tab==='setup') {
    panel.innerHTML=`<section class="panel">${keyValues(run.settings?.setup || run.settings)}<details class="form-section"><summary>More</summary><p class="detail-body">Mesh and setup settings are planning only; the prepared deck controls the solve.</p></details>${run.settings?.notes?`<details class="form-section"><summary>Notes</summary><p class="detail-body">${esc(run.settings.notes)}</p></details>`:''}</section>`;return;
  }
  if(state.tab==='report') {renderReport();return;}
  if(state.tab==='results') {
    panel.innerHTML=`${resultsError()}${galleryHTML(state.outputs,run)||'<section class="panel empty">No contours or animations available.</section>'}<details class="panel results-extra"><summary>Downloads</summary>${downloadLink(run,'images','Images')}${downloadLink(run,'animations','Animations')}<details class="form-section"><summary>Individual files</summary><div class="detail-body">${outputsHTML(state.outputs.filter(o=>['images','animations'].includes(o.category)),run)}</div></details></details>`;
    return;
  }
  panel.innerHTML=`${resultsError()}<div class="solve-bar" id="solve-bar"></div><div class="chart-grid" id="chart-grid"></div><details class="chart-help"><summary>Help</summary><p>Hover or use arrow keys for values. Scroll to zoom; Reset restores the range.</p></details><details class="panel solve-details" style="margin-top:20px"><summary>Run details</summary><div class="detail-body"><p class="mono">${esc(run.settings?.setup?.deck_path || 'No prepared deck selected.')}</p><p class="muted" style="margin:10px 0 18px">Mesh and setup settings are planning only; the prepared deck controls the solve.</p><div class="actions"><button class="primary" data-action="start" data-run="${esc(run.id)}" ${run.status!=='draft'||!run.settings?.setup?.deck_path?'disabled':''}>Start solve</button>${state.monitor?.cancellation_supported?`<button data-action="stop" data-run="${esc(run.id)}">Stop solve</button>`:''}<button data-action="folder" data-run="${esc(run.id)}">Open folder</button></div>${checksOverview(state.results?.checks,state.results?.warnings)}<details class="form-section"><summary>Monitor details</summary><div id="monitor-details" class="detail-body">${keyValues(state.monitor)}</div></details></div></details>`;
  renderMonitor();renderCharts();
}
function resultsError() {return state.results?.error?`<div class="error-state">${esc(state.results.error)} <button data-action="refresh-run">Retry</button></div>`:'';}
function renderReport() {
  const run=state.detail,html=runPath(run,'/report.html?preview=true'),pdf=runPath(run,'/report.pdf?preview=true');
  $('#run-panel').innerHTML=`<section class="panel report-panel"><div class="report-heading">${state.results?.partial || ['partial','running'].includes(run.status)?'<h2>Partial report</h2>':''}<div class="actions"><a class="button small" href="${html}" target="_blank" rel="noopener">Open HTML ↗</a><a class="button small" href="${pdf}" target="_blank" rel="noopener">Open PDF ↗</a><a class="button small" href="${runPath(run,'/report.pdf')}" download>Download PDF</a><a class="button small" href="${runPath(run,'/report.html')}" download>Download HTML</a></div></div><iframe class="report-preview" title="${esc(runName(run))} HTML report" src="${html}" sandbox="allow-scripts allow-downloads"></iframe></section>`;
}

async function loadEvidence(kind) {
  const run=state.detail,token=state.generation;
  try {
    const previews=state.previews || await api(`/api/runs/${enc(run.id)}/previews`);
    if(token!==state.generation||state.detail?.id!==run.id)return;
    state.previews=previews;
    const host=$('#'+kind+'-evidence');if(!host)return;
    const evidence=state.previews[kind] || {},images=evidence.images || [];
    host.innerHTML=`${evidence.stats?.length?metricsHTML(evidence.stats):''}${images.length?`<div class="evidence-grid ${images.length===1?'one':''}">${images.map(image=>{const src=image.url || (image.output_id?runPath(run,'/download/'+enc(image.output_id)):null);return src?`<figure><a href="${esc(src)}" target="_blank" rel="noopener" aria-label="Open ${esc(image.label || kind)}"><img src="${esc(src)}" alt="${esc(image.label || kind)}" loading="lazy"></a><figcaption><strong>${esc(image.label || '')}</strong>${image.caption?`<span>${esc(image.caption)}</span>`:''}<a href="${esc(image.download_url || src)}" download>Download</a></figcaption></figure>`:'';}).join('')}</div>`:`<div class="empty">${esc(evidence.reason || 'No '+kind+' preview is available for this run.')}</div>`}${evidence.notes?.length?`<details class="form-section"><summary>Evidence notes (${evidence.notes.length})</summary><div class="detail-body">${evidence.notes.map(note=>`<p>${esc(note)}</p>`).join('')}</div></details>`:''}`;
  } catch(error) {if(token!==state.generation)return;const host=$('#'+kind+'-evidence');if(host)host.innerHTML=`<div class="error-state">${esc(error.message)} <button class="small" data-action="retry-evidence" data-kind="${kind}">Retry</button></div>`;}
}

function chartSelect() {return `<label class="live-label" for="chart-filter">Charts</label><select id="chart-filter" aria-label="Charts"><option value="all">All charts</option>${getCharts().map(c=>`<option value="${esc(c.id)}" ${state.chartFilter===c.id?'selected':''}>${esc(c.title)}</option>`).join('')}</select>`;}
function renderMonitor() {
  const host=$('#solve-bar');if(!host)return;const m=state.monitor || {},current=m.simulated_time_s==null?(m.simulation_time_ms ?? m.current_time_ms ?? m.time_ms):m.simulated_time_s*1000,end=m.target_time_s==null?(m.end_time_ms ?? state.detail.settings?.setup?.end_time_ms):m.target_time_s*1000,percentage=m.progress_fraction==null?(m.progress_percent ?? (current!=null&&end>0?current/end*100:null)):m.progress_fraction*100;
  host.innerHTML=`<span class="solve-time">${current==null?'Time unavailable':`${format(current,3)} / ${format(end,3)} ms`}</span><span class="muted">Elapsed ${duration(m.elapsed_seconds ?? m.elapsed_s)}</span><span class="muted">Remaining ${m.remaining_seconds==null?'—':'~'+duration(m.remaining_seconds)}</span>${percentage==null?'<span class="muted progress-unknown">Progress unavailable</span>':`<progress value="${Math.max(0,Math.min(100,percentage))}" max="100" aria-label="Solve progress"></progress>`}<div class="chart-tools"><label class="live-label"><input id="live-poll" type="checkbox" ${state.live?'checked':''}> Live</label>${chartSelect()}</div>`;
  if($('#monitor-details'))$('#monitor-details').innerHTML=keyValues(m);
}
function outputsHTML(outputs,run,empty='No output files available.') {return outputs.length?`<div class="table-surface output-files" style="min-height:0"><table class="output-table"><thead><tr><th>File</th><th>Type</th><th>Size</th></tr></thead><tbody>${outputs.map(o=>`<tr><td><a href="${runPath(run,'/download/'+enc(o.id))}" download>${esc(o.name)}</a></td><td>${esc(o.category)}</td><td>${o.size==null?'—':o.size<1024**2?`${format(o.size/1024)} KB`:`${format(o.size/1024**2)} MB`}</td></tr>`).join('')}</tbody></table></div>`:`<p class="muted">${esc(empty)}</p>`;}
function galleryHTML(outputs,run) {const media=outputs.filter(o=>/\.(png|jpg|jpeg|webp|gif|svg|mp4|webm)$/i.test(o.name)&&!['graphs','geometry','mesh'].includes(o.category));return media.length?`<section class="panel output-gallery"><h2>Animations & contours</h2><div class="gallery-grid">${media.map((o,index)=>{const src=runPath(run,'/download/'+enc(o.id)),video=/\.(mp4|webm)$/i.test(o.name);return `<figure ${index>=9?'hidden data-gallery-extra':''}>${video?`<video controls preload="none" aria-label="${esc(o.name)}"><source src="${src}"></video>`:`<a href="${src}" target="_blank" rel="noopener" aria-label="Open ${esc(o.name)}"><img src="${src}" loading="lazy" alt="${esc(o.name)}"></a>`}<figcaption><span>${esc(o.name.split('/').pop())}</span><a href="${src}" download>Download</a></figcaption></figure>`;}).join('')}</div>${media.length>9?`<button data-action="show-gallery" style="margin-top:16px">Show all ${media.length}</button>`:''}</section>`:'';}

function getCharts() {
  const charts=state.results?.charts || [];
  const mapped=chartDefaults.map(base=>{const chart=charts.find(c=>c.id===base.id || (base.id==='force'&&/force/i.test(c.title)) || (base.id==='regional_p99'&&/p99/i.test(c.title)) || (base.id!=='force'&&base.id!=='regional_p99'&&String(c.title).toLowerCase().includes(base.id)));return chart?{...base,...chart}:{...base,available:false,reason:'No recorded data.',series:[]};});
  return mapped.concat(charts.filter(c=>!mapped.some(m=>m.id===c.id)));
}
function chartState(chart) { const key=(state.comparison?'compare':state.detail?.id)+'/'+chart.id;if(!state.charts.has(key)){const series=chart.series||[],regional=/p99/i.test(chart.title),preferred=series.filter(s=>/body|closure.*left|closure.*right|left.*closure|right.*closure/i.test(s.name)).slice(0,3),shown=regional?(preferred.length?preferred:series.slice(0,3)):series;state.charts.set(key,{hidden:new Set(series.filter(s=>!shown.includes(s)).map(s=>s.name)),range:null,index:0});}return state.charts.get(key); }
function validSeries(chart) {return (chart.series || []).map((s,i)=>({...s,color:s.color || colors[i%colors.length],points:(s.x || []).map((x,j)=>[Number(x),Number(s.y?.[j])]).filter(([x,y])=>Number.isFinite(x)&&Number.isFinite(y))})).filter(s=>s.points.length);}
function chartExports(chart) {return state.comparison?`<button data-action="export-svg" data-chart="${esc(chart.id)}">SVG</button><button data-action="export-png" data-chart="${esc(chart.id)}">PNG</button>`:['csv','svg','png'].map(type=>`<a href="${runPath(state.detail,'/charts/'+enc(chart.id)+'.'+type)}" download>${type.toUpperCase()}</a>`).join('');}
function renderCharts() {const host=$('#chart-grid');if(!host)return;const focused=document.activeElement,focusChart=focused.closest('.chart-card')?.dataset.chart,focusSeries=focused.dataset.series,focusPlot=focused.classList.contains('plot');const charts=getCharts().filter(c=>state.chartFilter==='all'||state.chartFilter===c.id);host.classList.toggle('single',state.chartFilter!=='all');host.innerHTML=charts.map(c=>chartHTML(c)).join('');bindCharts(host);if(focusChart){const card=$$('.chart-card',host).find(c=>c.dataset.chart===focusChart);if(card){if(focusPlot)$('.plot',card)?.focus();else if(focusSeries){const button=$$('[data-series]',card).find(b=>b.dataset.series===focusSeries);button?.closest('details')?.setAttribute('open','');button?.focus();}}}}
function chartHTML(chart,expanded=false) {
  const cs=chartState(chart),series=validSeries(chart),visible=series.filter(s=>!cs.hidden.has(s.name));
  const legendButton=s=>`<button data-series="${esc(s.name)}" aria-pressed="${!cs.hidden.has(s.name)}"><span class="swatch" style="background:${esc(s.color)}"></span>${esc(s.name)}</button>`;
  const shown=series.filter(s=>!cs.hidden.has(s.name)),extra=series.filter(s=>cs.hidden.has(s.name));
  const compact=series.length>6||/p99/i.test(chart.title);
  return `<article class="chart-card" data-chart="${esc(chart.id)}"><div class="chart-heading"><h3>${esc(chart.title)}</h3>${expanded?'':`<button data-action="expand-chart" data-chart="${esc(chart.id)}" aria-label="Expand ${esc(chart.title)}" title="Expand">↗</button>`}</div>${series.length?svgChart(chart,visible,cs):`<div class="chart-empty"><div><strong>Unavailable</strong>${esc(chart.reason || 'No recorded data.')}</div></div>`}<div class="legend" aria-label="${esc(chart.title)} series">${(compact?shown:series).map(legendButton).join('')}${compact&&extra.length?`<details class="series-more"><summary>More series (${extra.length})</summary><div class="series-list">${extra.map(legendButton).join('')}</div></details>`:''}</div><div class="chart-bottom"><span class="point-readout" aria-live="off">${series.length?'—':''}</span>${series.length?`<button data-action="reset-chart" data-chart="${esc(chart.id)}">Reset</button>${chartExports(chart)}`:''}</div></article>`;
}
function extent(points,index) {let min=Infinity,max=-Infinity;for(const p of points){min=Math.min(min,p[index]);max=Math.max(max,p[index]);}if(min===Infinity)return [0,1];if(min===max)return [min-1,max+1];return [min,max];}
function svgChart(chart,series,cs) {
  const all=series.flatMap(s=>s.points),[xmin,xmax]=cs.range || extent(getCharts().flatMap(c=>validSeries(c).flatMap(s=>s.points)),0);let [ymin,ymax]=extent(all.filter(p=>p[0]>=xmin&&p[0]<=xmax),1);const padding=(ymax-ymin)*.08;ymin-=padding;ymax+=padding;
  const sx=x=>54+(x-xmin)/(xmax-xmin)*330,sy=y=>220-(y-ymin)/(ymax-ymin)*184;
  const clip='clip-'+String(chart.id).replace(/[^a-z0-9]/gi,'')+(dialog.open?'-modal':'');
  let grid='';for(let i=0;i<=4;i++){const x=xmin+(xmax-xmin)*i/4,y=ymin+(ymax-ymin)*i/4;grid+=`<line class="grid" x1="54" y1="${sy(y)}" x2="384" y2="${sy(y)}"/><text x="46" y="${sy(y)+3}" text-anchor="end">${format(y,2)}</text><line class="grid" x1="${sx(x)}" y1="36" x2="${sx(x)}" y2="220"/><text x="${sx(x)}" y="239" text-anchor="middle">${format(x,2)}</text>`;}
  return `<svg class="plot" viewBox="0 0 410 267" tabindex="0" role="img" aria-label="${esc(chart.title)}. Use left and right arrows for values; plus and minus to zoom." data-xmin="${xmin}" data-xmax="${xmax}" data-ymin="${ymin}" data-ymax="${ymax}" xmlns="http://www.w3.org/2000/svg"><title>${esc(chart.title)}</title><defs><clipPath id="${clip}"><rect x="54" y="35" width="331" height="186"/></clipPath></defs><text x="10" y="18">${esc(chart.y_label)}</text>${grid}<line class="axis" x1="54" y1="36" x2="54" y2="220"/><line class="axis" x1="54" y1="220" x2="384" y2="220"/><text x="384" y="261" text-anchor="end">${esc(chart.x_label)}</text><g clip-path="url(#${clip})">${series.map(s=>`<polyline class="line" stroke="${esc(s.color)}" points="${s.points.map(p=>`${sx(p[0]).toFixed(2)},${sy(p[1]).toFixed(2)}`).join(' ')}"/>`).join('')}</g><line class="crosshair" x1="54" x2="54" y1="36" y2="220" hidden/><g class="point-markers"></g></svg>`;
}
function bindCharts(host) {
  (host.classList.contains('chart-card')?[host]:$$('.chart-card',host)).forEach(card=>{const chart=getCharts().find(c=>c.id===card.dataset.chart);if(!chart)return;const plot=$('.plot',card),cs=chartState(chart);
    $$('[data-series]',card).forEach(button=>button.addEventListener('click',()=>{cs.hidden.has(button.dataset.series)?cs.hidden.delete(button.dataset.series):cs.hidden.add(button.dataset.series);redrawChart(card,chart);}));
    if(!plot)return;
    const showPoint=x=>{const series=validSeries(chart).filter(s=>!cs.hidden.has(s.name));if(!series.length)return;const xmin=Number(plot.dataset.xmin),xmax=Number(plot.dataset.xmax),ymin=Number(plot.dataset.ymin),ymax=Number(plot.dataset.ymax);const closest=series.map(s=>{let point=s.points[0],distance=Infinity;for(const p of s.points){const d=Math.abs(p[0]-x);if(d<distance){point=p;distance=d;}}return {...s,point};});const px=54+(x-xmin)/(xmax-xmin)*330;const cross=$('.crosshair',plot);cross.removeAttribute('hidden');cross.setAttribute('x1',px);cross.setAttribute('x2',px);$('.point-markers',plot).innerHTML=closest.map(s=>`<circle cx="${54+(s.point[0]-xmin)/(xmax-xmin)*330}" cy="${220-(s.point[1]-ymin)/(ymax-ymin)*184}" r="3" fill="${esc(s.color)}"/>`).join('');const text=`${format(closest[0].point[0],4)}: ${closest.map(s=>s.name+' '+format(s.point[1],4)).join(' · ')}`;$('.point-readout',card).textContent=text;$('.point-readout',card).title=text;};
    plot.addEventListener('pointermove',event=>{const rect=plot.getBoundingClientRect(),viewX=(event.clientX-rect.left)/rect.width*410;const x=Number(plot.dataset.xmin)+(Math.max(54,Math.min(384,viewX))-54)/330*(Number(plot.dataset.xmax)-Number(plot.dataset.xmin));showPoint(x);});
    plot.addEventListener('pointerleave',()=>{$('.crosshair',plot).setAttribute('hidden','');$('.point-markers',plot).innerHTML='';});
    plot.addEventListener('keydown',event=>{const points=validSeries(chart).find(s=>!cs.hidden.has(s.name))?.points || [];if(!points.length)return;if(event.key==='ArrowLeft'||event.key==='ArrowRight'||event.key==='Home'||event.key==='End'){event.preventDefault();$('.point-readout',card).setAttribute('aria-live','polite');cs.index=Math.max(0,Math.min(points.length-1,event.key==='Home'?0:event.key==='End'?points.length-1:cs.index+(event.key==='ArrowRight'?1:-1)));showPoint(points[cs.index][0]);}if(event.key==='+'||event.key==='='||event.key==='-'){event.preventDefault();zoomChart(card,chart,event.key==='-'?1.3:.75);}});
    plot.addEventListener('wheel',event=>{event.preventDefault();zoomChart(card,chart,event.deltaY>0?1.25:.8);},{passive:false});
  });
}
function zoomChart(card,chart,factor) {const cs=chartState(chart),points=validSeries(chart).flatMap(s=>s.points),full=extent(points,0),range=cs.range||full,center=(range[0]+range[1])/2,half=Math.min((full[1]-full[0])/2,(range[1]-range[0])/2*factor);if(half<1e-10)return;cs.range=[Math.max(full[0],center-half),Math.min(full[1],center+half)];redrawChart(card,chart);}
function redrawChart(card,chart) {const focus=card.contains(document.activeElement)?document.activeElement:null,wasPlot=focus?.classList.contains('plot'),seriesName=focus?.dataset.series;card.outerHTML=chartHTML(chart,dialog.open&&dialog.classList.contains('modal-chart'));const host=dialog.open&&dialog.classList.contains('modal-chart')?$('.dialog-body',dialog):$('#chart-grid');const next=$$('.chart-card',host).find(c=>c.dataset.chart===chart.id);bindCharts(next);if(wasPlot)$('.plot',next)?.focus();else if(seriesName){const button=$$('[data-series]',next).find(b=>b.dataset.series===seriesName);button?.closest('details')?.setAttribute('open','');button?.focus();}}
function expandChart(id) {const chart=getCharts().find(c=>c.id===id);if(!chart)return;showDialog(chart.title,`<div class="dialog-body">${chartHTML(chart,true)}</div>`,'modal-chart');bindCharts($('.dialog-body',dialog));}
async function exportChart(id,type) {const card=$$('.chart-card',dialog.open?dialog:main).find(c=>c.dataset.chart===id),plot=$('.plot',card);if(!plot)return;const clone=plot.cloneNode(true);clone.removeAttribute('tabindex');clone.querySelectorAll('.crosshair,.point-markers').forEach(e=>e.remove());const style=document.createElementNS('http://www.w3.org/2000/svg','style');style.textContent='.grid{stroke:#e8edf2;stroke-width:1}.axis{stroke:#bdc9d6;stroke-width:1}.line{fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}text{font:10px Arial,Helvetica,sans-serif;fill:#68778a}';clone.insertBefore(style,clone.firstChild);clone.setAttribute('width','1230');clone.setAttribute('height','801');const source=new XMLSerializer().serializeToString(clone),blob=new Blob([source],{type:'image/svg+xml'});if(type==='svg')saveBlob(blob,id+'.svg');else {const image=new Image(),url=URL.createObjectURL(blob);try{await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;image.src=url;});const canvas=document.createElement('canvas');canvas.width=1230;canvas.height=801;const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,1230,801);ctx.drawImage(image,0,0);const png=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(png)saveBlob(png,id+'.png');}catch{toast('Could not export the plot. Download SVG instead.',true);}finally{URL.revokeObjectURL(url);}}}
function saveBlob(blob,name) {const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}

async function compareRuns() {
  const runs=state.runs.filter(r=>state.selected.has(r.id));state.comparison=runs;state.detail=null;state.preview=null;const token=++state.generation;main.innerHTML='<div class="loading-state" role="status"><span class="spinner"></span> Loading comparison…</div>';
  try {const results=await Promise.all(runs.map(r=>api(`/api/runs/${enc(r.id)}/results`)));if(token!==state.generation)return;const combined=[];results.forEach((result,index)=>{(result.charts || []).forEach(chart=>{let target=combined.find(c=>c.id===chart.id);if(!target){target={...chart,series:[]};combined.push(target);}target.series.push(...(chart.series || []).map(s=>({...s,name:`${runName(runs[index])} · ${s.name}`})));target.available=target.series.length>0;});});state.results={charts:combined};state.chartFilter='all';main.className='workspace';document.title='Compare runs · Capstone';main.innerHTML=`<button class="ghost back-link" data-action="back">‹ ${state.projects.length>1?esc(state.project.name):'Designs'}</button><div class="comparison-heading"><h1>Compare runs</h1></div><div class="compare-tags">${runs.map(r=>`<span class="badge">${esc(runName(r))} · ${esc(revisionLabel(r))}</span>`).join('')}</div><div class="solve-bar"><h2>Plots</h2><div class="chart-tools">${chartSelect()}</div></div><div class="chart-grid" id="chart-grid"></div><details class="chart-help"><summary>Help</summary><p>Hover or use arrow keys for values. Toggle series to isolate a run.</p></details>`;renderCharts();
  }catch(error){main.innerHTML=`<button class="ghost back-link" data-action="back">‹ Runs</button><div class="error-state">${esc(error.message)} <button data-action="compare">Retry</button></div>`;}
}

function showDialog(title,content,className='') {lastFocus=document.activeElement;dialog.className=className;$('#dialog-content').innerHTML=`<div class="dialog-head"><h2 id="dialog-title">${esc(title)}</h2><button data-action="close-dialog" aria-label="Close dialog">×</button></div>${content}`;dialog.showModal();setTimeout(()=>$$('input:not([type=hidden]),select,textarea,button',$('.dialog-body',dialog)).find(element=>element.getClientRects().length&&!element.disabled)?.focus(),0);}
function closeDialog(force=false) {
  const form=$('form',dialog);
  if(!force&&form?.dataset.dirty==='true'){
    if($('.discard-panel',dialog)){keepEditing();return;}
    form.hidden=true;dialog.dataset.originalTitle=$('#dialog-title').textContent;$('#dialog-title').textContent='Discard changes?';
    $('#dialog-content').insertAdjacentHTML('beforeend','<div class="discard-panel"><div class="dialog-body"><p>Unsaved settings will be lost.</p></div><div class="dialog-actions"><button data-action="discard-changes">Discard changes</button><button class="primary" data-action="keep-editing">Keep editing</button></div></div>');$('[data-action="keep-editing"]',dialog).focus();return;
  }
  dialog.close();dialog.className='';lastFocus?.focus();newRunDraft=null;
}
function keepEditing() {$('.discard-panel',dialog)?.remove();const form=$('form',dialog);if(form){form.hidden=false;$('#dialog-title').textContent=dialog.dataset.originalTitle || 'Edit';$('input:not([type=hidden]),select,textarea',form)?.focus();}}
function field(id,label,value='',type='text',hint='') {return `<div class="field"><label for="${id}">${esc(label)}</label><input id="${id}" name="${id}" type="${type}" value="${esc(value)}" ${type==='number'?'step="any"':''}>${hint?`<small>${esc(hint)}</small>`:''}<span class="field-error" id="${id}-error"></span></div>`;}
function fieldError(id,message) {const input=$('#'+id,dialog);if(!input)return;input.closest('details')?.setAttribute('open','');input.setAttribute('aria-invalid','true');input.setAttribute('aria-describedby',id+'-error');$('#'+id+'-error',dialog).textContent=message;input.focus();}
function formError(form,message) {const host=$('.form-error',form);host.hidden=false;host.textContent=message;}
function clearErrors(form) {$$('.field-error',form).forEach(e=>e.textContent='');$$('[aria-invalid]',form).forEach(e=>e.removeAttribute('aria-invalid'));const host=$('.form-error',form);if(host)host.hidden=true;}
function selectField(id,label,options,value='') {return `<div class="field"><label for="${id}">${esc(label)}</label><select id="${id}" name="${id}">${options.map(o=>`<option value="${esc(o.value)}" ${String(o.value)===String(value)?'selected':''}>${esc(o.label)}</option>`).join('')}</select><span class="field-error" id="${id}-error"></span></div>`;}
async function newRun(defaultFamily=null,defaultRevision=null) {
  newRunDraft={};showDialog('New run',`<form id="new-run-form" novalidate><div class="dialog-body"><div class="form-error error-state" hidden></div><div class="section-line"><h3>Design</h3><button class="small" type="button" data-action="show-add-design">+ Add design</button></div><div id="add-design" hidden></div><div class="form-grid">${selectField('family','Family',state.families.length?state.families.map(f=>({value:f.id,label:f.name})):[{value:'',label:'Add a design first'}],defaultFamily)}${selectField('revision','Design',[{value:'',label:'Loading…'}])}</div>${field('name','Run name','','text','Automatic if blank')}<details class="form-section"><summary>Mesh</summary><div class="form-grid">${selectField('engine','Mesher',[{value:'gmsh',label:'Gmsh'},{value:'ansys',label:'ANSYS'},{value:'prepared',label:'Prepared deck'}],'prepared')}${selectField('element_type','Element type',[{value:'tetrahedral',label:'Tetrahedral'},{value:'hexahedral',label:'Hexahedral'},{value:'shell',label:'Shell'},{value:'deck',label:'From deck'}],'deck')}${field('size_mm','Global size (mm)','','number')}${field('refinement_mm','Local refinement (mm)','','number')}</div>${selectField('convergence','Convergence',[{value:'none',label:'Single mesh'},{value:'coarse-medium-fine',label:'Coarse / medium / fine'}])}</details><details class="form-section"><summary>Setup</summary><div class="form-grid">${field('velocity_m_s','Velocity (m/s)','','number')}${field('end_time_ms','End time (ms)','','number')}${field('processors','Processors',4,'number')}</div>${field('deck_path','Prepared LS-DYNA deck path','','text','Mesh and setup settings are planning only; the prepared deck controls the solve.')}</details><details class="form-section"><summary>Notes</summary><div class="field"><label for="notes">Notes</label><textarea id="notes" name="notes"></textarea></div></details></div><div class="dialog-actions"><button type="button" data-action="close-dialog">Cancel</button><button type="submit" class="primary">Save draft</button></div></form>`);
  $('#family').closest('.field').hidden=state.families.length===1;$('#new-run-form').addEventListener('submit',saveNewRun);$('#family').addEventListener('change',()=>loadRevisions($('#family').value));await loadRevisions($('#family').value,defaultRevision);
}
async function loadRevisions(familyId,selected=null) {
  const token=++familyGeneration,host=$('#revision',dialog);if(!host)return;host.innerHTML='<option value="">Loading…</option>';host.disabled=true;
  try {state.revisions=familyId?list(await api(`/api/revisions?family_id=${enc(familyId)}`)).sort((a,b)=>Number(b.number)-Number(a.number)):[];if(token!==familyGeneration||!dialog.open)return;host.innerHTML=state.revisions.length?state.revisions.map(r=>`<option value="${esc(r.id)}" ${r.id===selected?'selected':''}> ${esc(revisionTitle(r))}</option>`).join(''):'<option value="">No revisions</option>';host.disabled=false;}catch(error){if(token!==familyGeneration)return;host.innerHTML='<option value="">Could not load revisions</option>';formError($('#new-run-form'),error.message);}
}
function showAddDesign() {
  const host=$('#add-design');host.hidden=false;host.innerHTML=`<div class="inline-form"><div class="form-grid">${selectField('design_mode','Save as',[{value:'new',label:'New family'},{value:'revision',label:'Revision of selected family'}])}${field('family_name','Family name')}</div><div class="field"><label for="geometry-file">CAD file</label><input id="geometry-file" type="file" accept=".step,.stp,.iges,.igs,.scdoc,.scdocx,.x_t,.x_b,.sat,.stl,.sldprt,.sldasm"><small>128 MB max.</small><span class="field-error" id="geometry-file-error"></span></div>${field('geometry_path','Local geometry path','','text','')}${field('nickname','Design name')}<div class="field"><label for="changes">Changes</label><textarea id="changes" placeholder="Parameter changes from the previous revision"></textarea></div><div id="design-error" class="field-error"></div><div class="actions"><button type="button" class="small" data-action="hide-add-design">Cancel</button><button type="button" class="primary small" data-action="save-design">Save design</button></div></div>`;$('#design_mode').addEventListener('change',()=>{const revision=$('#design_mode').value==='revision';$('#family_name').disabled=revision;$('#family_name').closest('.field').hidden=revision;});$('#family_name').focus();$('#geometry-file').addEventListener('change',uploadGeometry);
}
async function saveDesign() {
  if(state.pending)return;const mode=$('#design_mode').value,familyName=$('#family_name').value.trim(),path=$('#geometry_path').value.trim();if(mode==='new'&&!familyName){fieldError('family_name','Enter a family name.');return;}if(!path){fieldError('geometry_path','Enter the local geometry path.');return;}if(mode==='revision'&&!$('#family').value){$('#design-error').textContent='Select a family first.';return;}
  state.pending=true;const button=$('[data-action="save-design"]');button.disabled=true;button.setAttribute('aria-busy','true');
  try {let familyId=$('#family').value;if(mode==='new'){if(!newRunDraft.createdFamily){newRunDraft.createdFamily=await api('/api/families',{method:'POST',body:JSON.stringify({project_id:state.project.id,name:familyName})});}familyId=newRunDraft.createdFamily.id;}
    const revision=await api(`/api/families/${enc(familyId)}/revisions`,{method:'POST',body:JSON.stringify({geometry_path:path,nickname:$('#nickname').value.trim(),changes:{notes:$('#changes').value.trim()},parent_revision_id:mode==='revision'?$('#revision').value:null})});state.families=list(await api(`/api/families?project_id=${enc(state.project.id)}`));$('#family').innerHTML=state.families.map(f=>`<option value="${esc(f.id)}" ${f.id===familyId?'selected':''}>${esc(f.name)}</option>`).join('');$('#family').closest('.field').hidden=state.families.length===1;await loadRevisions(familyId,revision.id);$('#add-design').hidden=true;$('#add-design').innerHTML='';newRunDraft.createdFamily=null;toast('Design saved.');
  }catch(error){$('#design-error').textContent=error.message;}finally{state.pending=false;if(button.isConnected){button.disabled=false;button.removeAttribute('aria-busy');}}
}
async function uploadGeometry(event) {
  const file=event.target.files[0];if(!file)return;
  if(!file.size||file.size>128*1024*1024){fieldError('geometry-file','Choose a nonempty CAD file up to 128 MB.');return;}
  if(state.pending)return;state.pending=true;const button=$('[data-action="save-design"]');button.disabled=true;event.target.disabled=true;$('#geometry-file-error').textContent='Saving file locally…';
  try{const uploaded=await api('/api/geometry/upload',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Filename':enc(file.name)},body:file});$('#geometry_path').value=uploaded.geometry_path;$('#geometry-file-error').textContent='File saved.';}catch(error){fieldError('geometry-file',error.message);}finally{state.pending=false;if(button.isConnected)button.disabled=false;if(event.target.isConnected)event.target.disabled=false;}
}
async function refreshImports() {if(state.pending)return;state.pending=true;try{const result=await api('/api/imports/refresh',{method:'POST',body:'{}'});await loadProject();toast(`${result.added || 0} new runs · ${result.updated || 0} updated`);}catch(error){mutationError(error.message);}finally{state.pending=false;}}
async function saveNewRun(event) {
  event.preventDefault();if(state.pending)return;const form=event.currentTarget;clearErrors(form);const revisionId=$('#revision').value;if(!revisionId){fieldError('revision','Choose a revision or add a design.');return;}
  const numberIds=['size_mm','refinement_mm','velocity_m_s','end_time_ms','processors'],numbers={};for(const id of numberIds){const raw=$('#'+id).value.trim();numbers[id]=raw===''?null:Number(raw);if(raw!==''&&(!Number.isFinite(numbers[id])||(id!=='velocity_m_s'&&numbers[id]<=0)||(id==='processors'&&(!Number.isInteger(numbers[id])||numbers[id]>1024)))){fieldError(id,id==='processors'?'Enter a whole number from 1 to 1024.':'Enter a value greater than zero.');$('#'+id).closest('details')?.setAttribute('open','');return;}}
  state.pending=true;const button=$('[type=submit]',form);button.disabled=true;button.setAttribute('aria-busy','true');
  try {await api('/api/runs',{method:'POST',body:JSON.stringify({revision_id:revisionId,name:$('#name').value.trim() || undefined,settings:{mesh:{engine:$('#engine').value,element_type:$('#element_type').value,size_mm:numbers.size_mm,refinement_mm:numbers.refinement_mm,convergence:$('#convergence').value},setup:{velocity_m_s:numbers.velocity_m_s,end_time_ms:numbers.end_time_ms,processors:numbers.processors,deck_path:$('#deck_path').value.trim()},notes:$('#notes').value.trim()}})});closeDialog(true);state.detail=null;state.comparison=null;state.page=1;await loadProject();toast('Run saved.');}
  catch(error){formError(form,error.message);}finally{state.pending=false;if(button.isConnected){button.disabled=false;button.removeAttribute('aria-busy');}}
}
function editName(run) {showDialog('Rename run',`<form id="rename-form" novalidate><div class="dialog-body"><div class="form-error error-state" hidden></div>${field('run-name','Run name',runName(run))}</div><div class="dialog-actions"><button type="button" data-action="close-dialog">Cancel</button><button class="primary" type="submit">Save name</button></div></form>`);$('#rename-form').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget,name=$('#run-name').value.trim();clearErrors(form);if(!name){fieldError('run-name','Enter a run name.');return;}await saveDialogMutation(form,()=>api(runPath(run),{method:'PATCH',body:JSON.stringify({name})}),'Run renamed.');});}
function editDesign(kind,id) {const isFamily=kind==='family',record=isFamily?state.families.find(family=>family.id===id):state.catalogRevisions.find(revision=>revision.id===id),value=isFamily?(record?.name || state.detail?.family_name):(record?.nickname || state.detail?.revision_nickname);showDialog(isFamily?'Rename family':'Rename design',`<form id="design-name-form" novalidate><div class="dialog-body"><div class="form-error error-state" hidden></div>${field('design-name',isFamily?'Family name':'Design name',value || '')}</div><div class="dialog-actions"><button type="button" data-action="close-dialog">Cancel</button><button class="primary" type="submit">Save name</button></div></form>`);$('#design-name-form').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget,value=$('#design-name').value.trim();clearErrors(form);if(isFamily&&!value){fieldError('design-name','Enter a family name.');return;}await saveDialogMutation(form,()=>api(`/api/${isFamily?'families':'revisions'}/${enc(id)}`,{method:'PATCH',body:JSON.stringify(isFamily?{name:value}:{nickname:value})}),'Name saved.');});}
async function saveDialogMutation(form,callback,message) {if(state.pending)return;state.pending=true;const button=$('[type=submit]',form);button.disabled=true;button.setAttribute('aria-busy','true');try{await callback();closeDialog(true);if(state.detail)await openRun(state.detail.id,state.tab);else await loadProject();toast(message);}catch(error){formError(form,error.message);}finally{state.pending=false;if(button.isConnected){button.disabled=false;button.removeAttribute('aria-busy');}}}
async function mutateRun(run,action) {if(state.pending)return;state.pending=true;try{await api(runPath(run,'/'+action),{method:'POST',body:'{}'});if(action==='folder'){toast('Folder opened.');return;}if(action==='duplicate'){state.detail=null;state.comparison=null;await loadProject();toast('Run duplicated.');return;}await openRun(run.id,state.tab);toast(action==='start'?'Solve started.':'Solve stopped.');}catch(error){mutationError(error.message);}finally{state.pending=false;}}

async function updateSystem() { const manifest=await publishedManifest; $('#system-summary').textContent='Updated '+new Intl.DateTimeFormat('en-US',{dateStyle:'medium'}).format(new Date(manifest.published_at)); $('#system-summary').setAttribute('aria-label','Publication date'); }
function schedulePoll() {}
document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-action]');if(!button || button.disabled)return;const action=button.dataset.action,id=button.dataset.run,run=state.runs.find(r=>r.id===id)||(state.detail?.id===id?state.detail:null);
  $$('details.row-menu[open]').forEach(d=>{if(!d.contains(button)||action)d.open=false;});
  try{switch(action){case 'retry-boot':await boot();break;case 'publish-dashboard':await publishDashboard();break;case 'new-run':await newRun(button.dataset.family || null,button.dataset.revision || null);break;case 'new-revision':await newRun(button.dataset.family,button.dataset.revision);showAddDesign();$('#design_mode').value='revision';$('#design_mode').dispatchEvent(new Event('change'));{const revision=state.catalogRevisions.find(item=>item.id===button.dataset.revision);if(revision?.geometry_path)$('#geometry_path').value=revision.geometry_path;}break;case 'open-run':await openRun(id);break;case 'open-results':await openRun(id,'results');break;case 'open-report':await openRun(id,'report');break;case 'set-marker':if(run)await setMarker(run,button.dataset.marker);break;case 'toggle-family':state.closedFamilies.has(button.dataset.family)?state.closedFamilies.delete(button.dataset.family):state.closedFamilies.add(button.dataset.family);renderRows();break;case 'toggle-revision':state.openRevisions.has(button.dataset.revision)?state.openRevisions.delete(button.dataset.revision):state.openRevisions.add(button.dataset.revision);renderRows();break;case 'refresh-run':await openRun(state.detail.id,state.tab);break;case 'retry-evidence':state.previews=null;await loadEvidence(button.dataset.kind);break;case 'preview':await previewRun(id);break;case 'retry-preview':state.preview=null;await previewRun(id);break;case 'back':++state.generation;state.detail=null;state.comparison=null;state.preview=null;await loadProject();preserveURL();break;case 'compare':await compareRuns();break;case 'refresh-imports':await refreshImports();break;case 'show-gallery':$$('[data-gallery-extra]').forEach(e=>e.hidden=false);button.remove();break;case 'rename':if(run)editName(run);break;case 'edit-family':editDesign('family',button.dataset.family);break;case 'edit-revision':editDesign('revision',button.dataset.revision);break;case 'duplicate':case 'folder':case 'start':case 'stop':if(run)await mutateRun(run,action);break;case 'close-dialog':if(!state.pending)closeDialog();break;case 'discard-changes':closeDialog(true);break;case 'keep-editing':keepEditing();break;case 'show-add-design':showAddDesign();break;case 'hide-add-design':$('#add-design').hidden=true;break;case 'save-design':await saveDesign();break;case 'clear-filters':state.search='';state.status='all';state.marker='all';renderList();break;case 'expand-chart':expandChart(button.dataset.chart);break;case 'reset-chart':{const chart=getCharts().find(c=>c.id===button.dataset.chart);chartState(chart).range=null;redrawChart(button.closest('.chart-card'),chart);break;}case 'export-svg':await exportChart(button.dataset.chart,'svg');break;case 'export-png':await exportChart(button.dataset.chart,'png');break;}}
  catch(error){toast(error.message,true);}
});
document.addEventListener('input',event=>{const form=event.target.closest('dialog form');if(form)form.dataset.dirty='true';if(event.target.id==='search'){state.search=event.target.value;state.page=1;$('#clear-search').hidden=!state.search;expandMatches();renderRows();}if(event.target.tagName==='TEXTAREA'){event.target.style.height='auto';event.target.style.height=Math.max(86,event.target.scrollHeight)+'px';}});
document.addEventListener('change',async event=>{const t=event.target;const form=t.closest('dialog form');if(form)form.dataset.dirty='true';try{if(t.id==='project-select'){state.project=state.projects.find(p=>String(p.id)===t.value);state.selected.clear();state.preview=null;state.page=1;await loadProject();}if(t.id==='status-filter'){state.status=t.value;expandMatches();renderRows();}if(t.id==='marker-filter'){state.marker=t.value;expandMatches();renderRows();}if(t.id==='run-sort'){state.sort=t.value;state.page=1;renderRows();}if(t.id==='page-size'){state.size=Number(t.value);state.page=1;renderRows();}if(t.dataset.select){t.checked?state.selected.add(t.dataset.select):state.selected.delete(t.dataset.select);renderRows();}if(t.id==='select-matching'){filteredRuns().forEach(run=>t.checked?state.selected.add(run.id):state.selected.delete(run.id));renderRows();}if(t.id==='chart-filter'){state.chartFilter=t.value;renderCharts();}if(t.id==='live-poll')state.live=t.checked;}catch(error){toast(error.message,true);}});
document.addEventListener('click',event=>{if(event.target.closest('#clear-search')){state.search='';state.page=1;$('#search').value='';$('#clear-search').hidden=true;renderRows();$('#search').focus();}if(event.target.closest('#previous-page')){state.page--;renderRows();}if(event.target.closest('#next-page')){state.page++;renderRows();}const tab=event.target.closest('[data-tab]');if(tab){state.tab=tab.dataset.tab;$$('[data-tab]').forEach(t=>{t.setAttribute('aria-selected',String(t===tab));t.tabIndex=t===tab?0:-1;});renderRunPanel();preserveURL();}});
document.addEventListener('keydown',event=>{if(event.target.matches('[role=tab]')&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const tabs=$$('[role=tab]'),index=tabs.indexOf(event.target),next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tabs[next].focus();tabs[next].click();}if(event.key==='Escape')$$('details.row-menu[open],details.marker-picker[open]').forEach(d=>{d.open=false;$('summary',d).focus();});});
dialog.addEventListener('cancel',event=>{event.preventDefault();if(!state.pending)closeDialog();});
document.addEventListener('click',event=>{$$('details.marker-picker[open]').forEach(picker=>{if(!picker.contains(event.target))picker.open=false;});});

async function showStats() {
  state.view='stats';state.detail=null;state.comparison=null;const token=++state.generation;
  main.className='workspace stats-page';main.innerHTML='<div class="loading-state" role="status">Loading stats…</div>';preserveURL();
  try {
    const stats=await api('/api/statistics');if(token!==state.generation)return;
    document.title='Stats · Capstone';
    const card=(label,value)=>`<div class="stat-card"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
    const total=stats.total_runs || 0,counts=stats.status_counts || {},other=Object.entries(counts).filter(([status,count])=>count&&!['completed','failed','partial'].includes(status));
    main.innerHTML=`<div class="page-heading"><h1>Stats</h1><button data-page="stats" class="small">Refresh</button></div><div class="stats-counts">${card('Runs',total)}${card('Completed',stats.completed_runs)}${card('Failed',stats.failed_runs)}${card('Partial',stats.partial_runs)}</div><div class="stats-status-bar" aria-label="Run status distribution">${Object.entries(counts).filter(([,count])=>count).map(([status,count])=>`<span class="status-segment ${esc(status)}" style="flex:${count}" title="${esc(status)}: ${count}"></span>`).join('')}</div>${other.length?`<details class="stats-other"><summary>Other statuses</summary><div>${other.map(([status,count])=>`<span>${badge(status)} ${count}</span>`).join('')}</div></details>`:''}<div class="stats-panels"><section class="panel"><h2>Total solve time</h2><p class="stat-time">${stats.total_solve_time_seconds==null?'—':duration(stats.total_solve_time_seconds)}</p><p class="muted">Recorded: ${stats.known_duration_runs} / ${total} runs.</p><dl class="stats-values"><div><dt>Average</dt><dd>${duration(stats.mean_solve_time_seconds)}</dd></div><div><dt>Longest</dt><dd>${duration(stats.longest_solve_time_seconds)}${stats.longest_run?` <button class="ghost small" data-action="open-run" data-run="${esc(stats.longest_run.id)}">${esc(stats.longest_run.name)}</button>`:''}</dd></div></dl><details class="form-section"><summary>More</summary><p class="detail-body">${esc(stats.source_clock_label)}. Durations are summed across runs, including overlaps. ${stats.missing_duration_runs} durations are unavailable.</p></details></section><section class="panel"><h2>Library</h2><dl class="stats-values"><div><dt>Designs</dt><dd>${stats.design_count}</dd></div><div><dt>Favorites</dt><dd>${stats.favorite_runs}</dd></div>${stats.known_physical_time_runs?`<div><dt>Simulated physical time</dt><dd>${format(stats.total_physical_simulation_time_seconds*1000,3)} ms <span class="muted">(${stats.known_physical_time_runs} runs)</span></dd></div>`:''}</dl></section></div>`;
  }catch(error){if(token===state.generation)main.innerHTML=`<div class="error-state">${esc(error.message)} <button data-page="stats">Retry</button></div>`;}
}
document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-page]');if(!button)return;
  $('.nav-menu').open=false;
  if(button.dataset.page==='stats')await showStats();
  else {state.view='runs';state.detail=null;state.comparison=null;++state.generation;await loadProject();preserveURL();}
});
document.addEventListener('click',event=>{const nav=$('.nav-menu');if(nav.open&&!nav.contains(event.target))nav.open=false;});
document.addEventListener('keydown',event=>{const nav=$('.nav-menu');if(event.key==='Escape'&&nav.open){nav.open=false;$('summary',nav).focus();}});


async function publishDashboard() {
  try {
    const current=await api('/api/publish');
    if(!current.configured)throw new Error('Publishing is not configured yet.');
    if(current.status!=='running')await api('/api/publish',{method:'POST',body:'{}'});
    toast('Publishing snapshot…');
    const poll=async()=>{
      try {
        const status=await api('/api/publish');
        if(status.status==='running'){setTimeout(poll,3000);return;}
        toast(status.message || 'Snapshot uploaded.',status.status==='failed');
      }catch(error){toast(error.message,true);}
    };
    setTimeout(poll,3000);
  }catch(error){toast(error.message,true);}
}

window.addEventListener('online',()=>toast('Connection restored.'));
boot();
