const scopeNames={household:'家庭生活',business:'工作经营',unassigned:'归属待确认'};
const natureNames={expense:'消费付款',refund:'退款',repayment:'还款',transfer:'往来转账',stored:'储值与充值',rent:'房租与押金',income:'收入或转入',unpaid:'未支付记录',duplicate_pending:'重复关系待核对'};
function isPending(e,mode){return (mode==='payment'?e.referenceFen:e.amountFen)==null;}
export function selectEvents(data,state={}){
 const {period='2026-09',scope='all',mode='expense',search='',status='all',dateFrom='',dateTo='',minFen=null,maxFen=null}=state;
 const query=String(search).trim().toLocaleLowerCase();
 return data.events.filter(e=>{
  if((mode==='payment'?(e.paymentPeriod||e.period):e.period)!==period||e.kind==='duplicate_pending'||(mode!=='payment'&&e.excluded))return false;
  if(scope!=='all'&&e.scope!==scope)return false;
  if((dateFrom&&e.date<dateFrom)||(dateTo&&e.date>dateTo))return false;
  const amount=mode==='payment'?e.referenceFen:e.amountFen;
  if(minFen!=null&&(amount==null||amount<minFen))return false;
  if(maxFen!=null&&(amount==null||amount>maxFen))return false;
  if(status==='pending'&&!isPending(e,mode))return false;
  if(status==='known'&&isPending(e,mode))return false;
  const terms=[e.id,e.party,e.description,e.purposeL1,e.purposeL2,e.platform,e.account,e.note,scopeNames[e.scope],...(e.sourceRefs||[]).map(r=>r.code)].join(' ').toLocaleLowerCase();
  return !query||terms.includes(query);
 });
}
export function summarize(events,mode='expense'){
 const sum={amountFen:0,knownCount:0,pendingCount:0,pendingReferenceFen:0,referenceFen:0,count:events.length,excludedCount:0};
 for(const e of events){
  const value=mode==='payment'?e.referenceFen:e.amountFen;
  if(value==null){sum.pendingCount++;sum.pendingReferenceFen+=e.referenceFen??0;}
  else {sum.knownCount++;sum.amountFen+=value;}
  sum.referenceFen+=e.referenceFen??0;
  if(e.excluded)sum.excludedCount++;
 }
 return sum;
}
export function groupEvents(events,dimension,mode='expense'){
 const fields={purpose:'purposeL1',purpose2:'purposeL2',platform:'platform',account:'account',party:'party',frequency:'frequency',necessity:'necessity'};
 const buckets=new Map();
 for(const e of events){
  const name=dimension==='scope'?(scopeNames[e.scope]||'归属待确认'):dimension==='nature'?(natureNames[e.kind]||'性质待确认'):(e[fields[dimension]]||'待确认');
  if(!buckets.has(name))buckets.set(name,[]);
  buckets.get(name).push(e);
 }
 return [...buckets].map(([name,rows])=>({name,events:rows,...summarize(rows,mode)}))
  .sort((a,b)=>(Math.abs(b.amountFen)+Math.abs(b.pendingReferenceFen))-(Math.abs(a.amountFen)+Math.abs(a.pendingReferenceFen))||a.name.localeCompare(b.name,'zh-CN'));
}
export function parseMoney(input,{allowNegative=false}={}){
 const text=String(input??'').trim();
 if(text==='')return null;
 const pattern=allowNegative?/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/:/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/;
 if(!pattern.test(text))throw new Error('请输入最多两位小数的金额');
 const clean=text.replaceAll(',','');
 const [whole,decimal='']=clean.replace('-','').split('.');
 const cents=Number(whole)*100+Number(decimal.padEnd(2,'0'));
 if(!Number.isSafeInteger(cents))throw new Error('金额超出可处理范围');
 return clean.startsWith('-')?-cents:cents;
}

export function validateLocalState(input,data){
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('草稿格式不正确');
 if(input.sourceVersion!==data.version)throw new Error('草稿与当前账本版本不一致，请核对后再导入');
 const isObject=v=>v&&typeof v==='object'&&!Array.isArray(v);
 const sourceDrafts=input.drafts??{},sourceBudgets=input.budgets??{};
 if(!isObject(sourceDrafts)||!isObject(sourceBudgets))throw new Error('草稿内容格式不正确');
 const drafts=Object.create(null),budgets=Object.create(null);
 for(const [id,p] of Object.entries(sourceDrafts)){
  const e=data.events.find(x=>x.id===id);
  if(!e||!isObject(p))throw new Error('草稿包含未知流水');
  const q={};
  for(const key of Object.keys(p))if(!['scope','period','purposeL1','purposeL2','amountFen','excluded','note','updatedAt','necessity'].includes(key))throw new Error('草稿包含不支持的字段');
  if(p.scope!==undefined){if(!['household','business','unassigned'].includes(p.scope))throw new Error('归属不正确');q.scope=p.scope;}
  if(p.period!==undefined){if(!data.periods.some(x=>x.id===p.period))throw new Error('费用账期不正确');q.period=p.period;}
  for(const key of ['purposeL1','purposeL2','note','updatedAt'])if(p[key]!==undefined){if(typeof p[key]!=='string'||p[key].length>(key==='note'?500:80)||/[\u0000-\u0008\u000b\u000c\u000e-\u001f|]/.test(p[key]))throw new Error('草稿文字过长或包含无效字符');q[key]=p[key];}
  if(p.necessity!==undefined){if(!['必要','可调整','待判断'].includes(p.necessity))throw new Error('预算标签不正确');q.necessity=p.necessity;}
  if(p.excluded!==undefined){if(typeof p.excluded!=='boolean')throw new Error('费用处理不正确');q.excluded=p.excluded;}
  if(Object.hasOwn(p,'amountFen')){
   if(p.amountFen!==null&&(!Number.isSafeInteger(p.amountFen)||Math.abs(p.amountFen)>e.rawAmountFen||(p.amountFen<0&&e.kind!=='refund')||(p.amountFen>0&&e.kind==='refund')))throw new Error('费用金额须在原交易金额以内；退款只能记零或负数');
   q.amountFen=p.amountFen;
  }
  if(['rent','duplicate_pending'].includes(e.kind)&&(Object.hasOwn(q,'amountFen')||q.period!==undefined||q.excluded!==undefined))throw new Error('关联房租和疑似重复记录的金额须在来源账本中核对');
  drafts[id]=q;
 }
 for(const [key,value] of Object.entries(sourceBudgets)){
  const parts=key.split('|');
  if(parts.length!==3||!data.periods.some(x=>x.id===parts[0])||!['household','business','unassigned'].includes(parts[1])||!parts[2]||parts[2].length>60||!Number.isSafeInteger(value)||value<0||value>100000000000)throw new Error('预算字段或金额无效');
  budgets[key]=value;
 }
 return {drafts,budgets};
}
export function applyDrafts(data,drafts={}){
 return data.events.map(e=>{
  const p=drafts[e.id];if(!p)return e;
  const {period,note,updatedAt,...fields}=p;
  const result={...e,...fields,paymentPeriod:e.period,period:period??e.period,localDraft:true,localNote:note??''};
  if(p.purposeL1||p.purposeL2)result.purposeStatus='local';
  if(Object.hasOwn(p,'amountFen')){result.excluded=false;result.expenseStatus=p.amountFen==null?'pending':'known';result.periodStatus=p.amountFen==null?'pending':'confirmed';}
  if(p.excluded){result.excluded=true;result.amountFen=0;result.expenseStatus='excluded';result.periodStatus='excluded';}
  return result;
 });
}
