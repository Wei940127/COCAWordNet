/* COCAWordNet — interactive word-network vocabulary app */
(function () {
"use strict";

/* 应用版本号：显示在界面右上角，也是「是否已更新」的判据。
   改动 app.js / index.html / style.css 时 +1，并同步把 sw.js 里的 CACHE +1。 */
const APP_VERSION = "v51";
window.APP_VERSION = APP_VERSION;

const D = window.APP_DATA;
if (!D || !D.words || !D.words.length || window.__DATA_FAIL) {
  /* data.js missing or corrupt — show a clear error instead of a dead page */
  const ld = document.getElementById("loader");
  if (ld) {
    ld.classList.add("err");
    const lt = document.getElementById("loaderText");
    if (lt) lt.innerHTML = "词库加载失败，应用无法启动。" +
      "<small>请确认数据文件与 index.html 在同一文件夹；" +
      "若是在线访问，请刷新重试或检查网络。</small>";
  }
  return;
}
const N = D.words.length;

/* ---------- 数据分块按需载入（v35 首屏瘦身） ----------
   原来一次性下载 data.js + ex.js（约 3MB gzip），首屏要等全部下完、解析完才能动。
   现在拆成：

     data_core.js       骨架：词表 / 词层 / 词→下标 / 别名            ← index.html 里同步加载（约 200KB）
     data_b01..b10.js   下标块 c = 词 [(c-1)*1000, c*1000)：
                        音标·释义·词族·关系·搭配·词根·例句             ← 需要哪块才载哪块
     data_extra.js      词表外关联词名（画布上灰节点要用）
     data_extra_def.js  词表外词的音标+释义（点开灰节点才要）

   合并进的是同一批全局数组，下标仍是全库下标，所以下面所有
   D.phon[i] / D.trans[i] / D.adj[i] 读法一个字都不用改 ——
   没载入的槽位是 undefined，读取处本来就善用 `|| ""` 兜底。

   首屏 = 骨架 + 当前块（约 500KB gzip）；其余在首屏画完之后按
   「离当前块由近到远」的顺序在后台补齐（省流模式下不预取）。 */
const CHUNK_N = 10;
const chunkOf = i => Math.floor(i / 1000) + 1;      /* 下标 → 块号 */
const chunkFile = c => "data_b" + (c < 10 ? "0" + c : c) + ".js";
const loadedChunk = new Set();
let hasExtra = false, hasExtraDef = false;
let hasZh = false;                  /* 中文释义索引（data_zh.js，214KB gzip，按需载入） */
let zhParts = null;                 /* 切分后的中文索引（N 段，与 D.words 同下标） */

/* 先把各字段占好位（空数组/空对象）：没载入的下标读出来是 undefined，
   这样所有 D.phon[i] / D.trans[i] 的既有读法都不会抛错。 */
["phon", "trans", "def", "tag", "fam", "adj"].forEach(f => { if (!D[f]) D[f] = new Array(N); });
["morph", "cogn", "coll"].forEach(f => { if (!D[f]) D[f] = {}; });
if (!D.extra) D.extra = [];
if (!D.extraPhon) D.extraPhon = [];
if (!D.extraTrans) D.extraTrans = [];
if (!window.APP_EX) window.APP_EX = {};
/* 段落记忆（data_net_bNNa..d.js）：词头 → {tw:[[关系词,关系类型],…], en, zh}
   和例句一样是「有就显示、没有就隐藏」的增强内容，载入失败一律静默。

   分块分两级：先按词层（每 1000 词一块，规则与词层块一致），块内再按全局下标
   切 NET_SUB=250 词一个子块（后缀 a/b/c/d）。原因是段落正文很长——一层写满有
   500KB+（b1 层 529 段 = 538KB），整块拉会白等；按当前词只取所在子块，流量降到 1/4。 */
if (!window.APP_NET) window.APP_NET = {};
const NET_SUB = 250;             /* 每个段落子块覆盖的全局下标跨度 */
const netLoaded = new Set();     /* 已载入的段落子块，键形如 "3c" */
const netMissing = new Set();    /* 确认没有段落数据的子块（不再重试） */
let hasNet = false;              /* 任何一个子块载入过 */

/* 段落子块 → 脚本名。
   不写「哪些块已生成」的白名单是**故意**的：将来一块块补齐时新文件放进去就自动
   生效，不用回头改代码。代价是没生成的子块会白请求一次（404），第一次失败后
   netMissing 就记住，同一子块不会重复请求。 */
const netSubOf = i => Math.floor((i % 1000) / NET_SUB);       /* 0..3 */
const netKey = i => chunkOf(i) + "abcd".charAt(netSubOf(i));
const netFile = i => {
  const c = chunkOf(i);
  return "data_net_b" + (c < 10 ? "0" + c : c) + "abcd".charAt(netSubOf(i)) + ".js";
};
function needNet(i) {
  const k = netKey(i);
  if (netLoaded.has(k) || netMissing.has(k)) return Promise.resolve();
  return loadPart(netFile(i), "net" + k, () => netLoaded.has(k))
    .catch(() => { netMissing.add(k); });
}

/* 易混词的缓存：每合并进一个词层块就作废重算（新载入的词会带来新的邻居） */
let confVer = 0;
const confMemo = new Map();
function confInvalidate() { confVer++; confMemo.clear(); }

/* 词根索引：同样是「随分块作废重算」的派生数据 —— D.morph 只覆盖已载入的词层，
   没载入的块进来之后必须重建，否则页面会永远停在半份清单上。 */
let rootIdx = null;

/* 载入完成后要顺带刷新的界面（单词列表 / 难词 / 统计 里的释义会补齐） */
function afterPartLoad() {
  try {
    if (typeof renderList === "function" && !$("listModal").classList.contains("hidden")) renderList();
    if (typeof renderHard === "function" && !$("hardModal").classList.contains("hidden")) renderHard();
    if (typeof renderStat === "function" && !$("statModal").classList.contains("hidden")) renderStat();
    if (hasExtraDef && typeof refreshExtInfo === "function") refreshExtInfo();
    if (typeof fillPanelIfPending === "function") fillPanelIfPending();
    if (typeof refillPara === "function") refillPara();
    if (typeof renderRoot === "function" && !$("rootModal").classList.contains("hidden")) renderRoot();
  } catch (e) {}
}

/* 块脚本调用这两个钩子把自己交进来 */
window.APP_MERGE = function (c, o) {
  if (!o || loadedChunk.has(c)) return;
  const base = (c - 1) * 1000;
  ["phon", "trans", "def", "tag", "fam", "adj"].forEach(f => {
    const src = o[f];
    if (!src) return;
    const dst = D[f] || (D[f] = new Array(N));
    for (let k = 0; k < src.length; k++) dst[base + k] = src[k];
  });
  ["morph", "cogn", "coll"].forEach(f => {
    const src = o[f];
    if (!src) return;
    const dst = D[f] || (D[f] = {});
    for (const w in src) dst[w] = src[w];
  });
  if (o.ex) {
    const ex = window.APP_EX || (window.APP_EX = {});
    for (const w in o.ex) ex[w] = o.ex[w];
  }
  loadedChunk.add(c);
  confInvalidate();
  rootIdx = null;                  /* 词根索引只统计已载入的词，新块进来必须重建 */
  afterPartLoad();
};
window.APP_MERGE_EXTRA = function (o) {
  D.extra = o.extra;
  extraMap = null;                 /* 之前可能建过空表，重来 */
  hasExtra = true;
  afterPartLoad();
};
window.APP_MERGE_EXTRA_DEF = function (o) {
  D.extraPhon = o.extraPhon;
  D.extraTrans = o.extraTrans;
  hasExtraDef = true;
  afterPartLoad();
};
/* 中文释义索引：一条大字符串，词与词之间用 ";" 分隔（生成脚本已保证正文里不含 ";"） */
window.APP_MERGE_ZH = function (o) {
  D.zh = o && o.zh ? o.zh : "";
  zhParts = null;                   /* 惰性切分：第一次用中文搜索时才 split */
  hasZh = true;
  afterPartLoad();
};

/* 段落记忆子块：和词层块一样由脚本自己调进来（payload 带 sub 说明是哪个子块） */
window.APP_MERGE_NET = function (c, o) {
  const src = (o && o.par) || {};
  const dst = window.APP_NET || (window.APP_NET = {});
  for (const w in src) dst[w] = src[w];
  const k = c + (o && o.sub ? o.sub : "");
  netMissing.delete(k);
  netLoaded.add(k);
  hasNet = true;
  afterPartLoad();
};

/* ---- 脚本注入 ---- */
const partPending = new Map();
function loadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = url;
    s.async = true;
    s.onload = () => resolve(true);
    s.onerror = () => { s.remove(); reject(new Error(url)); };
    document.head.appendChild(s);
  });
}
/* 注入脚本并确认「确实合并进来了」——只看 onload 不够：
   离线时 SW 会回一个 504 空响应、代理也可能塞回一个 200 的错误页，
   那样脚本等于没加载，必须当成失败去提示重试，而不是静默显示空内容。 */
function loadPart(file, key, ready) {
  let p = partPending.get(key);
  if (!p) {
    p = loadScript(file).then(() => {
      if (!ready()) throw new Error("empty:" + file);
      return true;
    }).catch(err => { partPending.delete(key); throw err; });
    partPending.set(key, p);
  }
  return p;
}
const chunkReady = c => loadedChunk.has(c);
function needChunk(c) { return chunkReady(c) ? Promise.resolve() : loadPart(chunkFile(c), "c" + c, () => chunkReady(c)); }
function needExtra() { return hasExtra ? Promise.resolve() : loadPart("data_extra.js", "extra", () => hasExtra); }
function needExtraDef() { return hasExtraDef ? Promise.resolve() : loadPart("data_extra_def.js", "extrad", () => hasExtraDef); }
/* 中文搜索索引：只有用户第一次输入中文时才下载，首屏零成本 */
function needZh() { return hasZh ? Promise.resolve() : loadPart("data_zh.js", "zh", () => hasZh); }

/* 载入失败（离线且没缓存）：给一条可重试的提示，不要静默变哑巴 */
let partFailShown = false;
function partFailed(target, msg) {
  if (partFailShown) return;
  partFailShown = true;
  const bar = document.createElement("div");
  bar.className = "datanote";
  bar.innerHTML = '<span>' + msg + "</span>" +
    '<button type="button">重试</button><button type="button" class="x">✕</button>';
  document.body.appendChild(bar);
  const [retry, close] = bar.querySelectorAll("button");
  close.onclick = () => { partFailShown = false; bar.remove(); };
  retry.onclick = () => { partFailShown = false; bar.remove(); target(); };
}

/* 首屏画完之后，把剩下的块按「离当前块由近到远」补齐。
   省流模式（saveData）或 2G 网络下不预取：用到哪块才载哪块。 */
function prefetchRest() {
  let conn = null;
  try { conn = navigator.connection || {}; } catch (e) {}
  if (conn.saveData || /(^|-)2g$/.test(String(conn.effectiveType || ""))) return;
  needExtra().catch(() => {});        /* 词名表只有 98KB，且第一次展开就要用 */
  const from = current !== null ? chunkOf(current) : 1;
  const order = [from];
  for (let d = 1; d < CHUNK_N; d++) {
    if (from - d >= 1) order.push(from - d);
    if (from + d <= CHUNK_N) order.push(from + d);
  }
  const step = () => {
    const c = order.shift();
    if (c === undefined) { needExtraDef().catch(() => {}); return; }
    if (chunkReady(c)) return step();
    needChunk(c).then(step, step);
  };
  step();
}

/* 还有词层没载入时，列表类的界面给一句提示（释义会随载入自动补齐） */
const partsLoading = () => loadedChunk.size < CHUNK_N;
const partsHint = () => (partsLoading() ? " · 部分词层释义载入中…" : "");

/* 供自动化测试/排查用：看当前载入了哪些块 */
window.COCA_DATA = {
  chunkOf, needChunk, needExtra, needExtraDef, needZh,
  state: () => ({ chunks: Array.from(loadedChunk).sort((a, b) => a - b), extra: hasExtra, extraDef: hasExtraDef, zh: hasZh }),
  go: (w) => go(w),
  expand: (i, o) => expand(i, o),
  zh: { has: () => hasZh, search: (q, cap) => zhSearch(zhNorm(q).split(/\s+/).filter(Boolean), cap).map(i => D.words[i]), hit: (w, q) => { const i = D.idx[String(w).toLowerCase()]; return i === undefined ? null : zhHitOf(i, [zhNorm(q)]); } },
  zoom: () => zoomBeh,          /* 供测试构造/复位视口变换 */
  resetView: () => resetView()
};
/* 易混词引擎（放在后面定义，这里先挂个转发壳，方便测试/排查直接调用） */
window.COCA_PARA = {
  has: w => !!paraOf(String(w).toLowerCase()),
  item: w => paraOf(String(w).toLowerCase()),
  forms: paraForms,
  sents: paraSents,
  play: () => paraReadAll(),
  playing: () => paraPlaying,
  open: () => openParaCloze(),
  close: closeParaCloze,
  fill: w => fillCloze(w),
  clear: k => clearCloze(k),
  check: () => checkCloze(),
  reveal: () => revealCloze(),
  rebuild: () => { if (pq) buildCloze(pq.i, pq.word, pq.item); },
  state: () => (pq ? {
    word: pq.word, blanks: pq.blanks.length, order: pq.order.slice(),
    answers: pq.blanks.map(b => b.w), fill: pq.fill.slice(), graded: pq.graded, revealed: pq.revealed
  } : null),
  parts: () => ({ loaded: [...netLoaded], missing: [...netMissing] }),
  /* 子块定位：词 → 键（"3c"）/ 文件名（data_net_b03c.js），供测试断言「只取了一个子块」 */
  sub: w => { const i = D.idx[String(w).toLowerCase()]; return i === undefined ? null : netKey(i); },
  subFile: w => { const i = D.idx[String(w).toLowerCase()]; return i === undefined ? null : netFile(i); }
};
window.COCA_CONF = {
  of: w => { const i = typeof w === "number" ? w : D.idx[String(w).toLowerCase()]; return i === undefined ? null : confusableOf(i); },
  items: w => { const i = typeof w === "number" ? w : D.idx[String(w).toLowerCase()]; return i === undefined ? null : confItems(i, 8, 4).map(x => ({ w: D.words[x.j], tag: confTagOf(x.o) })); },
  quiz: () => (cq && cq.cur ? { type: cq.cur.type, right: D.words[cq.cur.j], opts: cq.opts.map(j => D.words[j]), done: cq.done, total: cq.total, score: cq.right } : null)
};

/* ---------- relation meta ---------- */
const REL = [
  { t: 0, name: "同义词",   color: "#ff4fa3", dist: 95,  str: 0.55 },
  { t: 1, name: "反义词",   color: "#ff3838", dist: 115, str: 0.5  },
  { t: 2, name: "上位词",   color: "#a259ff", dist: 135, str: 0.4  },
  { t: 3, name: "下位词",   color: "#00b7ff", dist: 135, str: 0.4  },
  { t: 4, name: "同族派生", color: "#ffc400", dist: 78,  str: 0.7  },
  { t: 5, name: "近义联想", color: "#ff9ed2", dist: 100, str: 0.5  },
  { t: 6, name: "语义相关", color: "#64748b", dist: 150, str: 0.25 }
];
const RMAP = {}; REL.forEach(r => RMAP[r.t] = r);
/* keep the strongest relation type when a pair has several */
const TYPE_PRIORITY = [4, 1, 0, 2, 3, 5, 6];

/* ---------- 关系类型开关 ----------
   展开几个词之后连线会变得很密。图例里点某个关系名（可多选），
   画面上就只把这几类连线点亮，其余连线 / 无关节点一起淡出 —— 立刻清爽。
   空集合 = 全部显示（默认）。选择记在 localStorage，刷新后保留。 */
const RF_KEY = "cocawn.relfilter";
let relFilter = new Set();
try {
  const arr = JSON.parse(localStorage.getItem(RF_KEY) || "[]");
  if (Array.isArray(arr)) arr.forEach(t => { if (RMAP[t]) relFilter.add(t); });
} catch (e) {}
const saveRelFilter = () => {
  try { localStorage.setItem(RF_KEY, JSON.stringify([...relFilter])); } catch (e) {}
};
/* 与「点亮的关系」相连的节点集合；集合为空（= 未过滤）时为 null */
let litNodes = null;
function computeLit() {
  litNodes = null;
  if (!relFilter.size) return;
  const s = new Set();
  links.forEach(l => {
    if (relFilter.has(l.t)) { s.add(l.source.id); s.add(l.target.id); }
  });
  if (current !== null) s.add("w:" + current);
  litNodes = s;
}
/* 加了开关之后，未参与任何「点亮关系」的节点也一起淡出，视线不会被干扰 */
const nodeDim = d => (litNodes && !litNodes.has(d.id) ? 0.22 : 1);
/* 图例初始化后把自己的刷新函数注册进来（键盘快捷键也要能同步图例状态） */
let relUI = null;
const applyRelFilter = () => { saveRelFilter(); if (relUI) relUI(); computeLit(); paint(); };
function toggleRelType(t) {
  if (!RMAP[t]) return;
  if (relFilter.has(t)) relFilter.delete(t); else relFilter.add(t);
  applyRelFilter();
}
function clearRelFilter() {
  if (!relFilter.size) return;
  relFilter.clear();
  applyRelFilter();
}

/* ---------- 立体布局：语义高度 ----------
   让词网从「平面」变成「立体」：上位词（更抽象）悬浮在当前词所在平面的上方，
   下位词（更具体）垂到平面下方，其余关系（同义词 / 反义词 / 同族派生 /
   近义联想 / 语义相关）与当前词同处一个平面。

   实现上只给每个节点一个**层级 lvl**（0 = 平面，负 = 向上，正 = 向下），
   平面内的 x / y 仍然交给原来的力导向排布 —— 排布质量和原来一样，
   但抽象层级从此一眼可见。渲染时再做一次倾斜透视投影。 */
const LVL_MAX = 2;            // 上下各最多两层，再远的层级都夹到这里（再多画布放不下）
const TILT_KEY = "coca10000.tilt";
const TILT_MAX = 75;          // 视角滑块上限（度）
/* 默认 55°：既看得见平面，也看得清高低；0° = 完全俯视（就是原来的平面视图） */
let tiltDeg = 55;
try {
  const saved = localStorage.getItem(TILT_KEY);
  if (saved != null && !isNaN(+saved)) tiltDeg = Math.max(0, Math.min(TILT_MAX, +saved));
} catch (e) {}
let tilt = tiltDeg * Math.PI / 180;
let LVL_GAP = 50;             // 每层在世界坐标里的垂直高度（会按画布高度自适应）
let CX = 0, CY = 0;           // 世界原点 = 画布中心
const FOC = 1200;             // 透视焦距，越小透视越夸张
const PS_MIN = 0.84, PS_MAX = 1.28;

/* ---------- mastery store ---------- */
const LS = "coca10000.progress.v1";
let prog = {};
try { prog = JSON.parse(localStorage.getItem(LS) || "{}") || {}; } catch (e) { prog = {}; }
const saveProg = () => { try { localStorage.setItem(LS, JSON.stringify(prog)); } catch (e) {} };
const statusOf = i => (prog[D.words[i]] ? prog[D.words[i]].s : 0);
/* 只统计真正学过的词（s=0 的记录是给同步用的“墓碑”，不算数） */
const learnedCount = () => { let n = 0; for (const k in prog) if (prog[k] && prog[k].s) n++; return n; };
const setStatus = (i, s) => {
  /* 取消标记时保留一条 s=0 的记录（墓碑）而不是删除：
     否则另一台设备的旧数据在合并时会把这个词“复活”。 */
  const key = D.words[i];
  const prev = prog[key] || {};
  const now = Date.now();
  const rec = Object.assign({}, prev, { s: s, t: now });
  if (!s) {
    /* 移出复习计划（dueList 只看 s>0 的记录，所以 due=0 不会被收进来） */
    rec.due = 0; rec.ivl = 0; rec.reps = 0;
  } else if (prev.s !== s) {
    /* 手动改掌握度（不是通过复习）→ 给一个起步排期：
       「学习中」表示这个词还在滚动学，立刻进复习队列（标记完就能开始复习，
       否则新用户会看到一个空队列）；
       「已掌握」则 4 天后再回来抽查。 */
    rec.ivl = s === 2 ? 4 : 0;
    rec.due = s === 2 ? now + 4 * DAY : now;
    /* 统计日志：第一次标记 = 新学；第一次升到「已掌握」单独记一笔 */
    if (!prev.s) statBump("nw");
    if (s === 2) statBump("mst");
  }
  prog[key] = rec;
  saveProg();
};

/* ---------- 学习统计日志 ----------
   统计面板要「按天」的行为数据（今天复习了多少张、新学了几个词），
   这些从 prog 里推不出来（prog 只留每个词的当下状态），所以另记一本流水账：

     一天一条记录，只留最近 STAT_KEEP 天
       rv / ok / mid / bad  —— 复习张数，按评分三档拆开（记得 / 有印象 / 忘了）
       nw / mst             —— 新学词数、升到「已掌握」的次数

   老用户升级上来时按 prog 里的 last（上次复习时间）回填一次，
   把「那天复习过多少词」估进 rv，这样不会看到一张空图。 */
const STAT_KEY = "coca10000.stats.v1";
const STAT_BF = "coca10000.stats.bf";
const STAT_KEEP = 140;          /* 只留最近 140 天，够看趋势又不至于撑爆 localStorage */
let stat = {};
try { stat = JSON.parse(localStorage.getItem(STAT_KEY) || "{}") || {}; } catch (e) { stat = {}; }

/* 本地日期（不能用 toISOString：那是 UTC，晚上 8 点后会算到第二天） */
const dayKey = ts => {
  const d = new Date(ts);
  const p = n => (n < 10 ? "0" : "") + n;
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
};
const emptyDay = () => ({ rv: 0, ok: 0, mid: 0, bad: 0, nw: 0, mst: 0 });

function saveStat() {
  const ks = Object.keys(stat).sort();       /* 键就是日期，排序 = 时间顺序 */
  while (ks.length > STAT_KEEP) delete stat[ks.shift()];
  try { localStorage.setItem(STAT_KEY, JSON.stringify(stat)); } catch (e) {}
}
/* 记一笔；带 n 时按张数累计 */
function statBump(field, n) {
  const d = stat[dayKey(Date.now())] || (stat[dayKey(Date.now())] = emptyDay());
  d[field] = (d[field] || 0) + (n || 1);
  saveStat();
}

(function backfillStat() {
  try {
    if (localStorage.getItem(STAT_BF)) return;
    for (const k in prog) {
      const v = prog[k];
      if (!v || !v.s || !v.last) continue;
      const kk = dayKey(v.last);
      const d = stat[kk] || (stat[kk] = emptyDay());
      d.rv += 1;
    }
    saveStat();
    localStorage.setItem(STAT_BF, "1");
  } catch (e) {}
})();

/* ---------- 间隔重复（SRS） ----------
   在「掌握度」之上再挂一个「下次复习时间」：每个词记一个当前间隔 ivl（天）、
   到期时间 due、复习次数 reps、遗忘次数 laps。复习时按三档重新排期：

     忘了   → 间隔清零、掌握度降一级、10 分钟后再来
     有印象 → 间隔小幅延长（×1.3，保底 1 天），掌握度不降
     记得   → 间隔翻倍（新词从 1 天起步），掌握度升一级

   只有掌握度 > 0 的词才会进入复习队列；老版本的记录没有 due 字段，
   一律视为「现在就到期」——升级后它们会自动排进第一轮复习。
   数据全在本机 localStorage，和掌握度共用同一条记录（多出来的字段
   老版本会忽略，互不影响）。 */
const DAY = 86400000;
const SRS_AGAIN_MS = 10 * 60000;   /* 忘了 → 10 分钟后再来一次 */
const SRS_MAX_IVL = 600;           /* 最长间隔：600 天 */

function srsNext(rec, q, now) {
  const s = rec.s || 0, ivl = rec.ivl || 0;
  const out = {
    s: s, t: now, last: now,
    ivl: ivl, due: now,
    reps: (rec.reps || 0) + 1,
    laps: rec.laps || 0
  };
  if (q === 0) {                       /* 忘了 */
    out.s = Math.max(0, s - 1);
    out.ivl = 0;
    out.due = now + SRS_AGAIN_MS;
    out.laps = out.laps + 1;
  } else if (q === 1) {                /* 有印象 */
    out.s = Math.max(1, s);
    out.ivl = Math.min(SRS_MAX_IVL, Math.max(1, Math.round(ivl * 1.3)));
    out.due = now + out.ivl * DAY;
  } else {                             /* 记得 */
    out.s = Math.min(2, s + 1);
    out.ivl = Math.min(SRS_MAX_IVL, ivl ? Math.max(ivl + 1, Math.round(ivl * 2.2)) : 1);
    out.due = now + out.ivl * DAY;
  }
  return out;
}

/* 到期时间：没标记过的词返回 null（不进复习队列） */
const dueAtOf = i => { const r = prog[D.words[i]]; return (r && r.s) ? (r.due || 0) : null; };
const isDue = (i, now) => { const d = dueAtOf(i); return d !== null && d <= (now || Date.now()); };

/* 到期队列：越早到期越靠前；同一时刻按词频层（高频先复习） */
function dueList(now) {
  now = now || Date.now();
  const out = [];
  for (const k in prog) {
    const v = prog[k];
    if (!v || !v.s || (v.due || 0) > now) continue;
    const i = D.idx[k];
    if (i !== undefined) out.push(i);
  }
  out.sort((a, b) =>
    ((prog[D.words[a]].due || 0) - (prog[D.words[b]].due || 0)) || (D.band[a] - D.band[b]));
  return out;
}
function dueCount() {
  const now = Date.now();
  let n = 0;
  for (const k in prog) { const v = prog[k]; if (v && v.s && (v.due || 0) <= now) n++; }
  return n;
}
/* 人话版「下次复习」 */
function dueText(i) {
  const d = dueAtOf(i);
  if (d === null) return "";
  const ms = d - Date.now();
  if (ms <= 0) return "现在到期";
  if (ms < 3600000) return Math.round(ms / 60000) + " 分钟后";
  if (ms < DAY) return Math.round(ms / 3600000) + " 小时后";
  const days = Math.round(ms / DAY);
  if (days <= 45) return days + " 天后";
  return Math.round(days / 30) + " 个月后";
}

/* ---------- data helpers ---------- */
const BAND_NAMES = { 1: "1k", 2: "2k", 3: "3k", 4: "4k", 5: "5k", 6: "6k", 7: "7k", 8: "8k", 9: "9k", 10: "10k" };

/* 每个词层（1000 词一档）各有一种颜色：由高频的暖粉渐变到低频的深蓝，
   这样图上任何一点都能看出它属于哪个频率层 */
const BAND_COLORS = {
  1: "#f43f5e", 2: "#ec4899", 3: "#d946ef", 4: "#a855f7", 5: "#8b5cf6",
  6: "#6366f1", 7: "#3b82f6", 8: "#2563eb", 9: "#1d4ed8", 10: "#1e3a8a"
};
/* 每层的词频排名区间，如 4k => "3001–4000" */
const BAND_RANGE = {};
for (let _b = 1; _b <= 10; _b++) BAND_RANGE[_b] = ((_b - 1) * 1000 + 1) + "–" + (_b * 1000);
const bandColor = b => BAND_COLORS[b] || "#94a3b8";

const isWord = r => r >= 0;
const extraIdx = r => -r - 1;

/* grouped relations of a headword, by type */
function relsOf(i) {
  const list = D.adj[i] || [];
  /* 守卫（数据已在源头上清理过，这里只是兜底）：同一对词既有上位词又有下位词时，
     只保留「上位词」一侧 —— 否则画面上会同时出现紫线和蓝线，
     节点位置还会和线色打架（WordNet 不同义项会形成这种环）。 */
  const key = r => (r < 0 ? "x" : "w") + r;
  const keepTwo = new Set();
  for (const [t, r] of list) if (t === 2) keepTwo.add(key(r));
  const groups = {};
  list.forEach(([t, r]) => {
    if (t === 3 && keepTwo.has(key(r))) return;   /* 上位词优先 */
    (groups[t] = groups[t] || []).push(r);
  });
  return groups;
}
function nodeWord(kind, i) { return kind === "w" ? D.words[i] : D.extra[i]; }

/* ---------- svg setup ---------- */
const svg = d3.select("#graph");
const g = svg.append("g");
/* 立体视图的分层（从下往上）：地面网格 → 悬浮投影柱 → 连线 → 节点 → 标签 */
const gGrid = g.append("g").attr("class", "grid");
const gStalks = g.append("g").attr("class", "stalks");
const gLinks = g.append("g");
gLinks.attr("filter", "url(#fwGlow)");
/* 路径模式：每跳连线中点的关系名标签（普通模式为空） */
const gEdge = g.append("g").attr("class", "edgelbls");
const gNodes = g.append("g");
/* 单独的标签层，画在所有节点之上：
   否则后画的圆点会盖住先画节点下面的单词，看起来就像“线端点没有词”。 */
const gLabels = g.append("g");
const width = () => svg.node().clientWidth;
const height = () => svg.node().clientHeight;

/* ---------- 节点渐变 ----------
   纯色圆点在浅色背景上显得又扁又平。给每种节点颜色配一个
   「左上高光 → 原色」的径向渐变，节点立刻有了球面感和立体感。
   渐变用 objectBoundingBox 坐标，一个定义可以被任意大小的圆复用。 */
const GRAD_EXTRA = ["#16a34a", "#f59e0b", "#cbd5e1", "#94a3b8", "#e2e8f0"];
function lighten(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const L = (r + g + b) / 3;
  const a = L > 200 ? 0.3 : L > 150 ? 0.42 : 0.55;   /* 本来就浅的颜色少提亮，避免和背景糊在一起 */
  const k = amt !== undefined ? amt : a;
  r = Math.round(r + (255 - r) * k);
  g = Math.round(g + (255 - g) * k);
  b = Math.round(b + (255 - b) * k);
  return "#" + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}
