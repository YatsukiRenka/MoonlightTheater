export const labels={branch:'风格分支',palette:'配色方案',silhouette:'体态轮廓',face:'面部特征',hair:'发型',hairColor:'发色',eyeColor:'瞳色',expression:'表情',outfit:'服装',headAccessory:'头饰',nonhuman:'非人特征',legwear:'袜装',footwear:'鞋型',prop:'随身道具',pose:'姿势',style:'绘制画风',presentation:'展示形式'};
export const optional={headAccessory:'accessoryProbability',nonhuman:'nonhumanProbability',prop:'propProbability'};
const keys=['silhouette','face','hair','expression','outfit','headAccessory','nonhuman','legwear','footwear','prop','pose'];
const get=(a,id)=>a.find(x=>x.id===id);
export function validate(c){
 const fail=(m)=>{throw Error('词库配置有误：'+m)};
 if(c?.schemaVersion!==1||typeof c.profileVersion!=='string')fail('版本不兼容');
 const check=(a,k,weighted=true,english=true,optionalPool=false)=>{
  if(!Array.isArray(a)||(!optionalPool&&!a.length))fail(labels[k]+'缺少候选项');
  const seen=new Set();
  for(const e of a){if(!e||typeof e.id!=='string'||!e.id||seen.has(e.id)||!e.zh||typeof e.zh!=='string'||(english&&(!e.en||typeof e.en!=='string')))fail(labels[k]+'的编号或文字无效');seen.add(e.id);
   if(weighted){if(!Number.isFinite(e.weight)||e.weight<0)fail(labels[k]+'权重无效');const tags=k==='branch'?e.preferredTags:e.tags;if(!Array.isArray(tags)||!tags.every(t=>typeof t==='string'))fail(labels[k]+'标签无效')}}
  if(weighted&&!optionalPool&&!a.some(e=>e.weight>0))fail(labels[k]+'没有正权重候选');
 };
 check(c.branches,'branch',true,false);check(c.palettes,'palette');check(c.styles,'style',false);check(c.presentations,'presentation',false);
 for(const k of keys)check(c.pools?.[k],k,true,true,k in optional);
 for(const p of c.palettes)for(const key of ['hairColors','eyeColors'])if(!Array.isArray(p[key])||!p[key].length||!p[key].every(e=>typeof e.zh==='string'&&e.zh&&typeof e.en==='string'&&e.en))fail('配色缺少双语颜色');
 const s=c.settings||{};for(const k of ['exploration',...Object.values(optional),'similarityThreshold'])if(!Number.isFinite(s[k])||s[k]<0||s[k]>1)fail('概率超出范围');
 if(!Number.isFinite(s.branchAffinityMultiplier)||s.branchAffinityMultiplier<=0||!Number.isInteger(s.candidateCount)||s.candidateCount<1||s.candidateCount>1000||!Number.isInteger(s.historySize)||s.historySize<0||s.historySize>100)fail('抽样参数无效');
 if(!get(c.styles,s.defaultStyle)||!get(c.presentations,s.defaultPresentation))fail('默认预设不存在');
 const r=c.rules||{};const refs=(list,k)=>{if(!Array.isArray(list)||!list.every(id=>get(c.pools[k],id)))fail('兼容规则引用了不存在的'+labels[k])};
 refs(r.headAccessoryExcludeWhenNonhuman,'nonhuman');refs(r.forceLegwearNoneForOutfits,'outfit');if(!get(c.pools.legwear,'none'))fail('缺少袜装 none');
 if(!r.outfitHeadAccessoryExclusion||typeof r.outfitHeadAccessoryExclusion!=='object')fail('缺少头饰排除规则');
 for(const [id,ids] of Object.entries(r.outfitHeadAccessoryExclusion)){refs([id],'outfit');refs(ids,'headAccessory')}
 if(!r.similarityWeights||!Object.entries(r.similarityWeights).every(([k,w])=>Object.hasOwn(labels,k)&&Number.isFinite(w)&&w>=0))fail('相似度权重无效');
 return c;
}
export function rngFor(seed){let h=2166136261;for(const ch of String(seed))h=Math.imul(h^ch.charCodeAt(0),16777619);return ()=>{h=(h+0x6d2b79f5)|0;let t=Math.imul(h^(h>>>15),1|h);t=(t+Math.imul(t^(t>>>7),61|t))^t;return ((t^(t>>>14))>>>0)/4294967296}}
function pick(list,rng,branch,mult=1){
 const weights=list.map(e=>(e.weight??1)*(branch&&e.tags?.some(t=>branch.preferredTags.includes(t))?mult:1));let n=rng()*weights.reduce((a,b)=>a+b,0);
 for(let i=0;i<weights.length;i++){n-=weights[i];if(n<0)return list[i]}
}
const manualEntry = (manual, key, id) => manual?.[key]?.find(entry => entry.id === id);
export function pool(c, k, s, manual) {
 if (k === 'branch') return c.branches;
 if (k === 'style') return c.styles;
 if (k === 'presentation') return c.presentations;
 if (k === 'palette') return c.palettes;
 if (k === 'hairColor' || k === 'eyeColor') {
  const palette = get(c.palettes, s.palette);
  const colorKey = k + 's';
  const options = palette ? palette[colorKey] : manualEntry(manual, 'palette', s.palette)
   ? [...new Map(c.palettes.flatMap(item => item[colorKey]).map(color => [color.zh, color])).values()] : [];
  return options.map(color => ({...color, id: color.zh}));
 }
 return c.pools[k];
}
export function materialChoices(c, key, selection, manual) {
 return [...pool(c, key, selection, manual), ...(manual?.[key] || [])];
}
export function availableSelection(c,selection,manual){
 const fixed={...selection};
 for(const [key,id] of Object.entries(selection)){
  if(key==='hairColor'||key==='eyeColor')continue;
  if(id===null&&Object.hasOwn(optional,key))continue;
  if(!materialChoices(c,key,selection,manual).some(entry=>entry.id===id))delete fixed[key];
 }
 const nativeColors=['hairColor','eyeColor'].filter(key=>selection[key]!==undefined&&!manualEntry(manual,key,selection[key]));
 if(fixed.palette){
  for(const key of nativeColors)if(!pool(c,key,fixed,manual).some(color=>color.id===selection[key]))delete fixed[key];
 }else if(nativeColors.length){
  const palettes=c.palettes.filter(palette=>palette.weight>0);
  const hasColor=(palette,key)=>palette[key+'s'].some(color=>color.zh===selection[key]);
  const existingColors=nativeColors.filter(key=>palettes.some(palette=>hasColor(palette,key)));
  const hasCommonPalette=palettes.some(palette=>existingColors.every(key=>hasColor(palette,key)));
  for(const key of nativeColors)if(!hasCommonPalette||!existingColors.includes(key))delete fixed[key];
 }
 return fixed;
}
export function compatible(c,s,manual){const r=c.rules;
 if(s.headAccessory&&!manualEntry(manual,'headAccessory',s.headAccessory)&&r.headAccessoryExcludeWhenNonhuman.includes(s.nonhuman))return '当前非人特征与独立头饰冲突';
 if(s.headAccessory&&r.outfitHeadAccessoryExclusion[s.outfit]?.includes(s.headAccessory))return '当前服装与头饰冲突';
 if(s.legwear!==undefined&&r.forceLegwearNoneForOutfits.includes(s.outfit)&&s.legwear!=='none'&&!manualEntry(manual,'legwear',s.legwear))return '这套服装要求袜装选择「不单独指定」';
 if(s.palette&&!manualEntry(manual,'palette',s.palette)){let p=get(c.palettes,s.palette);if(!p)return '配色不存在';for(const k of ['hairColor','eyeColor'])if(s[k]&&!manualEntry(manual,k,s[k])&&!p[k+'s'].some(e=>e.zh===s[k]))return '配色不包含当前'+labels[k]}
 return '';
}
export function similarity(c,a,b,locked={}){let score=0,total=0;for(const [k,w] of Object.entries(c.rules.similarityWeights)){if(k in locked||(a[k]==null&&b[k]==null))continue;total+=w;if(a[k]===b[k])score+=w}return total?score/total:0}
export function generate(c,seed,{fixed={},history=[],exploration=c.settings.exploration,exclude={},manual}={}){
 const rng=rngFor(seed),cfg=c.settings;const invalid=compatible(c,fixed,manual);if(invalid)throw Error(invalid+'，请调整或解锁相关项。');
 const preset=(k,defaultId)=>{if(k in fixed)return fixed[k];if(!(k in exclude))return defaultId;const next=pick(pool(c,k,{}).filter(e=>e.id!==exclude[k]),rng);if(!next)throw Error(labels[k]+'仅有一个候选');return next.id};
 const alternatives=(k,s)=>pool(c,k,s,manual).filter(e=>e.id!==exclude[k]&& !compatible(c,{...s,[k]:e.id},manual));
 const branch='branch' in fixed?(get(c.branches,fixed.branch)||manualEntry(manual,'branch',fixed.branch)):pick(alternatives('branch',fixed),rng);
 if(!branch)throw Error('没有可选风格');const mult=rng()<exploration?1:cfg.branchAffinityMultiplier;
 let best,score=Infinity;
 for(let i=0;i<cfg.candidateCount;i++){
  let s={...fixed,branch:branch.id,style:preset('style',cfg.defaultStyle),presentation:preset('presentation',cfg.defaultPresentation)};
  for(const k of ['palette','hairColor','eyeColor','silhouette','face','hair','expression','outfit','nonhuman','headAccessory','legwear','footwear','prop','pose']){
   if(k in fixed)continue;
   if(k in optional&&rng()>=cfg[optional[k]]&&exclude[k]!==null){s[k]=null;continue}
   const opts=alternatives(k,s);let entry=pick(opts,rng,k==='pose'||branch.manual?null:branch,mult);
   if(!entry&&!(k in optional))throw Error(labels[k]+'没有兼容的其他候选，请调整或解锁相关项。');
   if(!entry&&exclude[k]===null)throw Error(labels[k]+'暂无兼容候选，请调整相关项。');
   s[k]=entry?.id??null;
  }
  const recent=cfg.historySize?history.slice(-cfg.historySize):[];let max=Math.max(0,...recent.map(b=>similarity(c,s,b,fixed)));
  if(max<cfg.similarityThreshold||!recent.length)return {selection:s,similarityWarning:false};
  if(max<score){best=s;score=max}
 }
 return {selection:best,similarityWarning:true};
}
export function renderPrompt(c,s,lang,manual){const val=k=>(manualEntry(manual,k,s[k])||get(pool(c,k,s,manual),s[k]))?.[lang]||'';const zh=lang==='zh';const line=(...a)=>a.filter(Boolean).map(x=>x.replace(/[。.!]+$/,'')).join(zh?'。':'. ')+(zh?'。':'.');
 const colorName=k=>{const name=val(k);return manualEntry(manual,k,s[k])||name.endsWith('色')||name.includes('挑染')?name:name+'色'};
 const color=zh?colorName('hairColor')+'的头发，'+val('hair'):val('hairColor')+' hair, '+val('hair');
 const eyes=zh?colorName('eyeColor')+'眼睛，'+val('expression'):val('eyeColor')+' eyes, '+val('expression');
 const branch=manualEntry(manual,'branch',s.branch)?val('branch'):'';
 return [line(zh?'原创日系二次元角色设计':'Original Japanese anime character design',branch,val('silhouette'),val('face'),color,eyes),line(val('outfit'),val('palette'),val('headAccessory'),val('nonhuman'),['none','bare'].includes(s.legwear)?'':val('legwear'),val('footwear'),val('prop'),val('pose')),line(val('style'),val('presentation'),zh?'细节服务于整体轮廓，装饰简洁有序':'Keep the silhouette distinct and the decorative details restrained')].join('\n\n');
}
