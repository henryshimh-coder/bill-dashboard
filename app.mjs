import { selectEvents, summarize, groupEvents, parseMoney, validateLocalState, applyDrafts } from './model.mjs?v=20260929';

const $ = (id) => document.getElementById(id);
const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const fmt = (fen, symbol = true) => Number.isSafeInteger(fen) ? `${symbol ? '¥ ' : ''}${(fen / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '待确认';
const scopeNames = { all: '全部归属', household: '家庭生活', business: '工作经营', unassigned: '待归属' };
const natureNames = { expense: '消费', refund: '退款', repayment: '还款', transfer: '资金往来', stored: '储值', rent: '房租及押金', income: '入账', unpaid: '未支付订单', duplicate_pending: '重复关系待确认' };
const categories = ['居住','餐饮','食材与日用品','交通用车','服饰个护','家居数码','运动休闲','旅行','通讯与数字服务','医疗健康','人情赠与','工作经营','用途待确认'];
let data;
let state = { period:'2026-09', scope:'all', mode:'expense', search:'', status:'all', dimension:'purpose', view:'overview', dateFrom:'',dateTo:'',minFen:null,maxFen:null };
let drafts = {}, budgets = {}, storageAvailable = true, activeEvent = null, reviewLimit = 30;
let filtered = [], effectiveEvents = [], toastTimer, storageKey;
const checkedReview = new Set();

function notify(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4200);
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(storageKey);
    if(raw){const clean=validateLocalState(JSON.parse(raw),data);drafts=clean.drafts;budgets=clean.budgets;}
  } catch { storageAvailable = false; drafts = {}; budgets = {}; }
}

function persist() {
  try { localStorage.setItem(storageKey, JSON.stringify({sourceVersion:data.version, drafts, budgets})); storageAvailable = true; return true; }
  catch { storageAvailable = false; notify('浏览器无法保存到本机，请及时导出草稿。当前页面中的修改仍保留。'); return false; }
}

function withDrafts() { return applyDrafts(data,drafts); }
function duplicateReviews(){
 return effectiveEvents.filter(e=>e.kind==='duplicate_pending'&&e.period===state.period&&(state.scope==='all'||e.scope===state.scope)&&(!state.search||[e.id,e.party,e.description].join(' ').toLowerCase().includes(state.search.toLowerCase()))&&(!state.dateFrom||e.date>=state.dateFrom)&&(!state.dateTo||e.date<=state.dateTo)&&(state.minFen==null||e.rawAmountFen>=state.minFen)&&(state.maxFen==null||e.rawAmountFen<=state.maxFen)&&state.status!=='known');
}

function empty(title, note = '试试调整账期、归属或搜索条件。') {
  return `<div class="empty-state"><strong>${escapeHTML(title)}</strong><p>${escapeHTML(note)}</p></div>`;
}

function currentPeriod() { return data.periods.find((p) => p.id === state.period) || data.periods[0]; }
function budgetKey(purpose) { return `${state.period}|${state.scope}|${purpose}`; }
function validBudget(value) { return Number.isSafeInteger(value) && value >= 0; }
function visiblePurposes() { return [...new Set(filtered.map((event) => event.purposeL1 || '用途待确认'))]; }

function budgetAggregate() {
  const activePurposes = visiblePurposes();
  const selected = Object.entries(budgets).filter(([key,value]) => {
    const [period,scope,purpose] = key.split('|');
    return validBudget(value) && period === state.period && (state.scope==='all'||scope === state.scope) && (!state.search && state.status === 'all' || activePurposes.includes(purpose));
  });
  return {count:selected.length, amountFen:selected.reduce((sum,[,value]) => sum + value,0)};
}

function renderOverview() {
  const summary = summarize(filtered,state.mode);
  const period = currentPeriod();
  const amount = Number.isSafeInteger(summary.amountFen) ? summary.amountFen : 0;
  document.querySelector('.currency').hidden=state.mode==='expense'&&summary.knownCount===0&&summary.pendingCount>0;
  $('hero-amount').textContent = state.mode==='expense'&&summary.knownCount===0&&summary.pendingCount>0 ? '待核定' : fmt(amount,false);
  $('amount-label').textContent = state.mode === 'payment' ? '原交易记录净额' : period.partial ? '已知跨期费用' : '已明确本期费用';
  $('completeness-badge').textContent = state.mode === 'payment' ? '非完整现金流' : period.partial ? '仅已知分摊' : '尚未完整';
  $('pending-count').textContent = `${summary.pendingCount || 0} 条`;
  $('pending-reference').textContent = fmt(summary.pendingReferenceFen ?? 0);
  const budget = budgetAggregate(); $('budget-total').textContent = budget.count ? fmt(budget.amountFen) : '未设置';
  $('hero-note').textContent = state.mode === 'payment'
    ? `当前筛选 ${summary.count || filtered.length} 条记录；退款、入账以负数呈现。跨来源记录不构成完整现金流，未确定的重复记录不相加。`
    : state.scope === 'business' && summary.knownCount === 0
      ? '本期经营费用尚待核定。已确认经营用途的付款，仍需核实服务期间与最终承担情况。已确认的经营付款单列在待核对金额中。'
      : `来自 ${summary.knownCount || 0} 条已明确费用明细；其他记录仍待核对。${state.scope === 'unassigned' ? '用途或本期金额已明确，不代表承担主体已确认。' : '金额不代表完整账期总费用。'}`;
  $('pending-metric-label').textContent = '待核对记录';
  $('reference-metric-label').textContent = '待核对原交易金额';
  $('period-dates').textContent = `${period.start.replaceAll('-','.')} — ${period.end.replaceAll('-','.')}`;
  $('future-notice').hidden = !period.partial;
  $('future-notice').textContent = '本账期仅有已知预付分摊，尚未导入完整流水。不要将此金额视为未来账期的总费用或完整房租。';
  const draftCount = Object.keys(drafts).length;
  $('draft-notice').hidden = !draftCount && storageAvailable;
  $('draft-notice').innerHTML = `<span>${draftCount ? `已应用 ${draftCount} 笔本机草稿。只影响当前浏览器，尚未合并到账本来源。` : '此浏览器无法使用本机存储，请导出修改以免丢失。'}</span>${draftCount ? '<button id="clear-drafts" type="button">清除流水草稿</button>' : ''}`;
  $('review-tab-count').textContent = String(filtered.filter(needsReview).length+duplicateReviews().length);
  $('group-caption').textContent = `当前筛选 ${filtered.length} 条明细 · 展开查看组成`;
  $('amount-column-label').textContent = state.mode === 'expense' ? '本期计入 / 待核对' : '原交易净额';
  $('group-footnote').textContent = state.mode === 'expense'
    ? '条形与占比仅对应当前筛选的已明确费用。待核对金额为原交易参考金额，不等于本期费用；归属不明的记录保持独立。'
    : '付款记录展示去除已确认来源镜像后的记录；退款与入账为负。还款、储值、划转保留在此视图，不重复进入费用。';
}

function eventStatus(event) {
  if (event.localDraft) return '本机草稿';
  if (event.expenseStatus === 'excluded' || event.excluded) return '未计费用';
  return event.amountFen !== null && event.expenseStatus === 'known' ? '本期已明确' : '待确认';
}

function transactionRow(event) {
  const amount = state.mode === 'payment' ? event.referenceFen : event.amountFen;
  return `<button class="transaction-row" type="button" data-event="${escapeHTML(event.id)}" aria-label="查看 ${escapeHTML(event.party)} ${escapeHTML(event.date)} 详情"><span class="transaction-date">${escapeHTML(event.date?.slice(5))}</span><span><span class="transaction-party">${escapeHTML(event.party || '收款方待确认')}${event.localDraft ? '<span class="draft-tag">本机</span>' : ''}</span><span class="transaction-description" style="display:block">${escapeHTML(event.description || event.purposeL2 || '用途待确认')}</span></span><span class="transaction-value"><strong>${amount === null || amount === undefined ? '待确认' : escapeHTML(fmt(amount))}</strong><small>${amount === null || amount === undefined ? `原 ${escapeHTML(fmt(event.rawAmountFen))}` : escapeHTML(eventStatus(event))}</small></span><span class="transaction-arrow" aria-hidden="true">↗</span></button>`;
}

function groupAmount(group) {
  if (state.mode === 'payment') return fmt(group.amountFen || 0);
  return group.knownCount ? fmt(group.amountFen || 0) : '待确认';
}

function renderGroups() {
  const groups = groupEvents(filtered,state.dimension,state.mode);
  if (!groups.length) { $('group-list').innerHTML = empty('当前没有匹配的记录'); return; }
  const total = summarize(filtered,state.mode).amountFen || 0;
  const max = Math.max(...groups.map((g) => Math.abs(g.amountFen || 0)),1);
  $('group-list').innerHTML = groups.map((group) => {
    const share = total > 0 && group.amountFen > 0 ? `${(group.amountFen/total*100).toFixed(1)}%` : '—';
    const width = Math.min(100,Math.abs(group.amountFen || 0)/max*100);
    const subgroups = state.dimension === 'purpose' ? groupEvents(group.events,'purpose2',state.mode) : null;
    const content = subgroups ? subgroups.map((sub) => `<details class="subgroup"><summary><span>${escapeHTML(sub.name)} <span class="muted">· ${sub.count} 条</span></span><span class="subgroup-value">${escapeHTML(groupAmount(sub))}</span></summary>${sub.events.map(transactionRow).join('')}</details>`).join('') : group.events.map(transactionRow).join('');
    return `<details class="group-row"><summary><span class="group-chevron" aria-hidden="true">›</span><span><span class="group-name">${escapeHTML(group.name)}</span><span class="group-meta" style="display:block">${group.count} 条明细${state.mode === 'expense' ? ` · 已明确占比 ${share}` : ''}</span></span><span class="group-bar" aria-hidden="true"><i style="width:${width}%"></i></span><span class="group-total">${escapeHTML(groupAmount(group))}${group.pendingCount ? `<small>${group.pendingCount} 条待核对 · 原 ${escapeHTML(fmt(group.pendingReferenceFen ?? 0,false))}</small>` : '<small>点击展开</small>'}</span></summary><div class="group-body">${content}</div></details>`;
  }).join('');
}

function needsReview(event) {
  return event.expenseStatus === 'pending' || event.periodStatus === 'pending' || event.scope === 'unassigned' && !event.excluded || (event.purposeStatus === 'unknown'||event.purposeL1==='用途待确认') && !event.excluded;
}

function reviewReason(event) {
  const reasons = [];
  if (event.expenseStatus === 'pending' || event.periodStatus === 'pending') reasons.push('本期计入金额待核对');
  if (event.scope === 'unassigned') reasons.push('家庭 / 经营归属待确认');
  if (event.purposeStatus === 'unknown'||event.purposeL1==='用途待确认') reasons.push('具体用途待确认');
  return reasons.length ? reasons.join(' · ') : '请核对费用处理方式';
}

function renderReview() {
  const events = filtered.filter(needsReview).sort((a,b) => Math.abs(b.rawAmountFen || 0) - Math.abs(a.rawAmountFen || 0));
  $('review-summary').textContent = `${events.length} 条待整理 · ${duplicateReviews().length} 条重复关系待核对`;
  const duplicates=duplicateReviews();
  if (!events.length && !duplicates.length) { $('review-list').innerHTML = empty('当前筛选没有待确认记录','可切换“全部归属”或“全部状态”，查看其他记录。'); return; }
  $('review-list').innerHTML = `<div class="batch-controls"><label class="review-check"><input id="review-select-visible" type="checkbox">选择本页记录</label><select id="batch-scope" aria-label="批量归属"><option value="household">家庭生活</option><option value="business">工作经营</option><option value="unassigned">待归属</option></select><button id="apply-batch-scope" class="outline-button" type="button">批量保存归属草稿</button><span class="muted">仅作用于勾选项</span></div>` + events.slice(0,reviewLimit).map((event,index) => `<article class="review-item"><label class="review-number review-check"><input type="checkbox" data-check-event="${escapeHTML(event.id)}" ${checkedReview.has(event.id) ? 'checked' : ''} aria-label="选择 ${escapeHTML(event.id)}"></label><div><h3>${escapeHTML(event.party || event.purposeL1 || '用途待确认')}${event.localDraft ? '<span class="draft-tag">本机草稿</span>' : ''}</h3><p>${escapeHTML(event.date)} · ${escapeHTML(event.id)} · ${escapeHTML(event.platform)}</p><p>${escapeHTML(reviewReason(event))}</p></div><div class="review-value">${escapeHTML(fmt(event.rawAmountFen))}<small>原交易金额</small></div><button class="outline-button" data-event="${escapeHTML(event.id)}">核对这笔 ↗</button></article>`).join('') + (events.length > reviewLimit ? `<button id="review-more" class="review-more">继续查看 ${Math.min(30,events.length-reviewLimit)} 条 ↓</button>` : '') + (duplicates.length ? `<details class="duplicate-review" open><summary>重复关系待核对 · ${duplicates.length} 条（不追加合计）</summary><p class="footnote">这些记录可能与已有付款为同一消费；仅展示证据，核实前不会再次计费。</p>${duplicates.map(transactionRow).join('')}</details>` : '');
}

function renderPrepaid() {
  const hasRent = filtered.some((event) => event.kind === 'rent' || event.id.startsWith('RENT') || event.purposeL2?.includes('房租'));
  const eligible=selectEvents({...data,events:effectiveEvents},{...state,mode:'payment'});
  const hasStored = eligible.some((event) => ['A94','A172'].includes(event.id));
  let html = '';
  if (hasRent && data.rent) {
    const r = data.rent;
    html += `<article class="prepaid-card"><div class="prepaid-top"><div><p class="eyebrow">已确认 · 家庭住房</p><h3>一笔付款，按服务日期展开</h3><p>2026.09.10 · 两条付款关联为一个租金及押金组</p></div><strong>${escapeHTML(fmt(r.paidFen))}</strong></div><div class="component-line"><div><span>跨期预付租金</span><strong>${escapeHTML(fmt(r.rentFen))}</strong></div><div><span>押金 · 不计费用</span><strong>${escapeHTML(fmt(r.depositFen))}</strong></div><div><span>未分配尾差</span><strong>${escapeHTML(fmt(r.roundingFen))}</strong></div></div><div class="allocation-track"><div class="allocation-month"><span>09 月账期</span><strong>¥ 0.00</strong><small>本次付款对应服务尚未开始；不代表本期其他房租为零。</small></div>${r.allocations.map((a) => `<div class="allocation-month"><span>${escapeHTML(a.period.slice(-2))} 月账期</span><strong>${escapeHTML(fmt(a.amountFen))}</strong><small>${escapeHTML(a.note || '仅本次已付租金的已知分摊')}</small></div>`).join('')}</div><p class="footnote">服务日期：9 月 27—30 日及 10 月 1—31 日。按自然月实际天数映射到账期，最后一段承接分币尾差。押金与 0.13 元尾差不并入费用。</p></article>`;
  }
  if (hasStored && data.storedValue) {
    const s = data.storedValue;
    html += `<article class="prepaid-card"><div class="prepaid-top"><div><p class="eyebrow">储值与实际使用分开</p><h3>中石油储值</h3><p>充值不直接等于本期油费</p></div><strong>${escapeHTML(fmt(s.topupFen))}</strong></div><div class="component-line"><div><span>本次已知充值</span><strong>${escapeHTML(fmt(s.topupFen))}</strong></div><div><span>用户提供的余额</span><strong>${escapeHTML(fmt(s.balanceFen))}</strong></div><div><span>本期实际使用</span><strong>${escapeHTML(fmt(s.usageFen))}</strong></div></div><p class="footnote">${escapeHTML(s.note || '余额时点、期初余额及其他变动尚未核实，不能直接将充值与余额之差认定为本期费用。')}</p></article>`;
  }
  $('prepaid-content').innerHTML = html || empty('当前筛选未包含预付或储值记录','查看储值原付款可切换“付款记录”，并选择“全部归属”。未来月份仅展示已知租金分摊。');
}

function renderBudgets() {
  const period = currentPeriod();
  if(state.scope==='all'){$('budget-description').textContent='家庭生活和工作经营分别设置预算，避免重复计算。';$('budget-list').innerHTML=empty('请选择家庭生活或工作经营','顶部切换归属后，可按用途编辑预算。全部归属的已设置预算为各归属预算之和。');return;}
  $('budget-description').textContent = `${period.label} · ${scopeNames[state.scope]}。输入用途预算后自动保存。当前筛选范围内已明确费用用于差额参考，设置预算不会改动历史记录。`;
  const purposeSet = new Set(visiblePurposes());
  const names = !state.search && state.status === 'all' ? [...new Set([...categories,...purposeSet])] : [...purposeSet];
  const allExpenses=selectEvents({...data,events:effectiveEvents},{...state,mode:'expense'});
  const expenseEvents = allExpenses.filter((event) => event.expenseStatus === 'known');
  $('budget-list').innerHTML = `<div class="budget-head"><span>用途</span><span>已明确费用</span><span>本账期预算</span><span>已知费用后余额</span></div>` + names.map((name) => {
    const matches = expenseEvents.filter((event) => (event.purposeL1 || '用途待确认') === name);
    const isUncertain=allExpenses.some(e=>(e.purposeL1||'用途待确认')===name&&e.amountFen==null);
    const actual = matches.reduce((sum,event) => sum + (event.amountFen || 0),0);
    const budget = budgets[budgetKey(name)];
    return `<div class="budget-row"><span>${escapeHTML(name)}<small>${matches.length ? `${matches.length} 条已明确费用` : '本期费用资料可能未完整'}</small></span><span>${matches.length?escapeHTML(fmt(actual)):(isUncertain?'待核定':'暂无明确费用')}</span><label class="budget-input-wrap"><span>¥</span><input inputmode="decimal" type="text" data-budget="${escapeHTML(name)}" aria-label="${escapeHTML(name)}预算" value="${validBudget(budget) ? (budget/100).toFixed(2) : ''}" placeholder="未设置" maxlength="14"></label><span class="${validBudget(budget) && budget < actual ? 'over-budget' : ''}">${validBudget(budget) ? (isUncertain?'费用待齐':escapeHTML(fmt(budget-actual))) : '未设置'}</span></div>`;
  }).join('');
}

function renderMethodology() {
  const meta = data.meta;
  $('methodology-content').innerHTML = `<p class="methodology-counts"><strong>${meta.sourceCount}</strong> 份来源 · 保留 <strong>${meta.rawCount}</strong> 条原记录 · 本账期 <strong>${meta.periodRawCount}</strong> 条 · <strong>${meta.duplicateCount}</strong> 条重复来源证据仅用于核对 · 另 <strong>${meta.pendingDuplicateCount}</strong> 条重复关联待确认。</p><div class="methodology-grid"><div><h3>01 / 费用与付款</h3><p>明确本期费用只计已经核实受益期间的金额。未知期间、未知性质与未核定退款不会被包装成最终总额。</p><p>经营用途付款已确认 ${escapeHTML(fmt(meta.businessPaymentFen))}，本期费用仍待核定。原交易净额不等于现金流、收入或家庭费用。</p></div><div><h3>02 / 日期与来源</h3><p>账期为每月 18 日至次月 17 日。信用卡、借记卡采用记账日；微信、支付宝采用交易日。保留中国本地日期，不随设备时区转换。</p><p>每笔详情保留脱敏摘要、来源及页码或行号；同一支付的多份证据不重复计费。</p></div><div><h3>03 / 本机修改与隐私</h3><p>页面使用脱敏资料，不含原账单附件、完整账户或订单号。用途、归属、费用账期与预算草稿仅保存在当前浏览器，可导出备份。</p><p>本机保存不表示修改已上传或经过源账本确认。未设置预算与零预算分别展示。</p></div></div>`;
  $('footer-meta').textContent = `数据版本 ${data.version} · 仅供本账期核对 · 本机草稿独立保存`;
}

function render() {
  effectiveEvents = withDrafts();
  filtered = selectEvents({...data,events:effectiveEvents},state);
  document.querySelectorAll('[data-scope]').forEach((button) => button.setAttribute('aria-pressed',String(button.dataset.scope === state.scope)));
  document.querySelectorAll('[data-mode]').forEach((button) => button.setAttribute('aria-pressed',String(button.dataset.mode === state.mode)));
  document.querySelectorAll('[data-view]').forEach((button) => { if (button.dataset.view === state.view) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current'); });
  ['overview','review','prepaid','budget'].forEach((view) => { $(`${view}-panel`).hidden = state.view !== view; });
  $('period-select').value = state.period; $('status-select').value = state.status; $('dimension-select').value = state.dimension;
  renderOverview(); renderGroups(); renderReview(); renderPrepaid(); renderBudgets();
}

function showEvent(id) {
  const event = effectiveEvents.find((entry) => entry.id === id);
  if (!event) return;
  activeEvent = id;
  const original = data.events.find((entry) => entry.id === id);
  const refs = event.sourceRefs || [];
  const locked=['rent','duplicate_pending'].includes(event.kind);
  const knownExpense = Number.isSafeInteger(event.amountFen) ? fmt(event.amountFen) : '待核定';
  $('dialog-content').innerHTML = `<h2 id="dialog-title" class="detail-title">${escapeHTML(event.party || event.purposeL1 || '交易详情')}</h2><p class="detail-subtitle">${escapeHTML(event.id)} · ${escapeHTML(event.date)} · ${escapeHTML(eventStatus(event))}${event.localDraft ? ' · 尚未合并到来源账本' : ''}</p><div class="detail-amounts"><div><span>原交易金额</span><strong>${escapeHTML(fmt(event.rawAmountFen))}</strong></div><div><span>本期计入费用</span><strong>${escapeHTML(knownExpense)}</strong></div></div><dl class="detail-list"><dt>用途</dt><dd>${escapeHTML(event.purposeL1 || '用途待确认')} / ${escapeHTML(event.purposeL2 || '明细待确认')}</dd><dt>用途依据</dt><dd>${escapeHTML(event.purposeStatus==='user'?'用户已确认':event.purposeStatus==='local'?'本机修改草稿':event.purposeStatus==='source'?'来源线索建议，尚待核实':'待确认')}</dd><dt>归属</dt><dd>${escapeHTML(scopeNames[event.scope] || '待归属')}</dd><dt>支付渠道</dt><dd>${escapeHTML(event.platform || '未提供')} · ${escapeHTML(event.account || '账户未提供')}</dd><dt>资金性质</dt><dd>${escapeHTML(natureNames[event.kind] || event.kind || '待确认')}</dd><dt>原始摘要</dt><dd>${escapeHTML(event.description || '未提供可公开的摘要')}</dd><dt>日期口径</dt><dd>${escapeHTML(event.date)}${event.transactionDate && event.transactionDate !== event.date ? `（原交易日 ${escapeHTML(event.transactionDate)}）` : ''}</dd><dt>费用规律</dt><dd>${escapeHTML(event.frequency || '待判断')}</dd></dl>${event.note ? `<div class="detail-note">${escapeHTML(event.note)}</div>` : ''}${event.localDraft ? `<div class="detail-note">本机草稿已覆盖展示字段，原始来源仍保留。原确认用途：${escapeHTML(original.purposeL1 || '待确认')}；原本期金额：${escapeHTML(fmt(original.amountFen))}。${escapeHTML(event.localNote || '')}</div>` : ''}<h3 class="detail-section-title">关联来源 · ${refs.length} 条证据</h3>${refs.length ? refs.map((ref) => `<div class="source-evidence"><strong>${escapeHTML(ref.sourceLabel || '账本来源')} · ${escapeHTML(ref.code || '')}</strong><span>${ref.page ? `第 ${escapeHTML(ref.page)} 页` : ''}${ref.row ? ` · 第 ${escapeHTML(ref.row)} 行` : ''} · ${escapeHTML(ref.date || event.date)} · ${escapeHTML(fmt(ref.amountFen))}</span><small>${escapeHTML(ref.role || '来源记录')} · 仅展示脱敏定位，不公开原始附件</small></div>`).join('') : '<p class="muted">本条为已确认预付款的分摊明细，查看关联房租付款组。</p>'}<form id="edit-form" class="edit-form"><h3>保存一份本机确认草稿</h3><p>核对依据后修改。所有原付款和来源证据保持不变；保存仅作用于当前设备。</p><div class="form-grid"><label>归属主体<select name="scope">${Object.entries(scopeNames).filter(([key]) => key !== 'all').map(([key,label]) => `<option value="${key}" ${event.scope===key?'selected':''}>${label}</option>`).join('')}</select></label><label>费用账期<select name="period" ${locked?'disabled':''}>${data.periods.map((p) => `<option value="${escapeHTML(p.id)}" ${event.period === p.id ? 'selected' : ''}>${escapeHTML(p.label)}</option>`).join('')}</select></label><label>一级用途<input name="purposeL1" value="${escapeHTML(event.purposeL1 || '')}" maxlength="60" placeholder="用途待确认"></label><label>二级用途<input name="purposeL2" value="${escapeHTML(event.purposeL2 || '')}" maxlength="80" placeholder="具体用途"></label><label>本期计入金额（元）<input name="amount" ${locked?'disabled':''} inputmode="decimal" value="${Number.isSafeInteger(event.amountFen) ? (event.amountFen/100).toFixed(2) : ''}" placeholder="留空表示待确认" maxlength="14"></label><label>费用处理<select name="treatment" ${locked?'disabled':''}><option value="include" ${!event.excluded?'selected':''}>按所填金额计入 / 待确认</option><option value="exclude" ${event.excluded?'selected':''}>不计费用，保留原交易</option></select></label><label>预算调整空间<select name="necessity">${['待判断','必要','可调整'].map(v=>`<option ${event.necessity===v?'selected':''}>${v}</option>`).join('')}</select></label><label style="grid-column:1/-1">确认说明<input name="note" value="${escapeHTML(event.localNote || '')}" placeholder="如：服务日期、最终承担人、核对依据" maxlength="500"></label></div>${locked?'<p class="detail-note">房租关联组及疑似重复记录保持来源账本的金额与分摊，避免再次计费。此处可补充用途、归属和说明。</p>':''}<p id="form-error" class="form-error" role="alert"></p><div class="form-actions"><button type="submit" class="primary-button">保存本机草稿</button>${event.localDraft ? '<button id="restore-event" class="quiet-button" type="button">恢复来源记录</button>' : ''}</div></form>`;
  if (!$('event-dialog').open) $('event-dialog').showModal();
}

function saveEvent(form) {
  const fields = new FormData(form);
  try {
    const amountFen = parseMoney(fields.get('amount'),{allowNegative:true});
    const event = data.events.find((entry) => entry.id === activeEvent);
    const patch={...drafts[activeEvent],scope:fields.get('scope'),purposeL1:String(fields.get('purposeL1')).trim()||'用途待确认',purposeL2:String(fields.get('purposeL2')).trim()||'未细分',necessity:fields.get('necessity'),note:String(fields.get('note')).trim(),updatedAt:new Date().toISOString()};
    if(!['rent','duplicate_pending'].includes(event.kind))Object.assign(patch,{period:fields.get('period'),amountFen,excluded:fields.get('treatment')==='exclude'});
    const clean=validateLocalState({sourceVersion:data.version,drafts:{...drafts,[activeEvent]:patch},budgets},data);
    drafts=clean.drafts;

    const saved = persist(); render(); showEvent(activeEvent); notify(saved ? '已保存本机草稿，尚未上传或合并到来源账本。' : '修改暂存于当前页面，请导出草稿备份。');
  } catch (error) { $('form-error').textContent = error.message || '请检查金额，最多保留两位小数。'; }
}

function download(content,filename,type) {
  const url = URL.createObjectURL(new Blob([content],{type}));
  const anchor = document.createElement('a'); anchor.href=url; anchor.download=filename; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url),1000);
}

function exportDrafts() {
  if (!data) return;
  download(JSON.stringify({schemaVersion:1,sourceVersion:data.version,exportedAt:new Date().toISOString(),status:'local_draft_not_server_confirmed',drafts,budgets},null,2),`月度账本-本机草稿-${new Date().toISOString().slice(0,10)}.json`,'application/json;charset=utf-8');
  notify('已导出本机草稿；文件不代表来源账本已更新。');
}

function csvCell(value) {
  if(typeof value==='number'&&Number.isFinite(value))return String(value.toFixed(2));
  let text = String(value ?? '');
  if (/^[\s]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"','""')}"`;
}

