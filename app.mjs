import {labels,optional,pool,materialChoices,availableSelection,generate,validate,renderPrompt} from './engine.mjs';
import {icon} from './icons.mjs';
import {initializeImages} from './images.mjs';
import {manualTextLimit, resolveManualMaterial} from './manual-materials.mjs';
import {importDesignLibrary} from './design-library.mjs';
import {initializeHistoryBackup} from './history-backup.mjs';
import {createCloudHistory} from './cloud-history.mjs';
import {readHistoryLimits} from './history-limits.mjs';
import {makePromptBackup, matchesRating, mergePromptBackup, trimPromptHistory} from './prompt-history.mjs';
const $=id=>document.getElementById(id),storage='yue-atelier-v1',base=validate(await (await fetch('./profile.json')).json());
const esc=s=>String(s??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
const opt=(k,t)=>'<option value="'+esc(k)+'">'+esc(t)+'</option>';
const options=a=>a.map(e=>opt(e.id,e.zh)).join('');
const styleNames={clean_cel:'干净日系平涂',soft_pastel:'清透水色粉彩',graphic_cel:'平面赛璐璐'};
const paletteNames={strawberry:'草莓奶白',soda:'奶蓝苏打',lilac:'薰衣草紫',mint:'薄荷奶绿',ink_rose:'墨黑玫瑰',porcelain:'黑白瓷釉',apricot:'奶油杏黄',navy:'海军灰蓝',black_red:'黑白朱红',pearl:'雾紫珍珠',pop_coral:'珊瑚浅蓝',forest:'松石米白'};
const colors={strawberry:['#fff3e0','#f2a9c6','#9b3557'],soda:['#afd6ea','#fff3de','#283d64'],lilac:['#cbb4de','#fffaee','#684d78'],mint:['#bde2cd','#fff8e9','#ebd993'],ink_rose:['#2e2935','#c77e9b','#fff5de'],porcelain:['#faf5e4','#39363f','#c9af73'],apricot:['#f5e5a7','#f5c2a1','#afcbdf'],navy:['#343e5e','#dedee0','#b58567'],black_red:['#302d34','#f2efeb','#c64a47'],pearl:['#faf4ec','#cfc2df','#dbc89e'],pop_coral:['#f18e7c','#b6d8e7','#404050'],forest:['#7bb9af','#f5e6c9','#60493e']};
let model;try{model=JSON.parse(localStorage.getItem(storage))}catch{}
if(!model||model.schemaVersion!==1)model={schemaVersion:1,profiles:{initial:base},active:'initial',prefs:{branch:'',style:base.settings.defaultStyle,exploration:base.settings.exploration,lang:'zh'},history:[],current:null,locks:[]};
model.manualMaterials ??= {};
model.library ??= model.active;
model.active = model.current?.profileId ?? model.library;
validate(model.profiles[model.library]);
const pref=model.prefs;
let expanded=false,libKey='branch',messageTimer,dialogOpener;
const rowKeys=['palette','hair','expression','outfit','pose','silhouette','face','hairColor','eyeColor','headAccessory','nonhuman','legwear','footwear','prop','branch','style','presentation'];
const rowIcons={palette:'palette',hair:'hair',expression:'face',outfit:'outfit',pose:'pose',silhouette:'pose',face:'face',hairColor:'palette',eyeColor:'eye',style:'layers'};
const newSeed=()=>crypto.getRandomValues(new Uint32Array(1))[0].toString(16).toUpperCase().padStart(8,'0');
const cur=()=>model.current,sel=()=>cur().selection;
function manualFor(selection, manual=model.manualMaterials) {
 const archived=model.archivedManualMaterials;
 if(!archived)return manual;
 const selected={...manual};
 for(const key of Object.keys(labels)) {
  const entry=Object.hasOwn(archived,selection[key])?archived[selection[key]]:undefined;
  if(entry&&!manual[key]?.some(item=>item.id===entry.id))selected[key]=[...(manual[key]||[]),entry];
 }
 return selected;
}
const notify=m=>{let n=$('toast');n.textContent=m;n.classList.add('show');clearTimeout(messageTimer);messageTimer=setTimeout(()=>n.classList.remove('show'),3100)};
const notifyStorageFailure=()=>notify('浏览器存储空间不足，当前修改仅在本页保留');
let storageFailed=false;
function persist(){try{localStorage.setItem(storage,JSON.stringify(model));storageFailed=false;return true}catch{storageFailed=true;const dialog=$('dialog');if(dialog.open)dialog.addEventListener('close',notifyStorageFailure,{once:true});else notifyStorageFailure();return false}}
function saveCurrent(){const i=model.history.findIndex(e=>e.id===cur().id);if(i>=0)model.history[i]=cur();return persist()}
function profileId(){return 'profile-'+newSeed()}
const libraryProfile=()=>model.profiles[model.library];
const characterProfile=()=>model.profiles[cur()?.profileId]??libraryProfile();
function storeLibrary(profile){
 model.library=profileId();model.profiles[model.library]=profile;
}
function pruneProfiles(){
 const used=new Set([model.library,cur()?.profileId,...model.history.map(entry=>entry.profileId)]);
 for(const id of Object.keys(model.profiles))if(!used.has(id))delete model.profiles[id];
}
function saveLibrary(profile){
 storeLibrary(profile);pruneProfiles();return persist();
}
function fixed(){
 const s=cur()?.selection||{};
 const f=Object.fromEntries(model.locks.filter(key=>Object.hasOwn(s,key)).map(key=>[key,s[key]]));
 if(pref.branch)f.branch=pref.branch;
 if(!Object.hasOwn(f,'style'))f.style=pref.style;
 return f;
}
function commit(seed,result){
 const profile=libraryProfile(),s=result.selection,manual=manualFor(s);
 model.active=model.library;
 model.current={id:crypto.randomUUID(),time:Date.now(),seed,algorithmVersion:1,profileVersion:profile.profileVersion,profileId:model.library,selection:s,prompt:{zh:renderPrompt(profile,s,'zh',manual),en:renderPrompt(profile,s,'en',manual)},edits:{}};
 model.history.push(cur());
 Object.assign(model,trimPromptHistory(model,readHistoryLimits().promptCount));
 const saved=persist();draw();if(saved&&result.similarityWarning)notify('部分设定与近期角色相似，已保留差异最大的组合');
 return saved;
}
function make(kind){const seed=kind==='replay'?$('seed').value.trim():newSeed();if(!seed)throw Error('请先输入随机种子');
 const profile=libraryProfile();
 const selected=kind==='fresh'?{style:fixed().style,presentation:cur()?.selection.presentation??profile.settings.defaultPresentation}:fixed();
 const manual=manualFor(selected),f=availableSelection(profile,selected,manual);
 const history=kind==='replay'?[]:model.history.map(entry=>entry.selection);
 const result=generate(profile,seed,{fixed:f,manual,exploration:pref.exploration,history});
 model.locks=model.locks.filter(key=>Object.hasOwn(f,key));
 if(!f.branch)pref.branch='';
 pref.style=result.selection.style;
 if(commit(seed,result)&&kind==='replay')notify('已按当前设置重现种子');
}
function setSlot(k,value,random=false,manual=model.manualMaterials,message=''){
 if(model.locks.includes(k))throw Error('请先解锁'+labels[k]);
 const profile=libraryProfile(),s=sel(),selected={...s};delete selected[k];
 if(k==='palette'&&!manualFor({palette:value},manual).palette?.some(entry=>entry.id===value))for(const color of ['hairColor','eyeColor'])if(!model.locks.includes(color))delete selected[color];
 if(!random)selected[k]=value;
 const effectiveManual=manualFor(selected,manual),f=availableSelection(profile,selected,effectiveManual);
 if(!random&&!Object.hasOwn(f,k))throw Error('当前设计库没有可用的'+labels[k]+'，请选择其他素材。');
 const seed=newSeed(),result=generate(profile,seed,{fixed:f,manual:effectiveManual,exploration:pref.exploration,exclude:random?{[k]:s[k]}:{}});
 const replaced=rowKeys.filter(key=>Object.hasOwn(selected,key)&&!Object.hasOwn(f,key));
 const unlocked=replaced.filter(key=>model.locks.includes(key));
 model.manualMaterials=manual;
 model.locks=model.locks.filter(key=>Object.hasOwn(f,key));
 if(k==='branch'&&pref.branch)pref.branch=result.selection.branch;
 if(k==='style')pref.style=result.selection.style;
 if(!commit(seed,result))return;
 const notices=[message];
 if(replaced.length)notices.push('当前设计库的素材有变化，已一并重抽「'+replaced.map(key=>labels[key]).join('、')+'」。');
 if(unlocked.length)notices.push('已解除「'+unlocked.map(key=>labels[key]).join('、')+'」的锁定。');
 if(notices.some(Boolean))notify(notices.filter(Boolean).join(' '));
}
function choicesFor(k,s,profile=characterProfile()){return materialChoices(profile,k,s,manualFor(s))}
function labelFor(k,s,profile=characterProfile()){return choicesFor(k,s,profile).find(e=>e.id===s[k])?.zh||'无'}
const named=(dict,id)=>Object.hasOwn(dict,id)?dict[id]:undefined;
function short(k,s,profile=characterProfile()){return (k==='palette'?named(paletteNames,s[k]):k==='style'?named(styleNames,s[k]):k==='presentation'&&s[k]==='white_fullbody'?'白底单人全身立绘':'')||labelFor(k,s,profile)}
const swatches=id=>'<span class="swatches">'+(named(colors,id)||[]).map(color=>'<span class="swatch" style="background:'+color+'"></span>').join('')+'</span>';
function configControls(){
 const profile=libraryProfile();
 $('branch').innerHTML=opt('','自动匹配')+options(choicesFor('branch',sel(),profile));
 $('branch').value=pref.branch;
 if($('branch').selectedIndex<0)$('branch').value='';
 $('style').innerHTML=choicesFor('style',sel(),profile).map(x=>opt(x.id,named(styleNames,x.id)||x.zh)).join('');
 $('style').value=pref.style;
 if($('style').selectedIndex<0)$('style').value=profile.settings.defaultStyle;
 $('explore').value=Math.round(pref.exploration*100);$('exploreValue').textContent=$('explore').value+'%';
}
function draw(){
 const s=sel();configControls();$('seed').value=cur().seed;
 const rows=expanded?rowKeys:rowKeys.slice(0,5);$('slots').innerHTML=rows.map(k=>{const locked=model.locks.includes(k);return '<div class="slot"><span class="sloticon">'+icon(rowIcons[k]||'star')+'</span><span class="slotlabel" id="slot-label-'+k+'">'+labels[k]+'</span><button class="slotval" id="slot-value-'+k+'" data-edit="'+k+'" title="'+esc(labelFor(k,s))+'" aria-labelledby="slot-label-'+k+' slot-value-'+k+'">'+(k==='palette'?swatches(s.palette):'')+esc(short(k,s))+'</button><span class="slottools"><button class="mini '+(locked?'on':'')+'" data-lock="'+k+'" aria-pressed="'+locked+'" aria-label="锁定'+labels[k]+'" title="锁定'+labels[k]+'">'+icon(locked?'lock':'unlock')+'</button><button class="mini" data-roll="'+k+'" aria-label="重抽'+labels[k]+'" title="重抽'+labels[k]+'" '+(locked?'disabled':'')+'>'+icon('repeat')+'</button></span></div>'}).join('');
 $('expand').innerHTML=expanded?'收起其余设定 '+icon('down'):'展开全部设定（'+rowKeys.length+'） '+icon('down');
 $('output').value=cur().edits?.[pref.lang]??cur().prompt[pref.lang];count();document.querySelectorAll('[data-lang]').forEach(b=>{b.classList.toggle('selected',b.dataset.lang===pref.lang);b.setAttribute('aria-pressed',b.dataset.lang===pref.lang)});
 $('ratings').innerHTML=['喜欢','一般','不喜欢'].map((r,i)=>'<button class="'+(cur().feedback?.rating===r?'selected':'')+'" data-rate="'+r+'">'+icon(['heart','dot','x'][i])+r+'</button>').join('')
}
function count(){$('counter').textContent=$('output').value.length+' 字符'}
function restoreButtonFocus(button) {
 if(!button?.matches('button')||button.isConnected)return;
 for(const attr of ['data-lock','data-roll','data-edit','data-lib','data-rate']){
  const value=button.getAttribute(attr);
  if(value!==null){document.querySelector('button['+attr+'="'+CSS.escape(value)+'"]')?.focus();return}
 }
}
function showDialog(title,content,opener=document.activeElement){dialogOpener=opener;$('dtitle').textContent=title;$('dbody').innerHTML=content;$('dstatus').textContent='';$('dialog').showModal()}
function closeDialog(){$('dialog').close()}
function choose(key,opener) {
 if (model.locks.includes(key)) throw Error('请先解锁'+labels[key]);
 const current = sel()[key];
 const list = (model.manualMaterials[key] || []).toReversed().concat(pool(libraryProfile(),key,sel(),manualFor(sel())));
 const selected = choicesFor(key,sel()).find(entry=>entry.id===current);
 if (key in optional) list.unshift({id: null, zh: '无', en: 'None'});
 const manualForm = '<form class="manual-choice" id="manualChoice" method="post">'
  + '<label class="settinglabel">手动输入<input id="manualChoiceText" required maxlength="'+manualTextLimit+'" value="'+esc(selected?.zh)+'"></label>'
  + '<label class="settinglabel">英文（选填）<input id="manualChoiceEnglish" maxlength="'+manualTextLimit+'" placeholder="留空使用输入的文字" value="'+esc(selected?.manual&&selected.en!==selected.zh?selected.en:'')+'"></label>'
  + '<button type="submit" class="copy">使用手动输入</button><p class="note" id="manualChoiceError" role="status" hidden></p></form>';
 const options = list.map((entry, index) => '<button type="button" data-choice="'+index+'" class="'+(entry.id===current?'selected':'')+'"'+(entry.id===current?' autofocus':'')+'>'
  +esc(entry.zh)+(entry.id===current?'　✓':'')+(entry.manual?'<span class="choice-manual">手动条目</span>':'')+'</button>').join('');
 showDialog('设置'+labels[key], manualForm+'<h3 class="choice-title">从素材中选择</h3><div class="choices">'+options+'</div>',opener);
 $('manualChoice').onsubmit = event => {
  event.preventDefault();
  try {
   const {entry,created,updated} = resolveManualMaterial(list,$('manualChoiceText').value,$('manualChoiceEnglish').value);
   let manual = model.manualMaterials;
   const saved = manual[key] || [];
   if (created || updated) {
    manual = {...manual,[key]:created?[...saved,entry]:saved.map(item=>item.id===entry.id?entry:item)};
   }
   const message=created?'已使用并保存为新条目':updated?'已更新手动条目':'已使用现有条目';
   if (entry.id!==current || manual!==model.manualMaterials) setSlot(key,entry.id,false,manual,message);
   else notify(message);
   closeDialog();
  } catch (error) {
   $('manualChoiceError').hidden=false;
   $('manualChoiceError').textContent=error.message;
  }
 };
 $('dbody').onclick = event => {
  const button=event.target.closest('[data-choice]');
  if(button)attempt(()=>{setSlot(key,list[Number(button.dataset.choice)].id);closeDialog()});
 };
}
function dl(name,obj){let a=document.createElement('a'),u=URL.createObjectURL(new Blob([JSON.stringify(obj,null,2)],{type:'application/json'}));a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),2000)}
function libraryPalette(profile){
 const s=sel();
 return profile.palettes.some(entry=>entry.id===s.palette)||model.manualMaterials.palette?.some(entry=>entry.id===s.palette)?s:{palette:profile.palettes[0].id};
}
function libraries(){const profile=libraryProfile();const keys=Object.keys(labels);$('libtabs').innerHTML=keys.map(k=>'<button class="'+(libKey===k?'selected':'')+'" data-lib="'+k+'" aria-pressed="'+(libKey===k)+'">'+labels[k]+'</button>').join('');
 $('materials').innerHTML=materialChoices(profile,libKey,libraryPalette(profile),model.manualMaterials).map((e,i)=>'<div class="material"><div>'+esc(e.zh)+'<small>'+esc(e.manual?'手动条目'+(e.en!==e.zh?' · '+e.en:''):e.en||e.preferredTags?.join(' · '))+'</small></div>'+('weight' in e?'<label>权重 <input aria-label="'+esc(e.zh)+'权重" type="number" min="0" step="any" data-weight="'+i+'" value="'+e.weight+'"></label>':'')+'</div>').join('')}
