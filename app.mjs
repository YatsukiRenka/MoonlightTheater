import {labels,optional,pool,materialChoices,generate,validate,renderPrompt} from './engine.mjs';
import {icon} from './icons.mjs';
import {initializeImages} from './images.mjs';
import {importManualMaterials, manualTextLimit, resolveManualMaterial} from './manual-materials.mjs';
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
let c=validate(model.profiles[model.active]),pref=model.prefs,expanded=false,libKey='branch',messageTimer;
const rowKeys=['palette','hair','expression','outfit','pose','silhouette','face','hairColor','eyeColor','headAccessory','nonhuman','legwear','footwear','prop','branch','style','presentation'];
const rowIcons={palette:'palette',hair:'hair',expression:'face',outfit:'outfit',pose:'pose',silhouette:'pose',face:'face',hairColor:'palette',eyeColor:'eye',style:'layers'};
const newSeed=()=>crypto.getRandomValues(new Uint32Array(1))[0].toString(16).toUpperCase().padStart(8,'0');
const cur=()=>model.current,sel=()=>cur().selection;
const notify=m=>{let n=$('toast');n.textContent=m;n.classList.add('show');clearTimeout(messageTimer);messageTimer=setTimeout(()=>n.classList.remove('show'),3100)};
function persist(){try{localStorage.setItem(storage,JSON.stringify(model))}catch{notify('浏览器存储空间不足，当前修改仅在本页保留')}}
function saveCurrent(){const i=model.history.findIndex(e=>e.id===cur().id);if(i>=0)model.history[i]=cur();persist()}
function profileId(){return 'profile-'+newSeed()}
function useProfile(profile,reset){model.active=profileId();model.profiles[model.active]=profile;c=profile;if(reset){pref.branch='';pref.style=c.settings.defaultStyle;pref.exploration=c.settings.exploration;model.locks=[]}}
function fixed(){const s=cur()?.selection||{};const f=Object.fromEntries(model.locks.filter(k=>k in s).map(k=>[k,s[k]]));if(pref.branch)f.branch=pref.branch;f.style=pref.style;return f}
function commit(seed,result,opts={}){
 const s=result.selection,manual=model.manualMaterials;model.current={id:crypto.randomUUID(),time:Date.now(),seed,algorithmVersion:1,profileVersion:c.profileVersion,profileId:model.active,selection:s,prompt:{zh:renderPrompt(c,s,'zh',manual),en:renderPrompt(c,s,'en',manual)},edits:{},...opts};
 model.history.push(cur());model.history=model.history.slice(-100);const used=new Set([model.active,...model.history.map(e=>e.profileId)]);for(const k of Object.keys(model.profiles))if(!used.has(k))delete model.profiles[k];
 persist();draw();if(result.similarityWarning)notify('部分设定与近期角色相似，已保留差异最大的组合');
}
function make(kind){let seed=kind==='replay'?$('seed').value.trim():newSeed();if(!seed)throw Error('请先输入随机种子');
 const f=kind==='fresh'?{style:pref.style,presentation:cur()?.selection.presentation??c.settings.defaultPresentation}:fixed();
 const result=generate(c,seed,{fixed:f,manual:model.manualMaterials,exploration:pref.exploration,history:kind==='replay'?[]:model.history.filter(x=>x.profileId===model.active).map(x=>x.selection)});
 if(kind==='fresh'){model.locks=model.locks.filter(k=>['style','presentation'].includes(k));pref.branch=''}
 commit(seed,result);if(kind==='replay')notify('已按当前设置重现种子');
}
function setSlot(k,value,random=false,manual=model.manualMaterials){
 if(model.locks.includes(k))throw Error('请先解锁'+labels[k]);
 const s=sel(),f={...s};delete f[k];
 if(k==='palette'&&!manual.palette?.some(entry=>entry.id===value))for(const color of ['hairColor','eyeColor'])if(!model.locks.includes(color))delete f[color];
 if(!random)f[k]=value;
 const seed=newSeed(),result=generate(c,seed,{fixed:f,manual,exploration:pref.exploration,exclude:random?{[k]:s[k]}:{}});
 model.manualMaterials=manual;
 if(k==='branch'&&pref.branch)pref.branch=result.selection.branch;
 if(k==='style')pref.style=result.selection.style;
 commit(seed,result)
}
function choicesFor(k,s,profile=c){return materialChoices(profile,k,s,model.manualMaterials)}
function labelFor(k,s,profile=c){return choicesFor(k,s,profile).find(e=>e.id===s[k])?.zh||'无'}
const named=(dict,id)=>Object.hasOwn(dict,id)?dict[id]:undefined;
function short(k,s,profile=c){return (k==='palette'?named(paletteNames,s[k]):k==='style'?named(styleNames,s[k]):k==='presentation'&&s[k]==='white_fullbody'?'白底单人全身立绘':'')||labelFor(k,s,profile)}
const swatches=id=>'<span class="swatches">'+(named(colors,id)||[]).map(color=>'<span class="swatch" style="background:'+color+'"></span>').join('')+'</span>';
function configControls(){$('branch').innerHTML=opt('','自动匹配')+options(choicesFor('branch',sel()));$('branch').value=pref.branch;$('style').innerHTML=choicesFor('style',sel()).map(x=>opt(x.id,named(styleNames,x.id)||x.zh)).join('');$('style').value=pref.style;$('explore').value=Math.round(pref.exploration*100);$('exploreValue').textContent=$('explore').value+'%'}
function draw(){
 const s=sel();configControls();$('seed').value=cur().seed;
 const rows=expanded?rowKeys:rowKeys.slice(0,5);$('slots').innerHTML=rows.map(k=>{const locked=model.locks.includes(k);return '<div class="slot"><span class="sloticon">'+icon(rowIcons[k]||'star')+'</span><span class="slotlabel">'+labels[k]+'</span><button class="slotval" data-edit="'+k+'" title="'+esc(labelFor(k,s))+'" aria-label="设置'+labels[k]+'">'+(k==='palette'?swatches(s.palette):'')+esc(short(k,s))+'</button><span class="slottools"><button class="mini '+(locked?'on':'')+'" data-lock="'+k+'" aria-pressed="'+locked+'" title="'+(locked?'解锁':'锁定')+labels[k]+'">'+icon(locked?'lock':'unlock')+'</button><button class="mini" data-roll="'+k+'" title="重抽'+labels[k]+'" '+(locked?'disabled':'')+'>'+icon('repeat')+'</button></span></div>'}).join('');
 $('expand').innerHTML=expanded?'收起其余设定 '+icon('down'):'展开全部设定（'+rowKeys.length+'） '+icon('down');
 $('output').value=cur().edits?.[pref.lang]??cur().prompt[pref.lang];count();document.querySelectorAll('[data-lang]').forEach(b=>{b.classList.toggle('selected',b.dataset.lang===pref.lang);b.setAttribute('aria-pressed',b.dataset.lang===pref.lang)});
 $('ratings').innerHTML=['喜欢','一般','不喜欢'].map((r,i)=>'<button class="'+(cur().feedback?.rating===r?'selected':'')+'" data-rate="'+r+'">'+icon(['heart','dot','x'][i])+r+'</button>').join('')
}
function count(){$('counter').textContent=$('output').value.length+' 字符'}
function showDialog(title,content){$('dtitle').textContent=title;$('dbody').innerHTML=content;$('dialog').showModal()}
function closeDialog(){$('dialog').close()}
function choose(key) {
 if (model.locks.includes(key)) throw Error('请先解锁'+labels[key]);
 const current = sel()[key];
 const list = [...(model.manualMaterials[key] || [])].reverse().concat(pool(c,key,sel(),model.manualMaterials));
 const selected = list.find(entry => entry.id === current);
 if (key in optional) list.unshift({id: null, zh: '无', en: 'None'});
 const manualForm = '<form class="manual-choice" id="manualChoice" method="post">'
  + '<label class="settinglabel">手动输入<input id="manualChoiceText" required maxlength="'+manualTextLimit+'" value="'+esc(selected?.zh)+'"></label>'
  + '<label class="settinglabel">英文（选填）<input id="manualChoiceEnglish" maxlength="'+manualTextLimit+'" placeholder="留空使用输入的文字" value="'+esc(selected?.manual&&selected.en!==selected.zh?selected.en:'')+'"></label>'
  + '<button type="submit" class="copy">使用手动输入</button><p class="note" id="manualChoiceError" role="status" hidden></p></form>';
 const options = list.map((entry, index) => '<button type="button" data-choice="'+index+'" class="'+(entry.id===current?'selected':'')+'">'
  +esc(entry.zh)+(entry.id===current?'　✓':'')+(entry.manual?'<span class="choice-manual">手动条目</span>':'')+'</button>').join('');
 showDialog('设置'+labels[key], manualForm+'<h3 class="choice-title">从素材中选择</h3><div class="choices">'+options+'</div>');
 $('manualChoice').onsubmit = event => {
  event.preventDefault();
  try {
   const {entry,created,updated} = resolveManualMaterial(list,$('manualChoiceText').value,$('manualChoiceEnglish').value);
   let manual = model.manualMaterials;
   const saved = manual[key] || [];
   if (created || updated) {
    manual = {...manual,[key]:created?[...saved,entry]:saved.map(item=>item.id===entry.id?entry:item)};
   }
   if (entry.id!==current || manual!==model.manualMaterials) setSlot(key,entry.id,false,manual);
   closeDialog();
   notify(created?'已使用并保存为新条目':updated?'已更新手动条目':'已使用现有条目');
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
function libraries(){let keys=Object.keys(labels);$('libtabs').innerHTML=keys.map(k=>'<button class="'+(libKey===k?'selected':'')+'" data-lib="'+k+'">'+labels[k]+'</button>').join('');
 $('materials').innerHTML=choicesFor(libKey,sel()).map((e,i)=>'<div class="material"><div>'+esc(e.zh)+'<small>'+esc(e.manual?'手动条目'+(e.en!==e.zh?' · '+e.en:''):e.en||e.preferredTags?.join(' · '))+'</small></div>'+('weight' in e?'<label>权重 <input aria-label="'+esc(e.zh)+'权重" type="number" min="0" step="any" data-weight="'+i+'" value="'+e.weight+'"></label>':'')+'</div>').join('')}
function records(){$('records').innerHTML=model.history.slice().reverse().map(e=>{const cfg=model.profiles[e.profileId],s=e.selection;return '<article class="record"><div><strong>'+swatches(s.palette)+esc(short('palette',s,cfg))+' · '+esc(labelFor('branch',s,cfg))+'</strong><p>'+esc(labelFor('hair',s,cfg))+' / '+esc(labelFor('outfit',s,cfg))+'</p><small>'+esc(new Date(e.time).toLocaleString('zh-CN'))+'　Seed '+esc(e.seed)+(e.feedback?'　'+esc(e.feedback.rating):'')+'</small></div><button class="secondary" data-restore="'+esc(e.id)+'">恢复</button></article>'}).join('')}
function page() {
 const anchor=location.hash.slice(1);
 const key=['library','history','settings'].includes(anchor)?anchor:'studio';
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
}
function attempt(fn){try{fn()}catch(e){notify(e.message)}}
document.querySelectorAll('[data-icon]').forEach(el=>el.replaceWith(document.createRange().createContextualFragment(icon(el.dataset.icon))));
for(const [id,type] of [['generate','new'],['fresh','fresh'],['replay','replay']])$(id).onclick=()=>attempt(()=>make(type));
$('branch').onchange=()=>{const v=$('branch').value;if(model.locks.includes('branch')&&v!==sel().branch){notify('请先解锁风格分支');configControls();return}pref.branch=v;persist()};
$('style').onchange=()=>{const old=pref.style;try{setSlot('style',$('style').value)}catch(e){pref.style=old;configControls();notify(e.message)}};
$('explore').oninput=()=>{pref.exploration=+$('explore').value/100;$('exploreValue').textContent=$('explore').value+'%';persist()};
$('unlock').onclick=()=>{model.locks=[];pref.branch='';persist();draw();notify('已解除全部锁定')};
$('slots').onclick=e=>{let b=e.target.closest('button');if(!b)return;attempt(()=>{if(b.dataset.edit)choose(b.dataset.edit);if(b.dataset.roll)setSlot(b.dataset.roll,null,true);if(b.dataset.lock){let k=b.dataset.lock;model.locks=model.locks.includes(k)?model.locks.filter(x=>x!==k):[...model.locks,k];if(k==='branch'&&model.locks.includes(k))pref.branch=sel().branch;persist();draw()}})};
$('expand').onclick=()=>{expanded=!expanded;draw()};
document.querySelectorAll('[data-lang]').forEach(b=>b.onclick=()=>{pref.lang=b.dataset.lang;persist();draw()});
$('output').oninput=()=>{cur().edits[pref.lang]=$('output').value;count();saveCurrent()};
$('copy').onclick=async()=>{try{await navigator.clipboard.writeText($('output').value);notify('已复制当前提示词')}catch{$('output').select();notify(document.execCommand('copy')?'已复制当前提示词':'已选中提示词，可手动复制')}};
$('exportChar').onclick=()=>dl('character-'+cur().seed+'.json',{...cur(),prompt:{...cur().prompt,...cur().edits}});
$('ratings').onclick=e=>{let b=e.target.closest('[data-rate]');if(!b)return;const rating=b.dataset.rate;showDialog('记录评价 · '+rating,'<label class="settinglabel">评价对象<select id="rateTarget">'+opt('design','角色设定')+opt('image','实际成图')+'</select></label><label class="settinglabel">备注（选填）<input id="rateNote" maxlength="500" placeholder="哪些细节合你的口味？"></label><button class="copy" id="saveRate">保存评价</button>');$('rateTarget').value=cur().feedback?.target||'design';$('rateNote').value=cur().feedback?.note||'';$('saveRate').onclick=()=>{cur().feedback={rating,target:$('rateTarget').value,note:$('rateNote').value,time:Date.now(),selection:{...sel()}};saveCurrent();closeDialog();draw();notify('评价已保存')}};
$('libtabs').onclick=e=>{const b=e.target.closest('[data-lib]');if(b){libKey=b.dataset.lib;libraries()}};
$('materials').onchange=e=>{if(!e.target.matches('[data-weight]'))return;try{let next=structuredClone(c);const v=e.target.valueAsNumber;pool(next,libKey,sel())[+e.target.dataset.weight].weight=v;validate(next);useProfile(next,false);persist();notify('抽取权重已保存，将用于后续生成')}catch(err){notify(err.message);libraries()}};
$('exportConfig').onclick=()=>{
 const {schemaVersion,profileVersion,note,branches,palettes,styles,presentations,pools,settings,rules}=c;
 dl('moonlight-theater-design-library.json',{schemaVersion,profileVersion,note,branches,palettes,styles,presentations,pools,settings,rules,manualMaterials:model.manualMaterials});
};
$('import').onclick=()=>$('file').click();$('file').onchange=async()=>{let f=$('file').files[0];if(!f)return;try{const {manualMaterials,...profile}=JSON.parse(await f.text());let cfg=validate(profile);const manual=importManualMaterials(model.manualMaterials,manualMaterials);let seed=newSeed(),r=generate(cfg,seed);useProfile(cfg,true);model.manualMaterials=manual;commit(seed,r);libraries();notify('已导入词库并生成角色')}catch(e){notify('导入失败：'+e.message)}$('file').value=''};
$('records').onclick=e=>{let b=e.target.closest('[data-restore]');if(!b)return;let rec=model.history.find(x=>x.id===b.dataset.restore);model.current=structuredClone(rec);model.active=rec.profileId;c=model.profiles[model.active];pref.branch='';pref.style=sel().style;model.locks=[];persist();draw();location.hash='studio';notify('已恢复角色设定和编辑文本')};
$('moreSettings').onclick=()=>{const keys={accessoryProbability:'头饰出现概率',nonhumanProbability:'非人特征出现概率',propProbability:'道具出现概率',similarityThreshold:'历史相似度阈值'};showDialog('高级设置',Object.entries(keys).map(([k,t])=>'<label class="settinglabel">'+t+'（%）<input type="number" min="0" max="100" value="'+Math.round(c.settings[k]*100)+'" id="'+k+'"></label>').join('')+'<p class="note">新设置用于后续生成。重现种子时使用当前设置，并跳过历史查重。</p><button id="saveSettings" class="copy">保存设置</button>');$('saveSettings').onclick=()=>attempt(()=>{const next=structuredClone(c);for(const k of Object.keys(keys))next.settings[k]=$(k).valueAsNumber/100;validate(next);useProfile(next,false);persist();closeDialog();notify('生成设置已保存')})};
$('close').onclick=closeDialog;$('dialog').onclose=()=>{$('dbody').onclick=null};$('dialog').onclick=e=>{if(e.target===$('dialog')){const rect=$('dialog').getBoundingClientRect();if(e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom)closeDialog()}};
if(!cur())make('new');else draw();
const imageViews=initializeImages(()=>({prompt:$('output').value,seed:cur().seed,language:pref.lang}));
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
  const target={ArrowLeft:1-index,ArrowRight:1-index,Home:0,End:1}[event.key];
  if(target===undefined)return;
  event.preventDefault();
  showHistoryTab(target,true);
 };
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
