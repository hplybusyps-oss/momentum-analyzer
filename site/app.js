// 모멘텀 분석기 — 정적(GitHub Pages) 버전
// data.json(원시 일봉) + portfolio.json(종목·그룹) + settings.json(설정·레시피)을 읽어 브라우저에서 계산한다.
'use strict';

const REPO      = 'hplybusyps-oss/momentum-analyzer';
const BRANCH    = 'main';
const WORKFLOW  = 'deploy.yml';
const LS = { token: 'ma.token', portfolio: 'ma.portfolio', settings: 'ma.settings', ui: 'ma.ui' };

const WATCHLIST_CAT    = '관심종목';
const UNCLASSIFIED_CAT = '미분류';
const PROTECTED_CATS   = new Set(['전체', WATCHLIST_CAT, UNCLASSIFIED_CAT]);

// ── 컬럼 정의 ────────────────────────────────────────────────────────────────
const COLUMNS = [
  ['name', '종목명'], ['ticker', '티커'], ['rank', '랭킹'], ['score', '점수'],
  ['close', '최근 종가'], ['avg_momentum', '평균 모멘텀'], ['wgt_momentum', '가중 모멘텀'],
  ['abs_mom', '절대 모멘텀'], ['volatility', '변동성(연환산)'], ['overvol', '과변동성 필터'],
  ['rsm', 'RSM'], ['slope', '회귀 기울기'], ['r_squared', '기울기 신뢰도(R²)'],
  ['rel_vol', '상대 거래량'], ['high52w', '52주 근접도'], ['rsi', 'RSI'],
  ['macd_hist', 'MACD 히스토그램'], ['bb_pct', '볼린저 %B'],
];
const COL_KEYS = COLUMNS.map(c => c[0]);
const PINNED   = ['chk', 'name', 'ticker', 'rank', 'score'];
const DATA_INSUFFICIENT_KEYS = new Set([
  'avg_momentum', 'wgt_momentum', 'abs_mom', 'volatility', 'overvol',
  'rsm', 'slope', 'r_squared', 'rel_vol', 'high52w', 'rsi', 'macd_hist', 'bb_pct',
]);

const RANKING_INDICATORS = [
  ['avg_momentum', '평균 모멘텀'], ['wgt_momentum', '가중 모멘텀'], ['abs_mom', '절대 모멘텀'],
  ['volatility', '변동성'], ['overvol', '과변동성 필터'], ['rsm', 'RSM'], ['slope', '회귀 기울기'],
  ['r_squared', '기울기 신뢰도'], ['rel_vol', '상대 거래량'], ['high52w', '52주 근접도'],
  ['rsi', 'RSI'], ['macd_hist', 'MACD 히스토그램'], ['bb_pct', '볼린저 %B'],
];
const IND_KEY_TO_LBL = Object.fromEntries(RANKING_INDICATORS);
const IND_LBL_TO_KEY = Object.fromEntries(RANKING_INDICATORS.map(([k, l]) => [l, k]));
const FORMULA_LABELS = RANKING_INDICATORS.filter(([k]) => k !== 'overvol').map(([, l]) => l);
const FORMULA_OPS    = [['+', '+'], ['-', '-'], ['*', '×'], ['/', '÷']];

function colLabel(key) {
  const cfg = S.settings;
  if (key === 'abs_mom') return `절대 모멘텀(${cfg.Momentum.period_12m}M)`;
  if (key === 'rsm')     return `RSM(${cfg.RSM.period}M)`;
  if (key === 'rsi')     return `RSI(${cfg.Technical.rsi_period}일)`;
  return COLUMNS.find(c => c[0] === key)[1];
}

function colHelp(key) {
  const m = S.settings.Momentum, v = S.settings.Volatility, r = S.settings.RSM, t = S.settings.Technical;
  return {
    rank:         '레시피 점수 기준 순위',
    score:        '레시피 가중합 점수 (0~100)',
    close:        '가장 최근 거래일 종가\n한국: 미조정 주가 / 미국: 배당·분할 반영 수정주가',
    avg_momentum: `${m.period_1m}M·${m.period_3m}M·${m.period_6m}M·${m.period_12m}M 수익률 단순 평균\n= (R₁ + R₂ + R₃ + R₄) / 4`,
    wgt_momentum: `단기 비중을 높인 가중 평균\n= R${m.period_1m}M×${m.weight_1m} + R${m.period_3m}M×${m.weight_3m} + R${m.period_6m}M×${m.weight_6m} + R${m.period_12m}M×${m.weight_12m}`,
    abs_mom:      `${m.period_12m}개월 전 종가 대비 현재 수익률\n= (현재가 / ${m.period_12m}개월 전 가격) − 1`,
    volatility:   `최근 ${v.vol_period}개월 일간 수익률의 표준편차 × √252 (연환산)\n낮을수록 해당 기간 동안 가격 흐름이 안정적`,
    overvol:      `장기(${v.filter_long}개월) 구간의 ${v.filter_short}개월 롤링 변동성 시계열 평균 + ${v.filter_sigma}σ 를\n최근 ${v.filter_short}개월 변동성이 초과하면 "발동"\n즉, 최근 변동성이 과거 분포 기준 통계적 이상치일 때 발동`,
    rsm:          `상대 강도 모멘텀 — ${r.period}개월 기준 벤치마크 대비 초과 수익률\n= (1 + R_종목) / (1 + R_벤치마크) − 1\n벤치마크: 한국 ${r.benchmark_kr} / 미국 ${r.benchmark_us}`,
    slope:        `최근 ${t.slope_period}개월 주가에 로그 선형 회귀를 적합한 뒤\n기울기를 연환산(×252×100)한 값 (%)\n양수일수록 해당 기간 동안 꾸준한 우상향 추세`,
    r_squared:    '회귀 기울기와 같은 기간의 결정계수 (0~1)\n1에 가까울수록 주가가 추세선에 밀착 — 추세가 일관됨\n0에 가까우면 기울기 값이 있어도 노이즈가 많음',
    rel_vol:      `전일 거래량 / 최근 ${t.rel_vol_period}개월 평균 거래량\n1.0 = 평균, 2.0 = 평균의 2배`,
    high52w:      `최근 ${t.high_period}개월 최고가 대비 현재가 위치\n= (현재가 / 최고가) − 1\n0에 가까울수록 신고가 근처`,
    rsi:          `${t.rsi_period}일 상대강도지수 (0~100)\n70 이상 과매수 · 30 이하 과매도`,
    macd_hist:    `MACD선(EMA${t.macd_fast}−EMA${t.macd_slow})과 시그널선(EMA${t.macd_signal})의 차이\n양수 → 상승 모멘텀 강화, 음수 → 약화`,
    bb_pct:       `볼린저 밴드(${t.bb_period}일, ${t.bb_std}σ) 내 현재가 위치\n= (현재가 − 하단) / (상단 − 하단)\n0 = 하단, 0.5 = 중심, 1.0 = 상단`,
  }[key] || '';
}

// ── 상태 ─────────────────────────────────────────────────────────────────────
const S = {
  data: null, series: {}, ind: {},
  portfolio: null, settings: null,
  ui: { main: 'analysis', cat: '전체', sort: {}, selected: new Set(), chart: null, setTab: 0, recipeSel: null },
};

const $  = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = o => JSON.parse(JSON.stringify(o));

function lsGet(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 저장소 차단 시 무시 */ } }
function lsDel(k) { try { localStorage.removeItem(k); } catch { /* 무시 */ } }
function getToken() { try { return localStorage.getItem(LS.token) || ''; } catch { return ''; } }

let statusTimer = null;
function setStatus(msg, kind = '') {
  const el = $('#status');
  if (!el) return;
  el.textContent = msg ? `ℹ️ ${msg}` : '';
  el.className = 'status ' + kind;
  clearTimeout(statusTimer);
  if (msg && !kind) statusTimer = setTimeout(() => { el.textContent = ''; }, 8000);
}