function records(){const rating=$('ratingFilter').value,filtered=model.history.filter(e=>matchesRating(e,rating)).toReversed();$('records').innerHTML=filtered.map(e=>{const cfg=model.profiles[e.profileId],s=e.selection;return '<article class="record"><div><strong>'+swatches(s.palette)+esc(short('palette',s,cfg))+' · '+esc(labelFor('branch',s,cfg))+'</strong><p>'+esc(labelFor('hair',s,cfg))+' / '+esc(labelFor('outfit',s,cfg))+'</p><small>'+esc(new Date(e.time).toLocaleString('zh-CN'))+'　Seed '+esc(e.seed)+(e.feedback?'　'+esc(e.feedback.rating):'')+'</small></div><button class="secondary" data-restore="'+esc(e.id)+'">恢复</button></article>'}).join('');
 const status=$('ratingFilterStatus'),message=model.history.length?(filtered.length?`显示 ${filtered.length} 条提示词记录。`:'没有符合筛选条件的提示词记录。'):'';
 if(status.textContent!==message)status.textContent=message;
}
function page() {
 const anchor=location.hash.slice(1);
 const key=anchor==='historyBackup'?'settings':['library','history','settings'].includes(anchor)?anchor:'studio';
 document.title={studio:'月光剧场 · 角色提示词生成器',library:'设计库 · 月光剧场',history:'历史记录 · 月光剧场',settings:'设置 · 月光剧场'}[key];
 for (const id of ['studio','library','history','settings']) $(id).hidden=id!==key;
 document.querySelectorAll('[data-page]').forEach(link=>{
  const active=link.dataset.page===key;
  link.classList.toggle('active',active);
  if(active)link.setAttribute('aria-current','page');
  else link.removeAttribute('aria-current');
 });
 if(key==='library')libraries();
 if(key==='history')showHistoryTab(historyIndex);
 else imageViews.hideHistory();
 if(anchor==='imageStudio') {
  setImageVisibility(true);
  $('imageStudio').scrollIntoView({block:'start'});
 }
 if(anchor==='historyBackup')$('historyBackup').scrollIntoView({block:'start'});
}
function showError(message){if($('dialog').open)$('dstatus').textContent=message;else notify(message)}
function attempt(fn){try{fn()}catch(e){showError(e.message)}}
document.querySelectorAll('[data-icon]').forEach(el=>el.replaceWith(document.createRange().createContextualFragment(icon(el.dataset.icon))));
for(const [id,type] of [['generate','new'],['fresh','fresh'],['replay','replay']])$(id).onclick=()=>attempt(()=>make(type));
$('branch').onchange=()=>{const v=$('branch').value;if(model.locks.includes('branch')&&v!==sel().branch){notify('请先解锁风格分支');configControls();return}pref.branch=v;persist()};
$('style').onchange=()=>{const old=pref.style;try{setSlot('style',$('style').value)}catch(e){pref.style=old;configControls();notify(e.message)}};
$('explore').oninput=()=>{pref.exploration=+$('explore').value/100;$('exploreValue').textContent=$('explore').value+'%';persist()};
$('unlock').onclick=()=>{model.locks=[];pref.branch='';const saved=persist();draw();if(saved)notify('已解除全部锁定')};
$('slots').onclick=e=>{let b=e.target.closest('button');if(!b)return;attempt(()=>{if(b.dataset.edit)choose(b.dataset.edit,b);if(b.dataset.roll)setSlot(b.dataset.roll,null,true);if(b.dataset.lock){let k=b.dataset.lock;model.locks=model.locks.includes(k)?model.locks.filter(x=>x!==k):[...model.locks,k];if(k==='branch'&&model.locks.includes(k))pref.branch=sel().branch;persist();draw()}});restoreButtonFocus(b)};
$('expand').onclick=()=>{expanded=!expanded;draw()};
document.querySelectorAll('[data-lang]').forEach(b=>b.onclick=()=>{pref.lang=b.dataset.lang;persist();draw()});
$('output').oninput=()=>{cur().edits[pref.lang]=$('output').value;count();saveCurrent()};
$('copy').onclick=async()=>{try{await navigator.clipboard.writeText($('output').value);notify('已复制当前提示词')}catch{$('output').select();notify(document.execCommand('copy')?'已复制当前提示词':'已选中提示词，可手动复制')}};
$('ratings').onclick=e=>{let b=e.target.closest('[data-rate]');if(!b)return;const rating=b.dataset.rate;showDialog('记录评价 · '+rating,'<label class="settinglabel">评价对象<select id="rateTarget" autofocus>'+opt('design','角色设定')+opt('image','实际成图')+'</select></label><label class="settinglabel">备注（选填）<input id="rateNote" maxlength="500" placeholder="哪些细节合你的口味？"></label><button class="copy" id="saveRate">保存评价</button>',b);$('rateTarget').value=cur().feedback?.target||'design';$('rateNote').value=cur().feedback?.note||'';$('saveRate').onclick=()=>{cur().feedback={rating,target:$('rateTarget').value,note:$('rateNote').value,time:Date.now(),selection:{...sel()}};const saved=saveCurrent();closeDialog();draw();restoreButtonFocus(b);if(saved)notify('评价已保存')}};
$('libtabs').onclick=e=>{const b=e.target.closest('[data-lib]');if(b){libKey=b.dataset.lib;libraries();restoreButtonFocus(b)}};
$('materials').onchange=e=>{if(!e.target.matches('[data-weight]'))return;try{const next=structuredClone(libraryProfile());const v=e.target.valueAsNumber;pool(next,libKey,libraryPalette(next))[+e.target.dataset.weight].weight=v;if(saveLibrary(validate(next)))notify('抽取权重已保存，将用于后续生成')}catch(err){notify(err.message);libraries()}};
$('exportConfig').onclick=()=>{
 const {schemaVersion,profileVersion,note,branches,palettes,styles,presentations,pools,settings,rules}=libraryProfile();
 dl('moonlight-theater-design-library.json',{schemaVersion,profileVersion,note,branches,palettes,styles,presentations,pools,settings,rules,manualMaterials:model.manualMaterials});
};
$('import').onclick=()=>$('file').click();
$('file').onchange=async()=>{
 const file=$('file').files[0];
 $('file').value='';
 if(!file)return;
 try {
  const incoming=JSON.parse(await file.text());
  validate(incoming);
  showDialog('选择导入方式','<p class="note">'+esc(file.name)+'</p><div class="import-modes">'
   +'<div><button type="button" class="copy" data-mode="merge">合并设计库</button><p>新增素材与手动条目，重复项保留本地版本。当前角色、偏好和锁定项会保留。</p></div>'
   +'<div><button type="button" class="secondary" data-mode="replace">替换设计库</button><p>改用文件里的素材、设置与手动条目，并生成一个新角色。历史记录会保留。</p></div></div>',$('import'));
  $('dbody').onclick=event=>{
   const mode=event.target.closest('[data-mode]')?.dataset.mode;
   if(!mode)return;
   attempt(()=>{
    const {profile,manual}=importDesignLibrary(libraryProfile(),model.manualMaterials,incoming,mode);
    let saved;
    if(mode==='merge'){
     model.manualMaterials=manual;
     saved=saveLibrary(profile);
     configControls();
    }else{
     const seed=newSeed(),result=generate(profile,seed);
     model.archivedManualMaterials??=Object.create(null);
     for(const entry of Object.values(model.manualMaterials).flat())model.archivedManualMaterials[entry.id]=entry;
     model.manualMaterials=manual;
     storeLibrary(profile);
     pref.branch='';pref.style=profile.settings.defaultStyle;pref.exploration=profile.settings.exploration;model.locks=[];
     saved=commit(seed,result);
    }
    libraries();closeDialog();
    if(saved)notify(mode==='merge'?'已合并设计库':'已替换设计库');
   });
  };
 }catch(error){showError('导入失败：'+error.message)}
};
$('ratingFilter').onchange=records;
$('records').onclick=event=>{
 const button=event.target.closest('[data-restore]');if(!button)return;
 const record=model.history.find(entry=>entry.id===button.dataset.restore);
 model.current=structuredClone(record);model.active=record.profileId;
 if(choicesFor('style',sel(),libraryProfile()).some(entry=>entry.id===sel().style))pref.style=sel().style;
 pref.branch='';model.locks=[];
 const saved=persist();draw();location.hash='studio';if(saved)notify('已恢复角色设定和编辑文本');
};
$('moreSettings').onclick=event=>{
 const keys={accessoryProbability:'头饰出现概率',nonhumanProbability:'非人特征出现概率',propProbability:'道具出现概率',similarityThreshold:'历史相似度阈值'};
 const settings=libraryProfile().settings;
 showDialog('高级设置','<form id="settingsForm" method="post">'+Object.entries(keys).map(([k,t])=>'<label class="settinglabel">'+t+'（%）<input type="number" min="0" max="100" required step="any" value="'+Math.round(settings[k]*1e4)/100+'" id="'+k+'"></label>').join('')+'<p class="note">新设置用于后续生成。重现种子时使用当前设置，并跳过历史查重。</p><button type="submit" id="saveSettings" class="copy">保存设置</button></form>',event.currentTarget);
 const form=$('settingsForm'),edited=new Set();
 form.oninput=event=>edited.add(event.target.id);
 const changed=k=>edited.has(k)&&$(k).valueAsNumber/100!==settings[k];
 form.onsubmit=event=>{
  event.preventDefault();
  if(!Object.keys(keys).some(changed)){if(storageFailed)persist();closeDialog();return}
  attempt(()=>{
   const next=structuredClone(libraryProfile());
   for(const k of Object.keys(keys))if(changed(k))next.settings[k]=$(k).valueAsNumber/100;
   const saved=saveLibrary(validate(next));closeDialog();if(saved)notify('生成设置已保存');
  });
 };
};
const dialog=$('dialog');
$('close').onclick=closeDialog;
dialog.onclose=()=>{
 if(dialog.open)return;
 $('dbody').onclick=null;
 const active=document.activeElement;
 if(!active||active===document.body||dialog.contains(active)){
  if(dialogOpener?.matches('button')&&dialogOpener.isConnected)dialogOpener.focus();
  else restoreButtonFocus(dialogOpener);
 }
 dialogOpener=null;
};
if(!('closedBy' in HTMLDialogElement.prototype)){
 const outside=e=>{const rect=dialog.getBoundingClientRect();return e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom};
 let outsidePointer;
 dialog.addEventListener('close',()=>{outsidePointer=undefined});
 dialog.onpointerdown=e=>{if(e.isPrimary&&e.button===0)outsidePointer=outside(e)?e.pointerId:undefined};
 dialog.onpointerup=e=>{
  if(e.pointerId!==outsidePointer)return;
  outsidePointer=undefined;
  if(outside(e))closeDialog();
 };
 dialog.onpointercancel=e=>{if(e.pointerId===outsidePointer)outsidePointer=undefined};
}
if(!cur())make('new');else draw();
const cloudHistory=createCloudHistory();
const imageViews=initializeImages(()=>({prompt:$('output').value,seed:cur().seed,language:pref.lang}),cloudHistory);
const historyTabs=[$('promptHistoryTab'),$('imageHistoryTab')];
let historyIndex=0;
function showHistoryTab(index, focus=false) {
 historyIndex=index;
 historyTabs.forEach((tab,i)=>{
  const active=i===index;
  tab.classList.toggle('selected',active);
  tab.setAttribute('aria-selected',active);
  tab.tabIndex=active?0:-1;
  $(tab.getAttribute('aria-controls')).hidden=!active;
 });
 if(focus)historyTabs[index].focus();
 if(index===0) {
  imageViews.hideHistory();
  records();
 } else void imageViews.showHistory();
}
historyTabs.forEach((tab,index)=>{
 tab.onclick=()=>showHistoryTab(index);
 tab.onkeydown=event=>{
  if(event.altKey||event.ctrlKey||event.metaKey)return;
  const target={ArrowLeft:1-index,ArrowRight:1-index,Home:0,End:1}[event.key];
  if(target===undefined)return;
  event.preventDefault();
  showHistoryTab(target,true);
 };
});