const gradId = c => "ng" + c.slice(1);
(function buildDefs() {
  const defs = svg.select("defs").node() ? svg.select("defs") : svg.append("defs");
  Object.values(BAND_COLORS).concat(GRAD_EXTRA).forEach(c => {
    const gd = defs.append("radialGradient")
      .attr("id", gradId(c)).attr("cx", "35%").attr("cy", "28%").attr("r", "78%");
    gd.append("stop").attr("offset", "0%").attr("stop-color", lighten(c));
    gd.append("stop").attr("offset", "100%").attr("stop-color", c);
  });
})();

/* 节点的基础色（用于渐变引用 / 投影柱颜色）与填充 */
function nodeBase(d) {
  const mode = document.getElementById("colorMode").value;
  if (d.kind === "x") return "#e2e8f0";
  if (mode === "flat") return "#94a3b8";
  if (mode === "band") return bandColor(d.band);
  const s = statusOf(d.i);
  return s === 2 ? "#16a34a" : s === 1 ? "#f59e0b" : "#cbd5e1";
}
function nodeFill(d) { return "url(#" + gradId(nodeBase(d)) + ")"; }

/* 层级配色：上位词（更抽象）紫色系、下位词（更具体）青色系 */
const LVLCOL = { up: "#8b5cf6", down: "#0ea5e9" };
const lvlColor = lvl => (lvl < 0 ? LVLCOL.up : lvl > 0 ? LVLCOL.down : null);
const zoomBeh = d3.zoom().scaleExtent([0.25, 4]).on("zoom", e => {
  g.attr("transform", e.transform);
  /* 缩得越小节点越挤：远观时把标签整体淡出，避免糊成一片；
     放大回来立刻恢复，不用重算布局 */
  gLabels.attr("opacity", e.transform.k < 0.7 ? 0.35 : 1);
});
svg.call(zoomBeh);

/* ---------- 一键复位视图 ----------
   展开很多词后又缩放又拖拽，容易偏出画布找不到方向：
   ⤾（视角控件里的按钮，或快捷键 Z）把缩放/平移一次归零，布局不动只动镜头。 */
function resetView() {
  svg.transition().duration(350).call(zoomBeh.transform, d3.zoomIdentity);
}
(function bindReset() {
  const rb = document.getElementById("viewReset");
  if (rb) rb.onclick = resetView;
})();

const tooltip = document.getElementById("tooltip");

/* ---------- graph state ---------- */
let nodes = [], links = [], sim = null;
const nodeMap = new Map();   // id -> node
const linkSet = new Set();   // "a|b|t"
let current = null;          // word index of the focused node
let trail = [];              // history of word indices
let MAXN = 220;

function nodeId(kind, i) { return kind + ":" + i; }

function ensureNode(kind, i, dist) {
  const id = nodeId(kind, i);
  let n = nodeMap.get(id);
  if (n) { n.dist = Math.min(n.dist, dist); return n; }
  n = { id, kind, i, dist, expanded: false,
        lvl: 0,          /* 语义高度：负=上位（更抽象），正=下位（更具体） */
        word: nodeWord(kind, i),
        band: kind === "w" ? D.band[i] : 0 };
  nodes.push(n); nodeMap.set(id, n);
  return n;
}

function ensureLink(a, b, t) {
  const key = a.id + "|" + b.id + "|" + t;
  if (linkSet.has(key)) return;
  linkSet.add(key);
  links.push({ source: a, target: b, t });
}

function radius(d) {
  if (d.kind === "x") return 4.5;
  return 5.5 + (10 - d.band) * 0.75 + (d.id === "w:" + current ? 3 : 0);
}

function startSim() {
  if (sim) sim.stop();
  sim = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id(d => d.id)
      .distance(l => RMAP[l.t].dist).strength(l => RMAP[l.t].str))
    .force("charge", d3.forceManyBody().strength(-300))
    .force("collide", d3.forceCollide().radius(d => radius(d) + 5).iterations(1))
    .force("center", d3.forceCenter(width() / 2, height() / 2))
    .alpha(1).restart();
  draw();
}

function prune() {
  if (nodes.length <= MAXN) return;
  /* 只考虑离当前词两步以外的节点；已掌握的词永远保留，
     用户展开过的节点尽量靠后移除。这样图始终有上限，
     不会膨胀到看不清、节点被挤出画布。 */
  const removable = nodes
    .filter(n => n.dist >= 2 && n.id !== "w:" + current &&
                 !(n.kind === "w" && statusOf(n.i) === 2))
    .sort((a, b) => ((a.expanded ? 1 : 0) - (b.expanded ? 1 : 0)) ||
                    ((statusOf(a.i) === 1 ? 1 : 0) - (statusOf(b.i) === 1 ? 1 : 0)));
  const over = nodes.length - MAXN;
  const kill = new Set(removable.slice(0, Math.max(0, over)).map(n => n.id));
  if (!kill.size) return;
  nodes = nodes.filter(n => !kill.has(n.id));
  kill.forEach(id => nodeMap.delete(id));
  links = links.filter(l => !kill.has(l.source.id) && !kill.has(l.target.id));
  rebuildLinkSet();
}

function rebuildLinkSet() {
  linkSet.clear();
  links.forEach(l => linkSet.add(l.source.id + "|" + l.target.id + "|" + l.t));
}

/* 上位词/下位词这条边会让语义高度 ±1，其余关系不改变高度 */
function lvlDelta(t, reverse) {
  if (t === 2) return reverse ? 1 : -1;    /* 上位词 → 更抽象 → 往上 */
  if (t === 3) return reverse ? -1 : 1;    /* 下位词 → 更具体 → 往下 */
  return 0;
}

/* 从当前词出发做 BFS，给全图推一遍「语义高度」：
   直接关系优先（最短路径），上位词边 -1、下位词边 +1、其余关系不变 ——
   天然满足“上位词在上面、下位词在下面、其余关系留在同一个平面”。 */
function assignLevels() {
  nodes.forEach(n => { n.lvl = 0; });
  if (current === null) return;
  const adj = new Map();
  links.forEach(l => {
    const a = l.source.id, b = l.target.id;
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push([b, l.t, false]);
    adj.get(b).push([a, l.t, true]);   /* 反向走时上下位互换 */
  });
  const start = "w:" + current;
  const best = new Map([[start, 0]]);
  const q = [start];
  let guard = 0;
  while (q.length && guard++ < 40000) {
    const id = q.shift();
    const base = best.get(id);
    (adj.get(id) || []).forEach(([nb, t, rev]) => {
      if (best.has(nb)) return;   /* 最短路径（直接关系）优先 */
      let v = Math.max(-LVL_MAX, Math.min(LVL_MAX, base + lvlDelta(t, rev)));
      best.set(nb, v);
      q.push(nb);
    });
  }
  nodes.forEach(n => { const v = best.get(n.id); if (v !== undefined) n.lvl = v; });
}

function expand(i, opts) {
  opts = opts || {};
  /* 这个下标所属的块（以及词表外词名）还没载入：先取回来再展开。
     数据块只有几百 KB 且常驻缓存，所以正常情况下这一步是同步的。 */
  if (!chunkReady(chunkOf(i)) || !hasExtra) {
    showPartPending(i);
    Promise.all([needExtra(), needChunk(chunkOf(i))])
      .then(() => { clearPartPending(); expand(i, opts); })
      .catch(() => { clearPartPending(); partFailed(() => expand(i, opts), "这个词所在词层的数据没载入成功"); });
    return;
  }
  exitPathMode();          /* 正常展开就离开路径模式（链路高亮不再有意义） */
  const me = ensureNode("w", i, 0);
  me.dist = 0;
  const groups = relsOf(i);
  const near = new Set([me.id]);
  TYPE_PRIORITY.forEach(t => {
    (groups[t] || []).forEach(r => {
      const kind = isWord(r) ? "w" : "x";
      const j = isWord(r) ? r : extraIdx(r);
      const n = ensureNode(kind, j, 1);
      n.dist = 1;
      near.add(n.id);
      ensureLink(me, n, t);
    });
  });
  /* 其它节点离当前词已有两步远：重新计算距离（而不是累加），
     prune 才能知道哪些节点现在离得很远、可以让位。 */
  nodes.forEach(n => { if (!near.has(n.id)) n.dist = 2; });
  me.expanded = true;
  current = i;
  prune();
  assignLevels();
  if (opts.reset) {
    const c = g.select("#" + cssId(me.id));
    if (!c.empty()) {
      me.x = width() / 2; me.y = height() / 2;
      me.fx = null;
    }
  }
  startSim();
  renderPanel(i);
  renderTrail();
  try { localStorage.setItem("coca10000.last", String(i)); } catch (e) {}
}

function cssId(id) { return "n" + id.replace(/[^a-zA-Z0-9]/g, "_"); }

function focusCurrent() {
  if (current === null) return;
  exitPathMode();
  const keep = new Set(["w:" + current]);
  (D.adj[current] || []).forEach(([t, r]) => keep.add(isWord(r) ? "w:" + r : "x:" + extraIdx(r)));
  nodes = nodes.filter(n => keep.has(n.id));
  nodeMap.clear(); nodes.forEach(n => nodeMap.set(n.id, n));
  const me = nodeMap.get("w:" + current);
  nodes.forEach(n => { n.expanded = (n === me); if (n !== me) n.dist = 1; });
  me.dist = 0;
  links = links.filter(l => l.source === me || l.target === me);
  rebuildLinkSet();
  assignLevels();
  startSim();
}

function clearGraph() {
  exitPathMode();
  nodes = []; links = []; nodeMap.clear(); linkSet.clear();
  current = null; trail = [];
  gLinks.selectAll("*").remove();
  gNodes.selectAll("*").remove();
  gLabels.selectAll("*").remove();
  gStalks.selectAll("*").remove();
  paint();
  if (sim) sim.stop();
  document.getElementById("emptyState").classList.remove("hidden");
  document.getElementById("detail").classList.add("hidden");
  document.getElementById("ph").classList.remove("hidden");
  renderTrail();
  try { localStorage.removeItem("coca10000.last"); } catch (e) {}
}

/* ---------- 路径查找：两个词之间沿关系的最短链路 ----------
   比“直接告诉你它们是近义词”有意思得多：让学习者看见
   「act → 同义词 play → 上位词 …」这样一跳一跳的语义联想。
   做法是关系图上的 BFS：第一遍只走语义明确的关系（同义/反义/上下位/派生/近义），
   找不到通路才允许经过「语义相关」（词共现，最弱的一类）。 */
const PATH_MAX_HOPS = 6;
let pathState = null;      // { steps, weak }
let edgeSel = null;        // 连线中点上的关系名
let extraMap = null;
function extraIndexOf(word) {
  if (!D.extra || !D.extra.length) return -1;      /* 词表外词名还没载入 */
  if (!extraMap) { extraMap = new Map(); D.extra.forEach((w, k) => extraMap.set(w, k)); }
  return extraMap.has(word) ? extraMap.get(word) : -1;
}
/* 输入解析：词表内 → 别名（词族联想）→ 词表外关联词 */
function resolveWord(s) {
  s = String(s == null ? "" : s).trim().toLowerCase();
  if (!s) return null;
  if (D.idx[s] !== undefined) return { kind: "w", i: D.idx[s], word: s };
  if (D.alias && D.alias[s] !== undefined) {
    const w = D.alias[s];
    if (D.idx[w] !== undefined) return { kind: "w", i: D.idx[w], word: w };
  }
  const k = extraIndexOf(s);
  if (k >= 0) return { kind: "x", i: k, word: s };
  return null;
}
/* BFS：只展开词表内的词（词表外词没有任何向外的关系，是叶子），
   所以词表外词只能作为最后一跳的终点 —— 比如 act → give up。 */
function bfsPath(from, to, opts) {
  opts = opts || {};
  const maxDepth = opts.maxDepth || PATH_MAX_HOPS;
  if (from.kind !== "w") return null;
  const startId = "w:" + from.i, goalId = to.kind + ":" + to.i;
  if (startId === goalId) return [{ kind: from.kind, i: from.i, t: null }];
  const par = new Map([[startId, null]]);   // id -> [上一跳 id, 关系类型]
  const q = [[from.i, 0]];
  let head = 0, guard = 0;
  while (head < q.length && guard < 300000) {
    const cur = q[head++], i = cur[0], d = cur[1];
    if (d >= maxDepth) continue;
    const rels = D.adj[i] || [];
    for (let k = 0; k < rels.length; k++) {
      guard++;
      const t = rels[k][0], r = rels[k][1];
      if (!opts.weak && t === 6) continue;      /* 第一遍绕开最弱的「语义相关」 */
      const kind = r >= 0 ? "w" : "x";
      const j = r >= 0 ? r : extraIdx(r);
      const id = kind + ":" + j;
      if (par.has(id)) continue;
      par.set(id, ["w:" + i, t]);
      if (id === goalId) return tracePath(par, id);
      if (kind === "x") continue;               /* 词表外词没有再往外的关系 */
      q.push([j, d + 1]);
    }
  }
  return null;
}
function tracePath(par, id) {
  const ids = [];
  let cur = id;
  while (cur) { ids.unshift(cur); const p = par.get(cur); cur = p ? p[0] : null; }
  return ids.map(sid => {
    const c = sid.indexOf(":");
    const p = par.get(sid);
    return { kind: sid.slice(0, c), i: +sid.slice(c + 1), t: p ? p[1] : null };
  });
}
/* 把链路画进词网：只画链路本身 —— 编号 + 关系名 + 加粗连线，每一跳都看得清 */
function drawPath(steps, weak) {
  exitPathMode();
  nodes = []; links = []; nodeMap.clear(); linkSet.clear();
  const seq = steps.map(s => ensureNode(s.kind, s.i, 0));
  seq.forEach((n, k) => { n.dist = 0; n.pathIdx = k + 1; });
  for (let k = 1; k < seq.length; k++) ensureLink(seq[k - 1], seq[k], steps[k].t);
  current = steps[0].kind === "w" ? steps[0].i : null;
  pathState = { steps: steps, weak: !!weak };
  /* 均匀铺开 + 上下交错：链路先后顺序一眼可读，也不会被力导向揉成一团。
     起点放上面一排、x 从图例右侧开始 —— 避开左下角图例和右下角视角控件 */
  const W = width(), H = height(), n = seq.length;
  const x0 = Math.max(320, W * 0.30), x1 = W * 0.92, amp = Math.min(H * 0.15, 115);
  seq.forEach((nn, k) => {
    nn.x = n === 1 ? (x0 + x1) / 2 : x0 + (x1 - x0) * k / (n - 1);
    nn.y = H / 2 + (k % 2 ? amp : -amp);
    nn.fx = nn.x; nn.fy = nn.y;
  });
  document.getElementById("emptyState").classList.add("hidden");
  const b = document.getElementById("pathBtn");
  if (b) b.classList.add("on");
  assignLevels();
  startSim();
  if (current !== null) renderPanel(current);
}
function exitPathMode() {
  if (!pathState) return;
  pathState = null;
  nodes.forEach(n => {
    n.pathIdx = 0;
    if (n.fx !== null && n.fx !== undefined) { /* 解除链路布局的钉位，恢复力导向 */
      n.x = n.fx; n.y = n.fy; n.fx = null; n.fy = null;
    }
  });
  if (edgeSel) { edgeSel.remove(); edgeSel = null; }
  gEdge.selectAll("*").remove();
  const b = document.getElementById("pathBtn");
  if (b) b.classList.remove("on");
  /* 标签文字/配色不归 paint() 管，这里得主动刷一次，否则编号会留在屏幕上 */
  styleNodeLabels();
  paint();
}
function renderEdgeLabels() {
  if (!pathState) { gEdge.selectAll("*").remove(); edgeSel = null; return; }
  const sel = gEdge.selectAll("text").data(links, l => l.source.id + "|" + l.target.id);
  sel.exit().remove();
  edgeSel = sel.enter().append("text")
    .attr("class", "elbl").attr("text-anchor", "middle")
    .style("pointer-events", "none")
    .merge(sel)
    .text(l => RMAP[l.t].name);
  paintEdgeLabels();
}
function paintEdgeLabels() {
  if (!edgeSel) return;
  edgeSel
    .attr("x", l => (l.source.px + l.target.px) / 2)
    .attr("y", l => (l.source.py + l.target.py) / 2 - 7);
}
/* 节点标签的文字与配色（draw() 和退出路径模式时都要刷新，所以单独抽出来） */
function styleNodeLabels() {
  if (!labelSel) return;
  labelSel
    .attr("class", d => "lbl" + (d.id === "w:" + current ? " cur" : "") + (d.pathIdx ? " path" : ""))
    .attr("fill", d => (d.pathIdx || d.id === "w:" + current ? "#1d4ed8"
      : d.kind === "x" ? "#64748b" : "#334155"))
    .text(d => (d.pathIdx ? d.pathIdx + ". " + d.word : d.word));
}

/* ---------- drawing ---------- */
let nodeSel = null, linkSel = null, labelSel = null, stalkSel = null;

/* ---------- 立体投影：分层带（strata） ----------
   世界坐标：X 向右、Y 在平面内向下、Z 向上（= 语义高度）。

   为什么不是「把整张平面倾斜一下」了事：斜着看平面时，平面自身的纵向跨度
   （画布高度的量级）远大于层与层之间的落差，平面前排的节点会比后排的上位词
   还低 —— 那样「上位词在上面」根本读不出来。

   所以改成**分层带**：
     · 每个语义层级（0 / ±1 / ±2）占一条水平带，带高按该层节点数分配，互不重叠；
       于是「上位词一定在平面之上、下位词一定在平面之下」是结构性保证的；
     · 带内仍按透视投影排布（近大远小、网格收敛），立体感来自投影而非错位；
     · tilt 控制透视的倾斜程度：0° = 正俯视（层与层只是上下两条并列的带）。
   每个层级还有一个仿射系数 (a,b)，把该层投影后的纵向范围铺满自己的带。 */
function projXYZ(x, y, z) {
  const st = Math.sin(tilt), ct = Math.cos(tilt);
  const X = x - CX, Y = y - CY;
  const depth = Y * st + z * ct;
  let p = FOC / (FOC + depth);
  if (p < PS_MIN) p = PS_MIN; else if (p > PS_MAX) p = PS_MAX;
  return [CX + X * p, CY + (Y * ct - z * st) * p, p];
}
/* 世界坐标里 Z 正方向朝上，而 lvl 是「负 = 上位」——所以这里取反 */
const lvlZ = d => -(d.lvl || 0) * LVL_GAP;

/* ---------- 分层带 ---------- */
let bands = new Map();          // lvl -> { top, h, bottom, a, b }
const BAND_MT = 62, BAND_MB = 52;
/* 平面（世界坐标）的纵向范围 —— 分层带的仿射、网格、地板、节点夹取都用它，
   必须一致，否则节点会被映射到带外。 */
const gy0 = () => BAND_MT - 22, gy1 = () => height() - BAND_MB + 22;
const FLAT_DEG = 8;             // 视角低于这个度数就当作原来的平面视图
const isFlat = () => tiltDeg < FLAT_DEG;
/* 平面视图下所有层级合并到一条带里（= 原来的样子），立体视角下才分层 */
const bandKey = lvl => (isFlat() || !bands.has(lvl) ? 0 : lvl);

function buildBands() {
  const H = height();
  const avail = H - BAND_MT - BAND_MB;
  const counts = new Map();
  nodes.forEach(n => {
    const k = isFlat() ? 0 : (n.lvl || 0);
    counts.set(k, (counts.get(k) || 0) + 1);
  });
  bands = new Map();
  if (!counts.size || avail <= 0) return;
  const lvls = Array.from(counts.keys()).sort((x, y) => x - y);   // 上位词（负）排在最前
  const gap = lvls.length > 1 ? Math.min(18, avail * 0.022) : 0;
  const weights = lvls.map(l => 2 + Math.sqrt(counts.get(l)));
  const sumW = weights.reduce((x, y) => x + y, 0);
  const usable = avail - gap * (lvls.length - 1);
  let top = BAND_MT;
  lvls.forEach((l, k) => {
    const h = usable * weights[k] / sumW;
    bands.set(l, { top: top, h: h, bottom: top + h, a: 1, b: 0 });
    top += h + gap;
  });
  /* 每个层的仿射：把该层在参考平面上的投影纵向范围 [ry0, ry1] 铺满自己的带 */
  bands.forEach((bd, l) => {
    const z = -l * LVL_GAP;
    const ry0 = ryOf(gy0() - CY, z), ry1 = ryOf(gy1() - CY, z);
    const span = (ry1 - ry0) || 1;
    bd.a = (bd.h - 14) / span;
    bd.b = bd.top + 7 - bd.a * ry0;
  });
}
function ryOf(Y, z) {
  const st = Math.sin(tilt), ct = Math.cos(tilt);
  const depth = Y * st + z * ct;
  let p = FOC / (FOC + depth);
  if (p < PS_MIN) p = PS_MIN; else if (p > PS_MAX) p = PS_MAX;
  return CY + (Y * ct - z * st) * p;
}
/* 投影后的纵向坐标 → 该层带内的画面纵向坐标 */
function mapY(ry, lvl) {
  const bd = bands.get(lvl || 0);
  return bd ? bd.a * ry + bd.b : ry;
}
function project(d) {
  const r = projXYZ(d.x == null ? CX : d.x, d.y == null ? CY : d.y, lvlZ(d));
  d.px = r[0]; d.py = mapY(r[1], bandKey(d.lvl || 0)); d.ps = r[2];
}
/* 拖拽用：把画面坐标反推回平面坐标（迭代几轮就收敛） */
function unproject(sx, sy, z, lvl) {
  const bd = bands.get(lvl || 0);
  const ry = bd ? (sy - bd.b) / (bd.a || 1) : sy;
  const st = Math.sin(tilt), ct = Math.cos(tilt) || 1e-6;
  let p = 1, Y = 0;
  for (let k = 0; k < 6; k++) {
    Y = ((ry - CY) / p + z * st) / ct;
    p = FOC / (FOC + (Y * st + z * ct));
    if (p < PS_MIN) p = PS_MIN; else if (p > PS_MAX) p = PS_MAX;
  }
  return [CX + (sx - CX) / p, CY + Y];
}

/* ---------- 层级小标签（不画任何平面/网格，只留文字提示） ---------- */
/* 左侧层级小标签的文字（不放色块底子，靠 CSS 白描边保证可读） */
const axText = l => isFlat() ? "平面视图 · 上下位词与当前词同层"
  : (l < 0 ? "▲ 上位词" + (l < -1 ? " " + (-l) + " 级" : "")
    : l > 0 ? "▼ 下位词" + (l > 1 ? " " + l + " 级" : "")
    : "当前词");
function paintGrid() {
  /* 只留左上角一枚小字标签标明每层含义，不画搁板/圆牌/网格 */
  const lvls = Array.from(bands.keys());
  gGrid.selectAll("text.axlbl").data(lvls, l => l).join(
    enter => enter.append("text").attr("class", "axlbl").attr("x", 10).attr("font-size", 10)
      .style("pointer-events", "none"),
    update => update,
    exit => exit.remove()
  )
   .attr("y", l => bands.get(l).top + 13)
   .attr("fill", l => (l < 0 ? "#8b5cf6" : l > 0 ? "#0ea5e9" : "#94a3b8"))
   .attr("fill-opacity", 0.75)
   .text(l => axText(l));
}

/* 越高/越低的层颜色越淡，帮助分辨高低（平面视图下不淡化） */
const lvlOpacity = lvl =>
  (lvl === 0 || isFlat() ? 1 : Math.max(0.55, 0.88 - (Math.abs(lvl) - 1) * 0.14));

/* 把模拟出来的平面坐标投到画面上：连线、节点、标签、投影柱全部在这里更新 */
function paint() {
  const W = width(), H = height();
  CX = W / 2; CY = H / 2;
  /* 层间距：只影响层间的透视缩放与投影柱长度，层级本身的上下由分层带保证 */
  LVL_GAP = Math.max(46, Math.min(96, H * 0.10));

  /* 空画布上只留干净的背景 */
  if (!nodes.length) {
    bands = new Map();
    gGrid.attr("display", "none");
    gStalks.attr("display", "none");
    return;
  }
  gGrid.attr("display", null);
  /* 平面视图下没有高低差，投影柱没有意义 */
  gStalks.attr("display", isFlat() ? "none" : null);

  const mx = 42, lo = gy0(), hi = gy1();
  nodes.forEach(d => {
    if (d.x == null || d.y == null) return;
    if (d.x < mx) d.x = mx; else if (d.x > W - mx) d.x = W - mx;
    if (d.y < lo) d.y = lo; else if (d.y > hi) d.y = hi;
  });
  buildBands();
  nodes.forEach(d => {
    project(d);
    if (d.px < mx) d.px = mx; else if (d.px > W - mx) d.px = W - mx;
  });

  paintGrid();

  /* 投影柱：非平面上的节点垂一条彩色圆点线到主平面，立体感的关键。
     颜色跟节点走（掌握度/词频层），比一排灰虚线柔和也更有信息量 */
  stalkSel = gStalks.selectAll("line").data(nodes.filter(n => n.lvl), n => n.id);
  stalkSel.exit().remove();
  stalkSel = stalkSel.enter().append("line")
    .attr("stroke-width", 1.2)
    .attr("stroke-opacity", 0.30)
    .attr("stroke-dasharray", "1 4")
    .attr("stroke-linecap", "round")
    .merge(stalkSel);
  stalkSel.attr("stroke", d => nodeBase(d));
  stalkSel.attr("stroke-opacity", d => (litNodes && !litNodes.has(d.id) ? 0.07 : 0.30));
  stalkSel.each(function (d) {
    const a = projXYZ(d.x, d.y, lvlZ(d));
    const b = projXYZ(d.x, d.y, 0);
    d3.select(this).attr("x1", a[0]).attr("y1", mapY(a[1], bandKey(d.lvl || 0)))
      .attr("x2", b[0]).attr("y2", mapY(b[1], 0));
  });

  if (linkSel) linkSel
    .attr("x1", l => l.source.px).attr("y1", l => l.source.py)
    .attr("x2", l => l.target.px).attr("y2", l => l.target.py)
    .attr("stroke-opacity", l => {
      if (pathState) return 0.92;                 /* 路径模式：链路要跳出来 */
      const off = relFilter.size && !relFilter.has(l.t);
      const base = l.t === 6 ? 0.35 : 0.6;
      const k = ((l.source.ps || 1) + (l.target.ps || 1)) / 2;
      const v = base * (0.5 + 0.62 * k);
      if (off) return 0.06;                       /* 没勾选的关系几乎淡出，只留一点点提示 */
      /* 开了开关时，被勾选的线再亮一档，对比更明显 */
      return relFilter.size ? Math.min(1, v * 1.45 + 0.16) : Math.min(1, v);
    })
    .attr("stroke-width", l => {
      if (pathState) return 3.4;
      const w = l.t === 4 ? 2.3 : l.t === 6 ? 1 : 1.8;
      const k = ((l.source.ps || 1) + (l.target.ps || 1)) / 2;
      let v = w * Math.max(0.7, Math.min(1.35, k));
      if (relFilter.size && !relFilter.has(l.t)) v *= 0.55;
      return v;
    });
  paintEdgeLabels();
  if (nodeSel) nodeSel
    .attr("transform", d => "translate(" + d.px + "," + d.py + ") scale(" + (d.ps || 1) + ")")
    .attr("opacity", d => lvlOpacity(d.lvl || 0) * nodeDim(d));
  if (labelSel) labelSel
    .attr("x", d => d.px)
    .attr("y", d => d.py + radius(d) * (d.ps || 1) + 12)
    .attr("font-size", d => (d.kind === "x" ? 10 : d.id === "w:" + current ? 14 : 11) *
      Math.max(0.86, Math.min(1.16, (d.ps || 1) * 0.75 + 0.25)))
    .attr("opacity", d => lvlOpacity(d.lvl || 0) * nodeDim(d));
}