// ── GitHub API ───────────────────────────────────────────────────────────────
async function gh(path, opts = {}) {
  const headers = {
    Authorization: `Bearer ${getToken()}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const r = await fetch(`https://api.github.com/repos/${REPO}${path}`, { cache: 'no-store', ...opts, headers });
  if (!r.ok) {
    let msg = String(r.status);
    try { msg += ' ' + (await r.json()).message; } catch { /* 본문 없음 */ }
    throw new Error(msg);
  }
  return r.status === 204 ? null : r.json();
}

function b64(text) {
  let bin = '';
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function ghPutFile(file, text, message) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let sha;
    try { sha = (await gh(`/contents/${file}?ref=${BRANCH}`)).sha; }
    catch (e) { if (!e.message.startsWith('404')) throw e; }
    try {
      return await gh(`/contents/${file}`, {
        method: 'PUT',
        body: JSON.stringify({ message, content: b64(text), sha, branch: BRANCH }),
      });
    } catch (e) {
      if (attempt === 0 && /^(409|422)/.test(e.message)) continue;   // sha 충돌 → 재시도
      throw e;
    }
  }
}

// 저장 요청은 순서대로 처리 (sha 충돌 방지)
let saveChain = Promise.resolve();
function persist(kind, what) {
  const obj = kind === 'portfolio' ? S.portfolio : S.settings;
  obj.updated_at = Date.now();
  lsSet(LS[kind], obj);
  if (!getToken()) {
    setStatus(`${what} — 이 브라우저에만 저장됨`, 'warn');
    return Promise.resolve(false);
  }
  const text = JSON.stringify(obj, null, 2) + '\n';
  saveChain = saveChain.then(async () => {
    try {
      await ghPutFile(`${kind}.json`, text, `${what} (${kind}.json)`);
      setStatus(`${what} — GitHub 저장 완료`);
      return true;
    } catch (e) {
      setStatus(`GitHub 저장 실패: ${e.message}`, 'err');
      return false;
    }
  });
  return saveChain;
}

async function triggerRefresh() {
  if (!getToken()) { setStatus('데이터 갱신은 이 브라우저에서 사용할 수 없습니다', 'warn'); return; }
  try {
    await gh(`/actions/workflows/${WORKFLOW}/dispatches`, { method: 'POST', body: JSON.stringify({ ref: BRANCH }) });
    setStatus('데이터 갱신 시작 — 약 2~3분 뒤 페이지를 새로고침하세요');
  } catch (e) {
    setStatus(`데이터 갱신 실패: ${e.message}`, 'err');
  }
}

// ── 데이터 로드 / 계산 ───────────────────────────────────────────────────────
async function fetchJSON(path) {
  const r = await fetch(`${path}?v=${Date.now()}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}

function newer(remote, local) {
  if (local && (!remote || (local.updated_at || 0) > (remote.updated_at || 0))) return local;
  return remote;
}

function normalizePortfolio(p) {
  p.watchlist     = p.watchlist || [];
  p.all_tickers   = p.all_tickers || [];
  p.categories    = p.categories || {};
  p.group_recipes = p.group_recipes || {};
  if (!p.categories[WATCHLIST_CAT]) p.categories[WATCHLIST_CAT] = [...p.watchlist];
  return p;
}

function recompute() {
  const calc  = new IndicatorCalculator(S.settings);
  const bKr   = S.series[S.settings.RSM.benchmark_kr];
  const bUs   = S.series[S.settings.RSM.benchmark_us];
  S.ind = {};
  for (const t of S.portfolio.all_tickers) {
    const s = S.series[t];
    if (!s) continue;
    try { S.ind[t] = calc.calculateAll(s, S.data.tickers[t].kr ? bKr : bUs); }
    catch (e) { console.error(t, e); }
  }
}

// ── 점수 / 랭킹 (app.py calculate_scores 와 동일) ─────────────────────────────
function activeRecipeIdx(cat) {
  const list = S.settings.recipes.list;
  const g = S.portfolio.group_recipes[cat];
  if (g !== undefined && g >= 0 && g < list.length) return g;
  return Math.max(0, Math.min(S.settings.recipes.active || 0, list.length - 1));
}

function parseFormula(expr) {
  const labels = [...FORMULA_LABELS].sort((a, b) => b.length - a.length);
  for (const [op] of [['/'], ['*'], ['+'], ['-']]) {
    for (const a of labels) for (const b of labels) {
      if (expr.trim() === `${a} ${op} ${b}`) return [a, op, b];
    }
  }
  return null;
}

function evalFormula(expr, ind) {
  const p = parseFormula(expr);
  if (!p) return null;
  const val = l => { const v = ind[IND_LBL_TO_KEY[l]]; return v === null || v === undefined ? NaN : Number(v); };
  const a = val(p[0]), b = val(p[2]);
  const r = p[1] === '+' ? a + b : p[1] === '-' ? a - b : p[1] === '*' ? a * b : a / b;
  return Number.isFinite(r) ? r : null;
}

function calculateScores(tickers, cat) {
  const list = S.settings.recipes.list;
  if (!list.length) return {};
  const recipe = list[activeRecipeIdx(cat)];
  if (!recipe || !recipe.items.length) return {};
  const tk = tickers.filter(t => S.ind[t]);
  const n = tk.length;
  if (!n) return {};

  const excluded = new Array(n).fill(false);
  for (const [fk, op, fv] of recipe.filters || []) {
    if (!COL_KEYS.includes(fk)) continue;
    tk.forEach((t, i) => {
      let v = S.ind[t][fk];
      if (v === null || v === undefined) return;
      v = Number(v);
      if ((op === '<' && v < fv) || (op === '>' && v > fv)) excluded[i] = true;
    });
  }

  const raw = {};
  for (const [key] of recipe.items) {
    if (key.startsWith('formula:')) raw[key] = tk.map(t => evalFormula(key.slice(8), S.ind[t]));
    else if (COL_KEYS.includes(key)) raw[key] = tk.map(t => { const v = S.ind[t][key]; return v === undefined ? null : (typeof v === 'boolean' ? Number(v) : v); });
  }
  const valid = recipe.items.filter(([k]) => k in raw);
  const totalW = valid.reduce((s, [, w]) => s + w, 0) || 1;

  const noData = new Set();
  for (let i = 0; i < n; i++) {
    if (!excluded[i] && valid.length && valid.some(([k]) => raw[k][i] === null)) noData.add(i);
  }

  const scores = new Array(n).fill(0);
  for (const [key, w, dir] of valid) {
    const pairs = raw[key].map((v, i) => [i, v]).filter(([i, v]) => v !== null && !excluded[i] && !noData.has(i));
    if (!pairs.length) continue;
    const nv = pairs.length;
    pairs.sort((a, b) => a[1] - b[1]).forEach(([i], pos) => {
      const pct = nv > 1 ? pos / (nv - 1) * 100 : 50;
      scores[i] += (dir === '-' ? 100 - pct : pct) * (w / totalW);
    });
  }

  const ranked = [];
  for (let i = 0; i < n; i++) if (!excluded[i] && !noData.has(i)) ranked.push([i, scores[i]]);
  const ranks = new Array(n).fill(null);
  ranked.sort((a, b) => b[1] - a[1]).forEach(([i], pos) => { ranks[i] = pos + 1; });

  const out = {};
  tk.forEach((t, i) => {
    const ex = excluded[i] || noData.has(i);
    out[t] = { score: ex ? null : scores[i], rank: ranks[i], excluded: ex };
  });
  return out;
}

// ── 표시 포맷 / 스타일 (app.py _fmt_display / style_df 와 동일) ───────────────
const sgn = v => (v >= 0 ? '+' : '');
const fmtNum = (v, d) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

function fmtVal(key, v, kr) {
  if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) {
    return DATA_INSUFFICIENT_KEYS.has(key) ? '데이터부족' : '-';
  }
  if (typeof v === 'string') return v;
  switch (key) {
    case 'rank':   return `#${v}`;
    case 'score':  return v.toFixed(1);
    case 'close':  return kr ? (v >= 100 ? fmtNum(v, 0) : v.toFixed(4)) : fmtNum(v, 2);
    case 'avg_momentum': case 'wgt_momentum': case 'abs_mom': case 'rsm': case 'high52w':
      return `${sgn(v)}${(v * 100).toFixed(1)}%`;
    case 'volatility': return `${(v * 100).toFixed(1)}%`;
    case 'slope':      return `${sgn(v)}${v.toFixed(1)}%`;
    case 'r_squared':  return v.toFixed(2);
    case 'rel_vol':    return `${v.toFixed(2)}x`;
    case 'rsi':        return v.toFixed(1);
    case 'macd_hist':  return `${sgn(v)}${v.toFixed(5)}`;
    case 'bb_pct':     return v.toFixed(2);
  }
  return String(v);
}

