/* COCAWordNet — interactive word-network vocabulary app */
(function () {
"use strict";

/* 应用版本号：显示在界面右上角，也是「是否已更新」的判据。
   改动 app.js / index.html / style.css 时 +1，并同步把 sw.js 里的 CACHE +1。 */
const APP_VERSION = "v19";
window.APP_VERSION = APP_VERSION;

const D = window.APP_DATA;
if (!D || !D.words || !D.words.length || window.__DATA_FAIL) {
  /* data.js missing or corrupt — show a clear error instead of a dead page */
  const ld = document.getElementById("loader");
  if (ld) {
    ld.classList.add("err");
    const lt = document.getElementById("loaderText");
    if (lt) lt.innerHTML = "词库 data.js 加载失败，应用无法启动。" +
      "<small>请确认 data.js 与 index.html 在同一文件夹；" +
      "若是在线访问，请刷新重试或检查网络。</small>";
  }
  return;
}
const N = D.words.length;

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
  prog[D.words[i]] = { s, t: Date.now() };
  saveProg();
};

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
svg.call(d3.zoom().scaleExtent([0.25, 4]).on("zoom", e => {
  g.attr("transform", e.transform);
  /* 缩得越小节点越挤：远观时把标签整体淡出，避免糊成一片；
     放大回来立刻恢复，不用重算布局 */
  gLabels.attr("opacity", e.transform.k < 0.7 ? 0.35 : 1);
}));

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
      const base = l.t === 6 ? 0.35 : 0.6;
      const k = ((l.source.ps || 1) + (l.target.ps || 1)) / 2;
      return Math.min(1, base * (0.5 + 0.62 * k));
    })
    .attr("stroke-width", l => {
      const w = l.t === 4 ? 2.3 : l.t === 6 ? 1 : 1.8;
      const k = ((l.source.ps || 1) + (l.target.ps || 1)) / 2;
      return w * Math.max(0.7, Math.min(1.35, k));
    });
  if (nodeSel) nodeSel
    .attr("transform", d => "translate(" + d.px + "," + d.py + ") scale(" + (d.ps || 1) + ")")
    .attr("opacity", d => lvlOpacity(d.lvl || 0));
  if (labelSel) labelSel
    .attr("x", d => d.px)
    .attr("y", d => d.py + radius(d) * (d.ps || 1) + 12)
    .attr("font-size", d => (d.kind === "x" ? 10 : d.id === "w:" + current ? 14 : 11) *
      Math.max(0.86, Math.min(1.16, (d.ps || 1) * 0.75 + 0.25)))
    .attr("opacity", d => lvlOpacity(d.lvl || 0));
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
        if (d.i !== current) { trail.push(current); if (trail.length > 24) trail.shift(); expand(d.i); }
        renderPanel(d.i);
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

  /* 标签层：永远在节点之上，位置跟随节点。
     白色描边（paint-order: stroke）让文字压在连线上也读得清 */
  labelSel = gLabels.selectAll("text").data(nodes, d => d.id);
  labelSel.exit().remove();
  labelSel = labelSel.enter().append("text")
    .attr("class", "lbl")
    .attr("text-anchor", "middle")
    .style("pointer-events", "none")
    .merge(labelSel);
  labelSel
    .attr("class", d => "lbl" + (d.id === "w:" + current ? " cur" : ""))
    .attr("fill", d => (d.id === "w:" + current ? "#1d4ed8"
      : d.kind === "x" ? "#64748b" : "#334155"))
    .text(d => d.word);

  paintGrid();
  paint();

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
function speak(word, btnEl) {
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
  if (current !== null) speak(D.words[current]);
  else if (extraCurrent !== null) speak(extraCurrent);
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
/* 词性 → 配色组 */
function posGroup(t) {
  const k = (t || "").replace(/\./g, "").toLowerCase();
  if (k === "n" || k === "u") return "n";
  if (k === "v" || k === "vt" || k === "vi") return "v";
  if (k === "a" || k === "s" || k === "adj") return "a";
  if (k === "adv" || k === "ad" || k === "r") return "adv";
  return "other";
}
/* 拆出开头的词性缩写（vt. / n. / a.）或领域标记（[计]） */
function splitTag(s) {
  let m = /^\s*\[([^\]]{1,8})\]\s*/.exec(s);
  if (m) return { tag: m[1], dom: true, rest: s.slice(m[0].length) };
  m = /^\s*([A-Za-z][A-Za-z.&]{0,10}\.)\s*/.exec(s);
  if (m) {
    const k = m[1].replace(/\.$/, "").replace(/&.*$/, "").toLowerCase();
    if (POS_ZH[k] !== undefined) return { tag: m[1], dom: false, rest: s.slice(m[0].length) };
  }
  return { tag: "", dom: false, rest: s };
}
/* 词性/领域小标签（无标签时给一个等宽占位，保证各列左缘对齐） */
function chipHTML(tag, dom) {
  if (!tag) return '<b class="pos blank"></b>';
  const k = tag.replace(/\.$/, "").replace(/&.*$/, "").toLowerCase();
  const zh = dom ? (DOM_ZH[tag] || "") : (POS_ZH[k] || "");
  const p = dom ? "dom" : posGroup(k);
  return '<b class="pos" data-p="' + p + '"' + (zh ? ' title="' + esc(zh) + '"' : "") + ">" + esc(tag) + "</b>";
}
function moreBtn(n) {
  const t = "显示全部 " + n + " 个义项 ▾";
  return '<button class="morebtn" data-open="' + t + '">' + t + "</button>";
}
/* 中文释义：每个词性/领域一行，行内义项用 · 分隔（短释义读起来像词典） */
function fmtTrans(str, cap, fold) {
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
      rows.push('<div class="trow over">' + chipHTML(t.tag, t.dom) +
        '<span class="tsen">' + senses.map(s => '<i class="sn">' + esc(s) + "</i>").join('<span class="dot">·</span>') + "</span></div>");
      idx += senses.length;
      return;
    }
    const vis = senses.slice(0, room);
    const ovr = senses.slice(room);
    let body = vis.map(s => '<i class="sn">' + esc(s) + "</i>").join('<span class="dot">·</span>');
    /* 超出部分连同它前面的 · 一起包起来，折叠时整段消失，不留孤零零的点 */
    if (ovr.length) body += '<span class="ovr"><span class="dot">·</span>' +
      ovr.map(s => '<i class="sn">' + esc(s) + "</i>").join('<span class="dot">·</span>') + "</span>";
    idx += senses.length;
    rows.push('<div class="trow">' + chipHTML(t.tag, t.dom) +
      '<span class="tsen">' + body + "</span></div>");
  });
  if (!rows.length) return esc(raw.trim());
  return rows.join("") + (fold && idx > cap ? moreBtn(idx) : "");
}
/* 英文释义：每个词性一组，组内义项逐条编号（长句必须独占一行） */
function fmtDef(str, cap) {
  cap = cap || 6;
  if (!str) return "";
  const lines = String(str).split(/\\n|\n/).map(s => s.trim()).filter(Boolean);
  if (!lines.length) return "";
  const groups = [];
  lines.forEach(line => {
    const t = splitTag(line);
    const last = groups[groups.length - 1];
    if (t.tag && (!last || last.tag !== t.tag)) groups.push({ tag: t.tag, dom: t.dom, items: [t.rest] });
    else if (last) last.items.push(t.rest || line);
    else groups.push({ tag: "", dom: false, items: [t.rest || line] });
  });
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
    return '<div class="dgrp' + (hide ? " over" : "") + '">' + chipHTML(g.tag, g.dom) +
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
  const tr = extraTrans(i);
  const th = fmtTrans(tr, 10);
  $("dTrans").innerHTML = th || "（暂无释义，可点 🔊 听发音）";
  $("dTrans").classList.toggle("dim", !tr);
  bindMore($("dTrans"));
  $("bDef").style.display = "none";
  $("dDef").innerHTML = "";
  $("bMorph").style.display = "none";
  $("bColl").style.display = "none";
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
function showExtInfo(j) {
  const el = $("extInfo");
  if (!el) return;
  const w = D.extra[j], ph = extraPhon(j), tr = extraTrans(j);
  el.classList.remove("hidden");
  el.innerHTML =
    "<div class='exth'><b>" + w + "</b>" +
    (ph ? '<span class="phon">/' + ph + "</span>" : '<span class="muted">无音标</span>') +
    '<button class="mini-say" title="再听一次">🔊 再听一次</button></div>' +
    "<div class='exttr'>" + (fmtTrans(tr, 0, false) || "（暂无释义）") + "</div>" +
    "<div class='muted'>词表外关联词 · 不在 10000 词表内，无法展开词网</div>";
  const b = el.querySelector(".mini-say");
  if (b) b.onclick = () => speak(w);
}

function renderPanel(i, extraNode) {
  if (i === null) {
    if (extraNode) renderExtraPanel(extraNode);
    return;
  }
  extraCurrent = null;
  $("masteryRow").style.display = "";
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

  const tr = D.trans[i];
  $("dTrans").innerHTML = fmtTrans(tr, 10) || "<span class='muted'>（暂无释义）</span>";
  $("dTrans").classList.toggle("dim", !tr);
  bindMore($("dTrans"));
  /* 英文释义：按词性分组 + 逐条编号，超过 6 条先折叠 */
  const defHTML = fmtDef(D.def[i], 6);
  $("dDef").innerHTML = defHTML;
  $("bDef").style.display = defHTML ? "" : "none";
  bindMore($("dDef"));

  /* morphology: 词根拆解 + 同根词 */
  const w = D.words[i];
  const mw = D.morph && D.morph[w];
  const cg = D.cogn && D.cogn[w];
  $("bMorph").style.display = (mw || cg) ? "" : "none";
  $("dMorph").innerHTML = mw ? mw.map(function (seg) {
    const k = seg[0], t = seg[1], g = seg[2] || "";
    return '<span class="seg ' + k + '">' + t + (g ? "<i>" + g + "</i>" : "") + "</span>";
  }).join('<span class="plus">+</span>') : "";
  if (cg && cg.length) {
    $("dMorphNote").textContent = "· 同根词 " + cg.length + " 个";
    $("dCogn").innerHTML = cg.map(c => "<button data-w=\"" + c + "\">" + c + "</button>").join("");
    $("dCogn").querySelectorAll("button").forEach(b => {
      b.onclick = () => { trail.push(current); expand(D.idx[b.dataset.w]); speak(b.dataset.w); };
    });
  } else {
    $("dMorphNote").textContent = "";
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
  $("dFamNote").textContent = fam.length ? fam.length + " 个词形" : "";
  $("dFam").innerHTML = fam.map(([f, c]) => {
    const target = D.alias[f];
    if (target && target !== D.words[i] && D.idx[target] !== undefined) {
      return `<span class="jump" data-w="${target}"><b>${f}</b><i>${c}</i></span>`;
    }
    return `<span><b>${f}</b><i>${c}</i></span>`;
  }).join("") || "<span style='color:#9ca3af;font-size:12px'>无</span>";
  $("dFam").querySelectorAll(".jump").forEach(el => {
    el.onclick = () => { go(el.dataset.w); speak(el.dataset.w); };
  });

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

function doSuggest(q) {
  q = q.trim().toLowerCase();
  if (!q) { sugg.classList.add("hidden"); return; }
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
}

/* ---------- legend ---------- */
(function legend() {
  const el = $("legend");
  const LG_KEY = "cocawn.legend.mini";
  el.innerHTML =
    `<div class="lghd"><span class="lgt">图例</span>` +
    `<button class="lgbtn" id="lgBtn" type="button" title="收起图例">−</button></div>` +
    `<div class="lgbd">` +
    REL.map(r => {
      /* 上位词/下位词在立体视图里是有方向的：↑ 往上、↓ 往下 */
      const arrow = r.t === 2 ? " ↑" : r.t === 3 ? " ↓" : "";
      return `<div class="li"><span class="sw" style="background:${r.color}"></span>${r.name}${arrow}</div>`;
    }).join("") +
    `<div class="li" style="margin-top:5px;border-top:1px solid #eef2f7;padding-top:5px">
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
     <div class="li" style="margin-top:5px;border-top:1px solid #eef2f7;padding-top:5px">
       <span class="sw" style="background:#e2e8f0;border:1px solid #cbd5e1"></span>词表外关联词（点开可看释义·听发音）
     </div>
     <div class="li" style="color:#94a3b8">↑ 上位词悬浮上方（紫环）· ↓ 下位词沉在下方（青环）· 其余关系同一平面</div>` +
    `</div>`;

  const btn = el.querySelector("#lgBtn");
  const apply = mini => {
    el.classList.toggle("mini", mini);
    btn.textContent = mini ? "+" : "−";
    btn.title = mini ? "展开图例" : "收起图例";
    btn.setAttribute("aria-expanded", String(!mini));
  };
  let mini = false;
  try { mini = localStorage.getItem(LG_KEY) === "1"; } catch (e) {}
  apply(mini);
  btn.addEventListener("click", ev => {
    ev.stopPropagation();
    mini = !mini;
    apply(mini);
    try { localStorage.setItem(LG_KEY, mini ? "1" : "0"); } catch (e) {}
  });
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
    (listMode === "all" ? "（掌握 " + m + " · 学习中 " + l + " · 未学 " + (rows.length - m - l) + "）" : "");

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
      prog[k] = { s: v.s, t: v.t };
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

document.addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  if (e.key === "n" || e.key === "N") nextWord();
  if (e.key === "f" || e.key === "F") focusCurrent();
  if (e.key === "p" || e.key === "P") speakCurrent();
  if (e.key === "v" || e.key === "V") applyTilt(isFlat() ? 55 : 0, true);
  if (e.key === "m" || e.key === "M") { renderMap(); $("mapModal").classList.remove("hidden"); }
  if (e.key === "l" || e.key === "L") {
    if ($("listModal").classList.contains("hidden")) { renderList(true); $("listModal").classList.remove("hidden"); }
    else $("listModal").classList.add("hidden");
  }
});

window.addEventListener("resize", () => {
  if (sim) { sim.force("center", d3.forceCenter(width() / 2, height() / 2)); sim.alpha(0.3).restart(); }
  paintGrid(); paint();
});

/* ---------- boot ---------- */
const _loader = document.getElementById("loader");
if (_loader) _loader.classList.add("done");
renderStats();
try {
  const last = localStorage.getItem("coca10000.last");
  if (last !== null && D.idx[D.words[+last]] !== undefined) go(+last);
} catch (e) {}
if (location.hash.length > 1) applyHash();

})();