function draw() {
  nodeSel = gNodes.selectAll("g.node").data(nodes, d => d.id);
  nodeSel.exit().remove();
  const enter = nodeSel.enter().append("g").attr("class", "node")
    .attr("id", d => cssId(d.id))
    .call(d3.drag()
      .on("start", (e, d) => { if (!e.active) sim.alphaTarget(0.25).restart(); d.fx = d.x; d.fy = d.y; })
      /* 鼠标位置是**投影后**的画面坐标，斜视角下不能直接当作平面坐标：
         先反投影回平面，否则拖动起来会“跟不上手”。 */
      .on("drag", (e, d) => { const c = unproject(e.x, e.y, lvlZ(d), d.lvl); d.fx = c[0]; d.fy = c[1]; })
      .on("end", (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));

  /* 层级光晕：上位词紫、下位词青 —— 立体视图里一眼认出节点悬浮在哪个高度
     （画在圆点下面，所以先 append；平面视图里用 .flatview 类整体隐藏） */
  enter.append("circle")
    .attr("class", "glow")
    .style("pointer-events", "none");

  enter.append("circle")
    .attr("class", "vis")
    .attr("r", radius)
    .attr("fill", nodeFill)
    .attr("stroke", "rgba(255,255,255,0.95)")
    .attr("stroke-width", 1.4)
    .style("pointer-events", "none");

  /* 当前词的旋转虚线环：焦点一眼可见，又不喧宾夺主 */
  enter.append("circle")
    .attr("class", "ring")
    .attr("fill", "none")
    .attr("stroke", "#2563eb").attr("stroke-width", 1.6)
    .attr("stroke-dasharray", "4 6")
    .style("pointer-events", "none");

  /* transparent, larger hit area — makes the small out-of-list dots easy to click */
  enter.append("circle")
    .attr("class", "hit")
    .attr("r", d => radius(d) + (d.kind === "x" ? 8 : 3))
    .attr("fill", "transparent")
    .style("cursor", "pointer")
    .style("pointer-events", "all");

  const all = enter.merge(nodeSel);
  /* paint() 每帧按投影结果摆位置，必须拿到**合并后**的选择集，
     否则这一帧新加进来的节点不会被摆上去。 */
  nodeSel = all;
  all.select("circle.glow")
    .attr("r", d => radius(d) + 6)
    .attr("fill", d => lvlColor(d.lvl) || "none")
    .attr("opacity", d => (lvlColor(d.lvl) ? 0.15 : 0));
  all.select("circle.vis")
    .attr("r", radius)
    .attr("fill", nodeFill)
    .attr("stroke", d => (d.id === "w:" + current ? "#1d4ed8"
      : d.kind === "x" ? "#9fb0c6" : "#fff"))
    .attr("stroke-width", d => (d.id === "w:" + current ? 3 : d.kind === "x" ? 1.2 : 1.4));
  all.select("circle.ring")
    .attr("r", d => radius(d) + 5.5)
    .attr("display", d => (d.id === "w:" + current ? null : "none"));
  all.select("circle.hit")
    .attr("r", d => radius(d) + (d.kind === "x" ? 8 : 3));

  all.on("click", (e, d) => {
      e.stopPropagation();
      if (d.kind === "w") {
        /* 路径模式下点节点只“看”，不展开 —— 否则链路会被新节点淹没 */
        if (pathState) renderPanel(d.i);
        else if (d.i !== current) { trail.push(current); if (trail.length > 24) trail.shift(); expand(d.i); }
        else renderPanel(d.i);
      } else {
        /* out-of-list word: no network behind it — just show what we know */
        renderPanel(null, d);
      }
      /* 词表内的词和词表外的词一样：点一下就先朗读，
         面板顶部同时给出 音标 / 释义，一眼就能看清。 */
      speak(d.word);
    })
    .on("dblclick", (e, d) => { e.stopPropagation(); if (d.kind === "w") expand(d.i, { reset: true }); })
    .on("mouseenter", (e, d) => {
      d3.select(e.currentTarget).select("circle.vis").attr("r", radius(d) + 3);
      showTip(e, d);
    })
    .on("mousemove", (e, d) => moveTip(e))
    .on("mouseleave", (e, d) => {
      d3.select(e.currentTarget).select("circle.vis").attr("r", radius(d));
      hideTip();
    });

  linkSel = gLinks.selectAll("line").data(links, l => l.source.id + "|" + l.target.id + "|" + l.t);
  linkSel.exit().remove();
  const le = linkSel.enter().append("line")
    .attr("stroke", l => RMAP[l.t].color)
    .attr("stroke-linecap", "round")
    .attr("stroke-opacity", l => (l.t === 6 ? 0.35 : 0.6))
    .attr("stroke-width", l => (l.t === 4 ? 2.3 : l.t === 6 ? 1 : 1.8))
    .attr("stroke-dasharray", l => (l.t === 4 ? "4 3" : null));
  linkSel = le.merge(linkSel);

  /* 关系开关：先算好「哪些节点还挂在点亮的关系上」，paint() 每帧直接查表 */
  computeLit();

  /* 标签层：永远在节点之上，位置跟随节点。
     白色描边（paint-order: stroke）让文字压在连线上也读得清 */
  labelSel = gLabels.selectAll("text").data(nodes, d => d.id);
  labelSel.exit().remove();
  labelSel = labelSel.enter().append("text")
    .attr("class", "lbl")
    .attr("text-anchor", "middle")
    .style("pointer-events", "none")
    .merge(labelSel);
  styleNodeLabels();

  paintGrid();
  paint();
  /* 路径模式：在每跳连线的中点标出关系名（普通模式下这一步什么也不做） */
  renderEdgeLabels();

  /* sim 只有在展开过词之后才存在：空画布上合并进度时 draw() 会被直接调用，
     这里必须判空，否则整段刷新会中断。 */
  if (sim) sim.on("tick", paint);
}

svg.on("click", () => { document.getElementById("sugg").classList.add("hidden"); });

function showTip(e, d) {
  let html = "<b>" + d.word + "</b>";
  if (d.kind === "w") {
    const ph = D.phon[d.i];
    if (ph) html += ' <span class="tp">/' + ph + "/</span>";
    html += ' <span class="tp">· ' + BAND_NAMES[D.band[d.i]] + "词层（第 " + BAND_RANGE[D.band[d.i]] + " 词）</span>";
    const tr = (D.trans[d.i] || "").split("；")[0];
    if (tr) html += "<br>" + tr.slice(0, 90);
  } else {
    const ph = extraPhon(d.i);
    const tr = (extraTrans(d.i) || "").split("；")[0];
    html += ' <span class="tp">词表外</span>';
    if (ph) html += ' <span class="tp">/' + ph + "</span>";
    if (tr) html += "<br>" + tr.slice(0, 90);
    html += '<br><span class="tp">点击听发音 · 查看释义</span>';
  }
  tooltip.innerHTML = html;
  tooltip.classList.remove("hidden");
  moveTip(e);
}
function moveTip(e) {
  const r = svg.node().getBoundingClientRect();
  let x = e.clientX - r.left + 14, y = e.clientY - r.top + 14;
  if (x + 290 > r.width) x -= 300;
  if (y + 80 > r.height) y -= 90;
  tooltip.style.left = x + "px"; tooltip.style.top = y + "px";
}
function hideTip() { tooltip.classList.add("hidden"); }

/* ---------- side panel ---------- */
const $ = id => document.getElementById(id);

/* ---------- American pronunciation ---------- */
let US_VOICE = null, curAudio = null;
function pickVoice() {
  if (!("speechSynthesis" in window)) return;
  const vs = speechSynthesis.getVoices();
  US_VOICE =
    vs.find(v => /^en[-_]US/i.test(v.lang)) ||
    vs.find(v => /English \(United States\)/i.test(v.name)) ||
    vs.find(v => /^en/i.test(v.lang)) || null;
}
if ("speechSynthesis" in window) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}
function speakLocal(word) {
  if (!("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(word);
  u.lang = "en-US";
  u.rate = 0.85;
  if (US_VOICE) u.voice = US_VOICE;
  /* 这里**不要**再 cancel 一次：speak() 开头已经处理过打断，
     同一 tick 里 cancel()+speak() 连调会让 Chrome / iOS 把这次朗读吞掉。 */
  try { speechSynthesis.speak(u); } catch (e) {}
}

/* ---- 发音音源 ----
   ① 有道真人音（type=2 美音）：单字几乎全有，但**短语约 55% 它没有音频**，
      这种情况它返回 HTTP 500（内容是 JSON 不是 mp3），<audio> 立刻报错（媒体错误码 4）。
   ② ResponsiveVoice 的 en-US 语音（默认的 g1 = Google 美音）：
      **任意文本都能读**，实测 42 条真实搭配 42 条成功、350–900ms。
      它同样是普通的 <audio> 网络音频，所以 iPad 上也能出声。
   ③ 浏览器本地语音合成：离线兜底。

   关键：音源顺序在**点击那一刻同步决定**（用已缓存的探测结果），
   因为 iOS 只认用户手势 —— 等播放失败再异步回退，iOS 会静默丢帧、什么也听不到。
   所以：已知没有真人音的短语 → 直接用 ②；没探测过的短语 → 也用 ②（反向概率低）。 */
const YOUDAO_VOICE = w => "https://dict.youdao.com/dictvoice?audio=" + encodeURIComponent(w) + "&type=2";
/* sv=g1 是唯一在浏览器里可用的高质量美音（m1/m2/f1/f2/默认值都返回空音频） */
const RV_VOICE = w => "https://code.responsivevoice.org/getvoice.php?t=" + encodeURIComponent(w) +
  "&tl=en-US&sv=g1&vn=&pitch=0.5&rate=0.5&vol=1";
const HAS_DICT_KEY = "coca10000.hasdict.v1";
const PROBE_FRESH = 7 * 24 * 3600 * 1000;   /* 探测结果 7 天内有效 */

let hasDict = {};
try { hasDict = JSON.parse(localStorage.getItem(HAS_DICT_KEY) || "{}") || {}; } catch (e) { hasDict = {}; }
function rememberDict(w, ok) {
  hasDict[w] = { ok: ok, t: Date.now() };
  const keys = Object.keys(hasDict);
  if (keys.length > 4000) {          /* 只留最近的，避免 localStorage 无限膨胀 */
    keys.sort((a, b) => (hasDict[b].t || 0) - (hasDict[a].t || 0)).slice(3000).forEach(k => delete hasDict[k]);
  }
  try { localStorage.setItem(HAS_DICT_KEY, JSON.stringify(hasDict)); } catch (e) {}
}

/* 静默探测若干词有没有真人音（只下元数据，不播放） */
function probeDict(words) {
  if (navigator.onLine === false) return;
  words.forEach(w => {
    const rec = hasDict[w];
    if (rec && Date.now() - (rec.t || 0) < PROBE_FRESH) return;
    hasDict[w] = { ok: false, t: Date.now(), probing: true };   /* 占位，避免同一批重复探测 */
    let a;
    try { a = document.createElement("audio"); } catch (e) { return; }
    a.preload = "metadata";
    let settled = false;
    const finish = (ok, hard) => {
      if (settled) return;
      settled = true;
      /* 只有"这个源本身没有内容"（媒体错误码 4 / 被 ORB 拦）才记成没有；
         网络类失败保持"未知"，下次还会再试，免得把好词误判成没音频。 */
      if (ok) rememberDict(w, true);
      else if (hard) rememberDict(w, false);
      else {
        delete hasDict[w];
        try { localStorage.setItem(HAS_DICT_KEY, JSON.stringify(hasDict)); } catch (e) {}
      }
      try { a.removeAttribute("src"); a.load(); } catch (e) {}
    };
    a.addEventListener("loadedmetadata", () => finish(true));
    a.addEventListener("error", () => finish(false, !!(a.error && a.error.code === 4)));
    setTimeout(() => finish(false, false), 6000);
    a.src = YOUDAO_VOICE(w);
  });
}

/* btn: 可选，点击的那个小按钮（搭配/关联词），一起显示播放态 */
function speak(word, btnEl, onDone) {
  if (!word) return;
  const btn = $("dSpeak");
  btn.classList.add("playing");
  if (btnEl) btnEl.classList.add("playing");
  let over = false;
  const done = () => {
    if (over) return;
    over = true;
    btn.classList.remove("playing");
    if (btnEl) btnEl.classList.remove("playing");
    /* 通读全段靠这个回调一句接一句（本地兜底那条路不会调它） */
    if (onDone) { try { onDone(); } catch (e) {} }
  };

  if (curAudio) { try { curAudio.pause(); } catch (e) {} curAudio = null; }
  /* 只在**真的正在朗读**时才打断：无事发生时的 cancel() 紧接 speak() 会被浏览器吞掉 */
  if ("speechSynthesis" in window && (speechSynthesis.speaking || speechSynthesis.pending)) {
    try { speechSynthesis.cancel(); } catch (e) {}
  }

  const online = navigator.onLine !== false;
  const known = hasDict[word];
  const dictBad = !!(known && known.ok === false);          /* 探测过：确定没有真人音 */
  const dictGood = !!(known && known.ok === true);          /* 探测过：确定有真人音 */
  const isPhrase = /\s/.test(word);

  /* 同步排好音源顺序，点击手势不丢 */
  const srcs = [];
  if (online) {
    /* 单字默认先试真人音；短语只有在"确认有真人音"时才先试，
       否则直接用 ②（短语没有真人音的概率太高，先失败会白白拖 600ms） */
    if (!dictBad && (!isPhrase || dictGood)) srcs.push(["dict", YOUDAO_VOICE(word)]);
    srcs.push(["rv", RV_VOICE(word)]);
  }

  let i = 0;
  const next = () => {
    if (over) return;
    if (i >= srcs.length) { done(); speakLocal(word); return; }   /* 离线 / 都失败 → 本地语音 */
    const tag = srcs[i][0], url = srcs[i][1];
    i++;
    let a;
    try { a = new Audio(url); } catch (e) { next(); return; }
    curAudio = a;
    let moved = false, started = false, timer = 0;
    /* onerror 和 play() 的 reject 会同时到达 —— 必须去重，
       否则本地 TTS 会被连叫两遍，cancel()+speak() 互相打断反而没声音。 */
    const skip = hard => {
      if (moved || over) return;
      moved = true;
      clearTimeout(timer);
      try { a.pause(); } catch (e) {}
      if (curAudio === a) curAudio = null;
      /* 只有"源本身没内容"（媒体错误码 4）才记进缓存，网络抖动不记 */
      if (hard && online && tag === "dict") rememberDict(word, false);
      next();
    };
    a.addEventListener("error", () => skip(!!(a.error && a.error.code === 4)));
    a.addEventListener("playing", () => { started = true; clearTimeout(timer); });
    a.onended = done;
    /* 网络卡住时 play() 既不 resolve 也不 reject，加个看门狗避免永远没声 */
    timer = setTimeout(() => { if (!started) skip(false); }, 4200);
    const p = a.play();
    if (p && p.catch) p.catch(e => skip(!!(e && e.name === "NotSupportedError")));
  };
  next();
}
function speakCurrent() {
  /* 先看 extraCurrent：点词网里的「词表外关联词」节点**不会**改 current
     （current 仍是上一个词表内焦点），只看 current 的话，卡片上明明写着
     afterward，念出来的却是 after。extraCurrent 只在词表外卡片显示时非空
     （renderPanel 渲染词表内词时会把它清掉），所以它就是"当前卡片"。 */
  if (extraCurrent !== null) speak(extraCurrent);
  else if (current !== null) speak(D.words[current]);
}
$("dSpeak").onclick = speakCurrent;
$("dPhon").style.cursor = "pointer";
$("dPhon").onclick = speakCurrent;

/* ---------- 释义排版：按词性 / 义项分列 ---------- */
/* 数据格式：def 用「字面 \n」（反斜杠+n 两个字符！）分隔义项；
   trans 用「；」分组、组内用「,」分义项，可能带 [计]/[化] 这类领域标记。 */
const POS_ZH = {
  n: "名词", v: "动词", vt: "及物动词", vi: "不及物动词", adj: "形容词", a: "形容词", s: "形容词",
  adv: "副词", ad: "副词", r: "副词", prep: "介词", p: "介词", conj: "连词", c: "连词",
  pron: "代词", num: "数词", art: "冠词", int: "感叹词", interj: "感叹词", aux: "助动词",
  modal: "情态动词", abbr: "缩写", pl: "复数", det: "限定词", part: "分词", u: "不可数名词",
  vbl: "动词性", auxil: "助动词"
};
const DOM_ZH = {
  "计": "计算机", "化": "化学", "医": "医学", "法": "法律", "网络": "网络用语", "经": "经济",
  "机": "机械", "电": "电子", "生物": "生物学", "物": "物理", "数": "数学", "农": "农业",
  "军": "军事", "商": "商业", "冶": "冶金", "建": "建筑", "纺": "纺织", "印": "印刷", "海": "航海"
};
function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
/* 词性 → 配色组 / 词性导航分组 */
function posGroup(t) {
  const k = (t || "").replace(/\./g, "").toLowerCase();
  if (k === "n" || k === "u") return "n";
  if (k === "v" || k === "vt" || k === "vi") return "v";
  if (k === "a" || k === "s" || k === "adj") return "a";
  if (k === "adv" || k === "ad" || k === "r") return "adv";
  if (k === "prep" || k === "p") return "prep";
  if (k === "conj" || k === "c") return "conj";
  if (k === "pron") return "pron";
  if (k === "num") return "num";
  if (k === "art") return "art";
  if (k === "int" || k === "interj") return "int";
  if (k === "aux" || k === "auxil" || k === "modal") return "aux";
  return "other";
}
/* 词性导航 tab 的展示名（缩写用学习者更熟的写法；数据里 a. = 形容词） */
const POS_TAB_META = {
  n: ["名词", "n."], v: ["动词", "v."], a: ["形容词", "adj."], adv: ["副词", "adv."],
  prep: ["介词", "prep."], conj: ["连词", "conj."], pron: ["代词", "pron."],
  num: ["数词", "num."], art: ["冠词", "art."], int: ["感叹词", "int."], aux: ["助动词", "aux."]
};
const POS_TAB_ORDER = ["n", "v", "a", "adv", "prep", "conj", "pron", "num", "art", "int", "aux"];
/* 拆出开头的词性缩写（vt. / n. / a.）或领域标记（[计]） */
function splitTag(s) {
  let m = /^\s*\[([^\]]{1,8})\]\s*/.exec(s);
  if (m) return { tag: m[1], dom: true, rest: s.slice(m[0].length) };
  m = /^\s*([A-Za-z][A-Za-z.&]{0,10}\.)\s*/.exec(s);
  if (m) {
    const k = m[1].replace(/\.$/, "").replace(/&.*$/, "").toLowerCase();
    if (POS_ZH[k] !== undefined) {
      /* WordNet 的卫星义项标记 s（=形容词近似义）统一显示成 a.，避免用户看不懂 */
      return { tag: k === "s" ? "a." : m[1], dom: false, rest: s.slice(m[0].length) };
    }
    /* 组合词性（vi.vt. / vt.vi. / vt.&vi. …）：每一段都是已知词性才接受 */
    const parts = m[1].replace(/\.$/, "").split(/[.&]/).filter(Boolean).map(p => p.toLowerCase());
    if (parts.length > 1 && parts.every(p => POS_ZH[p] !== undefined)) {
      return { tag: m[1], dom: false, rest: s.slice(m[0].length), multi: parts };
    }
  }
  return { tag: "", dom: false, rest: s };
}
/* 词性/领域小标签（无标签时给一个等宽占位，保证各列左缘对齐） */
function chipHTML(tag, dom, multi) {
  if (!tag) return '<b class="pos blank"></b>';
  const k = tag.replace(/\.$/, "").replace(/&.*$/, "").toLowerCase();
  let zh = dom ? (DOM_ZH[tag] || "") : (POS_ZH[k] || "");
  if (multi && multi.length) zh = multi.map(p => POS_ZH[p]).filter(Boolean).join("／");
  const p = dom ? "dom" : posGroup(multi && multi.length ? multi[0] : k);
  return '<b class="pos" data-p="' + p + '"' + (zh ? ' title="' + esc(zh) + '"' : "") + ">" + esc(tag) + "</b>";
}
function moreBtn(n) {
  const t = "显示全部 " + n + " 个义项 ▾";
  return '<button class="morebtn" data-open="' + t + '">' + t + "</button>";
}
/* 中文释义：每个词性/领域一行，行内义项用 · 分隔（短释义读起来像词典）。
   fg = 词性过滤（词性导航 tab 选中时）：只留该词性的组，且整组展开不折叠 */
function fmtTrans(str, cap, fold, fg) {
  cap = cap || 10; if (fold === undefined) fold = true;
  if (!str) return "";
  const raw = String(str).replace(/\\n/g, "；");
  const frags = raw.split(/[；;]/).map(s => s.trim()).filter(Boolean);
  if (!frags.length) return "";
  /* 开头没有词性/领域标记的碎片，是上一组的续写，并回去 */
  const groups = [];
  frags.forEach(f => {
    if (!splitTag(f).tag && groups.length) groups[groups.length - 1].push(f);
    else groups.push([f]);
  });
  if (fg) {
    const kept = groups.filter(g => {
      const t = splitTag(g[0]);
      return t.tag && !t.dom && posGroup(t.multi && t.multi.length ? t.multi[0] : t.tag) === fg;
    });
    if (!kept.length) return "";
    groups.length = 0; kept.forEach(g => groups.push(g));
    fold = false; cap = Infinity;
  }
  if (!groups.some(g => splitTag(g[0]).tag)) return esc(raw.trim());   /* 没有任何词性信息就按原文显示 */
  let idx = 0;
  const rows = [];
  groups.forEach(g => {
    const t = splitTag(g[0]);
    let senses = t.rest.split(/[,，]/).map(s => s.trim()).filter(Boolean);
    for (let k = 1; k < g.length; k++) senses = senses.concat(g[k].split(/[,，]/).map(s => s.trim()).filter(Boolean));
    if (!senses.length) return;
    const room = fold ? Math.max(0, cap - idx) : senses.length;
    /* 这一行一个义项都放不下 → 整行（含词性标签）先藏起来，避免行尾只剩个标签 */
    if (room === 0) {
      rows.push('<div class="trow over">' + chipHTML(t.tag, t.dom, t.multi) +
        '<span class="tsen">' + senses.map(s => '<i class="sn">' + esc(s) + "</i>").join("，") + "</span></div>");
      idx += senses.length;
      return;
    }
    const vis = senses.slice(0, room);
    const ovr = senses.slice(room);
    let body = vis.map(s => '<i class="sn">' + esc(s) + "</i>").join("，");
    /* 超出部分连同它前面的逗号一起包起来，折叠时整段消失，不留孤零零的标点 */
    if (ovr.length) body += '<span class="ovr">，' +
      ovr.map(s => '<i class="sn">' + esc(s) + "</i>").join("，") + "</span>";
    idx += senses.length;
    rows.push('<div class="trow">' + chipHTML(t.tag, t.dom, t.multi) +
      '<span class="tsen">' + body + "</span></div>");
  });
  if (!rows.length) return esc(raw.trim());
  return rows.join("") + (fold && idx > cap ? moreBtn(idx) : "");
}
/* 英文释义：每个词性一组，组内义项逐条编号（长句必须独占一行）。
   fg = 词性过滤，选中时该组全量展开 */
function fmtDef(str, cap, fg) {
  cap = cap || 6;
  if (!str) return "";
  const lines = String(str).split(/\\n|\n/).map(s => s.trim()).filter(Boolean);
  if (!lines.length) return "";
  const groups = [];
  lines.forEach(line => {
    const t = splitTag(line);
    const last = groups[groups.length - 1];
    if (t.tag && (!last || last.tag !== t.tag)) groups.push({ tag: t.tag, dom: t.dom, multi: t.multi, items: [t.rest] });
    else if (last) last.items.push(t.rest || line);
    else groups.push({ tag: "", dom: false, items: [t.rest || line] });
  });
  if (fg) {
    const kept = groups.filter(g => g.tag && posGroup(g.multi && g.multi.length ? g.multi[0] : g.tag) === fg);
    if (!kept.length) return "";
    groups.length = 0; kept.forEach(g => groups.push(g));
    cap = Infinity;
  }
  let idx = 0;
  const html = groups.map(g => {
    const items0 = g.items.filter(Boolean);
    if (!items0.length) return "";
    /* 这一组一个义项都放不下时，连词性标签一起藏（不然只剩个空标签） */
    const room = Math.max(0, cap - idx);
    const hide = room === 0;
    const items = items0.map((s, k) => {
      const cls = (!hide && k >= room) ? "dsen over" : "dsen";
      return '<span class="' + cls + '"><i class="num">' + (k + 1) + "</i>" + esc(s) + "</span>";
    });
    idx += items0.length;
    return '<div class="dgrp' + (hide ? " over" : "") + '">' + chipHTML(g.tag, g.dom, g.multi) +
      '<div class="dl">' + items.join("") + "</div></div>";
  }).join("");
  /* 折叠计数：按总量给按钮文案 */
  const total = groups.reduce((n, g) => n + g.items.filter(Boolean).length, 0);
  if (!html) return "";
  return html + (total > cap ? moreBtn(total) : "");
}
/* 义项过多时「显示全部 / 收起」——只切 CSS 类，不重排 DOM */
function bindMore(root) {
  if (!root) return;
  root.classList.remove("expanded");
  root.querySelectorAll(".morebtn").forEach(b => {
    b.textContent = b.dataset.open;
    b.onclick = ev => {
      ev.stopPropagation();
      const on = root.classList.toggle("expanded");
      b.textContent = on ? "收起 ▴" : b.dataset.open;
    };
  });
}

/* ---------- 词性导航：多义词按 n./v./adj. 一键切换 ----------
   长词（light 24 义、run 20+ 义）全局折叠后动词/副词整行被藏起来，
   扫一眼根本不知道还有别的词性。tab 直接给出「有哪些词性、各几个义项」，
   点选后中文/英文释义联动只看该词性（该词性没有英文释义时明说）。 */
function posTabsOf(str) {
  const frags = String(str || "").replace(/\\n/g, "；").split(/[；;]/);
  const m = new Map();
  frags.forEach(f0 => {
    const f = String(f0).trim(); if (!f) return;
    const t = splitTag(f);
    if (!t.tag || t.dom) return;
    const g = posGroup(t.multi && t.multi.length ? t.multi[0] : t.tag);
    if (!POS_TAB_META[g]) return;
    if (!m.has(g)) m.set(g, { g, zh: POS_TAB_META[g][0], ab: POS_TAB_META[g][1], count: 0 });
    m.get(g).count += t.rest.split(/[,，]/).filter(s => s.trim()).length || 1;
  });
  return POS_TAB_ORDER.filter(g => m.has(g)).map(g => m.get(g));
}
let posFilter = "";     /* 当前选中的词性分组（"" = 全部） */
let senseIdx = null;    /* 当前面板显示的词表内词下标（null = 词表外 / 无） */
function renderPosTabs(str) {
  const box = $("dPos");
  if (!box) return;
  const tabs = posTabsOf(str);
  if (tabs.length < 2) { box.classList.add("hidden"); box.innerHTML = ""; return; }
  box.classList.remove("hidden");
  box.innerHTML = '<button class="ptab all' + (posFilter ? "" : " on") + '" data-g="">全部</button>' +
    tabs.map(t => '<button class="ptab' + (posFilter === t.g ? " on" : "") + '" data-g="' + t.g +
      '" title="' + t.zh + '">' + t.zh + " <i>" + t.ab + "</i>" +
      (t.count > 1 ? "<em>" + t.count + "</em>" : "") + "</button>").join("");
}
/* 中文释义 + 英文释义按当前词性过滤渲染（renderPanel / renderExtraPanel 共用） */
function renderSenses(i) {
  senseIdx = i;
  const tr = D.trans[i];
  $("dTrans").innerHTML = fmtTrans(tr, 10, undefined, posFilter) || "<span class='muted'>（暂无释义）</span>";
  $("dTrans").classList.toggle("dim", !tr);
  bindMore($("dTrans"));
  /* 英文释义：按词性分组 + 逐条编号，超过 6 条先折叠；选中词性时整组展开。
     选中词性但没有对应英文释义时，明说「暂无」而不是悄悄藏掉整块，
     否则用户会以为渲染出了问题。 */
  const defHTML = fmtDef(D.def[i], 6, posFilter);
  $("dDef").innerHTML = defHTML || (posFilter ? '<span class="muted">该词性暂无英文释义（英文释义未覆盖全部词性）</span>' : "");
  $("bDef").style.display = (defHTML || posFilter) ? "" : "none";
  const note = $("dDefNote");
  if (note) note.textContent = defHTML && posFilter ? " · 只看" + (POS_TAB_META[posFilter] || [])[0] : "";
  bindMore($("dDef"));
}
/* 词性 tab 点击：中文/英文释义联动过滤（词表内走 senseIdx，词表外走 extraCurrent） */
const posBox = $("dPos");
if (posBox) posBox.onclick = ev => {
  const b = ev.target.closest(".ptab");
  if (!b) return;
  ev.stopPropagation();
  posFilter = b.dataset.g || "";
  if (senseIdx !== null) {
    renderPosTabs(D.trans[senseIdx]);
    renderSenses(senseIdx);
  } else if (extraCurrent) {
    const k = D.extra ? D.extra.indexOf(extraCurrent) : -1;
    if (k >= 0) {
      const etr = extraTrans(k);
      renderPosTabs(etr);
      $("dTrans").innerHTML = fmtTrans(etr, 10, undefined, posFilter) || "（暂无释义，可点 🔊 听发音）";
      $("dTrans").classList.toggle("dim", !etr);
      bindMore($("dTrans"));
    }
  }
};

/* ---------- out-of-list related words ---------- */
/* D.extraPhon / D.extraTrans are ARRAYS parallel to D.extra — index, not word key */
let extraCurrent = null;
function extraPhon(i) { return (D.extraPhon && D.extraPhon[i]) || ""; }
function extraTrans(i) { return (D.extraTrans && D.extraTrans[i]) || ""; }

function renderExtraPanel(node) {
  const i = node.i, word = D.extra[i];
  extraCurrent = word;
  /* 顺便探一下这个词有没有真人音：有的话点击时就播真人音，没有就走网络 TTS */
  probeDict([word]);
  $("ph").classList.add("hidden");
  $("detail").classList.remove("hidden");
  $("dWord").textContent = word;
  const ph = extraPhon(i);
  $("dPhon").textContent = ph ? "/" + ph + "/" : "无音标 · 点 🔊 听发音";
  $("dPhon").classList.toggle("nophon", !ph);
  $("dBand").textContent = "词表外关联词";
  $("dTags").innerHTML = "";
  document.querySelectorAll(".mbtn").forEach(b => b.classList.remove("on"));
  $("masteryRow").style.display = "none";
  const _dd = $("dDue"); if (_dd) { _dd.style.display = "none"; _dd.textContent = ""; }
  const tr = extraTrans(i);
  senseIdx = null;                       /* 词表外词：tab 点击走 extraTrans 这条路 */
  posFilter = "";
  renderPosTabs(tr);
  const th = fmtTrans(tr, 10, undefined, posFilter);
  $("dTrans").innerHTML = th || "（暂无释义，可点 🔊 听发音）";
  $("dTrans").classList.toggle("dim", !tr);
  bindMore($("dTrans"));
  $("bDef").style.display = "none";
  $("dDef").innerHTML = "";
  $("bMorph").style.display = "none";
  $("bColl").style.display = "none";
  $("bConf").style.display = "none";
  $("bPara").style.display = "none";
  stopParaRead();
  paraWant = null;
  $("dConf").innerHTML = "";
  $("dFamNote").textContent = "";
  $("dFam").innerHTML = "<span class='muted'>词表外词汇，无词族数据</span>";
  $("extInfo").classList.add("hidden");
  $("dRel").innerHTML =
    "<span class='muted'>该词不在 10000 词表内，所以没有可展开的关系网络。" +
    "点 🔊（或直接点这个节点）可以听美式发音，上方是它的释义。" +
    " 想看更多词形变化，可去 <a class='extlink' target='_blank' rel='noopener' href='https://dict.youdao.com/result?word=" +
    encodeURIComponent(word) + "&lang=en'>在线词典 ↗</a></span>";
}

/* inline card used by the 关系词 list (.ext buttons) so you don't lose the current word */
let extInfoIdx = -1;
function showExtInfo(j) {
  const el = $("extInfo");
  if (!el) return;
  extInfoIdx = j;
  const w = D.extra[j], ph = extraPhon(j), tr = extraTrans(j);
  el.classList.remove("hidden");
  el.innerHTML =
    "<div class='exth'><b>" + w + "</b>" +
    (ph ? '<span class="phon">/' + ph + "</span>" : (hasExtraDef ? '<span class="muted">无音标</span>' : "")) +
    '<button class="mini-say" title="再听一次">🔊 再听一次</button></div>' +
    (hasExtraDef
      ? "<div class='exttr'>" + (fmtTrans(tr, 0, false) || "（暂无释义）") + "</div>"
      : '<div class="partload"><i class="spin"></i>释义正在载入…</div>') +
    "<div class='muted'>词表外关联词 · 不在 10000 词表内，无法展开词网</div>";
  const b = el.querySelector(".mini-say");
  if (b) b.onclick = () => speak(w);
  if (!hasExtraDef) {
    needExtraDef().then(() => { if (extInfoIdx === j) refreshExtInfo(); },
      () => partFailed(() => showExtInfo(j), "词表外词的释义没载入成功"));
  }
}
/* 词表外词那包到位后，把还挂着的占位卡片补成完整内容 */
function refreshExtInfo() {
  if (extInfoIdx < 0) return;
  const el = $("extInfo");
  if (!el || el.classList.contains("hidden") || !el.querySelector(".partload")) return;
  showExtInfo(extInfoIdx);
}

/* ---------- 例句（大模型生成；覆盖全部 10000 词） ---------- */
function escHTML(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
/* 句中目标词高亮：用词族全部词形匹配，长词优先，避免 act 命进 actor 中间 */
function exHighlight(en, forms) {
  const safe = escHTML(en);
  const list = (forms || []).filter(Boolean)
    .map(f => String(f).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((a, b) => b.length - a.length);
  if (!list.length) return safe;
  try {
    return safe.replace(new RegExp("\\b(" + list.join("|") + ")\\b", "gi"), "<b>$1</b>");
  } catch (e) { return safe; }
}
function exFormsOf(i) {
  const set = new Set([D.words[i]]);
  (D.fam[i] || []).forEach(p => set.add(String(p[0])));
  return Array.from(set);
}

/* ---------- 段落记忆：把词网里的关系词编进同一段 ----------
   词根索引解决「一串同根词」，这里解决「一个词网一段话」。
   段落是离线预生成的（_net_gen 流水线），随词层分块载入 data_net_bNN.js：
   一个词头 → 一段 90–170 词的连贯情景文，里面用到了它词网里的每个目标词。
   读出「这些词本来活在同一个语境里」，比一个个背释义强。 */

const reEsc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* 目标词在段落里是带变形出现的（shout → shouts / shouted / shouting），
   规则沿用例句那套，另外补上不规则动词 —— 漏了会误判成「没写进去」。 */
const PARA_IRREG = {
  lie: ["lying", "lay", "lain"], stick: ["stuck"], draw: ["drew", "drawn"], tear: ["tore", "torn"],
  ride: ["rode", "ridden"], rise: ["rose", "risen"], run: ["ran"], hold: ["held"],
  begin: ["began", "begun"], break: ["broke", "broken"], find: ["found"], feel: ["felt"],
  grow: ["grew", "grown"], meet: ["met"], lead: ["led"], leave: ["left"], lose: ["lost"],
  pay: ["paid"], spend: ["spent"], bring: ["brought"], catch: ["caught"], think: ["thought"],
  say: ["said"], see: ["saw", "seen"], give: ["gave", "given"], take: ["took", "taken"],
  eat: ["ate", "eaten"], sing: ["sang", "sung"], speak: ["spoke", "spoken"], shine: ["shone"],
  fall: ["fell", "fallen"], freeze: ["froze", "frozen"], beat: ["beaten"], make: ["made"],
  keep: ["kept"], sell: ["sold"], tell: ["told"], hear: ["heard"], buy: ["bought"]
};
function paraForms(w) {
  const s = new Set([w]);
  const add = x => { if (x.length > 1) s.add(x); };
  ["s", "es", "ed", "d", "ing", "er", "est", "ly", "ion", "ment", "ness", "ers", "ings"].forEach(suf => add(w + suf));
  if (/e$/.test(w)) { const b = w.slice(0, -1); ["ing", "ed", "es", "er", "est"].forEach(suf => add(b + suf)); }
  if (/[^aeiou][aeiou][^aeiouwxy]$/.test(w)) {
    const d = w + w.slice(-1);
    ["ed", "ing", "er", "est"].forEach(suf => add(d + suf));
  }
  if (/y$/.test(w)) { const b = w.slice(0, -1); add(b + "ies"); add(b + "ied"); }
  (PARA_IRREG[w] || []).forEach(add);
  return [...s];
}

/* 匹配计划：变形 → {词, 关系类型}。
   目标词必须排在词头前面注册 —— 否则词头的变形会把派生目标词吃掉
   （join 的 -er 变形 = joiner、receive 的 -r = receiver、deposit 的 -ion = deposition）。 */
function paraPlan(word, tw) {
  const all = (tw || []).map(([w, t]) => ({ w, t })).concat([{ w: word, t: -1 }]);
  const map = new Map();
  /* 两遍登记，顺序很关键：bet+er 会拼出 better、join+er 会拼出 joiner。
     若让派生形先占坑，词头自己的原形就被别的词认领走了 —— 挖空时会把词头
     当成 bet 挖掉，高亮也会把 better 标成 bet。所以先登记各词自己的拼写，
     派生形只在没人认领时才占坑。 */
  all.forEach(m => {
    const k = m.w.toLowerCase();
    if (!map.has(k)) map.set(k, m);
  });
  all.forEach(m => paraForms(m.w).forEach(v => { if (!map.has(v)) map.set(v, m); }));
  const keys = [...map.keys()].sort((a, b) => b.length - a.length).map(reEsc);
  return { map, re: new RegExp("\\b(" + keys.join("|") + ")\\b", "gi") };
}
/* 段落高亮：目标词按关系类型着色（色值同图例），词头另给一个底色 */
function paraHTML(word, en, tw) {
  const safe = escHTML(en);
  if (!tw || !tw.length) return safe;
  const p = paraPlan(word, tw);
  try {
    return safe.replace(p.re, m => {
      const o = p.map.get(String(m).toLowerCase());
      if (!o) return m;
      return '<b class="pw pt' + o.t + '" data-w="' + escHTML(o.w) + '" role="button" tabindex="0">' + m + "</b>";
    });
  } catch (e) { return safe; }
}
/* 分句：不用 lookbehind（老 Safari 不支持），按词尾标点切 */
function paraSents(en) {
  const out = [];
  let buf = "";
  String(en || "").split(/\s+/).forEach(w => {
    buf = buf ? buf + " " + w : w;
    if (/[.!?]$/.test(w)) { out.push(buf); buf = ""; }
  });
  if (buf) out.push(buf);
  return out;
}
const paraOf = w => (window.APP_NET && window.APP_NET[w]) || null;

/* 载入补齐后回调：当前词的面板重画一次（段落是「有则显示」的，晚到不能丢） */
let paraWant = null;
function refillPara() { if (paraWant !== null && paraWant === current) renderPara(paraWant); }

function renderPara(i) {
  const blk = $("bPara");
  if (!blk) return;
  /* 面板此刻显示的是词表外的词（内联卡片）：段落只属于词表内的词，一律不画。
     否则 needNet 的晚到回调会把上一个词的段落重新画到这张卡片上。 */
  if (extraCurrent) { blk.style.display = "none"; paraWant = null; return; }
  paraWant = i;
  stopParaRead();                       /* 换词就停掉上一段的连读 */
  const word = D.words[i], item = paraOf(word);
  if (!item) {
    blk.style.display = "none";
    $("dPara").innerHTML = "";
    $("dParaNote").textContent = "";
    const k = netKey(i);
    if (!netLoaded.has(k) && !netMissing.has(k)) {
      needNet(i).then(() => { if (paraWant === i) renderPara(i); });
    }
    return;
  }
  blk.style.display = "";
  const tw = item.tw || [];
  $("dParaNote").textContent = "覆盖 " + (tw.length + 1) + " 个词 · 点句子朗读 · 点彩色词跳词网";
  const html = paraSents(item.en)
    .map(s => '<span class="psent" data-s="' + escHTML(s) + '" role="button" tabindex="0">' +
      paraHTML(word, s, tw) + "</span>")
    .join(" ");
  $("dPara").innerHTML = '<p class="pen">' + html + "</p>" +
    '<p class="pzh">' + escHTML(item.zh || "") + "</p>";
  $("dPara").querySelectorAll(".psent").forEach(el => {
    el.onclick = () => speak(el.dataset.s, el);
  });
  $("dPara").querySelectorAll(".pw").forEach(el => {
    el.onclick = ev => { ev.stopPropagation(); go(el.dataset.w); speak(el.dataset.w); };
  });
}

/* 通读全段：一句接一句（speak 的第三个参数就是「读完了」的回调）。
   离线时没有回调可等，退化成按词数估时长。 */
let paraPlaying = false, paraTimer = 0;
function stopParaRead() {
  paraPlaying = false;
  clearTimeout(paraTimer);
  if (curAudio) { try { curAudio.pause(); } catch (e) {} curAudio = null; }
  const btn = $("dParaPlay");
  if (btn) { btn.classList.remove("on"); btn.textContent = "▶ 通读全段"; }
}
function paraReadAll() {
  const i = current;
  if (i === null) return;
  const item = paraOf(D.words[i]);
  if (!item) return;
  if (paraPlaying) { stopParaRead(); return; }
  const btn = $("dParaPlay");
  const sents = paraSents(item.en);
  const online = navigator.onLine !== false;
  let k = 0;
  paraPlaying = true;
  if (btn) { btn.classList.add("on"); btn.textContent = "■ 停止朗读"; }
  const step = () => {
    if (!paraPlaying || current !== i) { stopParaRead(); return; }
    if (k >= sents.length) { stopParaRead(); return; }
    const s = sents[k++];
    if (online) speak(s, null, () => { paraTimer = setTimeout(step, 220); });
    else { speakLocal(s); paraTimer = setTimeout(step, 600 + s.split(/\s+/).length * 330); }
  };
  step();
}

/* ---------- 段落挖空：把目标词挖掉，用词池回填 ----------
   读一遍是输入，填一遍才是输出 —— 段落真正值钱的用法在这里。
   成绩写回**词头**那条 SRS 记录（和复习卡、词根串记同一条）。 */
let pq = null;
function shuffle(arr) {
  const a = arr.slice();
  for (let k = a.length - 1; k > 0; k--) {
    const j = Math.floor(Math.random() * (k + 1));
    const t = a[k]; a[k] = a[j]; a[j] = t;
  }
  return a;
}
function buildCloze(i, word, item) {
  const tw = item.tw || [];
  const p = paraPlan(word, tw);
  const blanks = [], segs = [], seen = new Set();
  let last = 0, m;
  p.re.lastIndex = 0;
  while ((m = p.re.exec(item.en))) {
    const o = p.map.get(String(m[0]).toLowerCase());
    if (!o || o.t === -1) continue;           /* 词头不挖：它是这一段的锚 */
    if (seen.has(o.w)) continue;              /* 一个词只挖第一次出现 */
    seen.add(o.w);
    if (m.index > last) segs.push({ t: "x", v: item.en.slice(last, m.index) });
    segs.push({ t: "b", k: blanks.length });
    blanks.push({ w: o.w, rt: o.t });
    last = m.index + m[0].length;
  }
  segs.push({ t: "x", v: item.en.slice(last) });
  pq = {
    i, word, item, segs, blanks,
    fill: new Array(blanks.length).fill(null),
    used: new Set(),
    order: shuffle(blanks.map((b, k) => k)),
    graded: false, revealed: false
  };
  $("paraSub").textContent = word + " · " + blanks.length + " 空";
  $("paraHint").textContent = "点词池里的词填进空格 · 点已填的空格取回";
  $("paraHint").className = "";
  renderCloze();
}
function renderCloze() {
  if (!pq) return;
  const body = [];
  pq.segs.forEach(s => {
    if (s.t === "x") { body.push(escHTML(s.v)); return; }
    const b = pq.blanks[s.k], f = pq.fill[s.k];
    const bad = pq.graded && f !== b.w;
    const cls = "pbl" + (f ? " on" : "") + (pq.graded ? (bad ? " bad" : " ok") : "");
    const inner = f ? escHTML(f) : "&nbsp;";
    body.push('<button class="' + cls + '" data-k="' + s.k + '" type="button">' + inner +
      (bad ? '<i class="pans">' + escHTML(b.w) + "</i>" : "") + "</button>");
  });
  const chips = pq.order.map(k => {
    const b = pq.blanks[k], used = pq.used.has(b.w);
    return '<button class="pchip' + (used ? " used" : "") + '" data-w="' + escHTML(b.w) +
      '" type="button"' + (used ? " disabled" : "") + ">" + escHTML(b.w) + "</button>";
  }).join("");
  $("paraBody").innerHTML =
    '<p class="pen">' + body.join("") + "</p>" +
    '<div class="pbank"><span class="pbankt">词池</span>' + chips + "</div>";
  const doneAll = pq.fill.every(x => x);
  $("paraCheck").classList.toggle("hidden", pq.graded || !doneAll);
  $("paraReveal").classList.toggle("hidden", pq.revealed);
  $("paraAgain").classList.toggle("hidden", !pq.graded && !pq.revealed);
}
function fillCloze(w) {
  if (!pq || pq.graded || pq.revealed || pq.used.has(w)) return;
  const k = pq.fill.indexOf(null);
  if (k < 0) return;
  pq.fill[k] = w;
  pq.used.add(w);
  renderCloze();
}
function clearCloze(k) {
  if (!pq || pq.graded || pq.revealed) return;
  const w = pq.fill[k];
  if (!w) return;
  pq.fill[k] = null;
  pq.used.delete(w);
  renderCloze();
}
function checkCloze() {
  if (!pq || pq.graded) return;
  pq.graded = true;
  renderCloze();
  const n = pq.blanks.length;
  const right = pq.blanks.filter((b, k) => pq.fill[k] === b.w).length;
  const q = right === n ? 2 : (n - right <= 2 ? 1 : 0);
  const r = applyGrade(pq.i, q);
  /* 成绩说清楚：填对几空 + 换算成哪一档 + 下次什么时候再来（s=0 时没有排期，就别说） */
  const bits = ["填对 " + right + "/" + n, "算作「" + ["忘了", "有印象", "记得"][q] + "」"];
  const dtx = dueText(pq.i);
  if (dtx) bits.push(dtx);
  if (r.nowS !== r.prevS) {
    bits.push("掌握度 " + ["未学", "学习中", "已掌握"][r.prevS] + " → " + ["未学", "学习中", "已掌握"][r.nowS]);
  }
  $("paraHint").className = "pgot";
  $("paraHint").textContent = bits.join(" · ");
  renderStats();
  updateRvBadge();
  if (!$("detail").classList.contains("hidden")) renderPanel(pq.i);
}
function revealCloze() {
  if (!pq || pq.graded) return;
  pq.blanks.forEach((b, k) => { pq.fill[k] = b.w; pq.used.add(b.w); });
  pq.revealed = true;
  renderCloze();
  $("paraHint").className = "";
  $("paraHint").textContent = "这是答案 · 不算成绩，看一遍再点「再来一次」";
}
function openParaCloze() {
  const i = current;
  if (i === null) return;
  /* 词表外词的卡片显示时 current 仍是上一个词表内词，按 T 会打开别的词的挖空；
     词表外词本来就没有段落（renderPara 里也是这么挡的），直接不响应。 */
  if (extraCurrent) return;
  const word = D.words[i], item = paraOf(word);
  if (!item) return;
  buildCloze(i, word, item);
  $("paraModal").classList.remove("hidden");
}
function closeParaCloze() { $("paraModal").classList.add("hidden"); pq = null; }

/* ---------- 易混词：近形 / 近音 ----------
   完全由词表 + 音标算出，不依赖任何外部数据：
   · 近形 = 拼写做 Damerau-Levenshtein（相邻换位算 1 步，抓 quiet/quite 这类）
   · 近音 = 音标归一化后比较，并要求「辅音骨架」基本一致，
            否则 bad/bed/bid 这种会全被算成一类
   同一词族的词（effect / effective）不算易混，先排除。 */
const CONF_FORM_TH = 0.72;      /* 拼写相似度门槛：约等于 6 个字母错 2 个 */
const CONF_SND_TH = 0.80;       /* 发音相似度门槛 */
const CONF_KEEP = 12;           /* 每个词最多留这么多候选（展示时再截） */

function _osa(a, b) {           /* Damerau-Levenshtein（最优字符串对齐） */
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  if (Math.abs(m - n) > 3) return 99;      /* 长度差太多直接出局，省时间 */
  const d = [];
  for (let i = 0; i <= m; i++) { d.push(new Array(n + 1)); d[i][0] = i; }
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    const c = a[i - 1] === b[j - 1] ? 0 : 1;
    let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
      v = Math.min(v, d[i - 2][j - 2] + 1);
    d[i][j] = v;
  }
  return d[m][n];
}

/* 一个词可能标了多个读音，用 . 或 ; 分隔（desert = 'dezәt. di'sә:t）——取第一个（最常用） */
function _firstPhon(p) { return String(p || "").split(/[.;]/)[0]; }
/* 音标归一化：① 取首个读音 ② 双元音合字（数据里 eɪ 写成 i+e 两个字符）
   ③ 去重音（ASCII ' 与 IPA ˈˌ）、长度符 :、括号、点、空格 ④ 转小写 */
const _DIGRAPH = { ei: "e", ai: "a", au: "a", ou: "o", "ɔi": "o" };
function _phonKey(p) {
  return _firstPhon(p).toLowerCase()
    .replace(/ei|ai|au|ou|ɔi/g, m => _DIGRAPH[m])
    .replace(/['ˈˌ.:()\s\u02c8\u02cc-]/g, "");
}
/* 元音集合：ECDICT 用的是「西里尔 ә」(U+04D9) 而不是拉丁 ə(U+0259)，两个都收 */
const _VOWELS = new Set("aeiouæɑɒɔəɜʌɐɪʊɛɘɵøœyә".split(""));
/* 元音按粗类归并；i/ɪ 与 e/æ 必须分开，否则 peace/pass 会被误判成同音 */
const _VCLS = { a: "A", "ɑ": "A", "ɒ": "A", "ʌ": "V", "ɐ": "V",
  "ə": "@", "ә": "@", "ɜ": "@", "ɘ": "@",
  e: "E", "æ": "E", "ɛ": "E", i: "I", "ɪ": "I", y: "I",
  u: "U", "ʊ": "U", o: "O", "ɔ": "O", "ø": "O", "œ": "O", "ɵ": "O" };
/* 辅音清浊归并：loose/lose、advice/advise、proof/prove 只差一个清浊音 */
const _CCLS = { s: "S", z: "S", f: "F", v: "F", "ʃ": "X", "ʒ": "X", "θ": "Q", "ð": "Q" };
function _cls(ch) { return _VOWELS.has(ch) ? (_VCLS[ch] || "V") : (_CCLS[ch] || ch); }
function _sndKey(p) { let o = ""; for (const ch of _phonKey(p)) o += _cls(ch); return o; }
function _consSkel(p) { let o = ""; for (const ch of _phonKey(p)) if (!_VOWELS.has(ch)) o += _cls(ch); return o; }

/* 同词族的词先排除（D.fam[i] 是 [[词形, 词频], ...]）。fam 随词层分块载入，所以要跟着作废重算。 */
let _famSets = null, _famVer = -1;
function _famSetOf(i) {
  if (_famVer !== confVer) { _famSets = new Array(N); _famVer = confVer; }
  let s = _famSets[i];
  if (!s) {
    s = new Set();
    const f = D.fam && D.fam[i];
    if (f) for (let k = 0; k < f.length; k++) {
      const p = f[k];
      if (p) s.add(String(p[0] === undefined ? p : p[0]).toLowerCase());
    }
    _famSets[i] = s;
  }
  return s;
}
function _sameFam(i, j) {
  return _famSetOf(i).has(D.words[j].toLowerCase()) || _famSetOf(j).has(D.words[i].toLowerCase());
}

/* 只统计「已载入词层」里的词；没载入的 phon 是 undefined，自然不参与比较 */
function confusableOf(i) {
  const hit = confMemo.get(i);
  if (hit && hit.ver === confVer) return hit.val;
  const wa = D.words[i].toLowerCase();
  const pa = D.phon[i];
  const sa = pa ? _sndKey(pa) : "";
  const ca = pa ? _consSkel(pa) : "";
  const form = [], sound = [];
  for (let j = 0; j < N; j++) {
    if (j === i) continue;
    const wb = D.words[j].toLowerCase();
    if (Math.abs(wa.length - wb.length) <= 2) {
      const d = _osa(wa, wb);
      if (d <= 2) {
        const s = 1 - d / Math.max(wa.length, wb.length);
        if (s >= CONF_FORM_TH && !_sameFam(i, j)) form.push({ j, s });
      }
    }
    const pb = D.phon[j];
    if (pa && pb) {
      const sb = _sndKey(pb);
      if (Math.abs(sa.length - sb.length) <= 3 && _osa(ca, _consSkel(pb)) <= 1) {
        const d = _osa(sa, sb);
        if (d <= 2) {
          const s = 1 - d / Math.max(sa.length, sb.length);
          if (s >= CONF_SND_TH && !_sameFam(i, j)) sound.push({ j, s });
        }
      }
    }
  }
  const cmp = (x, y) => (y.s - x.s) || (D.band[x.j] - D.band[y.j]);
  form.sort(cmp); sound.sort(cmp);
  const val = { form: form.slice(0, CONF_KEEP), sound: sound.slice(0, CONF_KEEP) };
  confMemo.set(i, { ver: confVer, val });
  return val;
}

/* 近形 / 近音合并去重，tag = form | snd | both。
   「又形近又音近」的最值得看，排最前；纯音近的候选最多留 sndOnlyMax 条，
   免得一堆 -fect / -lect 之类的弱候选把真正的形近词挤出去。 */
function confItems(i, max, sndOnlyMax) {
  const c = confusableOf(i);
  const m = new Map();
  c.form.forEach(x => { const o = m.get(x.j) || {}; o.form = true; o.sf = x.s; m.set(x.j, o); });
  c.sound.forEach(x => { const o = m.get(x.j) || {}; o.snd = true; o.ss = x.s; m.set(x.j, o); });
  const arr = [];
  m.forEach((o, j) => arr.push({
    j, o, score: Math.max(o.sf || 0, o.ss || 0) + (o.form && o.snd ? 0.1 : 0)
  }));
  arr.sort((a, b) => (b.score - a.score) || (D.band[a.j] - D.band[b.j]));
  if (!sndOnlyMax) return max ? arr.slice(0, max) : arr;
  const out = []; let n = 0;
  for (const x of arr) {
    if (!x.o.form) { if (n >= sndOnlyMax) continue; n++; }
    out.push(x);
  }
  return max ? out.slice(0, max) : out;
}
const confTagOf = o => (o.form && o.snd ? "both" : o.form ? "form" : "snd");
const CONF_TAG_TEXT = { form: "形近", snd: "音近", both: "形音" };

/* 面板里的「易混词」区块：只列词，点击跳过去并朗读 */
function renderConf(i) {
  const box = $("dConf");
  if (!box) return;
  const items = confItems(i, 8, 4);
  const loading = loadedChunk.size < CHUNK_N;
  $("bConf").style.display = "";
  $("dConfNote").textContent = items.length
    ? (loading ? "形状 / 发音相近 · 其余词层载入中…" : "形状 / 发音相近")
    : (loading ? "词层载入中…" : "");
  box.innerHTML = items.map(x =>
    '<button class="cf ' + confTagOf(x.o) + '" data-j="' + x.j + '"><i>' +
    CONF_TAG_TEXT[confTagOf(x.o)] + "</i>" + escHTML(D.words[x.j]) + "</button>"
  ).join("") || '<span class="muted">' + (loading ? "载入中…" : "没有找到形近 / 音近的词") + "</span>";
  box.querySelectorAll(".cf").forEach(b => {
    b.onclick = () => { const j = +b.dataset.j; go(D.words[j]); speak(D.words[j]); };
  });
  const btn = $("dConfBtn");
  if (btn) btn.style.display = items.length >= 1 ? "" : "none";
}

/* 词层陆续载入时，面板若正开着，易混词区块要跟着补齐（afterPartLoad 会调这里） */
function fillPanelIfPending() {
  if (current === null || current === undefined) return;
  const b = $("bConf");
  if (!b || b.style.display === "none") return;
  renderConf(current);
}

/* 一次把所有词层都要来（辨析需要全局比对，光靠当前块不够） */
function needAll() {
  const ps = [];
  for (let c = 1; c <= CHUNK_N; c++) if (!chunkReady(c)) ps.push(needChunk(c));
  return ps.length ? Promise.all(ps) : Promise.resolve();
}

/* ---------- 辨析弹窗：对比表 + 考一考 ---------- */
let confIdx = null, confList = [], cq = null;

function confShuffle(a) { for (let k = a.length - 1; k > 0; k--) { const r = Math.floor(Math.random() * (k + 1)); const t = a[k]; a[k] = a[r]; a[r] = t; } return a; }

function openConfuse(i) {
  const m = $("confModal");
  if (!m) return;
  confIdx = i;
  m.classList.remove("hidden");
  $("confSub").textContent = "「" + D.words[i] + "」和它容易混的词";
  $("confBody").innerHTML = '<div class="partload"><i class="spin"></i>正在收集这些词的释义…</div>';
  needAll().catch(() => {}).then(() => {
    if (confIdx !== i) return;                 /* 期间又点了别的词 */
    const items = confItems(i, 6, 3);
    const idxs = [i];
    items.forEach(x => { if (idxs.indexOf(x.j) < 0) idxs.push(x.j); });
    confList = idxs.slice(0, 6);
    renderConfuse();
  });
}
function closeConfuse() { const m = $("confModal"); if (m) m.classList.add("hidden"); }

function renderConfuse() {
  const body = $("confBody");
  if (!body) return;
  const i = confIdx;
  if (confList.length < 2) {
    body.innerHTML = '<div class="cempty">暂时没找到和「' + escHTML(D.words[i]) +
      '」形近 / 音近的词。<br><small>换一个词试试，或等其余词层载入完成再打开。</small></div>';
    return;
  }
  const cf = confusableOf(i);
  const rows = confList.map(j => {
    const isF = cf.form.some(x => x.j === j), isS = cf.sound.some(x => x.j === j);
    const tag = isF && isS ? "both" : isF ? "form" : isS ? "snd" : "";
    const ph = D.phon[j];
    const tr = fmtTrans(D.trans[j], 70);
    return '<tr class="' + (j === i ? "anchor" : "") + '">' +
      '<td class="cw"><button class="cword" data-j="' + j + '" title="跳到词网并朗读">' + escHTML(D.words[j]) + "</button>" +
      (j === i ? '<i class="ctag anchor">本词</i>' : (tag ? '<i class="ctag ' + tag + '">' + CONF_TAG_TEXT[tag] + "</i>" : "")) + "</td>" +
      '<td class="cp">' + (ph ? "/" + escHTML(ph) + "/" : "—") + "</td>" +
      '<td class="cm">' + (tr || "<span class='muted'>（暂无释义）</span>") + "</td>" +
      '<td class="cs"><button class="cspeak" data-w="' + escHTML(D.words[j]) + '" title="朗读">🔊</button></td>' +
      "</tr>";
  }).join("");
  body.innerHTML =
    '<div class="ctabwrap"><table class="ctab"><thead><tr><th>单词</th><th>音标</th><th>中文释义</th><th></th></tr></thead><tbody>' +
    rows + "</tbody></table></div>" +
    '<div class="cqz" id="cqz"></div>';
  body.querySelectorAll(".cword").forEach(b => {
    b.onclick = () => { const j = +b.dataset.j; closeConfuse(); go(D.words[j]); speak(D.words[j]); };
  });
  body.querySelectorAll(".cspeak").forEach(b => { b.onclick = () => speak(b.dataset.w, b); });
  cqStart();
}

/* ---- 考一考：优先出「例句填空」（例句都含目标词），没例句就考中文释义 ---- */
function cqStart() {
  cq = { right: 0, total: 0, cur: null, opts: [], done: false };
  cqNext();
}
function cqPick() {
  const pool = confList.filter(j => D.words[j]);
  if (pool.length < 2) return null;
  const cand = confShuffle(pool.slice());
  for (const j of cand) {
    const ex = window.APP_EX && window.APP_EX[D.words[j]];
    if (ex && ex[0]) {
      const b = cqBlank(ex[0], exFormsOf(j));
      if (b) return { type: "blank", j, zh: ex[1] || "", b };
    }
  }
  return { type: "mean", j: cand[0] };
}
/* 把例句里的目标词挖空；目标词可能以变形出现，用词族词形匹配 */
function cqBlank(sentence, forms) {
  const list = (forms || []).filter(Boolean).map(f => String(f).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((a, b) => b.length - a.length);
  if (!list.length) return null;
  let m;
  try { m = new RegExp("\\b(" + list.join("|") + ")\\b", "i").exec(sentence); } catch (e) { return null; }
  if (!m) return null;
  return { before: sentence.slice(0, m.index), hit: m[0], after: sentence.slice(m.index + m[0].length) };
}
function cqNext() {
  const box = $("cqz");
  if (!box) return;
  const q = cqPick();
  if (!q) { box.innerHTML = ""; return; }
  const others = confShuffle(confList.filter(j => j !== q.j)).slice(0, 3);
  const opts = confShuffle([q.j].concat(others));
  cq.cur = q; cq.opts = opts; cq.done = false;
  box.innerHTML =
    '<div class="cqhead"><b>考一考</b><small id="cqScore">已答 ' + cq.total + " · 对 " + cq.right + "</small></div>" +
    '<p class="cqinstr">' + (q.type === "blank" ? "读句子，选出该填的词" : "下面这条中文释义是哪个词？") + "</p>" +
    '<p class="cqs">' + (q.type === "blank"
      ? escHTML(q.b.before) + '<b class="cblank" id="cqBlank">＿＿＿＿</b>' + escHTML(q.b.after)
      : fmtTrans(D.trans[q.j], 90)) + "</p>" +
    '<div class="cqopts" id="cqOpts">' + opts.map(j =>
      '<button type="button" data-j="' + j + '">' + escHTML(D.words[j]) + "</button>").join("") + "</div>" +
    '<div class="cqfoot"><span class="cqfeed" id="cqFeed"></span>' +
    '<button type="button" class="btn mini hidden" id="cqNextBtn">下一题 ▸</button></div>';
  $("cqOpts").querySelectorAll("button").forEach(b => { b.onclick = () => cqAnswer(+b.dataset.j); });
  $("cqNextBtn").onclick = () => cqNext();
}
function cqAnswer(choice) {
  if (cq.done) return;
  cq.done = true;
  const q = cq.cur, right = q.j;
  const good = choice === right;
  cq.total++; if (good) cq.right++;
  const ph = D.phon[right];
  const zh = q.type === "blank" ? (q.zh || "") : String(D.trans[right] || "").slice(0, 60);
  $("cqOpts").querySelectorAll("button").forEach(b => {
    const j = +b.dataset.j;
    b.disabled = true;
    if (j === right) b.classList.add("ok");
    else if (j === choice) b.classList.add("bad");
  });
  if (q.type === "blank" && $("cqBlank")) {
    $("cqBlank").textContent = q.b.hit;
    $("cqBlank").classList.add("filled");
  }
  const feed = $("cqFeed");
  feed.className = "cqfeed " + (good ? "good" : "bad");
  feed.innerHTML = (good ? "✓ 对了" : "✗ 应该是 <b>" + escHTML(D.words[right]) + "</b>") +
    (ph ? ' <span class="cqph">/' + escHTML(ph) + "/</span>" : "") +
    (zh ? ' <span class="cqzh">' + escHTML(zh) + "</span>" : "");
  $("cqScore").textContent = "已答 " + cq.total + " · 对 " + cq.right;
  $("cqNextBtn").classList.remove("hidden");
  if (!good) speak(D.words[right]);
}


/* 数据块还在路上时，面板先亮个「载入中」占位：点了没反应最让人困惑 */
function showPartPending(i) {
  if (!panelPending("")) return;
  $("dWord").textContent = D.words[i];
  $("dBand").textContent = BAND_NAMES[D.band[i]] + " 词层 · 高频第 " + BAND_RANGE[D.band[i]] + " 词";
  $("masteryRow").style.display = "";
}
function clearPartPending() { /* 展开时本来就会重画面板，占位不用单独收拾 */ }

/* 面板通用占位骨架：返回 false 说明 DOM 还没就绪 */
function panelPending(bandText) {
  const d = $("detail"), ph = $("ph");
  if (!d || !ph) return false;
  $("emptyState").classList.add("hidden");
  d.classList.remove("hidden");
  ph.classList.add("hidden");
  $("dPhon").textContent = "";
  $("dBand").textContent = bandText;
  $("dTags").innerHTML = "";
  $("dTrans").innerHTML = '<div class="partload"><i class="spin"></i>释义正在载入…</div>';
  $("dDue").textContent = "";
  ["bEx", "bDef", "bMorph", "bColl", "bConf"].forEach(id => { const el = $(id); if (el) el.style.display = "none"; });
  $("dFam").innerHTML = "";
  $("dConf").innerHTML = "";
  $("dRel").innerHTML = "";
  $("masteryRow").style.display = "none";
  return true;
}

function renderPanel(i, extraNode) {
  if (i === null) {
    if (!extraNode) return;
    /* 词表外词的音标/释义是单独一包（约 480KB），点开时才去取 */
    if (!hasExtraDef) {
      if (!panelPending("词表外关联词")) return;
      $("dWord").textContent = D.extra[extraNode.i];
      needExtraDef().then(() => renderPanel(null, extraNode),
        () => partFailed(() => renderPanel(null, extraNode), "词表外词的释义没载入成功"));
      return;
    }
    renderExtraPanel(extraNode);
    return;
  }
  extraCurrent = null;
  $("masteryRow").style.display = "";
  const _dd = $("dDue"); if (_dd) _dd.style.display = "";
  $("ph").classList.add("hidden");
  $("detail").classList.remove("hidden");
  $("extInfo").classList.add("hidden");
  document.querySelectorAll("button.ext.on").forEach(x => x.classList.remove("on"));

  $("dWord").textContent = D.words[i];
  const ph = D.phon[i];
  $("dPhon").textContent = ph ? "/" + ph + "/" : "无音标";
  $("dPhon").classList.toggle("nophon", !ph);
  $("dBand").textContent = BAND_NAMES[D.band[i]] + " 词层 · 高频第 " + BAND_RANGE[D.band[i]] + " 词";
  const tags = (D.tag[i] || "").split(" ").filter(Boolean);
  $("dTags").innerHTML = tags.map(t => "<i>" + t + "</i>").join("");

  document.querySelectorAll(".mbtn").forEach(b => {
    b.classList.toggle("on", +b.dataset.s === statusOf(i));
  });

  /* 复习排期提示：标记过掌握度的词会显示「下次复习 / 已到期」 */
  const ddue = $("dDue");
  if (ddue) {
    const rec = prog[D.words[i]];
    if (!rec || !rec.s) {
      ddue.className = "ddue";
      ddue.textContent = "标记「学习中 / 已掌握」后会自动排进复习计划";
    } else {
      const overdue = (rec.due || 0) <= Date.now();
      ddue.className = "ddue" + (overdue ? " due" : "");
      ddue.innerHTML = (overdue ? "🔔 复习已到期" : "⏱ 下次复习 " + dueText(i)) +
        '<span class="ddim">已复习 ' + (rec.reps || 0) + " 次" +
        (rec.laps ? " · 忘过 " + rec.laps + " 次" : "") + "</span>";
    }
  }

  /* 例句：语境句 + 中文，点整句朗读 */
  const exWord = D.words[i];
  const exRec = (window.APP_EX && window.APP_EX[exWord]) || null;
  const bEx = $("bEx");
  if (bEx) {
    if (exRec && exRec[0]) {
      bEx.style.display = "";
      const note = $("dExNote");
      if (note) note.textContent = "点击整句朗读";
      $("dEx").innerHTML =
        '<div class="exrow" data-en="' + escHTML(exRec[0]) + '" role="button" tabindex="0">' +
        '<p class="exen">' + exHighlight(exRec[0], exFormsOf(i)) + "</p>" +
        '<p class="exzh">' + escHTML(exRec[1] || "") + "</p>" +
        "</div>";
      $("dEx").querySelectorAll(".exrow").forEach(el => {
        el.onclick = () => speak(el.dataset.en, el);
      });
    } else {
      /* 万一没有例句时彻底收起，并清掉上一个词残留的 DOM */
      bEx.style.display = "none";
      $("dEx").innerHTML = "";
      if ($("dExNote")) $("dExNote").textContent = "";
    }
  }

  /* 段落记忆：把词网里的关系词编进同一段（没有该词的段落时整块收起） */
  renderPara(i);

  /* 中文/英文释义 + 词性导航 tab（每次换词重置回「全部」） */
  posFilter = "";
  renderPosTabs(D.trans[i]);
  renderSenses(i);

  /* morphology: 词根拆解 + 同根词 */
  const w = D.words[i];
  const mw = D.morph && D.morph[w];
  const cg = D.cogn && D.cogn[w];
  $("bMorph").style.display = (mw || cg) ? "" : "none";
  /* 每个词根段都是入口：点一下看「所有含这个词根的词」（-spect- → expect/inspect/respect…） */
  $("dMorph").innerHTML = mw ? mw.map(function (seg) {
    const k = seg[0], t = seg[1], g = seg[2] || "";
    return '<button type="button" class="seg ' + k + '" data-k="' + esc(k) + '" data-t="' + esc(t) +
      '" title="看所有含「' + esc(t) + '」的词">' + esc(t) +
      (g ? "<i>" + esc(g) + "</i>" : "") + "</button>";
  }).join('<span class="plus">+</span>') : "";
  $("dMorph").querySelectorAll("button.seg").forEach(b => {
    b.onclick = () => openRoot(b.dataset.k, b.dataset.t);
  });
  const mn = $("dMorphNote");
  mn.textContent = "";
  if (mw) {
    const all = document.createElement("button");
    all.type = "button";
    all.id = "dMorphAll";
    all.className = "mlink";
    all.textContent = "全部词根 ›";
    all.title = "词根 / 词缀索引（快捷键 I）";
    all.onclick = () => openRoot();
    mn.appendChild(all);
    if (cg && cg.length) mn.appendChild(document.createTextNode(" · 同根词 " + cg.length + " 个"));
  } else if (cg && cg.length) {
    mn.textContent = "同根词 " + cg.length + " 个";
  }
  if (cg && cg.length) {
    $("dCogn").innerHTML = cg.map(c => "<button data-w=\"" + c + "\">" + c + "</button>").join("");
    $("dCogn").querySelectorAll("button").forEach(b => {
      b.onclick = () => { trail.push(current); expand(D.idx[b.dataset.w]); speak(b.dataset.w); };
    });
  } else {
    $("dCogn").innerHTML = "";
  }

  /* collocations: 高频搭配 */
  const cl = D.coll && D.coll[w];
  $("bColl").style.display = cl ? "" : "none";
  if (cl) {
    $("dColl").innerHTML = cl.map(([p, c]) =>
      "<button class=\"colb\" data-p=\"" + p + "\"><span>" + p + "</span><i>" + c + "</i></button>"
    ).join("");
    $("dColl").querySelectorAll(".colb").forEach(b => {
      b.onclick = () => speak(b.dataset.p, b);
    });
    /* 顺手探测这批搭配有没有真人音：点击时才好同步决定用哪个音源 */
    probeDict(cl.map(x => x[0]));
  } else {
    $("dColl").innerHTML = "";
  }

  /* word family */
  const fam = D.fam[i] || [];
  $("dFamNote").textContent = fam.length ? fam.length + " 个词形" : "";  $("dFam").innerHTML = fam.map(([f, c]) => {
    const target = D.alias[f];
    if (target && target !== D.words[i] && D.idx[target] !== undefined) {
      return `<span class="jump" data-w="${target}"><b>${f}</b><i>${c}</i></span>`;
    }
    return `<span><b>${f}</b><i>${c}</i></span>`;
  }).join("") || "<span style='color:#9ca3af;font-size:12px'>无</span>";
  $("dFam").querySelectorAll(".jump").forEach(el => {
    el.onclick = () => { go(el.dataset.w); speak(el.dataset.w); };
  });

  /* 易混词：形近 / 音近，需要全局词表，所以可能随词层载入逐步补齐 */
  renderConf(i);

  /* relations */
  const groups = relsOf(i);
  let html = "";
  TYPE_PRIORITY.forEach(t => {
    const list = groups[t];
    if (!list || !list.length) return;
    const r = RMAP[t];
    html += `<div class="rgroup"><div class="rt"><span class="dot" style="background:${r.color}"></span>${r.name} · ${list.length}</div><div class="rlist">`;
    list.slice(0, 24).forEach(ref => {
      if (isWord(ref)) {
        html += `<button data-i="${ref}">${D.words[ref]}</button>`;
      } else {
        const j = extraIdx(ref);
        html += `<button class="ext" data-x="${j}" title="${(extraTrans(j) || "词表外").split("；")[0].slice(0, 60)} · 点击听发音">${D.extra[j]}</button>`;
      }
    });
    html += "</div></div>";
  });
  $("dRel").innerHTML = html || "<span class='muted'>该词暂无关系词</span>";
  $("dRel").querySelectorAll("button[data-i]").forEach(b => {
    b.onclick = () => { trail.push(current); expand(+b.dataset.i); speak(D.words[+b.dataset.i]); };
  });
  $("dRel").querySelectorAll("button.ext").forEach(b => {
    b.onclick = () => {
      const j = +b.dataset.x;
      $("dRel").querySelectorAll("button.ext").forEach(x => x.classList.toggle("on", x === b));
      showExtInfo(j);
      speak(D.extra[j]);
    };
  });
}

document.querySelectorAll(".mbtn").forEach(b => {
  b.onclick = () => {
    if (current === null) return;
    setStatus(current, +b.dataset.s);
    renderPanel(current);
    draw();
    renderStats();
    if (!$("listModal").classList.contains("hidden")) renderList();
  };
});

/* ---------- trail / history ---------- */
function renderTrail() {
  const el = $("trail");
  if (!trail.length) { el.innerHTML = ""; return; }
  const items = trail.slice(-6).filter(x => x !== null && x !== undefined);
  el.innerHTML = "<span class='sep'>历史：</span>" + items.map(i =>
    `<a data-i="${i}">${D.words[i]}</a>`).join("<span class='sep'>›</span>");
  el.querySelectorAll("a").forEach(a => {
    a.onclick = () => go(D.words[+a.dataset.i]);
  });
}

/* ---------- search ---------- */
const sugg = $("sugg");
const search = $("search");
let sugItems = [], sugSel = -1;

/* 中文搜索：汉字 → 命中该义的词。索引 data_zh.js 按需载入（214KB gzip），
   首屏不下载；只有第一次输入中文时才拉取。
   索引里「词间」用 ";"、「词内义项间」用 "|"（两个分隔符必须不同，
   否则 split("|") 出来的是义项总数而不是词数）。 */
const CJK_RE = /[\u4e00-\u9fa5]/;
const ZH_WSEP = ";", ZH_SEP = "|";
/* 与生成脚本 slim() 保持一致：只留汉字/字母/数字 */
const zhNorm = s => String(s || "").replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "");
function zhArray() {
  if (zhParts === null && D.zh) {
    const a = D.zh.split(ZH_WSEP);
    zhParts = a.length === N ? a : null;      /* 结构对不上就当没载入，不至于错位 */
  }
  return zhParts;
}
/* 命中该词的哪个义项（拿来做候选行的说明） */
function zhHitOf(i, toks) {
  const arr = zhArray();
  const s = arr ? arr[i] || "" : "";
  const sl = s.split(ZH_SEP).find(x => toks.every(t => x.indexOf(t) >= 0)) || s;
  return sl.slice(0, 24);
}
function zhSearch(toks, cap) {
  const arr = zhArray();
  if (!arr) return [];
  const out = [];
  for (let i = 0; i < N; i++) {
    const s = arr[i];
    if (!s) continue;
    let okAll = true;
    for (let k = 0; k < toks.length; k++) if (s.indexOf(toks[k]) < 0) { okAll = false; break; }
    if (okAll) out.push(i);
  }
  out.sort((a, b) => D.band[a] - D.band[b]);   /* 高频词层优先 */
  return out.slice(0, cap || 12);
}

function doSuggest(q) {
  const raw = String(q || "").trim();
  if (!raw) { sugg.classList.add("hidden"); return; }
  if (CJK_RE.test(raw)) { zhSuggest(raw); return; }
  q = raw.toLowerCase();
  const res = [];
  const seen = new Set();
  for (let i = 0; i < N && res.length < 8; i++) {
    if (D.words[i].startsWith(q) && !seen.has(D.words[i])) { seen.add(D.words[i]); res.push([D.words[i], i, ""]); }
  }
  for (let i = 0; i < N && res.length < 10; i++) {
    if (D.words[i].includes(q) && !seen.has(D.words[i])) { seen.add(D.words[i]); res.push([D.words[i], i, ""]); }
  }
  /* alias hits (word-family members like teacher → teach) */
  const aliases = [];
  for (const f in D.alias) {
    if (f.startsWith(q) && aliases.length < 6) aliases.push([f, D.alias[f]]);
  }
  aliases.forEach(([f, h]) => {
    if (!seen.has(h)) {
      seen.add(h);
      res.push([h, D.idx[h], "词族成员 " + f]);
    }
  });
  sugItems = res.slice(0, 10); sugSel = -1;
  if (!sugItems.length) { sugg.classList.add("hidden"); return; }
  sugg.innerHTML = sugItems.map(([w, i, note], k) =>
    `<div data-k="${k}"><b>${w}</b><i>${note || (D.trans[i] || "").split("；")[0].slice(0, 30)}</i><span class="sugband" style="color:${bandColor(D.band[i])}">${BAND_NAMES[D.band[i]]}</span></div>`
  ).join("");
  sugg.classList.remove("hidden");
  sugg.querySelectorAll("div").forEach(d => {
    d.onclick = () => pick(sugItems[+d.dataset.k]);
  });
}

/* 中文路径：索引没载入就先拉，载完后自动用「当时输入框里的内容」重跑一次 */
function zhSuggest(raw) {
  const toks = raw.split(/\s+/).map(zhNorm).filter(Boolean);
  if (!toks.length) { sugg.classList.add("hidden"); return; }
  if (!hasZh) {
    sugg.innerHTML = '<div class="sugload">正在载入中文词典…</div>';
    sugg.classList.remove("hidden");
    needZh().then(() => {
      const now = String(search.value || "").trim();
      if (now && CJK_RE.test(now)) zhSuggest(now);
    }).catch(() => {
      sugg.innerHTML = '<div class="sugload">中文词典没能载入（可点顶栏徽标强制更新后重试）</div>';
    });
    return;
  }
  const hits = zhSearch(toks, 12);
  sugItems = hits.map(i => [D.words[i], i, zhHitOf(i, toks)]);
  sugSel = -1;
  if (!sugItems.length) {
    sugg.innerHTML = '<div class="sugload">没有匹配「' + escHTML(raw) + '」的词</div>';
    sugg.classList.remove("hidden");
    return;
  }
  sugg.innerHTML = sugItems.map(([w, i, note], k) =>
    `<div data-k="${k}"><b>${w}</b><i>${note}</i><span class="sugband" style="color:${bandColor(D.band[i])}">${BAND_NAMES[D.band[i]]}</span></div>`
  ).join("");
  sugg.classList.remove("hidden");
  sugg.querySelectorAll("div").forEach(d => {
    d.onclick = () => pick(sugItems[+d.dataset.k]);
  });
}

function pick(item) {
  if (!item) return;
  sugg.classList.add("hidden");
  search.value = "";
  go(item[1]);
}

search.addEventListener("input", () => doSuggest(search.value));
search.addEventListener("keydown", e => {
  if (e.key === "ArrowDown") { sugSel = Math.min(sugSel + 1, sugItems.length - 1); markSug(); e.preventDefault(); }
  else if (e.key === "ArrowUp") { sugSel = Math.max(sugSel - 1, 0); markSug(); e.preventDefault(); }
  else if (e.key === "Enter") {
    if (sugSel >= 0) pick(sugItems[sugSel]);
    else if (sugItems.length) pick(sugItems[0]);
  } else if (e.key === "Escape") { sugg.classList.add("hidden"); }
});
function markSug() {
  sugg.querySelectorAll("div").forEach((d, k) => d.classList.toggle("on", k === sugSel));
}

function go(w) {
  let i = null;
  if (typeof w === "number") i = w;
  else {
    w = String(w).trim().toLowerCase();
    if (D.idx[w] !== undefined) i = D.idx[w];
    else if (D.alias[w] !== undefined) i = D.idx[D.alias[w]];
  }
  if (i === null || i === undefined) return;
  document.getElementById("emptyState").classList.add("hidden");
  if (current !== null && current !== i) { trail.push(current); if (trail.length > 24) trail.shift(); }
  expand(i, { reset: true });
  try { history.replaceState(null, "", "#" + encodeURIComponent(nodeWord("w", i))); } catch (e) {}
}

/* ---------- deep link (#word) ---------- */
function applyHash() {
  const w = decodeURIComponent(location.hash.slice(1)).trim().toLowerCase();
  if (w) go(w);
}
window.addEventListener("hashchange", applyHash);

/* ---------- next word ---------- */
function nextWord() {
  const b = +$("bandSel").value;
  const pool = [];
  for (let i = 0; i < N; i++) {
    if (b && D.band[i] !== b) continue;
    const s = statusOf(i);
    if (s === 0) pool.push(i);
  }
  if (!pool.length) {
    for (let i = 0; i < N; i++) { if (b && D.band[i] !== b) continue; pool.push(i); }
  }
  if (!pool.length) return;
  go(pool[Math.floor(Math.random() * pool.length)]);
}

/* ---------- stats ---------- */
function renderStats() {
  const b = +$("bandSel").value;
  let total = 0, learned = 0, mastered = 0;
  for (let i = 0; i < N; i++) {
    if (b && D.band[i] !== b) continue;
    total++;
    const s = statusOf(i);
    if (s === 1) learned++;
    if (s === 2) mastered++;
  }
  const pct = total ? Math.round((mastered + learned) / total * 100) : 0;
  $("stats").innerHTML =
    `<span>已掌握 <b>${mastered}</b></span>` +
    `<span>学习中 <b>${learned}</b></span>` +
    `<span>共 ${total}</span>` +
    `<div class="bar"><div style="width:${pct}%"></div></div>` +
    `<span>${pct}%</span>`;
  updateRvBadge();
  updateHardBadge();
}

/* ---------- legend：词关系卡片 ----------
   只留「可点的 7 类关系开关」，常驻左下角；
   静态说明（掌握度 / 词频层 / 词表外词 / 悬浮方向）挪到顶栏「ⓘ 说明」按钮旁，
   这样主学习屏只保留要操作的东西。 */
(function legend() {
  const wrap = $("legend");

  const relBody =
    `<div class="lgrs">` +
    REL.map(r => {
      /* 上位词/下位词在立体视图里是有方向的：↑ 往上、↓ 往下 */
      const arrow = r.t === 2 ? " ↑" : r.t === 3 ? " ↓" : "";
      /* --rc 供 CSS 取色（选中发光），选中底色由 JS 按 rgba 上 */
      return `<div class="lgr" data-t="${r.t}" role="button" tabindex="0"` +
        ` style="--rc:${r.color}"` +
        ` title="点击：只高亮「${r.name}」这一类（可多选，再点一次取消）">` +
        `<span class="sw" style="background:${r.color}"></span>` +
        `<span class="lgn">${r.name}${arrow}</span></div>`;
    }).join("") +
    `</div>` +
    `<div class="lgfoot">` +
      `<span class="lghint" id="lgHint"></span>` +
      `<button class="lgbtn lgall" id="lgRst" type="button" title="恢复显示全部关系（快捷键 0）">全部</button>` +
    `</div>`;

  /* 造一张可收起的卡片；mini 状态记在 localStorage */
  function mkCard(title, bodyHTML, key) {
    const card = document.createElement("div");
    card.className = "lgcard";
    card.innerHTML =
      `<div class="lghd"><span class="lgt">${title}</span>` +
      `<button class="lgbtn lgmin" type="button" title="收起">−</button></div>` +
      `<div class="lgbd">` + bodyHTML + `</div>`;
    wrap.appendChild(card);
    const btn = card.querySelector(".lghd .lgbtn");
    const apply = mini => {
      card.classList.toggle("mini", mini);
      btn.textContent = mini ? "+" : "−";
      btn.title = mini ? "展开" + title : "收起" + title;
      btn.setAttribute("aria-expanded", String(!mini));
    };
    let mini = false;
    try { mini = localStorage.getItem(key) === "1"; } catch (e) {}
    apply(mini);
    btn.addEventListener("click", ev => {
      ev.stopPropagation();
      mini = !mini;
      apply(mini);
      try { localStorage.setItem(key, mini ? "1" : "0"); } catch (e) {}
    });
    return card;
  }
  const relCard = mkCard("词关系", relBody, "cocawn.legend.mini");

  /* ---- 关系类型开关：点关系名只高亮这一类，其余淡出 ---- */
  const hint = relCard.querySelector("#lgHint");
  const rst = relCard.querySelector("#lgRst");
  const rgba = (hex, a) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  };
  function syncRelUI() {
    const on = relFilter.size > 0;
    relCard.querySelectorAll(".lgr").forEach(row => {
      const t = +row.dataset.t;
      const c = RMAP[t].color, sel = relFilter.has(t);
      row.classList.toggle("on", sel);
      row.classList.toggle("off", on && !sel);
      row.setAttribute("aria-pressed", String(sel));
      /* 选中时用「这条线自己的颜色」淡淡铺底，而不是统一一个色 */
      row.style.background = sel ? rgba(c, 0.13) : "";
      row.style.borderColor = sel ? rgba(c, 0.42) : "";
    });
    rst.classList.toggle("active", on);
    hint.textContent = on
      ? "只看 " + relFilter.size + " 类"
      : "点关系名只看该类型";
  }
  relUI = syncRelUI;                 /* 键盘快捷键切换时同步图例高亮 */
  relCard.querySelector(".lgbd").addEventListener("click", ev => {
    const row = ev.target.closest(".lgr");
    if (!row) return;
    ev.stopPropagation();
    ev.preventDefault();
    toggleRelType(+row.dataset.t);
  });
  /* 键盘可达：Tab 到某一类后回车/空格同样生效 */
  relCard.querySelector(".lgbd").addEventListener("keydown", ev => {
    const row = ev.target.closest(".lgr");
    if (!row || (ev.key !== "Enter" && ev.key !== " ")) return;
    ev.preventDefault();
    ev.stopPropagation();
    toggleRelType(+row.dataset.t);
  });
  rst.addEventListener("click", ev => {
    ev.stopPropagation();
    clearRelFilter();
  });
  syncRelUI();
})();

/* ---------- 说明浮层：挂在顶栏「ⓘ 说明」按钮旁边 ----------
   纯参考信息（不是操作），所以做成按钮旁的浮层：看完点一下就走，
   主学习屏只留词网 + 关系开关。 */
(function helpPop() {
  const btn = $("helpBtn");
  if (!btn) return;
  const pop = document.createElement("div");
  pop.className = "helppop lgbox hidden";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "图例与说明");
  pop.innerHTML =
    `<div class="lghd"><span class="lgt">说明</span>` +
    `<button class="lgbtn lgx" type="button" title="关闭（Esc）">✕</button></div>` +
    `<div class="lgbd">` +
    /* 怎么用：把原来学习屏上方那行小字搬进来，并补成一份简短使用说明 */
    `<div class="hsec">怎么用</div>` +
    `<div class="hlist">
       <div><i>1</i>顶栏搜索支持打中文找词（如「政府」「放弃」）；点任意节点朗读美音、右侧看音标与释义</div>
       <div><i>2</i>点相邻节点继续向外扩，像滚雪球一样把相关词连成一片</div>
       <div><i>3</i>线太密看不清：点左下「词关系」里的关系名，只看这一类</div>
       <div><i>4</i>滚轮缩放、拖拽平移；双击节点重新展开它；按 Z（或点右下角 ⤾）把视图复位</div>
       <div><i>5</i>老记不住的词会自动收进顶栏「⚠ 难词」，攒够了一起攻克</div>
       <div><i>6</i>多义词用释义上方的词性标签一键切换：只看名词 / 动词 / 形容词的义项</div>
       <div><i>7</i>顶栏「📊 统计」看每天的复习量、记忆保持率和下次复习排期</div>
       <div><i>8</i>词卡里的「易混词」列出形近 / 音近的词，点「辨析」并排对比、还能做小测（快捷键 C）</div>
       <div><i>9</i>词卡里的「词根拆解」每一段都能点：一个词根串起一串同根词（-spect- → expect / inspect / respect），这是把散词连成串最快的一条路（快捷键 I）。在词根索引页点「🧭 开始串记」还能把 411 组词根当学习路径一组组过，评过的词写进和复习卡同一条记录</div>
       <div><i>10</i>词卡里的「段落记忆」把这个词网编成一段小情景文：带色的就是它的关系词，点句子朗读、点彩色词跳回词网，点「挖空练习」用词池把挖掉的词填回去（快捷键 T）。读完一段，这些词就活在同一个语境里了</div>
     </div>` +
    `<div class="hsec">图例</div>` +
    `<div class="li">
       <span class="sw" style="background:#16a34a"></span>已掌握
       <span class="sw" style="background:#f59e0b;margin-left:6px"></span>学习中
       <span class="sw" style="background:#cbd5e1;margin-left:6px"></span>未学
     </div>
     <div class="bandblock">
       <div class="bandramp">
         ${Array.from({ length: 10 }, (_, k) =>
           `<span style="background:${BAND_COLORS[k + 1]}" title="${BAND_NAMES[k + 1]} 词层（第 ${BAND_RANGE[k + 1]} 词）"></span>`
         ).join("")}
       </div>
       <div class="bandscale"><span>1k 高频</span><span>← 词频层 →</span><span>10k 低频</span></div>
     </div>
     <div class="li" style="margin-top:4px">
       <span class="sw" style="background:#e2e8f0;border:1px solid #cbd5e1"></span>词表外关联词（点开看释义·发音）
     </div>
     <div class="li" style="color:#94a3b8">↑ 上位词悬浮上方（紫环）· ↓ 下位词沉在下方（青环）· 其余关系同一平面（拖右下「视角」可旋转）</div>` +
    `<div class="hsec">快捷键</div>` +
    `<div class="hkeys">
       <span><b>R</b>复习</span><span><b>N</b>下一个词</span><span><b>G</b>路径查找</span>
       <span><b>M</b>进度地图</span><span><b>L</b>单词列表</span><span><b>V</b>立体/平面</span>
       <span><b>P</b>发音</span><span><b>H</b>本说明</span><span><b>K</b>难词清单</span>
       <span><b>S</b>学习统计</span><span><b>C</b>易混词辨析</span><span><b>I</b>词根索引</span><span><b>T</b>段落挖空</span>
       <span><b>Z</b>复位视图</span><span><b>1–7</b>关系过滤</span><span><b>0</b>全部显示</span>
     </div>` +
    `</div>`;
  document.body.appendChild(pop);

  /* 贴着按钮放；右边/下边放不下就翻转 */
  function place() {
    const r = btn.getBoundingClientRect();
    const w = pop.offsetWidth || 244, h = pop.offsetHeight || 180;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    let top = r.bottom + 8;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
    pop.style.left = left + "px";
    pop.style.top = top + "px";
  }
  let open = false;
  function show(v) {
    open = v;
    pop.classList.toggle("hidden", !v);
    btn.classList.toggle("on", v);
    btn.setAttribute("aria-expanded", String(v));
    if (v) place();
  }
  window.toggleHelp = () => show(!open);
  window.closeHelp = () => show(false);
  btn.addEventListener("click", ev => { ev.stopPropagation(); show(!open); });
  pop.querySelector(".lgx").addEventListener("click", ev => { ev.stopPropagation(); show(false); });
  /* 点到别处就收起（点按钮本身由上面的 handler 管，不重复处理） */
  document.addEventListener("click", ev => {
    if (!open) return;
    if (pop.contains(ev.target) || btn.contains(ev.target)) return;
    show(false);
  });
  window.addEventListener("resize", () => { if (open) place(); });
  window.addEventListener("scroll", () => { if (open) show(false); }, true);
})();

/* ---------- progress map ---------- */
function bandStats() {
  const rows = [];
  for (let b = 1; b <= 10; b++) {
    let total = 0, learned = 0, mastered = 0;
    for (let i = 0; i < N; i++) {
      if (D.band[i] !== b) continue;
      total++;
      const s = statusOf(i);
      if (s === 1) learned++;
      if (s === 2) mastered++;
    }
    rows.push({ b, total, learned, mastered,
      pct: total ? (mastered + learned) / total : 0,
      mpct: total ? mastered / total : 0 });
  }
  return rows;
}

function renderMap() {
  const rows = bandStats();
  const tot = rows.reduce((a, r) => ({
    total: a.total + r.total, learned: a.learned + r.learned,
    mastered: a.mastered + r.mastered }), { total: 0, learned: 0, mastered: 0 });
  const tp = tot.total ? Math.round((tot.mastered + tot.learned) / tot.total * 100) : 0;

  /* weakness: lowest completion among bands that still have unlearned words */
  let weak = null;
  rows.forEach(r => {
    if (r.pct >= 1) return;
    if (!weak || r.pct < weak.pct) weak = r;
  });

  $("mapSub").textContent = "总体 " + tp + "% · 已掌握 " + tot.mastered;
  let html =
    '<div class="mrow"><div class="bl">全部<small>10 层</small></div>' +
    '<div class="stack"><div class="m" style="width:' + (tot.total ? tot.mastered / tot.total * 100 : 0) + '%"></div>' +
    '<div class="l" style="width:' + (tot.total ? tot.learned / tot.total * 100 : 0) + '%"></div></div>' +
    '<div class="bnum">掌握 <b>' + tot.mastered + '</b> · 学习中 ' + tot.learned +
    '<br>未学 ' + (tot.total - tot.mastered - tot.learned) + ' · ' + tp + '%</div></div>';

  rows.forEach(r => {
    const cls = "brow" + (weak && r.b === weak.b ? " weak" : "");
    html +=
      '<div class="' + cls + '" data-b="' + r.b + '">' +
      '<div class="bl"><i class="bdot" style="background:' + bandColor(r.b) + '"></i>' +
      BAND_NAMES[r.b] + '<small>' + r.total + ' 词</small></div>' +
      '<div class="stack"><div class="m" style="width:' + (r.mpct * 100) + '%"></div>' +
      '<div class="l" style="width:' + ((r.pct - r.mpct) * 100) + '%"></div></div>' +
      '<div class="bnum">掌握 <b>' + r.mastered + '</b> · 学习中 ' + r.learned +
      '<br>未学 ' + (r.total - r.mastered - r.learned) + ' · ' + Math.round(r.pct * 100) + '%</div></div>';
  });
  $("mapBody").innerHTML = html;
  $("mapBody").querySelectorAll(".brow").forEach(el => {
    el.onclick = () => {
      $("bandSel").value = el.dataset.b;
      renderStats();
      $("mapModal").classList.add("hidden");
      nextWord();
    };
  });
  if (weak) $("mapSub").textContent += " · 短板 " + BAND_NAMES[weak.b];
}

$("mapBtn").onclick = () => { renderMap(); $("mapModal").classList.remove("hidden"); };
$("mapClose").onclick = () => $("mapModal").classList.add("hidden");
$("mapModal").addEventListener("click", e => {
  if (e.target === $("mapModal")) $("mapModal").classList.add("hidden");
});

/* ---------- 学习统计面板 ----------
   和「进度地图」分工：地图回答「哪些词层学了多少」，这里回答「学得怎么样」——
   复习量的日曲线、记忆保持率、下次到期分布、连续学习天数。

   数据两个来源：
     · prog  —— 全量口径（累计复习/遗忘次数、已掌握间隔、到期时间）
     · stat  —— 逐日行为日志（见「学习统计日志」一节） */
const STAT_DAYS = 14;              /* 活动图显示多少天 */

/* 全量口径的复习总量：直接从 prog 汇总，含统计日志启用之前的历史 */
function revTotals() {
  let reps = 0, laps = 0, ivlSum = 0, ivlMax = 0, ivlN = 0;
  for (const k in prog) {
    const v = prog[k];
    if (!v || !v.s) continue;
    reps += v.reps || 0;
    laps += v.laps || 0;
    if (v.s === 2) {
      const iv = v.ivl || 0;
      ivlSum += iv; ivlN++;
      if (iv > ivlMax) ivlMax = iv;
    }
  }
  return { reps, laps, ivlN, ivlMax, ivlAvg: ivlN ? Math.round(ivlSum / ivlN) : 0 };
}

/* 下次复习的到期分布（只统计已排期的词，即掌握度 > 0） */
function dueBuckets() {
  const now = Date.now();
  const b = [
    { t: "已到期", n: 0, c: "#dc2626" },
    { t: "今天", n: 0, c: "#f59e0b" },
    { t: "1–3 天", n: 0, c: "#eab308" },
    { t: "4–7 天", n: 0, c: "#84cc16" },
    { t: "8–30 天", n: 0, c: "#22c55e" },
    { t: "30 天以上", n: 0, c: "#0ea5e9" }
  ];
  for (const k in prog) {
    const v = prog[k];
    if (!v || !v.s) continue;
    const dd = (v.due || 0) - now;      /* due=0 是 v21 之前的老记录 → 视为立刻到期 */
    let slot;
    if (dd <= 0) slot = 0;
    else if (dayKey(v.due) === dayKey(now)) slot = 1;
    else if (dd <= 3 * DAY) slot = 2;
    else if (dd <= 7 * DAY) slot = 3;
    else if (dd <= 30 * DAY) slot = 4;
    else slot = 5;
    b[slot].n++;
  }
  return b;
}

/* 最近 n 天的活动：没记录的天也补一条空的，图上的间距才均匀 */
function actDays(n) {
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const k = dayKey(d.getTime());
    const r = stat[k] || {};
    out.push({ k, d, rv: r.rv || 0, ok: r.ok || 0, mid: r.mid || 0, bad: r.bad || 0, nw: r.nw || 0 });
  }
  return out;
}

/* 连续学习天数：今天还没学不算断（从昨天接着数） */
function streakDays() {
  let n = 0;
  const now = new Date();
  for (let i = 0; i <= STAT_KEEP; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const r = stat[dayKey(d.getTime())];
    const act = r && (r.rv > 0 || r.nw > 0);
    if (act) { n++; continue; }
    if (i === 0) continue;              /* 今天还没开始学，不打断连续 */
    break;
  }
  return n;
}

function renderStat() {
  const rows = bandStats();
  const tot = rows.reduce((a, r) => ({
    total: a.total + r.total, learned: a.learned + r.learned, mastered: a.mastered + r.mastered
  }), { total: 0, learned: 0, mastered: 0 });
  const un = tot.total - tot.mastered - tot.learned;
  const cover = tot.total ? Math.round((tot.mastered + tot.learned) / tot.total * 100) : 0;
  const rt = revTotals();
  const keep = rt.reps ? Math.max(0, Math.round((1 - rt.laps / rt.reps) * 100)) : null;
  const dueN = dueCount();
  const buckets = dueBuckets();
  const days = actDays(STAT_DAYS);
  const today = stat[dayKey(Date.now())] || emptyDay();
  const sum14 = days.reduce((a, d) => a + d.rv, 0);
  const learnedDays = Object.keys(stat).filter(k => stat[k].rv > 0 || stat[k].nw > 0).length;
  const streak = streakDays();

  $("statSub").textContent = "总体覆盖 " + cover + "% · 已掌握 " + tot.mastered + " / " + tot.total;

  if (!tot.mastered && !tot.learned) {
    $("statBody").innerHTML =
      '<div class="sempty"><div class="sbig">📊</div>' +
      "<h3>还没有学习记录</h3>" +
      "<p>先在词网里给几个词标上「学习中 / 已掌握」，或者做一轮复习。<br>" +
      "之后这里会长出每天的复习曲线、记忆保持率和下次复习的排期分布。</p>" +
      '<div class="sacts"><button id="statGoRv" class="btn primary">🔁 开始复习</button>' +
      '<button id="statGoList" class="btn">☰ 先看看单词列表</button></div></div>';
    $("statGoRv").onclick = () => { closeStat(); startReview(); };
    $("statGoList").onclick = () => { closeStat(); renderList(true); $("listModal").classList.remove("hidden"); };
    return;
  }

  /* ---- KPI 四宫格 ---- */
  const kpi = (label, val, unit, sub) =>
    '<div class="skpi"><span class="kl">' + label + "</span>" +
    "<b>" + val + (unit ? "<small>" + unit + "</small>" : "") + "</b>" +
    '<span class="ks">' + sub + "</span></div>";

  let html =
    '<div class="skpis">' +
      kpi("覆盖率", cover, "%", "已掌握 " + tot.mastered + " · 学习中 " + tot.learned + " · 未学 " + un) +
      kpi("待复习", dueN, "个", "今天已复习 " + today.rv + " 张 · 新学 " + today.nw + " 个词") +
      kpi("记忆保持率", keep === null ? "—" : keep, keep === null ? "" : "%",
          rt.reps ? "累计复习 " + rt.reps + " 次 · 忘了 " + rt.laps + " 次" : "还没有复习记录") +
      kpi("连续学习", streak, "天", "共学习 " + learnedDays + " 天 · 近 " + STAT_DAYS + " 天 " + sum14 + " 张") +
      kpi("复习间隔", rt.ivlAvg, "天", "已掌握 " + rt.ivlN + " 个 · 最长 " + rt.ivlMax + " 天") +
    "</div>";

  /* ---- 近 14 天复习量（堆叠柱：忘了 / 有印象 / 记得 / 无明细） ---- */
  const max = Math.max(1, ...days.map(d => d.rv));
  const bars = days.map((d, k) => {
    const rest = Math.max(0, d.rv - d.ok - d.mid - d.bad);   /* 回填估算的部分没有评分明细 */
    const seg = (n, c) => n > 0
      ? '<i style="height:' + (n / max * 100).toFixed(1) + "%;background:" + c + '"></i>' : "";
    const isToday = k === days.length - 1;
    const title = dayKey(d.d.getTime()) + " · " + (d.rv ? "复习 " + d.rv + " 张"
        + (d.ok + d.mid + d.bad ? "（记得 " + d.ok + " · 有印象 " + d.mid + " · 忘了 " + d.bad + "）" : "（早期记录，无评分明细）")
        : "没有复习")
      + (d.nw ? " · 新学 " + d.nw + " 个词" : "");
    return '<div class="scol' + (isToday ? " today" : "") + '" title="' + title + '">' +
      '<div class="sbar">' + seg(d.bad, "#ef4444") + seg(d.mid, "#f59e0b") +
      seg(d.ok, "#16a34a") + seg(rest, "#cbd5e1") + "</div>" +
      '<span class="sx">' + (isToday ? "今天" : d.d.getDate()) + "</span></div>";
  }).join("");

  html +=
    '<div class="scard">' +
      '<div class="scardhd"><b>近 ' + STAT_DAYS + " 天复习量</b>" +
      '<small>共 ' + sum14 + " 张 · 峰值 " + max + "</small>" +
      '<span class="slegend">' +
        '<i style="background:#ef4444"></i>忘了' +
        '<i style="background:#f59e0b"></i>有印象' +
        '<i style="background:#16a34a"></i>记得' +
      "</span></div>" +
      '<div class="schart">' + bars + "</div>" +
    "</div>";

  /* ---- 掌握进度 + 下次复习 并排 ---- */
  const pct = n => (tot.total ? (n / tot.total * 100).toFixed(1) : 0) + "%";
  const dueAll = buckets.reduce((a, b) => a + b.n, 0);

  const srow = (color, label, n, denom, extra) =>
    '<div class="srow"><span class="slab"><i style="background:' + color + '"></i>' + label + "</span>" +
    '<span class="strack"><i style="width:' + (denom ? (n / denom * 100).toFixed(1) : 0) + "%;background:" + color + '"></i></span>' +
    '<span class="snum">' + n + (extra || "") + "</span></div>";

  html +=
    '<div class="sgrid2">' +
      '<div class="scard">' +
        '<div class="scardhd"><b>掌握进度</b><small>' + tot.total + " 个词</small></div>" +
        '<div class="stack big"><div class="m" style="width:' + (tot.mastered / tot.total * 100) + '%"></div>' +
        '<div class="l" style="width:' + (tot.learned / tot.total * 100) + '%"></div></div>' +
        '<div class="slist">' +
          srow("#16a34a", "已掌握", tot.mastered, tot.total, ' <em>' + pct(tot.mastered) + "</em>") +
          srow("#f59e0b", "学习中", tot.learned, tot.total, ' <em>' + pct(tot.learned) + "</em>") +
          srow("#cbd5e1", "未学", un, tot.total, ' <em>' + pct(un) + "</em>") +
        "</div>" +
        '<div class="snote">覆盖率 = 已掌握 + 学习中 · 已掌握的词按间隔重复抽查</div>' +
      "</div>" +
      '<div class="scard">' +
        '<div class="scardhd"><b>下次复习</b><small>已排期 ' + dueAll + " 个词</small></div>" +
        '<div class="slist">' +
          buckets.map(b => {
            const pc = dueAll ? b.n / dueAll * 100 : 0;
            /* 占比太小的档位不标百分数（否则一片「0%」反而看不清数量） */
            return srow(b.c, b.t, b.n, Math.max(1, dueAll),
              pc >= 1 ? ' <em>' + Math.round(pc) + "%</em>" : "");
          }).join("") +
        "</div>" +
        '<div class="snote">' + (dueN ? "有 <b>" + dueN + "</b> 个词已经到期，随时可以复习"
          : "目前没有到期的词，按计划走就行") + "</div>" +
      "</div>" +
    "</div>";

  /* ---- 各词层进度（点一层直接跳过去） ---- */
  let weak = null;
  rows.forEach(r => { if (r.pct < 1 && (!weak || r.pct < weak.pct)) weak = r; });
  html += '<div class="scard"><div class="scardhd"><b>各词层进度</b><small>点词层直接跳到该层学习</small></div>';
  rows.forEach(r => {
    html +=
      '<div class="brow' + (weak && r.b === weak.b ? " weak" : "") + '" data-b="' + r.b + '">' +
      '<div class="bl"><i class="bdot" style="background:' + bandColor(r.b) + '"></i>' +
      BAND_NAMES[r.b] + "<small>" + r.total + " 词</small></div>" +
      '<div class="stack"><div class="m" style="width:' + (r.mpct * 100) + '%"></div>' +
      '<div class="l" style="width:' + ((r.pct - r.mpct) * 100) + '%"></div></div>' +
      '<div class="bnum">掌握 <b>' + r.mastered + "</b> · 学习中 " + r.learned +
      "<br>未学 " + (r.total - r.mastered - r.learned) + " · " + Math.round(r.pct * 100) + "%</div></div>";
  });
  html += "</div>";

  $("statBody").innerHTML = html;
  $("statBody").querySelectorAll(".brow").forEach(el => {
    el.onclick = () => {
      $("bandSel").value = el.dataset.b;
      renderStats();
      closeStat();
      nextWord();
    };
  });
}

function openStat() { renderStat(); $("statModal").classList.remove("hidden"); }
function closeStat() { $("statModal").classList.add("hidden"); }

$("statBtn").onclick = openStat;
$("statClose").onclick = closeStat;
$("statModal").addEventListener("click", e => { if (e.target === $("statModal")) closeStat(); });
$("statMapLink").onclick = () => { closeStat(); renderMap(); $("mapModal").classList.remove("hidden"); };

/* ---------- word list ---------- */
const LIST_CAP = 600;
let listMode = "all", listQuery = "", listCap = LIST_CAP;

function listRows() {
  const b = +$("bandSel").value;
  const q = listQuery.trim().toLowerCase();
  const rows = [];
  for (let i = 0; i < N; i++) {
    if (b && D.band[i] !== b) continue;
    if (listMode !== "all" && statusOf(i) !== +listMode) continue;
    if (q && D.words[i].toLowerCase().indexOf(q) < 0 &&
        String(D.trans[i] || "").toLowerCase().indexOf(q) < 0) continue;
    rows.push(i);
  }
  return rows;
}

function renderList(resetCap) {
  if (resetCap) listCap = LIST_CAP;
  const b = +$("bandSel").value;
  const rows = listRows();
  let m = 0, l = 0;
  rows.forEach(i => { const s = statusOf(i); if (s === 2) m++; else if (s === 1) l++; });
  $("listSub").textContent = (b ? BAND_NAMES[b] + " 层" : "全部词层") +
    " · " + rows.length + " 个词" +
    (listMode === "all" ? "（掌握 " + m + " · 学习中 " + l + " · 未学 " + (rows.length - m - l) + "）" : "") +
    (listQuery.trim() && partsLoading() ? " · 部分释义仍在载入，按释义的搜索可能不全" : partsHint());

  const show = rows.slice(0, listCap);
  const clean = s => String(s || "").replace(/\\[rnt]/g, " ").replace(/["<>]/g, "").replace(/\s+/g, " ").trim();
  $("listBody").innerHTML = show.length
    ? show.map(i => {
        const zh = clean(D.trans[i]).split(/[；;]/)[0].slice(0, 24);
        const tip = (BAND_NAMES[D.band[i]] + " 词层 · 第 " + BAND_RANGE[D.band[i]] + " 词 · ") +
          clean(D.trans[i]).slice(0, 90) + " · 点击发音";
        return '<span class="lw s' + statusOf(i) + (i === current ? " on" : "") + '" data-i="' + i +
          '" title="' + tip + '"><b>' + D.words[i] + "</b>" +
          (zh ? '<i>' + zh + "</i>" : "") + "</span>";
      }).join("")
    : '<div class="lempty">这里还没有符合条件的词</div>';

  $("listMore").innerHTML = rows.length > show.length
    ? '<button class="btn mini" id="listMoreBtn">显示更多（还有 ' + (rows.length - show.length) + ' 个）</button>'
    : "";
  const mb = $("listMoreBtn");
  if (mb) mb.onclick = () => { listCap += 600; renderList(); };
}

$("listBtn").onclick = () => { renderList(true); $("listModal").classList.remove("hidden"); };
$("listClose").onclick = () => $("listModal").classList.add("hidden");
$("listModal").addEventListener("click", e => {
  if (e.target === $("listModal")) $("listModal").classList.add("hidden");
});
$("listFilter").addEventListener("input", e => { listQuery = e.target.value; renderList(true); });
$("listSeg").addEventListener("click", e => {
  const btn = e.target.closest("button[data-f]");
  if (!btn) return;
  listMode = btn.dataset.f;
  $("listSeg").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === btn));
  renderList(true);
});
$("listBody").addEventListener("click", e => {
  const w = e.target.closest(".lw");
  if (!w) return;
  const i = +w.dataset.i;
  $("listModal").classList.add("hidden");
  go(i);
  /* 点词即发音（点按本身就是用户手势，iOS 也允许直接播放） */
  speak(D.words[i]);
});

/* ---------- 难词清单（错词本） ----------
   把复习里反复出问题的词聚成一册，方便集中攻克。两类词会被收进来：

     · 忘过的 —— 复习评分时选过「忘了」的词（laps 记的就是遗忘次数）
     · 卡住的 —— 还停在「学习中」、已经复习 3 次以上却没升到「已掌握」

   难度分 = 遗忘次数为主 + 掌握度越低越难 + 复习次数微调。
   数据全部来自已有的复习记录（prog），不需要额外存储，也不需要手动维护。 */
const HARD_STUCK_REPS = 3;      /* 复习满几次还没升上去，才算「卡住」 */

function hardRows() {
  const out = [];
  for (const k in prog) {
    const v = prog[k];
    if (!v || !v.s) continue;                  /* s=0 是同步用的墓碑，不算学过 */
    const i = D.idx[k];
    if (i === undefined) continue;
    const laps = v.laps || 0, reps = v.reps || 0, s = v.s || 0;
    const forgot = laps > 0;
    const stuck = !forgot && s === 1 && reps >= HARD_STUCK_REPS;
    if (!forgot && !stuck) continue;
    out.push({
      i: i, laps: laps, reps: reps, s: s,
      forgot: forgot, stuck: stuck,
      score: laps * 10 + (2 - Math.min(2, s)) * 4 + Math.min(reps, 10)
    });
  }
  out.sort((a, b) =>
    (b.score - a.score) || (b.laps - a.laps) || (D.band[a.i] - D.band[b.i]));
  return out;
}

/* 顶栏角标：一眼看到有多少难词攒着 */
function updateHardBadge() {
  const btn = $("hardBtn");
  if (!btn) return;
  const n = hardRows().length;
  btn.classList.toggle("has", n > 0);
  btn.innerHTML = "⚠ 难词" + (n ? '<i class="rvbadge">' + (n > 99 ? "99+" : n) + "</i>" : "");
  btn.title = n
    ? "难词清单：有 " + n + " 个词老是记不住（快捷键 K）"
    : "难词清单：目前还没有难词（快捷键 K）";
}

let hardMode = "all", hardQuery = "";
const HARD_CAP = 400;

/* 按当前的筛选条件（分段 + 搜索框）筛出要显示的难词 */
function hardFiltered() {
  const all = hardRows();
  let rows = hardMode === "forgot" ? all.filter(r => r.forgot)
           : hardMode === "stuck" ? all.filter(r => r.stuck)
           : all;
  const q = hardQuery.trim().toLowerCase();
  if (q) {
    rows = rows.filter(r =>
      D.words[r.i].toLowerCase().indexOf(q) >= 0 ||
      String(D.trans[r.i] || "").toLowerCase().indexOf(q) >= 0);
  }
  return { all: all, rows: rows };
}

function renderHard() {
  const st = hardFiltered();
  const nF = st.all.filter(r => r.forgot).length;
  const nS = st.all.filter(r => r.stuck).length;

  $("hardSub").textContent = (st.rows.length
    ? "共 " + st.rows.length + " 个词 · 忘过 " + nF + " · 卡住 " + nS
    : (st.all.length ? "没有符合筛选的词" : "还没有难词")) + partsHint();

  const clean = s => String(s || "").replace(/\\[rnt]/g, " ").replace(/["<>]/g, "").replace(/\s+/g, " ").trim();
  const show = st.rows.slice(0, HARD_CAP);

  $("hardBody").innerHTML = show.length
    ? show.map(r => {
        const i = r.i;
        const zh = clean(D.trans[i]).split(/[；;]/)[0].slice(0, 28);
        const why = r.forgot
          ? '<span class="hwhy bad">忘过 ' + r.laps + " 次</span>"
          : '<span class="hwhy warn">复习 ' + r.reps + " 次仍学习中</span>";
        const tip = BAND_NAMES[D.band[i]] + " 词层 · 第 " + BAND_RANGE[D.band[i]] + " 词 · " +
          clean(D.trans[i]).slice(0, 90) + " · 点击跳到词网并发音";
        return '<div class="hrow' + (i === current ? " on" : "") + '" data-i="' + i + '" title="' + tip + '">' +
          '<span class="hw">' + esc(D.words[i]) + "</span>" +
          '<span class="mchip band" style="border-color:' + bandColor(D.band[i]) + '33;color:' +
            bandColor(D.band[i]) + '">' + BAND_NAMES[D.band[i]] + "</span>" +
          rvBadgeOf(r.s) + why +
          '<span class="hzh">' + zh + "</span>" +
          '<span class="hdue">' + (dueText(i) || "") + "</span></div>";
      }).join("") +
      (st.rows.length > show.length
        ? '<div class="hmore">清单很长，先显示前 ' + show.length + " 个 · 用上面的搜索框找具体的词</div>"
        : "")
    : '<div class="hempty">' +
        (st.all.length
          ? "没有符合筛选条件的词"
          : "还没有难词 🎉<br>复习时评过「忘了」的词会自动收进这里，方便集中攻克。") +
      "</div>";

  const btn = $("hardReview");
  const n = Math.min(st.rows.length, RV_CAP);
  btn.disabled = !n;
  btn.textContent = n ? "🔁 复习这些词（" + n + "）" : "🔁 复习这些词";
}

$("hardBtn").onclick = () => { renderHard(); $("hardModal").classList.remove("hidden"); };
$("hardClose").onclick = () => $("hardModal").classList.add("hidden");
$("hardModal").addEventListener("click", e => {
  if (e.target === $("hardModal")) $("hardModal").classList.add("hidden");
});
$("hardFilter").addEventListener("input", e => { hardQuery = e.target.value; renderHard(); });
$("hardSeg").addEventListener("click", e => {
  const btn = e.target.closest("button[data-f]");
  if (!btn) return;
  hardMode = btn.dataset.f;
  $("hardSeg").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === btn));
  renderHard();
});
$("hardBody").addEventListener("click", e => {
  const row = e.target.closest(".hrow");
  if (!row) return;
  const i = +row.dataset.i;
  $("hardModal").classList.add("hidden");
  go(i);
  speak(D.words[i]);
});
/* 把清单里的词排成一队直接开练（沿用复习界面，评分照常写回排期） */
$("hardReview").onclick = () => {
  const rows = hardFiltered().rows;
  if (!rows.length) return;
  $("hardModal").classList.add("hidden");
  startReview(rows.slice(0, RV_CAP).map(r => r.i));
};

/* ---------- 词根 / 词缀索引 ----------
   D.morph 是按「词头」键控的一小段拆解：
     { expect: [["pre","ex","向外"], ["root","spect","看"]] }
   词卡里一次只看得见一个词的拆解，看不出这批词本来是一家人。这里把它
   反过来聚成「一个词根 → 一串同根词」—— -spect- → expect / inspect /
   respect / suspect，把散词变词串，这才是词根最该起的作用。

   不新增任何数据文件：全部由已载入词层的 D.morph 现算，新块进来时重建
   （见 APP_MERGE 里的 rootIdx = null），所以页面会随载入自己补齐。 */
const ROOT_KIND_CN = { pre: "前缀", root: "词根", suf: "后缀" };
const ROOT_CAP = 400;                 /* 一次最多画多少组：够翻，也不至于卡 */

function rootBuild() {
  const maps = { root: new Map(), pre: new Map(), suf: new Map() };
  for (const w in D.morph) {
    const segs = D.morph[w];
    if (!segs || !segs.length) continue;
    const i = D.idx[w];
    if (i === undefined) continue;            /* 只收词表内的词 */
    for (const seg of segs) {
      const kind = seg[0], t = seg[1], m = maps[kind];
      if (!m || !t) continue;
      let e = m.get(t);
      if (!e) {
        e = { t: t, kind: kind, gloss: seg[2] || "", words: [], seen: new Set() };
        m.set(t, e);
      } else if (!e.gloss && seg[2]) e.gloss = seg[2];
      if (e.seen.has(i)) continue;            /* 同一个词的两段同型词缀（如 able）只算一次 */
      e.seen.add(i);
      e.words.push(i);
    }
  }
  const all = [];
  ["root", "pre", "suf"].forEach(kind => maps[kind].forEach(e => {
    delete e.seen;
    /* 组内按词层升序：先看到最常用的那几个，串记才有抓手 */
    e.words.sort((a, b) => (D.band[a] - D.band[b]) || (a - b));
    e.best = D.band[e.words[0]] || 99;         /* 该词根里最常用的那个词在第几层 */
    all.push(e);
  }));
  /* 组间排序：词数多的在前（串得越长越值得看），再按最常见词的词层，最后按字母 */
  all.sort((a, b) =>
    (b.words.length - a.words.length) || (a.best - b.best) ||
    (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  return all;
}
function rootList() { return rootIdx || (rootIdx = rootBuild()); }

let rootMode = "all", rootQuery = "", rootMultiOnly = true;
const rootExpanded = new Set();        /* 已展开的分组，键 = kind + ":" + 词根 */
let rootFocus = "";                    /* 从词卡点进来时要高亮定位的那一组 */
const rootKeyOf = e => e.kind + ":" + e.t;

/* 列表页同款的一行简短释义（清洗掉换行、引号、多余空白） */
function zhBrief(i, n) {
  return String(D.trans[i] || "").replace(/\\[rnt]/g, " ").replace(/["<>]/g, "")
    .replace(/\s+/g, " ").trim().split(/[；;]/)[0].slice(0, n || 20);
}

function rootFiltered() {
  const all = rootList();
  const q = rootQuery.trim().toLowerCase();
  if (!q && rootMode === "all" && !rootMultiOnly) return { all: all, rows: all };
  const rows = all.filter(e => {
    if (rootMode !== "all" && e.kind !== rootMode) return false;
    if (rootMultiOnly && e.words.length < 2) return false;
    if (!q) return true;
    if (e.t.toLowerCase().indexOf(q) >= 0) return true;
    if (e.gloss && e.gloss.toLowerCase().indexOf(q) >= 0) return true;
    /* 也可以直接搜单词或中文释义，反查它挂在哪个词根下 */
    for (const i of e.words) {
      if (D.words[i].toLowerCase().indexOf(q) >= 0) return true;
      if (String(D.trans[i] || "").toLowerCase().slice(0, 160).indexOf(q) >= 0) return true;
    }
    return false;
  });
  return { all: all, rows: rows };
}

function rootChip(i) {
  const zh = zhBrief(i, 16);
  const tip = D.words[i] + " · " + BAND_NAMES[D.band[i]] + " 词层（第 " + BAND_RANGE[D.band[i]] +
    " 词）· " + zhBrief(i, 90) + " · 点击跳到词网并发音";
  return '<span class="lw s' + statusOf(i) + (i === current ? " on" : "") + '" data-i="' + i +
    '" title="' + esc(tip) + '"><b>' + esc(D.words[i]) + "</b>" +
    (zh ? "<i>" + esc(zh) + "</i>" : "") + "</span>";
}

function renderRoot() {
  if (!$("rootBody")) return;
  const st = rootFiltered();
  const shown = st.rows.slice(0, ROOT_CAP);
  const cover = new Set();
  st.rows.forEach(e => e.words.forEach(i => cover.add(i)));

  $("rootSub").textContent = st.rows.length
    ? "共 " + st.rows.length + " 组 · 覆盖 " + cover.size + " 个词" +
      (rootMultiOnly ? "" : " · 含只出现 1 次的") + partsHint()
    : (st.all.length
        ? "没有符合筛选条件的词根" + partsHint()
        : "还没有载入带词根拆解的词层" + partsHint());

  $("rootBody").innerHTML = shown.length
    ? shown.map(e => {
        const k = rootKeyOf(e), open = rootExpanded.has(k);
        const seg = '<span class="morph"><span class="seg ' + e.kind + '">' + esc(e.t) +
          (e.gloss ? "<i>" + esc(e.gloss) + "</i>" : "") + "</span></span>";
        return '<div class="rgroup' + (open ? " open" : "") + (k === rootFocus ? " focus" : "") +
          '" data-k="' + esc(k) + '">' +
          '<div class="rhead" role="button" tabindex="0" title="展开 / 收起这组同根词">' +
            seg +
            '<span class="rcount">' + e.words.length + " 词</span>" +
            '<span class="rkind">' + ROOT_KIND_CN[e.kind] + "</span>" +
            '<button class="rgo" data-k="' + esc(k) + '" title="从这一组开始串记：一组同根词一起过，每词点一下掌握度">🧭 练</button>' +
            '<span class="rarrow">' + (open ? "▾" : "▸") + "</span>" +
          "</div>" +
          (open ? '<div class="rwords">' + e.words.map(rootChip).join("") + "</div>" : "") +
          "</div>";
      }).join("") +
      (st.rows.length > shown.length
        ? '<div class="hmore">共 ' + st.rows.length + " 组，先显示前 " + shown.length +
          " 组 · 用上面的筛选框缩小范围</div>"
        : "")
    : '<div class="rempty">' + (st.all.length
        ? "没有符合筛选条件的词根"
        : "还没有载入带词根拆解的词层 🧩<br>词层会随时补进，载入完自动刷新。") + "</div>";

  const btn = $("rootToggleAll");
  if (btn) {
    btn.disabled = !shown.length;
    const anyOpen = shown.some(e => rootExpanded.has(rootKeyOf(e)));
    btn.textContent = anyOpen ? "全部收起" : "全部展开";
  }
}

/* 打开词根页。带 kind/text 时为「从词卡某个词根段点进来」，要定位到那一组 */
function openRoot(kind, text) {
  if (!$("rootModal")) return;
  if (kind && text) {
    rootQuery = ""; $("rootFilter").value = "";
    rootMode = "all";
    $("rootSeg").querySelectorAll("button").forEach(x => x.classList.toggle("on", x.dataset.f === "all"));
    /* 目标词根可能只出现在一个词里，先把「只看 ≥2 词」放开，否则会定位不到 */
    rootMultiOnly = false; $("rootMulti").checked = false;
    rootExpanded.clear();
    rootFocus = kind + ":" + text;
    rootExpanded.add(rootFocus);
  } else {
    rootFocus = "";
  }
  $("rootModal").classList.remove("hidden");
  renderRoot();
  refreshRootStudyBtn();
  if (rootFocus) requestAnimationFrame(() => {
    const el = Array.from($("rootBody").querySelectorAll(".rgroup"))
      .find(g => g.dataset.k === rootFocus);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "center" });
  });
}

$("rootBtn").onclick = () => openRoot();
$("rootClose").onclick = () => $("rootModal").classList.add("hidden");
$("rootModal").addEventListener("click", e => {
  if (e.target === $("rootModal")) $("rootModal").classList.add("hidden");
});
$("rootFilter").addEventListener("input", e => {
  rootQuery = e.target.value; rootFocus = ""; renderRoot();
});
$("rootSeg").addEventListener("click", e => {
  const b = e.target.closest("button[data-f]");
  if (!b) return;
  rootMode = b.dataset.f; rootFocus = "";
  $("rootSeg").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
  renderRoot();
});
$("rootMulti").addEventListener("change", e => {
  rootMultiOnly = e.target.checked; rootFocus = ""; renderRoot();
});
$("rootToggleAll").onclick = () => {
  const shown = rootFiltered().rows.slice(0, ROOT_CAP);
  if (shown.some(e => rootExpanded.has(rootKeyOf(e)))) rootExpanded.clear();
  else shown.forEach(e => rootExpanded.add(rootKeyOf(e)));
  renderRoot();
};
function rootToggleGroup(head) {
  const g = head.closest(".rgroup");
  if (!g) return;
  const k = g.dataset.k;
  if (rootExpanded.has(k)) rootExpanded.delete(k); else rootExpanded.add(k);
  rootFocus = "";
  renderRoot();
}
$("rootBody").addEventListener("click", e => {
  const go2 = e.target.closest(".rgo");           /* 组头「🧭 练」：从这一组开始串记 */
  if (go2) { e.stopPropagation(); startRootStudy(go2.dataset.k); return; }
  const chip = e.target.closest(".lw");
  if (chip) {
    const i = +chip.dataset.i;
    $("rootModal").classList.add("hidden");
    go(i);
    speak(D.words[i]);                 /* 点按本身是用户手势，iOS 也允许直接播 */
    return;
  }
  const head = e.target.closest(".rhead");
  if (head) rootToggleGroup(head);
});
$("rootBody").addEventListener("keydown", e => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const head = e.target.closest(".rhead");
  if (!head) return;
  if (e.target.closest(".rgo")) return;        /* 焦点在「🧭 练」上时交给按钮自己处理 */
  e.preventDefault();
  rootToggleGroup(head);
});

/* 供自动化测试/排查用：词根索引引擎 */
window.COCA_ROOT = {
  list: (kind) => rootList().filter(e => !kind || e.kind === kind)
    .map(e => ({ t: e.t, kind: e.kind, gloss: e.gloss, n: e.words.length })),
  words: (kind, t) => {
    const e = rootList().find(x => x.kind === kind && x.t === t);
    return e ? e.words.map(i => D.words[i]) : null;
  },
  state: () => ({ total: rootList().length, expanded: Array.from(rootExpanded), focus: rootFocus })
};

/* ---------- 词根串记（把词根索引当学习路径，一组一组过） ----------
   词根索引解决「看得到」，串记解决「记得住」：一组同根词排在一起过一遍，
   -spect- → expect / inspect / respect / suspect，把散词串成一串。

   和复习卡共用同一条 SRS 记录（applyGrade），所以串记过的词会正常进复习队列、
   也算进学习统计 —— 差别只在「怎么问」：
     复习卡：一次一个词，先在心里想，再翻答案自评；
     串记：一组同根词一起看，快速过一遍，每词点一下掌握度。
   没有新增数据、没有新增存储：全部基于已载入的 D.morph 现算。 */
const RS_WORD_CAP = 30;         /* 一组先画多少个词（re / ate 这类大组近百词，先画一屏） */
let rs = null;                  /* 当前串记会话 */
let rsOrderMode = "easy";       /* easy = 由易到难（组内词的词层中位数）；size = 词数优先 */

/* 组内词层中位数：这批词的「整体难度」。
   不能只看组内最常用的那个词（best）—— 1k 层有 1000 个词，几乎每组都挂着一个，
   best 全等于 1，排出来的顺序等于没排。中位数才区分得开：
   tend(伸展)/spec(看)/pos(放置)/port(搬运) 这些高频根在前，astr/ceit 这类冷僻根在后。 */
function rsMed(e) {
  if (e._med === undefined) {
    const bs = e.words.map(i => D.band[i] || 9).sort((a, b) => a - b);
    e._med = bs[bs.length >> 1] || 9;
  }
  return e._med;
}

/* 组间顺序：串记是「从认得的词往外扩」——先过由常用词组成的词根，再往生僻处走 */
function rsOrder(list) {
  const a = list.slice();
  const alpha = (x, y) => (x.t < y.t ? -1 : x.t > y.t ? 1 : 0);
  if (rsOrderMode === "size") {
    a.sort((x, y) => (y.words.length - x.words.length) || (x.best - y.best) || alpha(x, y));
  } else {
    a.sort((x, y) => (rsMed(x) - rsMed(y)) || (x.best - y.best) ||
      (y.words.length - x.words.length) || alpha(x, y));
  }
  return a;
}

function startRootStudy(startKey) {
  const base = rootFiltered().rows;
  if (!base.length) return false;
  const list = rsOrder(base);
  let gi = 0;
  if (startKey) {
    const k = list.findIndex(e => rootKeyOf(e) === startKey);
    if (k >= 0) gi = k;
  }
  /* 已有会话时保留累计统计，只在换了一批组时重开 */
  if (!rs || rs.list.length !== list.length || rootKeyOf(rs.list[0]) !== rootKeyOf(list[0])) {
    rs = { list: list, gi: 0, grades: [0, 0, 0], n: 0, openAll: false };
    gi = startKey ? gi : 0;
  }
  rs.gi = gi;
  rs.openAll = false;
  $("rootModal").classList.add("hidden");
  $("rsModal").classList.remove("hidden");
  refreshRootStudyBtn();
  renderRs();
  return true;
}

function rsScopeText() {
  const seg = rootMode === "all" ? "全部" : ROOT_KIND_CN[rootMode];
  const q = rootQuery.trim();
  return seg + (q ? " · 含「" + q + "」" : "") + (rootMultiOnly ? " · ≥2 词" : "");
}

function rsStatusBadge(s) {
  return s === 2 ? '<i class="mchip s2">● 已掌握</i>'
       : s === 1 ? '<i class="mchip s1">◐ 学习中</i>'
       : "";
}

function rsRow(i) {
  const s = statusOf(i);
  const ready = chunkReady(chunkOf(i));
  const ph = ready ? D.phon[i] : "";
  const zh = ready ? zhBrief(i, 22) : "";
  const tip = D.words[i] + " · " + BAND_NAMES[D.band[i]] + " 词层（第 " + BAND_RANGE[D.band[i]] + " 词）" +
    (dueText(i) ? " · " + dueText(i) : "");
  return '<div class="rsrow s' + s + '" data-i="' + i + '" title="' + esc(tip) + '">' +
    '<button class="rsw" title="点一下听发音">' + esc(D.words[i]) + "</button>" +
    '<span class="rsphon">' + (ph ? "/" + esc(ph) + "/" : "") + "</span>" +
    '<span class="rszh">' + (ready ? (zh || '<span class="muted">无中文释义</span>')
      : '<span class="muted">释义待载入…</span>') + "</span>" +
    rsStatusBadge(s) +
    '<span class="rsg">' +
      '<button class="rsgb q0" data-q="0" title="忘了：10 分钟后再来，掌握度降一级">✗</button>' +
      '<button class="rsgb q1" data-q="1" title="有印象：间隔小幅延长">◐</button>' +
      '<button class="rsgb q2" data-q="2" title="记得：间隔翻倍，掌握度升一级">✓</button>' +
    "</span>" +
    '<button class="rslook" title="在词网中看它的同义 / 反义 / 上下位词（串记会留着，回来接着过）">🕸</button>' +
    "</div>";
}

function rsStatText() {
  const g = rs.grades;
  return g[0] + g[1] + g[2]
    ? "本次已评 <b>" + rs.n + "</b> 张 · 记得 <b class='g2c'>" + g[2] + "</b> · 有印象 <b class='g1c'>" +
      g[1] + "</b> · 忘了 <b class='g0c'>" + g[0] + "</b>"
    : "还没评过 —— 认得的点 ✓、模糊的点 ◐、忘了的点 ✗";
}

/* 组头的难度概况：「已掌握 3 · 学习中 2」/「全部未学」+ 未载入词提示。
   整组渲染和「评完一个词」都要用，所以抽出来共用（否则评分后容易算成空字符串）。 */
function rsMetaText(e) {
  let mst = 0, mid = 0, unready = 0;
  e.words.forEach(i => {
    const s = statusOf(i);
    if (s === 2) mst++; else if (s === 1) mid++;
    if (!chunkReady(chunkOf(i))) unready++;
  });
  return (mst ? "已掌握 " + mst : "") + (mst && mid ? " · " : "") + (mid ? "学习中 " + mid : "") +
    (!mst && !mid ? "全部未学" : "") + (unready ? " · " + unready + " 词释义待载入" : "");
}

function renderRs() {
  if (!rs) return;
  const e = rs.list[rs.gi];
  const total = rs.list.length;
  const words = e.words;
  const shown = rs.openAll ? words : words.slice(0, RS_WORD_CAP);

  $("rsSub").textContent = "第 " + (rs.gi + 1) + " / " + total + " 组 · " + ROOT_KIND_CN[e.kind] +
    " · " + rsScopeText() + partsHint();
  $("rsFill").style.width = Math.round((rs.gi + 1) / total * 100) + "%";

  $("rsStage").innerHTML =
    '<div class="rstop">' +
      '<span class="morph"><span class="seg ' + e.kind + '">' + esc(e.t) +
        (e.gloss ? "<i>" + esc(e.gloss) + "</i>" : "") + "</span></span>" +
      '<span class="rcount">' + words.length + " 词</span>" +
      '<span class="rsmeta">' + rsMetaText(e) + "</span>" +
      '<span class="rkind">' + ROOT_KIND_CN[e.kind] + "</span>" +
    "</div>" +
    '<div class="rsbody">' + shown.map(rsRow).join("") +
      (words.length > shown.length
        ? '<div class="hmore">本组还有 ' + (words.length - shown.length) +
          ' 个词没显示 · 点右上角「显示本组全部」</div>'
        : "") +
    "</div>" +
    '<div class="rsnav">' +
      '<button id="rsPrev" class="btn"' + (rs.gi === 0 ? " disabled" : "") + ">‹ 上一组</button>" +
      '<span class="rsstat">' + rsStatText() + "</span>" +
      '<button id="rsNext" class="btn primary">' +
        (rs.gi >= total - 1 ? "完成串记 🎉" : "下一组 ›") + "</button>" +
    "</div>";

  const allBtn = $("rsAll");
  if (allBtn) {
    allBtn.style.display = words.length > RS_WORD_CAP ? "" : "none";
    allBtn.textContent = rs.openAll ? "只显示前 " + RS_WORD_CAP + " 个" : "显示本组全部";
  }
  const ordBtn = $("rsOrder");
  if (ordBtn) ordBtn.textContent = rsOrderMode === "easy" ? "由易到难 ⇅" : "词数优先 ⇅";
  $("rsPrev").onclick = () => rsGoto(-1);
  $("rsNext").onclick = () => rsGoto(1);
}

function rsGoto(d) {
  if (!rs) return;
  const g = rs.gi + d;
  if (g < 0) return;
  if (g >= rs.list.length) return renderRsDone();
  rs.gi = g; rs.openAll = false;
  renderRs();
}

/* 评一个词：写回同一条 SRS 记录，只重画这一行（大组整页重画会闪） */
function rsGrade(i, q, row) {
  if (!rs) return;
  const nowS = applyGrade(i, q).nowS;
  rs.grades[q]++; rs.n++;
  if (row) {
    row.className = "rsrow s" + nowS + " graded";
    const b = row.querySelector("i.mchip");
    const html = rsStatusBadge(nowS);
    if (b) b.outerHTML = html || "";
    else if (html) row.querySelector(".rszh").insertAdjacentHTML("afterend", html);
    setTimeout(() => { if (row && row.parentNode) row.classList.remove("graded"); }, 500);
  }
  /* 组头的「已掌握 / 学习中」跟着变 */
  const meta = $("rsStage").querySelector(".rsmeta");
  if (meta) meta.textContent = rsMetaText(rs.list[rs.gi]);
  const st = $("rsStage").querySelector(".rsstat");
  if (st) st.innerHTML = rsStatText();
  afterGrade();
}

function renderRsDone() {
  if (!rs) return;
  $("rsFill").style.width = "100%";
  $("rsSub").textContent = "串记结束";
  const g = rs.grades, total = g[0] + g[1] + g[2];
  $("rsStage").innerHTML =
    '<div class="rvdone"><div class="rvbig">' + (total ? "🎉" : "🧩") + "</div>" +
    "<h3>" + (total ? "这轮 " + rs.list.length + " 组串完了" : "还没有评过词") + "</h3>" +
    (total
      ? '<div class="rvsum">记得 <b class="g2c">' + g[2] + "</b> · 有印象 <b class=\"g1c\">" + g[1] +
        '</b> · 忘了 <b class="g0c">' + g[0] + "</b> · 共 " + rs.n + " 张</div>"
      : "<p>串记是按词根一组一组过：一组同根词排在一起，认得的点 ✓、模糊的点 ◐、忘了的点 ✗。<br>" +
        "评过的词会写进和复习卡同一条记录，之后按间隔重复自动排队。</p>") +
    '<p class="rvdone-note">' + dueSummaryLine() + " · 按同根词组的顺序过，比单看词卡更容易记住词根的含义</p>" +
    '<div class="rvacts">' +
      '<button id="rsRestart" class="btn primary">从头再串一遍</button>' +
      '<button id="rsBackList" class="btn">回到词根索引</button>' +
      '<button id="rsClose2" class="btn">结束</button>' +
    "</div></div>";
  $("rsRestart").onclick = () => { rs.gi = 0; rs.openAll = false; renderRs(); };
  $("rsBackList").onclick = () => { closeRootStudy(); openRoot(); };
  $("rsClose2").onclick = closeRootStudy;
}

function closeRootStudy() {
  $("rsModal").classList.add("hidden");
  refreshRootStudyBtn();
}

/* 入口按钮文案跟着会话状态走：没开过 = 开始串记；开着 = 继续第 x 组 */
function refreshRootStudyBtn() {
  const b = $("rootStudy");
  if (!b) return;
  const live = rs && rs.list && rs.gi < rs.list.length;
  b.textContent = live ? "▶ 继续串记（第 " + (rs.gi + 1) + " / " + rs.list.length + " 组）" : "🧭 开始串记";
  b.title = live
    ? "回到串记（从第 " + (rs.gi + 1) + " 组接着过）"
    : "按词根把同根词一组一组过一遍：认得的点 ✓、模糊的点 ◐、忘了的点 ✗（评过的词写进同一条复习记录）";
}

$("rsClose").onclick = closeRootStudy;
$("rsModal").addEventListener("click", e => { if (e.target === $("rsModal")) closeRootStudy(); });
$("rootStudy").onclick = () => startRootStudy(rootFocus || "");
$("rsOrder").onclick = () => {
  rsOrderMode = rsOrderMode === "easy" ? "size" : "easy";
  if (rs) {
    const cur = rootKeyOf(rs.list[rs.gi]);
    rs.list = rsOrder(rootFiltered().rows);
    const k = rs.list.findIndex(e => rootKeyOf(e) === cur);
    rs.gi = k >= 0 ? k : 0;
    renderRs();
  }
};
$("rsAll").onclick = () => { if (rs) { rs.openAll = !rs.openAll; renderRs(); } };
$("rsStage").addEventListener("click", e => {
  const gb = e.target.closest(".rsgb");
  if (gb) { rsGrade(+gb.closest(".rsrow").dataset.i, +gb.dataset.q, gb.closest(".rsrow")); return; }
  const w = e.target.closest(".rsw");
  if (w) { speak(w.textContent); return; }
  const look = e.target.closest(".rslook");
  if (look) {                                   /* 去词网看它的关系：会话留着，回来接着串 */
    const i = +look.closest(".rsrow").dataset.i;
    closeRootStudy();
    go(i);
    speak(D.words[i]);
  }
});
/* 串记时的键盘：← / → 切组，Esc 退出；1/2/3 评不了（一屏多个词，得先点到具体哪个） */
document.addEventListener("keydown", e => {
  if ($("rsModal").classList.contains("hidden")) return;
  if (e.key === "Escape") { closeRootStudy(); return; }
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  if (!rs) return;
  if (e.key === "ArrowLeft") { rsGoto(-1); e.preventDefault(); }
  else if (e.key === "ArrowRight") { rsGoto(1); e.preventDefault(); }
});

/* 供自动化测试/排查用：词根串记引擎 */
window.COCA_RS = {
  start: (key) => startRootStudy(key),
  state: () => rs && {
    total: rs.list.length, gi: rs.gi, n: rs.n, grades: rs.grades, openAll: rs.openAll,
    order: rsOrderMode, group: rootKeyOf(rs.list[rs.gi]),
    seq: rs.list.slice(0, 6).map(rootKeyOf),
    words: rs.list[rs.gi].words.map(i => D.words[i]),
    shown: (rs.openAll ? rs.list[rs.gi].words : rs.list[rs.gi].words.slice(0, RS_WORD_CAP)).length,
    hidden: !$("rsModal").classList.contains("hidden")
  },
  order: (m) => { rsOrderMode = m; if (rs) {
    const cur = rootKeyOf(rs.list[rs.gi]);
    rs.list = rsOrder(rootFiltered().rows);
    const k = rs.list.findIndex(e => rootKeyOf(e) === cur);
    rs.gi = k >= 0 ? k : 0; renderRs();
  } return rsOrderMode; },
  next: () => rsGoto(1), prev: () => rsGoto(-1),
  goto: (k) => { if (rs) { rs.gi = Math.max(0, Math.min(rs.list.length - 1, k)); rs.openAll = false; renderRs(); } },
  end: () => renderRsDone(),
  grade: (word, q) => {
    const i = D.idx[word];
    if (i === undefined || !rs) return null;
    const row = Array.from($("rsStage").querySelectorAll(".rsrow")).find(r => +r.dataset.i === i);
    rsGrade(i, q, row);
    const rec = prog[word] || {};
    return { hasRow: !!row, s: rec.s, ivl: rec.ivl, reps: rec.reps, laps: rec.laps,
      dueInMin: Math.round(((rec.due || 0) - Date.now()) / 60000) };
  },
  close: () => closeRootStudy(),
  open: () => startRootStudy("")
};

/* ---------- 易混词辨析弹窗 ---------- */
function openConfuseCurrent() {
  if (current === null || current === undefined) return;
  if (extraCurrent) return;                 /* 词表外词没有词表内的邻近词 */
  openConfuse(current);
}
$("dConfBtn").onclick = openConfuseCurrent;
$("confClose").onclick = () => closeConfuse();
$("confModal").addEventListener("click", e => { if (e.target === $("confModal")) closeConfuse(); });

/* ---------- 复习会话（间隔重复） ---------- */
const RV_CAP = 60;            /* 单次会话最多这么多张：一次刷不完就先做这一批 */
const RV_NEW = 10;            /* 「学新词」一次引入多少个 */
let rv = null;                /* 当前会话状态 */
let rvPaused = false;         /* 「在词网中看」暂时离开复习：会话保留，可随时回来继续 */

function updateRvBadge() {
  const btn = $("reviewBtn");
  if (!btn) return;
  /* 暂停中：按钮变成「继续复习」，带剩余张数角标，一眼能找回复习 */
  if (rvPaused && rv && rv.idx < rv.queue.length) {
    const left = rv.queue.length - rv.idx;
    btn.classList.remove("hasdue");
    btn.classList.add("resume");
    btn.innerHTML = "▶ 继续复习" + '<i class="rvbadge">' + left + "</i>";
    btn.title = "回到复习队列（第 " + (rv.idx + 1) + " / " + rv.queue.length + " 张，快捷键 R）";
    return;
  }
  btn.classList.remove("resume");
  const n = dueCount();
  btn.classList.toggle("hasdue", n > 0);
  btn.innerHTML = "🔁 复习" + (n ? '<i class="rvbadge">' + (n > 99 ? "99+" : n) + "</i>" : "");
  btn.title = n ? "有 " + n + " 个词到期（快捷键 R）" : "复习队列 · 目前没有到期的词（快捷键 R）";
}

/* 暂时离开复习去看词网：卡片停在原处，回来时接着评（不重新生成队列） */
function pauseReview() {
  if (!rv || rv.idx >= rv.queue.length) return false;
  const i = rv.queue[rv.idx];
  $("reviewModal").classList.add("hidden");
  rvPaused = true;
  const bar = $("rvPauseBar");
  if (bar) {
    bar.classList.remove("hidden");
    $("rvPauseTxt").innerHTML = "⏸ 复习已暂停 · 第 " + (rv.idx + 1) + " / " + rv.queue.length +
      " 张 <b>" + esc(D.words[i]) + "</b> · 看完图回来接着评";
  }
  updateRvBadge();
  return true;
}

function resumeReview() {
  if (!rv) return false;
  const was = rv.revealed;
  rvPaused = false;
  $("rvPauseBar").classList.add("hidden");
  $("reviewModal").classList.remove("hidden");
  if (rv.idx >= rv.queue.length) renderRvDone();
  else { showCard(); if (was) revealCard(rv.queue[rv.idx]); }
  updateRvBadge();
  return true;
}

function startReview(words) {
  const now = Date.now();
  let q, rest = 0;
  if (words) { q = words.slice(); }
  else {
    q = dueList(now);
    if (q.length > RV_CAP) { rest = q.length - RV_CAP; q = q.slice(0, RV_CAP); }
  }
  rv = { queue: q, idx: 0, ok: 0, mid: 0, bad: 0, revealed: false, rest: rest, round: 1, again: [] };
  rvPaused = false;
  $("rvPauseBar").classList.add("hidden");
  $("reviewModal").classList.remove("hidden");
  showCard();
}

/* 不看是否到期：把所有标记过掌握度的词按排期顺序过一遍（复习队列空时的兜底） */
function startReviewAll() {
  const out = [];
  for (let i = 0; i < N; i++) if (statusOf(i)) out.push(i);
  if (!out.length) return false;
  out.sort((a, b) => ((prog[D.words[a]].due || 0) - (prog[D.words[b]].due || 0)) || (D.band[a] - D.band[b]));
  startReview(out.slice(0, RV_CAP));
  return true;
}

/* 「学新词」：从当前词层（没选词层就全库）随机抽 RV_NEW 个还没标记过的词 */
function startNewWords(n) {
  const b = +$("bandSel").value;
  const pool = [];
  for (let i = 0; i < N; i++) {
    if (b && D.band[i] !== b) continue;
    if (statusOf(i)) continue;
    pool.push(i);
  }
  if (!pool.length) return false;
  for (let k = pool.length - 1; k > 0; k--) {         /* 洗牌，避免每次都是同一批 */
    const j = Math.floor(Math.random() * (k + 1));
    const t = pool[k]; pool[k] = pool[j]; pool[j] = t;
  }
  startReview(pool.slice(0, n || RV_NEW));
  return true;
}

function rvBadgeOf(s) {
  return s === 2 ? '<span class="mchip s2">● 已掌握</span>'
       : s === 1 ? '<span class="mchip s1">◐ 学习中</span>'
       : '<span class="mchip s0">○ 未学</span>';
}

function showCard() {
  const st = $("rvStage");
  if (!rv) return;
  if (rv.idx >= rv.queue.length) return renderRvDone();
  const i = rv.queue[rv.idx];
  const total = rv.queue.length;
  rv.revealed = false;
  /* 队列可能跨词层（到期词分散在不同块）：这一块还没到就现取，取回来再画这张卡 */
  if (!chunkReady(chunkOf(i))) {
    $("rvSub").textContent = "第 " + (rv.idx + 1) + " / " + total + " 张";
    $("rvFill").style.width = Math.round(rv.idx / total * 100) + "%";
    st.className = "rvstage";
    st.innerHTML = '<div class="rvcard"><div class="rvword">' + esc(D.words[i]) + "</div>" +
      '<div class="rvask"><i class="spin"></i> 这个词所在词层的释义正在载入…</div></div>';
    const at = i;
    needChunk(chunkOf(at)).then(() => { if (rv && rv.queue[rv.idx] === at) showCard(); },
      () => partFailed(() => showCard(), "词层数据没载入成功"));
    return;
  }
  $("rvFill").style.width = Math.round(rv.idx / total * 100) + "%";
  $("rvSub").textContent = "第 " + (rv.idx + 1) + " / " + total + " 张" +
    (rv.rest ? "（本次先做 " + total + " 张，还有 " + rv.rest + " 张到期）" : "") +
    (rv.round > 1 ? " · 第 " + rv.round + " 轮" : "");

  const ph = D.phon[i];
  st.className = "rvstage";
  st.innerHTML =
    '<div class="rvcard">' +
      '<div class="rvpos">' + rvBadgeOf(statusOf(i)) +
        '<span class="mchip band" style="border-color:' + bandColor(D.band[i]) + '33;color:' + bandColor(D.band[i]) + '">' +
        BAND_NAMES[D.band[i]] + " 词层</span></div>" +
      '<div class="rvword">' + esc(D.words[i]) + "</div>" +
      '<div class="rvphon">' + (ph ? "/" + esc(ph) + "/" : '<span class="muted">无音标</span>') + "</div>" +
      '<div class="rvask">先在心里想想它的意思，再点下面核对 👇</div>' +
      '<div id="rvAnswer" class="rvanswer"></div>' +
      '<button id="rvShow" class="btn primary rvshow">显示答案 ▾</button>' +
      '<div id="rvGrades" class="rvgrades"></div>' +
    "</div>";
  $("rvShow").onclick = () => revealCard(i);
  speak(D.words[i]);        /* 卡片一出现就朗读（点按钮本身就是用户手势，iOS 也放行） */
}

function revealCard(i) {
  if (!rv || rv.revealed) return;
  rv.revealed = true;
  const an = $("rvAnswer");
  /* 释义还在路上（跨词层的队列偶尔会碰上）：先说明一下，载入完自动补上 */
  if (!chunkReady(chunkOf(i))) {
    an.className = "rvanswer on";
    an.innerHTML = '<div class="partload"><i class="spin"></i>释义正在载入…</div>';
    needChunk(chunkOf(i)).then(() => {
      if (!rv || !rv.revealed || rv.queue[rv.idx] !== i) return;
      rv.revealed = false; revealCard(i);
    }, () => partFailed(() => { rv.revealed = false; revealCard(i); }, "词层数据没载入成功"));
    return;
  }
  const tr = fmtTrans(D.trans[i], 10);
  const df = fmtDef(D.def[i], 6);
  an.className = "rvanswer on";
  an.innerHTML =
    '<div class="rvzh qtrans">' + (tr || "<span class='muted'>（暂无中文释义）</span>") + "</div>" +
    (df ? '<div class="rven def"><div class="rvh">英文释义</div>' + df + "</div>" : "");
  bindMore(an);
  $("rvShow").style.display = "none";
  const g = $("rvGrades");
  g.className = "rvgrades on";
  g.innerHTML =
    '<button class="gbtn g0" data-q="0">忘了<small>10 分钟后再来 · 降一级</small></button>' +
    '<button class="gbtn g1" data-q="1">有印象<small>间隔小幅延长</small></button>' +
    '<button class="gbtn g2" data-q="2">记得<small>间隔翻倍 · 升一级</small></button>';
  g.querySelectorAll(".gbtn").forEach(b => b.onclick = () => gradeCard(+b.dataset.q));
}

/* 评一个词的掌握度：写回同一条 SRS 记录 + 记统计。
   复习卡和词根串记只是「怎么问」不同，记录是同一份 —— 所以抽出这一层共用。 */
function applyGrade(i, q) {
  const key = D.words[i];
  const prevS = (prog[key] && prog[key].s) || 0;
  prog[key] = srsNext(prog[key] || {}, q, Date.now());
  saveProg();
  const nowS = prog[key].s || 0;
  /* 统计日志：张数 + 评分档位；顺带记下过程中发生的掌握度跃迁 */
  statBump("rv");
  statBump(q === 2 ? "ok" : q === 1 ? "mid" : "bad");
  if (!prevS && nowS) statBump("nw");
  if (prevS !== 2 && nowS === 2) statBump("mst");
  return { prevS: prevS, nowS: nowS };
}

function gradeCard(q) {
  if (!rv || rv.idx >= rv.queue.length) return;
  const i = rv.queue[rv.idx];
  applyGrade(i, q);
  if (q === 2) rv.ok++;
  else if (q === 1) rv.mid++;
  else { rv.bad++; rv.again.push(i); }
  rv.idx++;
  afterGrade();
  showCard();
}

/* 评完一张就把所有依赖进度的界面同步刷新（统计 / 地图 / 列表 / 面板 / 画布） */
function afterGrade() {
  renderStats();
  updateRvBadge();
  if (!$("mapModal").classList.contains("hidden")) renderMap();
  if (!$("listModal").classList.contains("hidden")) renderList(true);
  if (!$("hardModal").classList.contains("hidden")) renderHard();
  if (!$("statModal").classList.contains("hidden")) renderStat();
  if (current !== null) renderPanel(current);
  draw();
}

function dueSummaryLine() {
  const n = dueCount();
  return n ? "还有 <b>" + n + "</b> 个词到期，可以接着复习" : "今天的复习都做完了 ✅";
}

function renderRvDone() {
  const st = $("rvStage");
  $("rvFill").style.width = "100%";
  $("rvSub").textContent = "本轮结束";

  /* 忘了的词：趁热再过一遍（最多两轮，不无限循环） */
  if (rv.again.length && rv.round < 2) {
    const words = rv.again.slice();
    st.innerHTML =
      '<div class="rvdone"><div class="rvbig">🔁</div>' +
      "<h3>第一遍完成</h3>" +
      "<p>有 <b>" + words.length + "</b> 个词没想起来 —— 趁热再过一遍，记得最牢。</p>" +
      '<div class="rvacts">' +
        '<button id="rvAgain" class="btn primary">再过一遍这 ' + words.length + " 个词</button>" +
        '<button id="rvFinish" class="btn">跳过，结束本轮</button>' +
      "</div></div>";
    $("rvAgain").onclick = () => {
      rv.round++; rv.again = []; rv.queue = words; rv.idx = 0;
      showCard();
    };
    $("rvFinish").onclick = () => { rv.again = []; renderRvDone(); };
    return;
  }

  const total = rv.ok + rv.mid + rv.bad;
  const rate = total ? Math.round((rv.ok + rv.mid * 0.5) / total * 100) : 0;
  const due = dueCount(), learned = learnedCount();
  const main = due
    ? '<button id="rvMore" class="btn primary">' + (total ? "继续复习" : "开始复习") + "（" + due + " 个到期）</button>"
    : (learned ? '<button id="rvAll" class="btn primary">复习全部学过的词（' + learned + " 个）</button>" : "");

  st.innerHTML =
    '<div class="rvdone"><div class="rvbig">' + (total ? "🎉" : "☕") + "</div>" +
    "<h3>" + (total ? "本轮复习完成" : "今天没有到期的词") + "</h3>" +
    (total
      ? '<div class="rvsum">记得 <b class="g2c">' + rv.ok + "</b> · 有印象 <b class=\"g1c\">" + rv.mid +
        '</b> · 忘了 <b class="g0c">' + rv.bad + "</b> · 得分 " + rate + "%</div>"
      : "<p>标记过「学习中 / 已掌握」的词会按间隔重复自动排队，到点就会出现在这里。<br>" +
        "想现在就开始练，可以「复习全部学过的词」或先学几个新词。</p>") +
    '<p class="rvdone-note">' + dueSummaryLine() + "</p>" +
    '<div class="rvacts">' + main +
      '<button id="rvNew" class="btn">学 ' + RV_NEW + " 个新词</button>" +
      '<button id="rvClose2" class="btn">结束</button>' +
    "</div></div>";
  const more = $("rvMore");
  if (more) more.onclick = () => startReview();
  const all = $("rvAll");
  if (all) all.onclick = () => startReviewAll();
  $("rvNew").onclick = () => {
    if (!startNewWords(RV_NEW)) { $("rvSub").textContent = "当前词层已经没有未学的词了"; }
  };
  $("rvClose2").onclick = closeReview;
}

function closeReview() {
  $("reviewModal").classList.add("hidden");
  rv = null;
  rvPaused = false;
  const bar = $("rvPauseBar");
  if (bar) bar.classList.add("hidden");
  updateRvBadge();
  afterGrade();
}

$("reviewBtn").onclick = () => {
  if (!$("reviewModal").classList.contains("hidden")) return closeReview();
  if (rvPaused) return resumeReview();
  startReview();
};
$("rvClose").onclick = closeReview;
$("reviewModal").addEventListener("click", e => { if (e.target === $("reviewModal")) closeReview(); });
$("rvSpeak").onclick = () => { if (rv && rv.idx < rv.queue.length) speak(D.words[rv.queue[rv.idx]]); };
/* 「在词网中看」：把当前这张卡的词展开到图谱里（同/反/上下位一眼扫到），复习进度原样保留 */
$("rvGraph").onclick = () => {
  if (!rv || rv.idx >= rv.queue.length) return;
  const w = D.words[rv.queue[rv.idx]];
  if (!pauseReview()) return;
  go(w);
  try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch (e) {}
};
$("rvResume").onclick = () => resumeReview();
$("rvPauseClose").onclick = () => closeReview();

/* 复习时的键盘操作：空格/回车翻答案，1/2/3（或 ←↓→）评分，Esc 退出 */
document.addEventListener("keydown", e => {
  if ($("reviewModal").classList.contains("hidden")) return;
  if (e.key === "Escape") { closeReview(); return; }
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  if (!rv) return;
  if ((e.key === " " || e.key === "Enter") && !rv.revealed && rv.idx < rv.queue.length) {
    e.preventDefault();
    revealCard(rv.queue[rv.idx]);
    return;
  }
  if (!rv.revealed) return;
  if (e.key === "1" || e.key === "ArrowLeft") gradeCard(0);
  else if (e.key === "2" || e.key === "ArrowDown") gradeCard(1);
  else if (e.key === "3" || e.key === "ArrowRight") gradeCard(2);
});

/* ---------- 路径查找弹窗 ---------- */
(function initPathFinder() {
  const modal = $("pathModal");
  if (!modal) return;
  const from = $("pathFrom"), to = $("pathTo"), msg = $("pathMsg"), res = $("pathResult");

  function open(seed) {
    const seedWord = seed || (current !== null ? D.words[current] : "");
    if (seedWord) from.value = seedWord;
    modal.classList.remove("hidden");
    setTimeout(() => { (from.value && !to.value ? to : from).focus(); (from.value && !to.value ? to : from).select(); }, 40);
  }
  /* 路径搜索要在全部 1 万词的关系里找通路，所以先把没载入的块补齐 */
  function findWaiting() {
    if (!hasExtra) {                       /* 端点可能是词表外关联词，先保证词名表在 */
      needExtra().then(find, () => partFailed(find, "词表外词名表没载入成功"));
      return true;
    }
    const todo = [];
    for (let c = 1; c <= CHUNK_N; c++) if (!chunkReady(c)) todo.push(c);
    if (!todo.length) return false;
    msg.className = "pmsg";
    res.innerHTML = "";
    let left = todo.length;
    const total = todo.length;
    msg.innerHTML = '<i class="spin"></i> 正在载入全部词层的关系数据…（首次使用需要几秒，之后就在缓存里了）';
    todo.forEach(c => needChunk(c).then(() => {
      left--;
      if (left > 0) { msg.innerHTML = '<i class="spin"></i> 正在载入词层数据…（还剩 ' + left + "/" + total + " 块）"; return; }
      find();
    }, () => partFailed(find, "词层数据没载入成功，路径查找需要全部 10 块数据")));
    return true;
  }

  function find() {
    if (findWaiting()) return;
    const a = resolveWord(from.value), b = resolveWord(to.value);
    msg.className = "pmsg"; res.innerHTML = "";
    if (!a) { msg.textContent = "找不到起点词「" + from.value.trim() + "」"; msg.classList.add("err"); return; }
    if (!b) { msg.textContent = "找不到终点词「" + to.value.trim() + "」（只支持 1 万词表和词表外关联词）"; msg.classList.add("err"); return; }
    if (a.kind === "x") { msg.textContent = "「" + a.word + "」不在 1 万词表内，没有可展开的关系，不能当起点"; msg.classList.add("err"); return; }
    if (b.kind === "w" && a.i === b.i) { msg.textContent = "起点和终点是同一个词"; msg.classList.add("err"); return; }
    let steps = bfsPath(a, b, { weak: false, maxDepth: PATH_MAX_HOPS }), weak = false;
    if (!steps) { steps = bfsPath(a, b, { weak: true, maxDepth: PATH_MAX_HOPS }); weak = true; }
    if (!steps) {
      msg.textContent = "在 " + PATH_MAX_HOPS + " 跳之内没有找到通路（这两个词可能确实没有语义关联）";
      msg.classList.add("err");
      return;
    }
    msg.innerHTML = "找到一条 <b>" + (steps.length - 1) + " 跳</b> 的链路" +
      (weak ? "：语义关系内没有通路，这条链路含「语义相关」（弱关系）"
            : "，全部由同义 / 反义 / 上下位 / 派生 / 近义联想构成");
    renderPathResult(steps);
    drawPath(steps, weak);
  }
  function renderPathResult(steps) {
    res.innerHTML = '<div class="pchain">' + steps.map((s, k) => {
      const w = nodeWord(s.kind, s.i);
      const node = '<div class="pnode"><b>' + (k + 1) + "</b>" +
        (s.kind === "w"
          ? '<button class="pw" data-i="' + s.i + '" title="选中该词并朗读">' + esc(w) + "</button>"
          : '<span class="pwx">' + esc(w) + '</span><i class="pxw">词表外</i>') + "</div>";
      const link = k === 0 ? "" :
        '<div class="plink" style="color:' + RMAP[s.t].color + '">↓ ' + RMAP[s.t].name + "</div>";
      return link + node;
    }).join("") + "</div>";
    res.querySelectorAll(".pw").forEach(b => b.onclick = () => {
      const i = +b.dataset.i;
      renderPanel(i);
      speak(D.words[i]);
    });
  }

  $("pathBtn").onclick = () => open();
  $("pathClose").onclick = () => modal.classList.add("hidden");
  modal.addEventListener("click", e => { if (e.target === modal) modal.classList.add("hidden"); });
  $("pathGo").onclick = find;
  $("pathSwap").onclick = () => {
    const t = from.value; from.value = to.value; to.value = t; find();
  };
  $("pathClear").onclick = () => {
    exitPathMode();
    msg.className = "pmsg"; res.innerHTML = "";
    msg.textContent = "已退出路径模式，回到普通词网（点任意节点继续展开）";
  };
  [from, to].forEach(inp => inp.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); find(); }
  }));
  window.COCA_PATH = { open: open, run: (a, b) => { from.value = a; to.value = b; find(); }, clear: exitPathMode };
})();