function cellClass(key, v) {
  if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return 'c-gray';
  if (typeof v === 'string') {
    if (v === '-' || v === '데이터부족' || v === '제외') return 'c-gray';
    return key === 'overvol' && v === '발동' ? 'ov-on' : '';
  }
  if (['avg_momentum', 'wgt_momentum', 'abs_mom', 'rsm', 'slope', 'macd_hist'].includes(key)) return v >= 0 ? 'c-pos' : 'c-neg';
  if (key === 'high52w') return v > -0.05 ? 'c-pos' : '';
  if (key === 'rsi')   return v >= 70 ? 'bg-bad' : v <= 30 ? 'bg-cold' : '';
  if (key === 'score') return v >= 70 ? 'bg-good' : v <= 30 ? 'bg-bad' : '';
  return '';
}

// ── 테이블 데이터 ────────────────────────────────────────────────────────────
function visibleTickers(cat) {
  const P = S.portfolio, all = P.all_tickers;
  if (cat === '전체') return all;
  if (cat === UNCLASSIFIED_CAT) {
    const inCat = new Set(Object.values(P.categories).flat());
    return all.filter(t => !inCat.has(t));
  }
  const lst = new Set(P.categories[cat] || []);
  return all.filter(t => lst.has(t));
}

function buildRows(cat) {
  const vis = visibleTickers(cat);
  const sc = calculateScores(vis, cat);
  const wl = new Set(S.portfolio.watchlist);
  return vis.map((t, order) => {
    const d = S.ind[t], rec = S.data.tickers[t];
    const kr = rec ? rec.kr : /^\d[0-9A-Z]{5}$/.test(t);
    let name = rec ? rec.name : '(데이터 수집 대기)';
    if (wl.has(t)) name = `★ ${name}`;
    const row = { _t: t, _kr: kr, _order: order, _pending: !d, name, ticker: t,
                  rank: sc[t]?.rank ?? null, score: sc[t]?.score ?? null };
    for (const k of COL_KEYS.slice(4)) row[k] = d ? d[k] : null;
    row.overvol = d && d.overvol !== null && d.overvol !== undefined ? (d.overvol ? '발동' : '정상') : '-';
    return row;
  });
}

function sortRows(rows, cat) {
  const s = S.ui.sort[cat];
  const key = s ? s.key : (PROTECTED_CATS.has(cat) ? null : 'rank');
  const dir = s ? s.dir : 1;
  if (!key) return rows;
  const val = r => {
    const v = r[key];
    if (v === null || v === undefined || v === '-' || (typeof v === 'number' && !Number.isFinite(v))) return null;
    return v;
  };
  return [...rows].sort((a, b) => {
    const va = val(a), vb = val(b);
    if (va === null && vb === null) return a._order - b._order;
    if (va === null) return 1;            // 값 없는 행은 정렬 방향과 무관하게 항상 맨 아래
    if (vb === null) return -1;
    const c = typeof va === 'string' ? va.localeCompare(vb, 'ko') : va - vb;
    return c !== 0 ? c * dir : a._order - b._order;
  });
}

// ── 분석 탭 ──────────────────────────────────────────────────────────────────
function renderAnalysisShell() {
  $('#analysis').innerHTML = `
    <div class="toolbar">
      <input type="text" id="tickerIn" placeholder="티커 예: 069500, SPY" autocomplete="off">
      <button class="b primary" data-act="add">조회·추가</button>
      <button class="b" data-act="watch">★ 관심추가</button>
      <button class="b" data-act="unwatch">☆ 관심삭제</button>
      <span class="sep"></span>
      <button class="b" data-act="refresh" title="GitHub Actions 로 지금 바로 데이터를 다시 수집합니다">↻ 데이터 갱신</button>
      <button class="b" data-act="delsel">선택 삭제</button>
      <button class="b danger" data-act="clear">전체 삭제</button>
      <span class="sep"></span>
      <button class="b" data-act="csv">CSV 내보내기</button>
    </div>
    <div id="status" class="status"></div>
    <div id="notices"></div>
    <div class="tabs" id="catTabs"></div>
    <div id="groupTools" class="grouptools"></div>
    <div class="split" id="split">
      <div id="tblBox" style="min-width:0"></div>
      <div id="chartBox" class="chart-card" hidden>
        <div class="chart-head">
          <button class="x" data-act="closechart" title="차트 닫기">✕</button>
          <h4 id="chartTitle"></h4><span class="sub" id="chartSub"></span>
        </div>
        <div id="chart"></div>
      </div>
    </div>`;
  $('#tickerIn').addEventListener('keydown', e => { if (e.key === 'Enter') onAction('add'); });
  $('#analysis').addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (b) onAction(b.dataset.act, b);
  });
}

function renderNotices() {
  const out = [];
  const pending = S.portfolio.all_tickers.filter(t => !S.data.tickers[t]);
  const errs = S.data.errors || {};
  const waiting = pending.filter(t => !errs[t]);
  const failed = pending.filter(t => errs[t]);
  if (waiting.length) {
    out.push(`<div class="notice info">데이터 수집 대기: <b>${esc(waiting.join(', '))}</b> — ${getToken()
      ? 'GitHub 에 저장되면 자동 수집됩니다 (2~3분 뒤 새로고침)'
      : '이 브라우저에서는 데이터 수집을 요청할 수 없습니다'}</div>`);
  }
  if (failed.length) out.push(`<div class="notice">수집 실패 (티커 확인 필요): <b>${esc(failed.join(', '))}</b></div>`);
  if ((S.data.stale || []).length) out.push(`<div class="notice">이번 갱신 실패로 이전 데이터 표시 중: ${esc(S.data.stale.join(', '))}</div>`);
  $('#notices').innerHTML = out.join('');
}

function allCats() {
  const user = Object.keys(S.portfolio.categories).filter(c => !PROTECTED_CATS.has(c));
  return ['전체', UNCLASSIFIED_CAT, WATCHLIST_CAT, ...user];
}

function renderCatTabs() {
  const cats = allCats();
  if (!cats.includes(S.ui.cat)) S.ui.cat = '전체';
  $('#catTabs').innerHTML = cats.map(c =>
    `<button data-cat="${esc(c)}" class="${c === S.ui.cat ? 'on' : ''}">${esc(c)}<span class="count">${visibleTickers(c).length}</span></button>`
  ).join('');
  $('#catTabs').onclick = e => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    S.ui.cat = b.dataset.cat;
    saveUi();
    renderCatTabs(); renderGroupTools(); renderTable();
  };
}