function persistPromptPatch(patch) {
 try{localStorage.setItem(storage,JSON.stringify({...model,...patch}));storageFailed=false;}
 catch(error){throw new Error('当前浏览器没有足够空间写入提示词历史。',{cause:error});}
 Object.assign(model,patch);
}
initializeHistoryBackup({
 cloud:cloudHistory,
 readPrompts:()=>makePromptBackup(model),
 mergePrompts(backup){
  const result=mergePromptBackup(model,backup,readHistoryLimits().promptCount);
  persistPromptPatch(result.patch);
  return result;
 },
 applyPromptLimit(limit){
  const before=model.history.length;
  if(before>limit)persistPromptPatch(trimPromptHistory(model,limit));
  return before-model.history.length;
 },
 refreshHistory(){if(location.hash==='#history')showHistoryTab(historyIndex);},
});

const visibilityKey='moonlight-image-studio-hidden';
function setImageVisibility(visible, remember=true) {
 $('imageStudio').hidden=!visible;
 $('workgrid').classList.toggle('image-hidden',!visible);
 $('toggleImageStudio').textContent=visible?'隐藏生图':'显示生图';
 $('toggleImageStudio').setAttribute('aria-expanded',visible);
 if(remember)try{localStorage.setItem(visibilityKey,String(!visible))}catch{}
}
try{setImageVisibility(localStorage.getItem(visibilityKey)!=='true',false)}catch{}
$('toggleImageStudio').onclick=()=>{
 const visible=$('imageStudio').hidden;
 setImageVisibility(visible);
 if(!visible&&location.hash==='#imageStudio')history.replaceState(history.state,'','#studio');
};
window.addEventListener('hashchange',page);
page();