/* ---------- 跨设备迁移：合并规则 ---------- */

/* 从导出的对象里挑出有效记录。保留每条记录自己的时间戳，
   这样合并时能判断“哪台设备的修改更新”。 */
function pickValid(p) {
  const clean = {};
  let skipped = 0;
  for (const k in p) {
    const v = p[k];
    const s = v && v.s;
    if (D.idx[k] !== undefined && (s === 0 || s === 1 || s === 2)) {
      clean[k] = { s: s, t: (typeof v.t === "number" && v.t > 0) ? v.t : Date.now() };
    } else skipped++;
  }
  return { clean: clean, skipped: skipped };
}

/* 逐词比较时间戳，较新的一条胜出；两边都有的词不会丢。 */
function mergeIntoProg(incoming) {
  let added = 0, updated = 0;
  for (const k in incoming) {
    const v = incoming[k];
    const cur = prog[k];
    if (!cur || v.t > (cur.t || 0)) {
      /* 同步码只带掌握度，不带复习计划 —— 合并时保留本机的排期字段
         （due / ivl / reps / laps），免得一同步就把复习节奏清空。 */
      prog[k] = Object.assign({}, cur || {}, { s: v.s, t: v.t });
      if (cur) updated++; else added++;
    }
  }
  return { added: added, updated: updated };
}