function renderGroupTools() {
  const cat = S.ui.cat, box = $('#groupTools');
  if (cat === '전체') {
    box.innerHTML = `<button class="b" data-act="newgroup">+ 새 그룹 추가</button>`;
    return;
  }
  if (PROTECTED_CATS.has(cat)) { box.innerHTML = ''; return; }
  const list = S.settings.recipes.list;
  const cur = activeRecipeIdx(cat);
  box.innerHTML = `
    <button class="b" data-act="grpadd" title="다른 탭에서 체크한 종목을 이 그룹에 추가">→ 그룹에 추가</button>
    <button class="b" data-act="grprm">← 그룹에서 제거</button>
    <button class="b" data-act="grprename">✏ 이름변경</button>
    <button class="b danger" data-act="grpdel">× 그룹삭제</button>
    <span class="sep"></span>
    <label>이 그룹 레시피
      <select id="grpRecipe">${list.map((r, i) => `<option value="${i}" ${i === cur ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>
    </label>`;
  $('#grpRecipe').onchange = e => {
    S.portfolio.group_recipes[cat] = +e.target.value;
    persist('portfolio', `[${cat}] 레시피 변경`);
    renderTable();
  };
}

function renderTable() {
  const cat = S.ui.cat;
  const rows = sortRows(buildRows(cat), cat);
  const box = $('#tblBox');
  if (!rows.length) {
    box.innerHTML = `<div class="empty">이 탭에 종목이 없습니다. 티커를 입력해 추가하세요.</div>`;
    return;
  }
  const s = S.ui.sort[cat];
  const allSel = rows.every(r => S.ui.selected.has(r._t));
  const head = `<th class="chk pin" data-col="chk"><input type="checkbox" id="selAll" ${allSel ? 'checked' : ''} title="전체 선택"></th>` +
    COLUMNS.map(([k]) => {
      const help = colHelp(k);
      const arrow = s && s.key === k ? `<span class="arrow">${s.dir === 1 ? '▲' : '▼'}</span>` : '';
      return `<th data-col="${k}" data-sort="${k}" class="${PINNED.includes(k) ? 'pin' : ''} ${help ? 'help' : ''}" ${help ? `data-help="${esc(help)}"` : ''}>${esc(colLabel(k))}${arrow}</th>`;
    }).join('');
  const body = rows.map(r => {
    const tds = COLUMNS.map(([k]) => {
      const v = r[k];
      let txt, cls;
      if (k === 'name' || k === 'ticker') { txt = v; cls = k === 'name' ? 'name' : ''; }
      else if (r._pending) { txt = '-'; cls = 'c-gray'; }
      else { txt = fmtVal(k, v, r._kr); cls = cellClass(k, v); }
      if (PINNED.includes(k)) cls += ' pin';
      return `<td data-col="${k}" class="${cls}"${k === 'name' ? ` title="${esc(v)}"` : ''}>${esc(txt)}</td>`;
    }).join('');
    const cls = [S.ui.selected.has(r._t) ? 'sel' : '', S.ui.chart === r._t ? 'charted' : ''].join(' ');
    return `<tr data-t="${esc(r._t)}" class="${cls}"><td class="chk pin" data-col="chk"><input type="checkbox" ${S.ui.selected.has(r._t) ? 'checked' : ''}></td>${tds}</tr>`;
  }).join('');
  box.innerHTML = `<div class="tbl-wrap"><table class="grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
    <div class="caption">행 클릭 → 차트 · 체크박스 → 선택 · 머리글 클릭 → 정렬(▲ → ▼ → 기본) · 값 없는 종목은 항상 맨 아래</div>`;
  pinColumns(box.querySelector('table'));

  const table = box.querySelector('table');
  table.querySelector('thead').onclick = e => {
    if (e.target.id === 'selAll') {
      rows.forEach(r => e.target.checked ? S.ui.selected.add(r._t) : S.ui.selected.delete(r._t));
      renderTable();
      return;
    }
    const th = e.target.closest('[data-sort]');
    if (!th) return;
    const k = th.dataset.sort, cur = S.ui.sort[cat];
    if (!cur || cur.key !== k) S.ui.sort[cat] = { key: k, dir: k === 'rank' ? 1 : -1 };
    else if (cur.dir === (k === 'rank' ? 1 : -1)) cur.dir = -cur.dir;
    else delete S.ui.sort[cat];
    renderTable();
  };
  table.querySelector('tbody').onclick = e => {
    const tr = e.target.closest('tr[data-t]');
    if (!tr) return;
    const t = tr.dataset.t;
    if (e.target.closest('td.chk')) {
      if (e.target.tagName !== 'INPUT') return;
      e.target.checked ? S.ui.selected.add(t) : S.ui.selected.delete(t);
      tr.classList.toggle('sel', e.target.checked);
      return;
    }
    if (!S.series[t]) { setStatus(`${t}: 아직 데이터가 없습니다`, 'warn'); return; }
    S.ui.chart = S.ui.chart === t ? null : t;
    renderTable(); renderChart();
  };
  bindTips(table);
}

function pinColumns(table) {
  const ths = [...table.querySelectorAll('thead th.pin')];
  let left = 0;
  const offsets = {};
  ths.forEach((th, i) => {
    offsets[th.dataset.col] = left;
    left += th.getBoundingClientRect().width;
    if (i === ths.length - 1) th.classList.add('last');
  });
  // 좁은 화면에서는 고정 열이 화면을 다 차지하지 않도록 이름·티커까지만 고정
  const narrow = table.parentElement.clientWidth < 700;
  table.querySelectorAll('.pin').forEach(el => {
    const col = el.dataset.col;
    if (narrow && (col === 'rank' || col === 'score')) { el.classList.remove('pin'); return; }
    el.style.left = offsets[col] + 'px';
    if (narrow && col === 'ticker') el.classList.add('last');
    else if (col === 'score') el.classList.add('last');
    else el.classList.remove('last');
  });
}

function bindTips(root) {
  const tip = $('#tip');
  root.querySelectorAll('[data-help]').forEach(el => {
    el.onmouseenter = () => {
      tip.textContent = el.dataset.help;
      tip.style.display = 'block';
      const r = el.getBoundingClientRect(), w = tip.offsetWidth;
      tip.style.left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8)) + 'px';
      tip.style.top = (r.bottom + 6) + 'px';
    };
    el.onmouseleave = () => { tip.style.display = 'none'; };
  });
}

function renderMeta() {
  const n = S.portfolio.all_tickers.length;
  $('#meta').textContent = `데이터 기준 ${S.data.generated_at} KST · 종목 ${n}개`;
}

function rerenderAll() {
  recompute();
  renderMeta(); renderNotices(); renderCatTabs(); renderGroupTools(); renderTable(); renderChart();
}

// ── 분석 탭 동작 ─────────────────────────────────────────────────────────────
function addToWatch(t) {
  const P = S.portfolio;
  if (!P.watchlist.includes(t)) P.watchlist.push(t);
  const wl = P.categories[WATCHLIST_CAT] || (P.categories[WATCHLIST_CAT] = []);
  if (!wl.includes(t)) wl.push(t);
}

function onAction(act) {
  const P = S.portfolio, cat = S.ui.cat;
  const input = $('#tickerIn');
  const typed = (input?.value || '').trim().toUpperCase();
  const sel = [...S.ui.selected].filter(t => P.all_tickers.includes(t));

  switch (act) {
    case 'add': {
      if (!typed) return;
      input.value = '';
      if (P.all_tickers.includes(typed)) { setStatus(`${typed} 은(는) 이미 목록에 있습니다`); return; }
      P.all_tickers.unshift(typed);
      if (!PROTECTED_CATS.has(cat)) (P.categories[cat] = P.categories[cat] || []).push(typed);
      persist('portfolio', `${typed} 추가`);
      rerenderAll();
      return;
    }
    case 'watch': {
      const targets = [...sel, ...(typed ? [typed] : [])].filter(t => !P.watchlist.includes(t));
      if (!targets.length) { setStatus('이미 관심종목에 있거나 종목을 선택/입력하세요'); return; }
      targets.forEach(t => { if (!P.all_tickers.includes(t)) P.all_tickers.unshift(t); addToWatch(t); });
      if (input) input.value = '';
      persist('portfolio', `★ ${targets.join(', ')} 관심종목 추가`);
      rerenderAll();
      return;
    }
    case 'unwatch': {
      const targets = [...sel, ...(typed ? [typed] : [])].filter(t => P.watchlist.includes(t));
      if (!targets.length) { setStatus('관심종목에 없는 종목입니다'); return; }
      P.watchlist = P.watchlist.filter(t => !targets.includes(t));
      P.categories[WATCHLIST_CAT] = (P.categories[WATCHLIST_CAT] || []).filter(t => !targets.includes(t));
      if (input) input.value = '';
      persist('portfolio', `☆ ${targets.join(', ')} 관심종목 삭제`);
      rerenderAll();
      return;
    }
    case 'refresh': triggerRefresh(); return;
    case 'delsel': {
      if (!sel.length) { setStatus('삭제할 종목을 체크하세요'); return; }
      if (!confirm(`${sel.length}개 종목을 삭제할까요?\n${sel.join(', ')}`)) return;
      const del = new Set(sel);
      P.all_tickers = P.all_tickers.filter(t => !del.has(t));
      P.watchlist = P.watchlist.filter(t => !del.has(t));
      for (const c of Object.keys(P.categories)) P.categories[c] = P.categories[c].filter(t => !del.has(t));
      sel.forEach(t => S.ui.selected.delete(t));
      if (del.has(S.ui.chart)) S.ui.chart = null;
      persist('portfolio', `${sel.length}개 종목 삭제`);
      rerenderAll();
      return;
    }
    case 'clear': {
      if (!confirm('모든 종목을 삭제할까요? 그룹 정의는 유지됩니다.')) return;
      P.all_tickers = []; P.watchlist = [];
      for (const c of Object.keys(P.categories)) P.categories[c] = [];
      S.ui.selected.clear(); S.ui.chart = null;
      persist('portfolio', '전체 삭제');
      rerenderAll();
      return;
    }
    case 'csv': exportCsv(); return;
    case 'closechart': S.ui.chart = null; renderTable(); renderChart(); return;
    case 'newgroup': {
      const name = (prompt('새 그룹 이름') || '').trim();
      if (!name) return;
      if (P.categories[name] || PROTECTED_CATS.has(name)) { alert('이미 존재하는 그룹명입니다'); return; }
      P.categories[name] = [];
      S.ui.cat = name;
      persist('portfolio', `'${name}' 그룹 추가`);
      renderCatTabs(); renderGroupTools(); renderTable();
      return;
    }
    case 'grpadd': {
      const lst = P.categories[cat];
      const add = sel.filter(t => !lst.includes(t));
      if (!add.length) { setStatus('다른 탭에서 추가할 종목을 체크한 뒤 누르세요'); return; }
      lst.push(...add);
      persist('portfolio', `${add.length}개 종목 → [${cat}] 그룹 추가`);
      renderCatTabs(); renderTable();
      return;
    }
    case 'grprm': {
      const vis = new Set(visibleTickers(cat));
      const rm = sel.filter(t => vis.has(t));
      if (!rm.length) { setStatus('이 탭에서 제거할 종목을 체크하세요'); return; }
      P.categories[cat] = P.categories[cat].filter(t => !rm.includes(t));
      rm.forEach(t => S.ui.selected.delete(t));
      persist('portfolio', `${rm.length}개 종목 [${cat}] 그룹에서 제거`);
      renderCatTabs(); renderTable();
      return;
    }
    case 'grprename': {
      const name = (prompt('새 그룹 이름', cat) || '').trim();
      if (!name || name === cat) return;
      if (P.categories[name] || PROTECTED_CATS.has(name)) { alert('이미 존재하는 그룹명입니다'); return; }
      const cats = {};
      for (const [k, v] of Object.entries(P.categories)) cats[k === cat ? name : k] = v;
      P.categories = cats;
      if (cat in P.group_recipes) { P.group_recipes[name] = P.group_recipes[cat]; delete P.group_recipes[cat]; }
      if (S.ui.sort[cat]) { S.ui.sort[name] = S.ui.sort[cat]; delete S.ui.sort[cat]; }
      S.ui.cat = name;
      persist('portfolio', `그룹 이름 변경: ${cat} → ${name}`);
      renderCatTabs(); renderGroupTools();
      return;
    }
    case 'grpdel': {
      if (!confirm(`'${cat}' 그룹을 삭제할까요? (종목은 유지)`)) return;
      delete P.categories[cat]; delete P.group_recipes[cat];
      S.ui.cat = '전체';
      persist('portfolio', `'${cat}' 그룹 삭제`);
      renderCatTabs(); renderGroupTools(); renderTable();
      return;
    }
  }
}

function exportCsv() {
  const cat = S.ui.cat;
  const rows = sortRows(buildRows(cat), cat);
  const q = s => `"${String(s).replace(/"/g, '""')}"`;
  const lines = [COLUMNS.map(([k]) => q(colLabel(k))).join(',')];
  for (const r of rows) {
    lines.push(COLUMNS.map(([k]) => q(k === 'name' || k === 'ticker' ? r[k] : r._pending ? '-' : fmtVal(k, r[k], r._kr))).join(','));
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  const ts = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  a.href = URL.createObjectURL(blob);
  a.download = `portfolio_${cat}_${ts}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ── 차트 (app.py build_chart_plotly 와 동일 구성) ────────────────────────────
function renderChart() {
  const box = $('#chartBox'), split = $('#split');
  const t = S.ui.chart;
  if (!t || !S.series[t] || !window.Plotly) {
    if (box.hidden === false && window.Plotly) Plotly.purge('chart');
    box.hidden = true; split.classList.remove('with-chart');
    if (t && !window.Plotly) setStatus('차트 라이브러리 로딩 실패 — 네트워크를 확인하세요', 'err');
    return;
  }
  box.hidden = false; split.classList.add('with-chart');
  const rec = S.data.tickers[t], s = S.series[t], kr = rec.kr;
  $('#chartTitle').textContent = rec.name;
  $('#chartSub').textContent = `(${t})`;

  const cfg = S.settings, T = cfg.Technical;
  const calc = new IndicatorCalculator(cfg);
  const N = s.c.length, n = Math.min(252, N), st = N - n;
  const sl = a => a.slice(st);
  const iso = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const dates = sl(s.t).map(iso);
  const [o, h, l, c, v] = [sl(s.o), sl(s.h), sl(s.l), sl(s.c), sl(s.v)];

  const bb = calc.bollingerSeries(s.c);
  const rsi = sl(calc.rsiSeries(s.c));
  const macd = calc.macdSeries(s.c);
  const nanNull = a => a.map(x => (Number.isFinite(x) ? x : null));
  // 각 날짜 시점 기준 평균 모멘텀 (그날까지의 데이터, 그날 기준 N개월 전 가격)
  const mom = [];
  for (let i = st; i < N; i++) {
    const m = calc.avgMomentum(s.t, s.c, s.t[i], i + 1);
    mom.push(m === null ? null : m * 100);
  }

  const [up, dn] = kr ? ['#c62828', '#1565c0'] : ['#2e7d32', '#c62828'];
  const pf = kr ? ',.0f' : ',.2f';
  const fmtTv = x => kr
    ? (x >= 1e12 ? `${(x / 1e12).toFixed(2)}조` : `${(x / 1e8).toFixed(0)}억`)
    : (x >= 1e9 ? `${(x / 1e9).toFixed(2)}B` : `${(x / 1e6).toFixed(1)}M`);
  const tv = c.map((x, i) => fmtTv(x * v[i]));

  const sma = nanNull(sl(bb.sma)), upper = nanNull(sl(bb.up)), lower = nanNull(sl(bb.lo));
  const hist = nanNull(sl(macd.hist)), line = nanNull(sl(macd.line)), sig = nanNull(sl(macd.sig));

  const traces = [
    { x: [...dates, ...[...dates].reverse()], y: [...upper, ...[...lower].reverse()], fill: 'toself',
      fillcolor: 'rgba(123,31,162,0.05)', line: { color: 'rgba(0,0,0,0)' }, hoverinfo: 'skip', showlegend: false, yaxis: 'y' },
    { x: dates, y: upper, name: 'BB상단', line: { color: '#7b1fa2', width: 1, dash: 'dash' }, opacity: 0.7,
      hovertemplate: `BB상단: %{y:${pf}}<extra></extra>`, yaxis: 'y' },
    { x: dates, y: lower, name: 'BB하단', line: { color: '#7b1fa2', width: 1, dash: 'dash' }, opacity: 0.7,
      hovertemplate: `BB하단: %{y:${pf}}<extra></extra>`, yaxis: 'y' },
    { x: dates, y: sma, name: `SMA${T.bb_period}`, line: { color: '#1565c0', width: 1.2 },
      hovertemplate: `SMA${T.bb_period}: %{y:${pf}}<extra></extra>`, yaxis: 'y' },
    { type: 'candlestick', x: dates, open: o, high: h, low: l, close: c, name: '가격', yaxis: 'y',
      increasing: { line: { color: up }, fillcolor: up }, decreasing: { line: { color: dn }, fillcolor: dn } },
    { type: 'bar', x: dates, y: v, name: '거래량', yaxis: 'y2', opacity: 0.75, customdata: tv,
      marker: { color: c.map((x, i) => (x >= o[i] ? up : dn)) },
      hovertemplate: '거래량: %{y:,.0f}<br>거래대금: %{customdata}<extra></extra>' },
    { type: 'bar', x: dates, y: mom.map(x => x ?? 0), name: '모멘텀', yaxis: 'y3', opacity: 0.75,
      marker: { color: mom.map(x => (x !== null && x >= 0 ? up : dn)) },
      hovertemplate: '모멘텀: %{y:.1f}%<extra></extra>' },
    { x: dates, y: nanNull(rsi), name: `RSI(${T.rsi_period})`, yaxis: 'y4', line: { color: '#e65100', width: 1.5 },
      hovertemplate: `RSI(${T.rsi_period}): %{y:.1f}<extra></extra>` },
    { type: 'bar', x: dates, y: hist, name: 'MACD Hist', yaxis: 'y5', opacity: 0.75,
      marker: { color: hist.map(x => (x !== null && x >= 0 ? up : dn)) },
      hovertemplate: 'MACD Hist: %{y:.1f}<extra></extra>' },
    { x: dates, y: line, name: 'MACD', yaxis: 'y5', line: { color: '#1565c0', width: 1.5 },
      hovertemplate: 'MACD: %{y:.1f}<extra></extra>' },
    { x: dates, y: sig, name: 'Signal', yaxis: 'y5', line: { color: '#e65100', width: 1.5 },
      hovertemplate: 'Signal: %{y:.1f}<extra></extra>' },
  ];
  traces.forEach(tr => { if (!tr.type) tr.type = 'scatter'; if (tr.type === 'scatter' && !tr.mode) tr.mode = 'lines'; });

  // 행 높이 비율 [0.40, 0.13, 0.15, 0.15, 0.17], 간격 0.025
  const gap = 0.025, ratios = [0.40, 0.13, 0.15, 0.15, 0.17], avail = 1 - gap * 4;
  const domains = [];
  let top = 1;
  for (const r of ratios) { const hgt = r * avail; domains.push([Math.max(0, top - hgt), top]); top -= hgt + gap; }
  const labels = [kr ? '가격(₩)' : '가격($)', '거래량', '모멘텀', 'RSI', 'MACD'];
  const grid = 'rgba(180,180,180,0.3)';
  const spike = { showspikes: true, spikemode: 'across', spikesnap: 'cursor', spikecolor: 'rgba(0,0,0,0.2)', spikethickness: 1 };

  // 주말·공휴일 빈 구간 제거
  const have = new Set(dates), missing = [];
  for (let d = parseDate(dates[0]); d <= parseDate(dates[dates.length - 1]); d += DAY_MS) {
    const s2 = iso(d); if (!have.has(s2)) missing.push(s2);
  }

  const layout = {
    hovermode: 'x unified', dragmode: 'zoom', bargap: 0.1, showlegend: true,
    margin: { l: 64, r: 16, t: 64, b: 30 },
    legend: { orientation: 'h', yanchor: 'bottom', y: 1.01, xanchor: 'right', x: 1, font: { size: 11 } },
    paper_bgcolor: 'white', plot_bgcolor: 'white',
    xaxis: { type: 'date', anchor: 'y5', rangeslider: { visible: false }, rangebreaks: [{ values: missing }],
             showgrid: true, gridcolor: grid, ...spike, spikecolor: 'rgba(0,0,0,0.3)' },
    shapes: [70, 30].map((y, i) => ({ type: 'line', xref: 'paper', x0: 0, x1: 1, yref: 'y4', y0: y, y1: y,
      line: { dash: 'dash', width: 0.8, color: i ? up : dn }, opacity: 0.6 })),
  };
  domains.forEach((dom, i) => {
    layout[i ? `yaxis${i + 1}` : 'yaxis'] = {
      domain: dom, anchor: 'x', showgrid: true, gridcolor: grid, ...spike,
      title: { text: labels[i], font: { size: 11, color: '#444' } },
      ...(i === 3 ? { range: [0, 100] } : {}),
      ...(i === 0 ? { tickformat: pf } : {}),
    };
  });

  Plotly.react('chart', traces, layout, { scrollZoom: true, displayModeBar: true, responsive: true, displaylogo: false });
}

// ── 설정 탭 ──────────────────────────────────────────────────────────────────
const SETTING_FORMS = [
  { title: '모멘텀', section: 'Momentum', fields: [
    ['period_1m', '단기(1M) 기간 (개월)', 1, 6, 1], ['weight_1m', '1M 가중치', 0, 1, 0.05],
    ['period_3m', '중단기(3M) 기간 (개월)', 1, 12, 1], ['weight_3m', '3M 가중치', 0, 1, 0.05],
    ['period_6m', '중기(6M) 기간 (개월)', 1, 18, 1], ['weight_6m', '6M 가중치', 0, 1, 0.05],
    ['period_12m', '장기(12M) 기간 (개월)', 1, 36, 1], ['weight_12m', '12M 가중치', 0, 1, 0.05],
  ], note: () => { const m = S.settings.Momentum; return `가중치 합계: ${(m.weight_1m + m.weight_3m + m.weight_6m + m.weight_12m).toFixed(2)} (1.0 권장)`; } },
  { title: '변동성', section: 'Volatility', fields: [
    ['vol_period', '변동성 계산 기간 (개월)', 1, 24, 1],
    ['filter_short', '과변동성 필터 · 단기 변동성 기간 (개월)', 1, 6, 1],
    ['filter_long', '과변동성 필터 · 장기 변동성 기간 (개월)', 1, 36, 1],
    ['filter_sigma', '과변동성 필터 · 임계값 σ 배수', 0.5, 4, 0.1],
  ] },
  { title: 'RSM / 벤치마크', section: 'RSM', fields: [
    ['period', 'RSM 기간 (개월)', 1, 36, 1],
    ['benchmark_kr', '한국 벤치마크 티커 (기본: 069500 KODEX 200)', 'text'],
    ['benchmark_us', '미국 벤치마크 티커 (기본: SPY)', 'text'],
  ], note: () => '벤치마크를 바꾸면 GitHub 저장 후 데이터가 다시 수집됩니다 (2~3분).' },
  { title: '기술적 지표', section: 'Technical', fields: [
    ['rsi_period', 'RSI 기간 (거래일)', 5, 200, 1], ['macd_fast', 'MACD 단기 EMA (거래일)', 5, 200, 1],
    ['rel_vol_period', '상대 거래량 기간 (개월)', 1, 24, 1], ['macd_slow', 'MACD 장기 EMA (거래일)', 10, 500, 1],
    ['slope_period', '회귀 기울기 기간 (개월)', 1, 36, 1], ['macd_signal', 'MACD 시그널 EMA (거래일)', 3, 50, 1],
    ['high_period', '최고가 기준 기간 (개월)', 1, 36, 1], ['bb_period', '볼린저 기간 (거래일)', 10, 504, 1],
    ['bb_std', '볼린저 표준편차 배수', 1, 3, 0.1],
  ] },
  { title: '랭킹 레시피' },
  { title: 'GitHub 연결' },
];

const showGithubTab = () => location.hash === '#gh';

function renderSettings() {
  if (!showGithubTab() && SETTING_FORMS[S.ui.setTab].title === 'GitHub 연결') S.ui.setTab = 0;
  const tabs = SETTING_FORMS.map((f, i) => (f.title === 'GitHub 연결' && !showGithubTab()) ? '' : `<button data-st="${i}" class="${i === S.ui.setTab ? 'on' : ''}">${f.title}</button>`).join('');
  $('#settings').innerHTML = `<div class="tabs" id="setTabs">${tabs}</div><div class="panel" id="setBody"></div>`;
  $('#setTabs').onclick = e => {
    const b = e.target.closest('[data-st]');
    if (!b) return;
    S.ui.setTab = +b.dataset.st;
    renderSettings();
  };
  const f = SETTING_FORMS[S.ui.setTab];
  if (f.title === '랭킹 레시피') renderRecipes();
  else if (f.title === 'GitHub 연결') renderGithub();
  else renderForm(f);
}

function renderForm(f) {
  const sec = S.settings[f.section];
  const fields = f.fields.map(([k, label, min, max, step]) => min === 'text'
    ? `<label>${label}<input type="text" data-k="${k}" value="${esc(sec[k])}"></label>`
    : `<label>${label}<input type="number" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${sec[k]}"></label>`
  ).join('');
  $('#setBody').innerHTML = `<h3>${f.title} 설정</h3><div class="form">${fields}</div>
    ${f.note ? `<div class="caption" id="formNote">${esc(f.note())}</div>` : ''}
    <div class="row-actions"><button class="b primary" id="formSave">저장</button><span class="caption" id="formMsg"></span></div>`;
  $('#formSave').onclick = () => {
    const next = clone(sec);
    for (const [k, label, min, max] of f.fields) {
      const el = $(`[data-k="${k}"]`, $('#setBody'));
      if (min === 'text') { next[k] = el.value.trim().toUpperCase(); continue; }
      const val = Number(el.value);
      if (!Number.isFinite(val) || val < min || val > max) { $('#formMsg').textContent = `⚠ ${label}: ${min}~${max} 사이 값을 입력하세요`; return; }
      next[k] = Number.isInteger(f.fields.find(x => x[0] === k)[4]) ? Math.round(val) : Math.round(val * 10000) / 10000;
    }
    const benchChanged = f.section === 'RSM' &&
      (next.benchmark_kr !== sec.benchmark_kr || next.benchmark_us !== sec.benchmark_us);
    S.settings[f.section] = next;
    persist('settings', `${f.title} 설정 저장`).then(ok => {
      $('#formMsg').textContent = ok ? '저장됨 ✓ (GitHub 반영)' : '저장됨 ✓ (이 브라우저)';
    });
    if (benchChanged && !getToken()) $('#formMsg').textContent = '이 브라우저에만 저장됨';
    rerenderAll();
    renderForm(f);
  };
}