function exportCSV() {
  const rows = [['编号','费用账期','日期','收款方（脱敏）','一级用途','二级用途','归属','原交易金额（元）','原交易带符号净额（元）','当前视图金额（元）','本期计入（元）','状态','渠道','账户','本机草稿']];
  for (const event of filtered) rows.push([event.id,event.period,event.date,event.party,event.purposeL1,event.purposeL2,scopeNames[event.scope],Number.isSafeInteger(event.rawAmountFen)?event.rawAmountFen/100:'',Number.isSafeInteger(event.referenceFen)?event.referenceFen/100:'',Number.isSafeInteger(state.mode==='payment'?event.referenceFen:event.amountFen)?(state.mode==='payment'?event.referenceFen:event.amountFen)/100:'',Number.isSafeInteger(event.amountFen)?event.amountFen/100:'',eventStatus(event),event.platform,event.account,event.localDraft?'是':'否']);
  download('\uFEFF'+rows.map((row) => row.map(csvCell).join(',')).join('\r\n'),`月度账本-${state.period}-${state.mode}-筛选明细.csv`,'text/csv;charset=utf-8');
  notify(`已导出当前筛选的 ${filtered.length} 条明细。`);
}

function bindEvents() {
  for(const [id,key] of [['date-from','dateFrom'],['date-to','dateTo']])$(id).addEventListener('change',e=>{state[key]=e.target.value;checkedReview.clear();render();});
  for(const [id,key] of [['min-amount','minFen'],['max-amount','maxFen']])$(id).addEventListener('change',e=>{try{state[key]=parseMoney(e.target.value,{allowNegative:true});e.target.removeAttribute('aria-invalid');checkedReview.clear();render();}catch(error){e.target.setAttribute('aria-invalid','true');notify(error.message);}});
  $('import-drafts').addEventListener('click',()=>$('draft-file').click());
  $('draft-file').addEventListener('change',async e=>{try{const file=e.target.files[0];if(!file)return;if(file.size>2000000)throw new Error('草稿文件过大');const clean=validateLocalState(JSON.parse(await file.text()),data);drafts={...drafts,...clean.drafts};budgets={...budgets,...clean.budgets};const saved=persist();render();notify(saved?'已合并导入本机草稿，同编号使用导入内容。':'草稿已载入当前页面，无法写入浏览器存储。');}catch(error){notify('未导入：'+error.message);}finally{e.target.value='';}});
  $('period-select').addEventListener('change',(event) => { state.period=event.target.value; state.dateFrom='';state.dateTo='';$('date-from').value='';$('date-to').value='';reviewLimit=30; checkedReview.clear(); render(); });
  $('status-select').addEventListener('change',(event) => { state.status=event.target.value; checkedReview.clear(); render(); });
  $('dimension-select').addEventListener('change',(event) => { state.dimension=event.target.value; renderGroups(); });
  $('search').addEventListener('input',(event) => { state.search=event.target.value; checkedReview.clear(); render(); });
  $('reset-filters').addEventListener('click',() => { state.search='';state.status='all';state.dateFrom='';state.dateTo='';state.minFen=null;state.maxFen=null;['search','date-from','date-to','min-amount','max-amount'].forEach(id=>$(id).value='');checkedReview.clear();render(); });
  $('scope-tabs').addEventListener('click',(event) => { const button=event.target.closest('[data-scope]');if(button){state.scope=button.dataset.scope;checkedReview.clear();render();} });
  $('mode-tabs').addEventListener('click',(event) => { const button=event.target.closest('[data-mode]');if(button){state.mode=button.dataset.mode;checkedReview.clear();render();} });
  $('view-tabs').addEventListener('click',(event) => { const button=event.target.closest('[data-view]');if(button){state.view=button.dataset.view;render();} });
  $('collapse-all').addEventListener('click',() => { $('group-list').querySelectorAll('details').forEach((detail) => {detail.open=false;}); });
  $('jump-methodology').addEventListener('click',() => { $('methodology').open=true;$('methodology').scrollIntoView({behavior:'smooth',block:'start'}); });
  $('export-csv').addEventListener('click',exportCSV);$('export-drafts').addEventListener('click',exportDrafts);
  $('close-dialog').addEventListener('click',() => $('event-dialog').close());
  $('event-dialog').addEventListener('click',(event) => { if(event.target === $('event-dialog')) { const bounds=$('event-dialog').getBoundingClientRect();if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)$('event-dialog').close(); } });
  $('dialog-content').addEventListener('submit',(event) => { if(event.target.id==='edit-form'){event.preventDefault();saveEvent(event.target);} });
  $('next-period').addEventListener('click',() => { const index=data.periods.findIndex((p)=>p.id===state.period);if(index < data.periods.length-1){state.period=data.periods[index+1].id;render();notify('已切换到下一账期，可填写用途预算。');}else notify('后续账期尚未建立，请先在当前账期安排预算。'); });
  $('budget-list').addEventListener('change',(event) => {
    const input=event.target.closest('[data-budget]');if(!input)return;
    try{const value=parseMoney(input.value);const key=budgetKey(input.dataset.budget);const next={...budgets};if(value===null)delete next[key];else next[key]=value;const clean=validateLocalState({sourceVersion:data.version,drafts,budgets:next},data);budgets=clean.budgets;const saved=persist();renderOverview();renderBudgets();notify(saved?(value===null?'已清除该用途预算。':'预算已保存在本机。'):'当前修改未能保存，请导出草稿。');}catch(error){input.setAttribute('aria-invalid','true');notify(error.message || '预算金额格式不正确。');input.focus();}
  });
  document.addEventListener('click',(event) => {
    const record=event.target.closest('[data-event]');if(record){showEvent(record.dataset.event);return;}
    if(event.target.id==='review-more'){reviewLimit+=30;renderReview();}
    if(event.target.id==='restore-event'){delete drafts[activeEvent];const saved=persist();render();showEvent(activeEvent);notify(saved?'已恢复来源账本的展示字段。':'仅在当前页面恢复，无法保存，请导出草稿。');}
    if(event.target.id==='clear-drafts'){drafts={};const saved=persist();render();notify(saved?'流水草稿已清除，预算设置保留。':'仅在当前页面清除，无法保存，请导出草稿。');}
    if(event.target.id==='apply-batch-scope'){
      const ids=[...checkedReview].filter((id)=>filtered.some((entry)=>entry.id===id));if(!ids.length){notify('请先勾选需要修改的记录。');return;}
      const scope=$('batch-scope').value;for(const id of ids)drafts[id]={...drafts[id],scope,updatedAt:new Date().toISOString()};const saved=persist();checkedReview.clear();render();notify(saved?`已保存 ${ids.length} 笔归属草稿，仅存在本机。`:'修改仅暂存当前页面，无法保存，请导出草稿。');
    }
  });
  $('review-list').addEventListener('change',(event)=>{
    if(event.target.matches('[data-check-event]')){if(event.target.checked)checkedReview.add(event.target.dataset.checkEvent);else checkedReview.delete(event.target.dataset.checkEvent);}
    if(event.target.id==='review-select-visible'){$('review-list').querySelectorAll('[data-check-event]').forEach((box)=>{box.checked=event.target.checked;if(box.checked)checkedReview.add(box.dataset.checkEvent);else checkedReview.delete(box.dataset.checkEvent);});}
  });
}

async function init() {
  try {
    const response = await fetch('./data.json',{cache:'no-cache'});
    if (!response.ok) throw new Error(`数据文件响应 ${response.status}`);
    data = await response.json();
    if (!data || !Array.isArray(data.events) || !Array.isArray(data.periods) || !data.periods.length || !data.meta) throw new Error('账本数据格式不完整');
    storageKey = `monthly-ledger:${data.version}:local-v1`;loadLocal();
    state.period = data.periods.some((period)=>period.id==='2026-09')?'2026-09':data.periods[0].id;
    $('period-select').innerHTML=data.periods.map((period)=>`<option value="${escapeHTML(period.id)}">${escapeHTML(period.label)}</option>`).join('');
    bindEvents();renderMethodology();render();$('loading').hidden=true;$('app').hidden=false;
  } catch(error) {
    $('loading').className='loading error-state';$('loading').innerHTML=`<h1>这份账本暂时未能打开</h1><p>请刷新页面重试。若从本地文件打开，请通过本地预览服务访问，以便载入账本数据。</p><p>${escapeHTML(error.message || '数据加载失败')}</p><button class="outline-button" id="reload-page">重新载入</button>`;$('reload-page').addEventListener('click',()=>location.reload());
  }
}
init();