/* 所有依赖进度的界面统一刷新 */
function refreshProgressViews() {
  renderStats();
  if (!$("mapModal").classList.contains("hidden")) renderMap();
  if (!$("listModal").classList.contains("hidden")) renderList(true);
  if (!$("hardModal").classList.contains("hidden")) renderHard();
  if (current !== null) renderPanel(current);
  draw();
}

/* ---------- 跨设备同步码 ----------
   把进度压成一段可以随便粘贴的文字：没有引号、没有反斜杠、没有 + / =
   这些聊天软件容易转义或换行的字符，全部由 0-9a-z 组成。

   格式：CWN1.<导出分钟>.<条数>.<下标>-<状态>-<多少分钟前>...
   时间只精确到分钟 —— 合并只需要判断先后顺序，够用了，
   而且能把每个词的记录压到 8 个字符左右。 */
const CODE_HEAD = "CWN1";
const b36 = n => Math.abs(n).toString(36);
const fromB36 = s => parseInt(s, 36) || 0;

function encodeProgress() {
  const base = Math.floor(Date.now() / 60000);      /* 当前时间（分钟） */
  const parts = [];
  for (const k in prog) {
    const v = prog[k];
    if (!v || (v.s !== 0 && v.s !== 1 && v.s !== 2)) continue;
    const i = D.idx[k];
    if (i === undefined) continue;
    const age = Math.max(0, base - Math.floor((v.t || Date.now()) / 60000));
    parts.push(b36(i) + "-" + v.s + "-" + b36(age));
  }
  return [CODE_HEAD, b36(base), b36(parts.length)].join(".") + "." + parts.join(".");
}