// ── 레시피 편집 ──────────────────────────────────────────────────────────────
let draft = null;   // 편집 중인 레시피 사본

function renderRecipes() {
  const R = S.settings.recipes;
  if (S.ui.recipeSel === null || S.ui.recipeSel >= R.list.length) S.ui.recipeSel = Math.min(R.active, R.list.length - 1);
  const sel = S.ui.recipeSel;
  if (!R.list.length) {
    $('#setBody').innerHTML = `<p>레시피가 없습니다.</p><button class="b" id="rcAddDefault">+ 기본 레시피 추가</button>`;
    $('#rcAddDefault').onclick = () => {
      R.list = [{ name: '순수 모멘텀', items: [['avg_momentum', 0.4, '+'], ['wgt_momentum', 0.3, '+'], ['rsm', 0.2, '+'], ['slope', 0.1, '+']], filters: [] }];
      R.active = 0; S.ui.recipeSel = 0; draft = null;
      persist('settings', '레시피 추가'); rerenderAll(); renderRecipes();
    };
    return;
  }
  if (!draft || draft._idx !== sel) {
    const r = R.list[sel];
    draft = {
      _idx: sel, name: r.name,
      items: r.items.filter(([k]) => !k.startsWith('formula:')).map(x => [...x]),
      formulas: r.items.filter(([k]) => k.startsWith('formula:')).map(([k, w, d]) => {
        const p = parseFormula(k.slice(8)) || [FORMULA_LABELS[0], '/', FORMULA_LABELS[3]];
        return [p[0], p[1], p[2], w, d];
      }),
      filters: (r.filters || []).map(x => [...x]),
    };
  }
  const opt = (list, cur) => list.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const IND = RANKING_INDICATORS;
  const FL = FORMULA_LABELS.map(l => [l, l]);
  const DIR = [['+', '↑ 높을수록 좋음'], ['-', '↓ 낮을수록 좋음']];
  const COND = [['<', '< 미만이면 제외'], ['>', '> 초과이면 제외']];

  const itemRows = draft.items.map(([k, w, d], i) => `<tr data-i="${i}">
      <td><select data-f="items.0">${opt(IND, k)}</select></td>
      <td><input type="number" data-f="items.1" min="0" max="1" step="0.05" value="${w}"></td>
      <td><select data-f="items.2">${opt(DIR, d)}</select></td>
      <td class="del"><button class="x" data-del="items">✕</button></td></tr>`).join('');
  const formulaRows = draft.formulas.map(([a, op, b, w, d], i) => `<tr data-i="${i}">
      <td><select data-f="formulas.0">${opt(FL, a)}</select></td>
      <td><select data-f="formulas.1">${opt(FORMULA_OPS, op)}</select></td>
      <td><select data-f="formulas.2">${opt(FL, b)}</select></td>
      <td><input type="number" data-f="formulas.3" min="0" max="1" step="0.05" value="${w}"></td>
      <td><select data-f="formulas.4">${opt(DIR, d)}</select></td>
      <td class="del"><button class="x" data-del="formulas">✕</button></td></tr>`).join('');
  const filterRows = draft.filters.map(([k, op, v], i) => `<tr data-i="${i}">
      <td><select data-f="filters.0">${opt(IND, k)}</select></td>
      <td><select data-f="filters.1">${opt(COND, op)}</select></td>
      <td><input type="number" data-f="filters.2" step="0.01" value="${v}"></td>
      <td class="del"><button class="x" data-del="filters">✕</button></td></tr>`).join('');

  $('#setBody').innerHTML = `
    <div class="row-actions">
      <select id="rcSel">${R.list.map((r, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${i === R.active ? '★ ' : ''}${esc(r.name)}</option>`).join('')}</select>
      <button class="b" id="rcAdd">+ 레시피 추가</button>
      <button class="b" id="rcDel">- 선택 삭제</button>
      <button class="b" id="rcAct">★ 활성으로 설정</button>
    </div>
    <div class="form"><label class="full">레시피 이름<input type="text" id="rcName" value="${esc(draft.name)}"></label></div>

    <h3>점수 지표 <span class="caption">(백분위 가중 합산 0~100점)</span></h3>
    <table class="edit"><thead><tr><th>지표</th><th style="width:110px">가중치</th><th style="width:170px">방향</th><th></th></tr></thead>
      <tbody data-sec="items">${itemRows}</tbody></table>
    <div class="row-actions"><button class="b" data-addrow="items">+ 지표 추가</button></div>

    <details class="box" ${draft.formulas.length ? 'open' : ''}><summary>수식 지표</summary>
      <table class="edit"><thead><tr><th>지표1</th><th style="width:70px">연산자</th><th>지표2</th><th style="width:100px">가중치</th><th style="width:160px">방향</th><th></th></tr></thead>
        <tbody data-sec="formulas">${formulaRows}</tbody></table>
      <div class="row-actions"><button class="b" data-addrow="formulas">+ 수식 추가</button></div>
    </details>
    <div class="caption" id="rcTotal"></div>

    <h3>제외 필터 <span class="caption">(조건에 해당하는 종목은 랭킹·점수에서 제외)</span></h3>
    <table class="edit"><thead><tr><th>지표</th><th style="width:170px">조건</th><th style="width:140px">기준값</th><th></th></tr></thead>
      <tbody data-sec="filters">${filterRows}</tbody></table>
    <div class="row-actions"><button class="b" data-addrow="filters">+ 필터 추가</button></div>
    <div class="caption">기준값은 원본 값 기준입니다 — 예: 모멘텀 0% 미만 제외 → <code>0</code>, 변동성 50% 초과 제외 → <code>0.5</code>, RSI 70 초과 제외 → <code>70</code></div>

    <div class="row-actions"><button class="b primary" id="rcSave">💾 레시피 저장</button><span class="caption" id="rcMsg"></span></div>`;

  const body = $('#setBody');
  const updTotal = () => {
    const tot = draft.items.reduce((s, x) => s + Number(x[1] || 0), 0) + draft.formulas.reduce((s, x) => s + Number(x[3] || 0), 0);
    $('#rcTotal').innerHTML = `가중치 합: ${tot.toFixed(2)} ` + (Math.abs(tot - 1) < 0.011 ? '<span class="ok">✓</span>' : '← 1.0으로 맞추세요');
  };
  updTotal();

  body.onchange = e => {
    const f = e.target.dataset.f;
    if (!f) return;
    const [sec, col] = f.split('.');
    const i = +e.target.closest('tr').dataset.i;
    draft[sec][i][+col] = e.target.type === 'number' ? Number(e.target.value) : e.target.value;
    updTotal();
  };
  $('#rcName').oninput = e => { draft.name = e.target.value; };
  body.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    draft[b.dataset.del].splice(+b.closest('tr').dataset.i, 1); renderRecipes();
  });
  body.querySelectorAll('[data-addrow]').forEach(b => b.onclick = () => {
    const s = b.dataset.addrow;
    if (s === 'items') draft.items.push([IND[0][0], 0.1, '+']);
    if (s === 'formulas') draft.formulas.push([FORMULA_LABELS[0], '/', FORMULA_LABELS[3], 0.1, '+']);
    if (s === 'filters') draft.filters.push([IND[0][0], '<', 0]);
    renderRecipes();
  });
  $('#rcSel').onchange = e => { S.ui.recipeSel = +e.target.value; renderRecipes(); };
  $('#rcAdd').onclick = () => {
    R.list.push({ name: `새 레시피 ${R.list.length + 1}`, items: [['avg_momentum', 0.5, '+'], ['rsm', 0.5, '+']], filters: [] });
    S.ui.recipeSel = R.list.length - 1; draft = null;
    persist('settings', '레시피 추가'); renderRecipes(); renderGroupTools();
  };
  $('#rcDel').onclick = () => {
    if (R.list.length <= 1) { $('#rcMsg').textContent = '마지막 레시피는 삭제할 수 없습니다'; return; }
    if (!confirm(`'${R.list[sel].name}' 레시피를 삭제할까요?`)) return;
    R.list.splice(sel, 1);
    if (R.active >= R.list.length) R.active = R.list.length - 1;
    // 그룹별 레시피 인덱스 보정
    const G = S.portfolio.group_recipes;
    let pChanged = false;
    for (const c of Object.keys(G)) {
      if (G[c] === sel) { delete G[c]; pChanged = true; }
      else if (G[c] > sel) { G[c]--; pChanged = true; }
    }
    if (pChanged) persist('portfolio', '그룹 레시피 보정');
    S.ui.recipeSel = Math.min(sel, R.list.length - 1); draft = null;
    persist('settings', '레시피 삭제'); rerenderAll(); renderRecipes();
  };
  $('#rcAct').onclick = () => {
    R.active = sel;
    persist('settings', `'${R.list[sel].name}' 활성화`); rerenderAll(); renderRecipes();
  };
  $('#rcSave').onclick = () => {
    const items = [
      ...draft.items.map(([k, w, d]) => [k, Number(w) || 0, d]),
      ...draft.formulas.map(([a, op, b, w, d]) => [`formula:${a} ${op} ${b}`, Number(w) || 0, d]),
    ];
    const filters = draft.filters.map(([k, op, v]) => [k, op, Number.isFinite(Number(v)) ? Number(v) : 0]);
    R.list[sel] = { name: (draft.name || '').trim() || `레시피 ${sel + 1}`, items, filters };
    draft = null;
    persist('settings', `'${R.list[sel].name}' 레시피 저장`).then(ok => {
      const m = $('#rcMsg'); if (m) m.textContent = ok ? '저장됨 ✓ (GitHub 반영)' : '저장됨 ✓ (이 브라우저)';
    });
    rerenderAll(); renderRecipes(); renderGroupTools();
  };
}

// ── GitHub 연결 ──────────────────────────────────────────────────────────────
function renderGithub() {
  const has = !!getToken();
  $('#setBody').innerHTML = `
    <h3>GitHub 연결 ${has ? '<span class="ok">● 연결됨</span>' : ''}</h3>
    <p class="caption" style="max-width:760px">연결하면 종목·그룹·설정 변경이 GitHub 저장소에 저장되어 <b>모든 기기에서 같은 내용</b>이 보이고,
      새로 추가한 종목의 데이터도 자동으로 수집됩니다. 연결하지 않으면 보기와 계산은 그대로 되지만 변경 사항은 이 브라우저에만 남습니다.</p>
    <div class="form">
      <label class="full">GitHub 토큰 (이 브라우저에만 저장, 다른 곳으로 전송되지 않음 — api.github.com 제외)
        <input type="password" id="tokIn" placeholder="${has ? '저장됨 — 바꾸려면 새 토큰 입력' : 'github_pat_...'}" autocomplete="off"></label>
    </div>
    <div class="row-actions">
      <button class="b primary" id="tokSave">저장 및 확인</button>
      ${has ? '<button class="b danger" id="tokDel">연결 해제</button>' : ''}
      <span class="caption" id="tokMsg"></span>
    </div>
    <details class="box" ${has ? '' : 'open'}><summary>토큰 만드는 법 (1회, 약 2분)</summary>
      <ol class="steps">
        <li>GitHub 로그인 → 오른쪽 위 프로필 → <b>Settings</b> → 왼쪽 맨 아래 <b>Developer settings</b></li>
        <li><b>Personal access tokens → Fine-grained tokens → Generate new token</b></li>
        <li>Token name: <code>momentum-analyzer</code>, Expiration: 원하는 기간 (최대 1년)</li>
        <li>Repository access: <b>Only select repositories</b> → <code>momentum-analyzer</code> 선택</li>
        <li>Permissions → Repository permissions:<br><b>Contents: Read and write</b>, <b>Actions: Read and write</b></li>
        <li><b>Generate token</b> → 표시된 토큰을 복사해 위 칸에 붙여넣기</li>
      </ol>
      <p class="caption">이 토큰은 이 저장소 하나만 수정할 수 있습니다. 공용 PC에서는 사용 후 <b>연결 해제</b>하세요.</p>
    </details>`;
  $('#tokSave').onclick = async () => {
    const v = $('#tokIn').value.trim();
    const msg = $('#tokMsg');
    if (v) { try { localStorage.setItem(LS.token, v); } catch { msg.textContent = '이 브라우저는 저장소를 차단했습니다'; return; } }
    if (!getToken()) { msg.textContent = '토큰을 입력하세요'; return; }
    msg.textContent = '확인 중...';
    try {
      const repo = await gh('');
      if (!repo.permissions?.push) throw new Error('쓰기 권한 없음 — Contents: Read and write 를 확인하세요');
      msg.textContent = '연결됨 ✓';
      // 이 브라우저에만 있던 변경 사항 업로드
      const pendingP = lsGet(LS.portfolio), pendingS = lsGet(LS.settings);
      if (pendingP && (pendingP.updated_at || 0) > (S.remote.portfolio.updated_at || 0)) persist('portfolio', '브라우저 변경 사항 업로드');
      if (pendingS && (pendingS.updated_at || 0) > (S.remote.settings.updated_at || 0)) persist('settings', '브라우저 변경 사항 업로드');
      renderNotices();
      setTimeout(renderGithub, 800);
    } catch (e) {
      msg.textContent = `실패: ${e.message}`;
    }
  };
  if (has) $('#tokDel').onclick = () => { lsDel(LS.token); renderGithub(); renderNotices(); };
}

// ── UI 상태 저장 / 메인 탭 ───────────────────────────────────────────────────
function saveUi() { lsSet(LS.ui, { main: S.ui.main, cat: S.ui.cat }); }

function showMain(which) {
  S.ui.main = which; saveUi();
  document.querySelectorAll('#mainTabs button').forEach(b => b.classList.toggle('on', b.dataset.main === which));
  $('#analysis').hidden = which !== 'analysis';
  $('#settings').hidden = which !== 'settings';
  if (which === 'settings') renderSettings();
  else { renderTable(); renderChart(); }
}

// ── 시작 ─────────────────────────────────────────────────────────────────────
async function init() {
  $('#mainTabs').onclick = e => { const b = e.target.closest('[data-main]'); if (b) showMain(b.dataset.main); };
  $('#analysis').innerHTML = '<div class="empty">데이터 불러오는 중...</div>';
  try {
    const [data, portfolio, settings] = await Promise.all([
      fetchJSON('data.json'), fetchJSON('portfolio.json'), fetchJSON('settings.json'),
    ]);
    S.data = data;
    S.remote = { portfolio, settings };
    S.portfolio = normalizePortfolio(clone(newer(portfolio, lsGet(LS.portfolio))));
    S.settings  = clone(newer(settings, lsGet(LS.settings)));
    for (const [t, rec] of Object.entries(data.tickers)) S.series[t] = toSeries(rec);
  } catch (e) {
    $('#analysis').innerHTML = `<div class="empty">데이터를 불러오지 못했습니다: ${esc(e.message)}<br>GitHub Actions 첫 실행이 끝났는지 확인하세요.</div>`;
    return;
  }
  const ui = lsGet(LS.ui);
  if (ui) { S.ui.cat = ui.cat || '전체'; }
  renderAnalysisShell();
  rerenderAll();
  showMain(ui?.main === 'settings' ? 'settings' : 'analysis');
  const openGh = () => { S.ui.setTab = SETTING_FORMS.length - 1; showMain('settings'); };
  addEventListener('hashchange', () => { if (location.hash === '#gh') openGh(); else if (S.ui.main === 'settings') renderSettings(); });
  if (location.hash === '#gh') openGh();
  let rz;
  addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (S.ui.main === 'analysis') renderTable(); }, 200); });
}

init();