function decodeProgress(text) {
  const s = String(text || "").trim().replace(/\s+/g, "");
  if (!s) throw new Error("请先把同步码粘到下面的框里");
  const seg = s.split(".");
  if (seg[0] !== CODE_HEAD) throw new Error("这不是本应用的同步码（开头应该是 " + CODE_HEAD + "）");
  if (seg.length < 4) throw new Error("同步码不完整，可能复制的时候被截断了");
  const base = fromB36(seg[1]);
  const expect = fromB36(seg[2]);
  const out = {};
  let bad = 0;
  for (let n = 3; n < seg.length; n++) {
    const tk = seg[n].split("-");
    const i = tk.length === 3 ? fromB36(tk[0]) : -1;
    const st = tk.length === 3 ? parseInt(tk[1], 10) : -1;
    if (tk.length !== 3 || (st !== 0 && st !== 1 && st !== 2) || i < 0 || i >= N) { bad++; continue; }
    out[D.words[i]] = { s: st, t: Math.max(1, (base - fromB36(tk[2])) * 60000) };
  }
  const n = Object.keys(out).length;
  if (!n) throw new Error("这段码里没有任何进度记录");
  return { prog: out, count: n, truncated: bad > 0 || n !== expect };
}

function codeMsg(t, cls) {
  const m = $("codeMsg");
  m.textContent = t;
  m.className = "codemsg" + (cls ? " " + cls : "");
}

$("codeBtn").onclick = () => {
  $("codeOut").value = encodeProgress();
  $("codeIn").value = "";
  codeMsg(learnedCount() ? "这台设备有 " + learnedCount() + " 条进度，点「复制同步码」即可带走。" : "这台设备还没有进度记录。");
  $("codeModal").classList.remove("hidden");
};
$("codeClose").onclick = () => $("codeModal").classList.add("hidden");
$("codeGen").onclick = () => {
  $("codeOut").value = encodeProgress();
  codeMsg("已重新生成（含 " + learnedCount() + " 条进度）。", "good");
};
$("codeCopy").onclick = () => {
  const ta = $("codeOut");
  if (!ta.value) ta.value = encodeProgress();
  const ok = () => codeMsg("已复制！\n发到另一台设备（微信「文件传输助手」或备忘录最省事），打开应用 → 进度地图 → 跨设备同步 → 粘进去 → 「合并到本机」。", "good");
  const manual = () => {
    ta.focus(); ta.select();
    try { ta.setSelectionRange(0, ta.value.length); } catch (e) {}
    codeMsg("浏览器没让自动复制：码已选中，请长按（或右键）选择「拷贝」。", "bad");
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(ta.value).then(ok).catch(manual);
  } else manual();
};
$("codeClear").onclick = () => { $("codeIn").value = ""; $("codeIn").focus(); };
$("codeApply").onclick = () => {
  let res;
  codeMsg("正在校验同步码…");
  try { res = decodeProgress($("codeIn").value); }
  catch (e) { codeMsg(e.message, "bad"); return; }
  if (res.truncated && !confirm("这段同步码看起来不完整（可能粘贴时被截断了），仍要合并吗？")) {
    codeMsg("已取消，本机进度没有变化。");
    return;
  }
  const r = mergeIntoProg(res.prog);
  saveProg();
  refreshProgressViews();
  $("codeOut").value = encodeProgress();
  codeMsg("合并完成：新增 " + r.added + " 条，更新 " + r.updated + " 条。本机现在共 " + learnedCount() + " 条进度 —— 把这台设备的新码复制回另一台，两边就完全一致了。", "good");
};

/* ---------- 进度导出 / 导入（JSON 文件，适合长期备份） ---------- */
$("expBtn").onclick = () => {
  const blob = new Blob(
    [JSON.stringify({ app: "COCAWordNet", v: 1, exported: new Date().toISOString(), prog }, null, 1)],
    { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "COCAWordNet-progress-" + new Date().toISOString().slice(0, 10) + ".json";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
};
$("impBtn").onclick = () => {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = ".json,application/json";
  inp.onchange = () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      let obj = null;
      try { obj = JSON.parse(String(rd.result)); } catch (e) { alert("文件不是有效的 JSON"); return; }
      const p = (obj && typeof obj === "object") ? (obj.prog || obj) : null;
      if (!p || typeof p !== "object") { alert("文件里没有进度数据"); return; }
      const res = pickValid(p);
      const n = Object.keys(res.clean).length;
      if (!n) { alert("没有找到有效的进度记录（需要是本应用导出的文件）"); return; }
      const merge = confirm("读到 " + n + " 条有效进度" +
        (res.skipped ? "（跳过 " + res.skipped + " 条无效）" : "") +
        "。\n\n【确定】= 与现有进度合并（推荐，两边都保留）\n【取消】= 用这份文件覆盖现有进度");
      if (merge) {
        const r = mergeIntoProg(res.clean);
        saveProg(); refreshProgressViews();
        alert("合并完成：新增 " + r.added + " 条，更新 " + r.updated + " 条。当前共 " + learnedCount() + " 条。");
      } else {
        prog = res.clean;
        saveProg(); refreshProgressViews();
        alert("已覆盖，当前共 " + learnedCount() + " 条进度。");
      }
    };
    rd.readAsText(f);
  };
  inp.click();
};

/* ---------- 视角控制（平面 ⇄ 立体） ---------- */
function applyTilt(deg, save) {
  tiltDeg = Math.max(0, Math.min(TILT_MAX, deg));
  tilt = tiltDeg * Math.PI / 180;
  const el = $("tilt");
  if (el && +el.value !== Math.round(tiltDeg)) el.value = String(Math.round(tiltDeg));
  const v = $("tiltVal");
  if (v) v.textContent = Math.round(tiltDeg) + "°";
  const tbtn = $("tiltToggle");
  if (tbtn) {
    tbtn.textContent = isFlat() ? "平面" : "立体";
    tbtn.classList.toggle("on", !isFlat());
  }
  if (save) { try { localStorage.setItem(TILT_KEY, String(Math.round(tiltDeg))); } catch (e) {} }
  /* 平面视图下没有高低差：层级光晕 / 圆牌的配色会误导，整体隐藏（CSS 控制） */
  gNodes.classed("flatview", isFlat());
  gGrid.classed("flatview", isFlat());
  paintGrid();
  paint();
}
(function initTilt() {
  const el = $("tilt");
  if (el) {
    el.addEventListener("input", () => applyTilt(+el.value, false));
    el.addEventListener("change", () => applyTilt(+el.value, true));
    el.addEventListener("pointerup", () => applyTilt(+el.value, true));
  }
  const b = $("tiltToggle");
  if (b) b.onclick = () => applyTilt(isFlat() ? 55 : 0, true);
  applyTilt(tiltDeg, false);
})();

/* ---------- toolbar events ---------- */
$("nextBtn").onclick = nextWord;
$("focusBtn").onclick = focusCurrent;
$("clearBtn").onclick = clearGraph;
$("colorMode").onchange = draw;
$("bandSel").onchange = () => {
  renderStats();
  if (!$("listModal").classList.contains("hidden")) renderList(true);
};

document.querySelectorAll(".quick button").forEach(b => b.onclick = () => go(b.dataset.w));

/* ---------- 段落记忆事件 ---------- */
$("dParaPlay").onclick = paraReadAll;
$("dParaCloze").onclick = openParaCloze;
$("paraClose").onclick = closeParaCloze;
$("paraCheck").onclick = checkCloze;
$("paraReveal").onclick = revealCloze;
$("paraAgain").onclick = () => { if (pq) buildCloze(pq.i, pq.word, pq.item); };
$("paraBody").onclick = ev => {
  const chip = ev.target.closest(".pchip");
  if (chip) { fillCloze(chip.dataset.w); return; }
  const bl = ev.target.closest(".pbl");
  if (bl) clearCloze(+bl.dataset.k);
};

document.addEventListener("keydown", e => {
  if (!$("reviewModal").classList.contains("hidden")) return;   /* 复习界面自己有键盘操作 */
  if (!$("rsModal").classList.contains("hidden")) return;       /* 串记界面同理（←/→ 切组） */
  if (!$("paraModal").classList.contains("hidden")) {           /* 段落挖空就开着的时候只认 Esc/T */
    if (e.key === "Escape") closeParaCloze();
    else if (e.key === "t" || e.key === "T") closeParaCloze();
    return;
  }
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  if (e.key === "r" || e.key === "R") { if (rvPaused) resumeReview(); else startReview(); return; }
  if (e.key === "n" || e.key === "N") nextWord();
  if (e.key === "f" || e.key === "F") focusCurrent();
  if (e.key === "z" || e.key === "Z") resetView();
  if (e.key === "p" || e.key === "P") speakCurrent();
  if (e.key === "v" || e.key === "V") applyTilt(isFlat() ? 55 : 0, true);
  if (e.key === "g" || e.key === "G") {
    if ($("pathModal").classList.contains("hidden")) { $("pathBtn").onclick(); }
    else $("pathModal").classList.add("hidden");
  }
  if (e.key === "m" || e.key === "M") { renderMap(); $("mapModal").classList.remove("hidden"); }
  if (e.key === "s" || e.key === "S") {
    if ($("statModal").classList.contains("hidden")) openStat(); else closeStat();
  }
  if (e.key === "k" || e.key === "K") {
    if ($("hardModal").classList.contains("hidden")) { renderHard(); $("hardModal").classList.remove("hidden"); }
    else $("hardModal").classList.add("hidden");
  }
  if (e.key === "l" || e.key === "L") {
    if ($("listModal").classList.contains("hidden")) { renderList(true); $("listModal").classList.remove("hidden"); }
    else $("listModal").classList.add("hidden");
  }
  /* 词根 / 词缀索引：I 开关 */
  if (e.key === "i" || e.key === "I") {
    if ($("rootModal").classList.contains("hidden")) openRoot();
    else $("rootModal").classList.add("hidden");
  }
  /* 易混词辨析：C 开关（当前词的形近 / 音近对比） */
  if (e.key === "c" || e.key === "C") {
    if ($("confModal").classList.contains("hidden")) openConfuseCurrent(); else closeConfuse();
  }
  /* 段落挖空：T 开关（当前词的词网段落） */
  if (e.key === "t" || e.key === "T") { if (paraOf(D.words[current])) openParaCloze(); }
  /* 关系类型开关：1–7 依次对应图例里的七种关系，0 = 全部显示 */
  if (/^[1-7]$/.test(e.key)) { toggleRelType(+e.key - 1); e.preventDefault(); }
  if (e.key === "0") { clearRelFilter(); e.preventDefault(); }
  /* 说明浮层：H 开关、Esc 关闭 */
  if (e.key === "h" || e.key === "H") { if (window.toggleHelp) window.toggleHelp(); }
  if (e.key === "Escape") {
    if (window.closeHelp) window.closeHelp();
    if (!$("hardModal").classList.contains("hidden")) $("hardModal").classList.add("hidden");
    if (!$("rootModal").classList.contains("hidden")) $("rootModal").classList.add("hidden");
    if (!$("statModal").classList.contains("hidden")) closeStat();
    if (!$("confModal").classList.contains("hidden")) closeConfuse();
  }
});

window.addEventListener("resize", () => {
  if (sim) { sim.force("center", d3.forceCenter(width() / 2, height() / 2)); sim.alpha(0.3).restart(); }
  paintGrid(); paint();
});

/* ---------- boot ----------
   首屏只等「骨架 + 起始词那一块 + 词表外词名」（约 500KB gzip，原来要等 3MB）。
   全新用户（没有上次的词、也没带 #词）连块都不用等：骨架就够画空状态，
   剩下 10 块在首屏画完之后按「离当前块由近到远」在后台补齐。 */
const _loader = document.getElementById("loader");
function hideLoader() { if (_loader) _loader.classList.add("done"); }

/* 起始词：优先 #hash（可分享的深链），其次是上次看的词 */
let bootSeed = null;
try {
  if (location.hash.length > 1) {
    const r = resolveWord(decodeURIComponent(location.hash.slice(1)).trim().toLowerCase());
    if (r && r.kind === "w") bootSeed = r.i;
  }
  if (bootSeed === null) {
    const last = localStorage.getItem("coca10000.last");
    if (last !== null && D.idx[D.words[+last]] !== undefined) bootSeed = +last;
  }
} catch (e) {}

function firstScreen() {
  hideLoader();
  renderStats();
  if (bootSeed !== null) go(bootSeed);
  else if (location.hash.length > 1) applyHash();
  setTimeout(prefetchRest, 900);      /* 先把首屏让出来，再慢慢补后面的块 */
}

if (bootSeed === null) {
  firstScreen();
} else {
  Promise.all([needExtra(), needChunk(chunkOf(bootSeed))]).then(firstScreen, () => {
    /* 起始块没载入成功（离线且没缓存）：先把应用放出来，用户点了会自动重试 */
    hideLoader();
    renderStats();
    setTimeout(prefetchRest, 900);
    partFailed(() => { if (bootSeed !== null) go(bootSeed); }, "起始词所在词层的数据没载入成功，点重试或直接选别的词");
  });
}

})();
