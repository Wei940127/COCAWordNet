/* COCAWordNet — interactive word-network vocabulary app */
(function () {
"use strict";

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
  const h = window.COCASyncHooks;
  if (h && h.onLocalChange) { try { h.onLocalChange(); } catch (e) {} }
};

/* ---------- data helpers ---------- */
const BAND_NAMES = { 1: "1k", 2: "2k", 3: "3k", 4: "4k", 5: "5k", 6: "6k", 7: "7k", 8: "8k", 9: "9k", 10: "10k" };
const isWord = r => r >= 0;
const extraIdx = r => -r - 1;

/* grouped relations of a headword, by type */
function relsOf(i) {
  const groups = {};
  (D.adj[i] || []).forEach(([t, r]) => {
    (groups[t] = groups[t] || []).push(r);
  });
  return groups;
}
function nodeWord(kind, i) { return kind === "w" ? D.words[i] : D.extra[i]; }

/* ---------- svg setup ---------- */
const svg = d3.select("#graph");
const g = svg.append("g");
const gLinks = g.append("g");
gLinks.attr("filter", "url(#fwGlow)");
const gNodes = g.append("g");
const width = () => svg.node().clientWidth;
const height = () => svg.node().clientHeight;
svg.call(d3.zoom().scaleExtent([0.25, 4]).on("zoom", e => g.attr("transform", e.transform)));

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
  const keepIds = new Set();
  if (current !== null) keepIds.add("w:" + current);
  nodes.forEach(n => {
    if (n.dist <= 1 || n.expanded || statusOf(n.i) === 2 && n.kind === "w") keepIds.add(n.id);
  });
  const removable = nodes
    .filter(n => !keepIds.has(n.id))
    .sort((a, b) => (b.dist - a.dist) || (statusOf(a.i) === 0 ? -1 : 1));
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

function expand(i, opts) {
  opts = opts || {};
  const me = ensureNode("w", i, 0);
  me.dist = 0;
  const groups = relsOf(i);
  TYPE_PRIORITY.forEach(t => {
    (groups[t] || []).forEach(r => {
      const kind = isWord(r) ? "w" : "x";
      const j = isWord(r) ? r : extraIdx(r);
      const n = ensureNode(kind, j, 1);
      ensureLink(me, n, t);
    });
  });
  me.expanded = true;
  current = i;
  prune();
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
  startSim();
}

function clearGraph() {
  nodes = []; links = []; nodeMap.clear(); linkSet.clear();
  current = null; trail = [];
  gLinks.selectAll("*").remove();
  gNodes.selectAll("*").remove();
  if (sim) sim.stop();
  document.getElementById("emptyState").classList.remove("hidden");
  document.getElementById("detail").classList.add("hidden");
  document.getElementById("ph").classList.remove("hidden");
  renderTrail();
  try { localStorage.removeItem("coca10000.last"); } catch (e) {}
}

/* ---------- drawing ---------- */
function nodeFill(d) {
  const mode = document.getElementById("colorMode").value;
  if (d.kind === "x") return "#e2e8f0";
  if (mode === "flat") return "#94a3b8";
  if (mode === "band") return d.band <= 3 ? "#db2777" : d.band <= 6 ? "#ca8a04" : "#1e3a8a";
  const s = statusOf(d.i);
  return s === 2 ? "#16a34a" : s === 1 ? "#f59e0b" : "#cbd5e1";
}

let nodeSel = null, linkSel = null;

function draw() {
  nodeSel = gNodes.selectAll("g.node").data(nodes, d => d.id);
  nodeSel.exit().remove();
  const enter = nodeSel.enter().append("g").attr("class", "node")
    .attr("id", d => cssId(d.id))
    .call(d3.drag()
      .on("start", (e, d) => { if (!e.active) sim.alphaTarget(0.25).restart(); d.fx = d.x; d.fy = d.y; })
      .on("drag", (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on("end", (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));

  enter.append("circle")
    .attr("class", "vis")
    .attr("r", radius)
    .attr("fill", nodeFill)
    .attr("stroke", "#fff")
    .attr("stroke-width", 1.5)
    .style("pointer-events", "none");

  /* transparent, larger hit area — makes the small out-of-list dots easy to click */
  enter.append("circle")
    .attr("class", "hit")
    .attr("r", d => radius(d) + (d.kind === "x" ? 8 : 3))
    .attr("fill", "transparent")
    .style("cursor", "pointer")
    .style("pointer-events", "all");

  enter.append("text")
    .attr("dy", d => radius(d) + 12)
    .attr("text-anchor", "middle")
    .style("pointer-events", "none")
    .text(d => d.word)
    .attr("fill", d => (d.kind === "x" ? "#94a3b8" : "#334155"))
    .attr("font-size", d => (d.kind === "x" ? 9 : d.id === "w:" + current ? 14 : 11));

  const all = enter.merge(nodeSel);
  all.select("circle.vis")
    .attr("r", radius)
    .attr("fill", nodeFill)
    .attr("stroke", d => (d.id === "w:" + current ? "#1d4ed8" : "#fff"))
    .attr("stroke-width", d => (d.id === "w:" + current ? 3 : 1.5));
  all.select("circle.hit")
    .attr("r", d => radius(d) + (d.kind === "x" ? 8 : 3));
  all.select("text")
    .attr("dy", d => radius(d) + 12)
    .attr("font-size", d => (d.kind === "x" ? 9 : d.id === "w:" + current ? 14 : 11))
    .text(d => d.word);

  all.on("click", (e, d) => {
      e.stopPropagation();
      if (d.kind === "w") {
        if (d.i !== current) { trail.push(current); if (trail.length > 24) trail.shift(); expand(d.i); }
        renderPanel(d.i);
      } else {
        /* out-of-list word: no network behind it — show what we know + play it */
        renderPanel(null, d);
        speak(d.word);
      }
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
    .attr("stroke-opacity", l => (l.t === 6 ? 0.35 : 0.6))
    .attr("stroke-width", l => (l.t === 4 ? 2.3 : l.t === 6 ? 1 : 1.8))
    .attr("stroke-dasharray", l => (l.t === 4 ? "4 3" : null));
  linkSel = le.merge(linkSel);

  sim.on("tick", () => {
    linkSel.attr("x1", l => l.source.x).attr("y1", l => l.source.y)
           .attr("x2", l => l.target.x).attr("y2", l => l.target.y);
    all.attr("transform", d => `translate(${d.x},${d.y})`);
  });
}

svg.on("click", () => { document.getElementById("sugg").classList.add("hidden"); });

function showTip(e, d) {
  let html = "<b>" + d.word + "</b>";
  if (d.kind === "w") {
    const ph = D.phon[d.i];
    if (ph) html += ' <span class="tp">/' + ph + "/</span>";
    html += ' <span class="tp">· ' + BAND_NAMES[D.band[d.i]] + "词层</span>";
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
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(word);
  u.lang = "en-US";
  u.rate = 0.85;
  if (US_VOICE) u.voice = US_VOICE;
  speechSynthesis.speak(u);
}
function speak(word) {
  if (!word) return;
  const btn = $("dSpeak");
  btn.classList.add("playing");
  const done = () => btn.classList.remove("playing");
  if (curAudio) { try { curAudio.pause(); } catch (e) {} curAudio = null; }
  /* real American voice from Youdao dict (type=2 = US), TTS fallback offline */
  try {
    const a = new Audio("https://dict.youdao.com/dictvoice?audio=" +
      encodeURIComponent(word) + "&type=2");
    curAudio = a;
    a.onended = done;
    a.onerror = () => { curAudio = null; done(); speakLocal(word); };
    a.play().catch(() => { curAudio = null; done(); speakLocal(word); });
  } catch (e) { done(); speakLocal(word); }
}
function speakCurrent() {
  if (current !== null) speak(D.words[current]);
  else if (extraCurrent !== null) speak(extraCurrent);
}
$("dSpeak").onclick = speakCurrent;
$("dPhon").style.cursor = "pointer";
$("dPhon").onclick = speakCurrent;

/* ---------- out-of-list related words ---------- */
/* D.extraPhon / D.extraTrans are ARRAYS parallel to D.extra — index, not word key */
let extraCurrent = null;
function extraPhon(i) { return (D.extraPhon && D.extraPhon[i]) || ""; }
function extraTrans(i) { return (D.extraTrans && D.extraTrans[i]) || ""; }

function renderExtraPanel(node) {
  const i = node.i, word = D.extra[i];
  extraCurrent = word;
  $("ph").classList.add("hidden");
  $("detail").classList.remove("hidden");
  $("dWord").textContent = word;
  const ph = extraPhon(i);
  $("dPhon").textContent = ph ? "/" + ph + "/" : "无音标 · 点 🔊 听发音";
  $("dBand").textContent = "词表外关联词";
  $("dTags").innerHTML = "";
  document.querySelectorAll(".mbtn").forEach(b => b.classList.remove("on"));
  $("masteryRow").style.display = "none";
  $("dTrans").textContent = extraTrans(i) || "（暂无释义）";
  $("dDef").style.display = "none";
  $("dDef").textContent = "";
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
    "<div class='exttr'>" + (tr || "（暂无释义）") + "</div>" +
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
  $("dPhon").textContent = D.phon[i] ? "/" + D.phon[i] + "/" : "";
  $("dBand").textContent = BAND_NAMES[D.band[i]] + " 词层";
  const tags = (D.tag[i] || "").split(" ").filter(Boolean);
  $("dTags").innerHTML = tags.map(t => "<i>" + t + "</i>").join("");

  document.querySelectorAll(".mbtn").forEach(b => {
    b.classList.toggle("on", +b.dataset.s === statusOf(i));
  });

  $("dTrans").textContent = D.trans[i] || "（暂无释义）";
  $("dDef").textContent = D.def[i] || "";
  $("dDef").style.display = D.def[i] ? "" : "none";

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
      b.onclick = () => { trail.push(current); expand(D.idx[b.dataset.w]); };
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
      b.onclick = () => speak(b.dataset.p);
    });
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
    el.onclick = () => go(el.dataset.w);
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
    b.onclick = () => { trail.push(current); expand(+b.dataset.i); };
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
    `<div data-k="${k}"><b>${w}</b><i>${note || (D.trans[i] || "").split("；")[0].slice(0, 30)}</i><span class="sugband">${BAND_NAMES[D.band[i]]}</span></div>`
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
  el.innerHTML = REL.map(r =>
    `<div class="li"><span class="sw" style="background:${r.color}"></span>${r.name}</div>`
  ).join("") +
  `<div class="li" style="margin-top:5px;border-top:1px solid #eef2f7;padding-top:5px">
     <span class="sw" style="background:#16a34a"></span>已掌握
     <span class="sw" style="background:#f59e0b;margin-left:6px"></span>学习中
     <span class="sw" style="background:#cbd5e1;margin-left:6px"></span>未学
   </div>
   <div class="li" style="margin-top:5px;border-top:1px solid #eef2f7;padding-top:5px">
     <span class="sw" style="background:#db2777"></span>1–3k 词层
     <span class="sw" style="background:#ca8a04;margin-left:6px"></span>4–6k
     <span class="sw" style="background:#1e3a8a;margin-left:6px"></span>7–10k
   </div>
   <div class="li" style="margin-top:5px;border-top:1px solid #eef2f7;padding-top:5px">
     <span class="sw" style="background:#e2e8f0;border:1px solid #cbd5e1"></span>词表外关联词（点开可看释义·听发音）
   </div>`;
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
    '<div class="mrow"><div class="bl">全部<small>10 层合计</small></div>' +
    '<div class="stack"><div class="m" style="width:' + (tot.total ? tot.mastered / tot.total * 100 : 0) + '%"></div>' +
    '<div class="l" style="width:' + (tot.total ? tot.learned / tot.total * 100 : 0) + '%"></div></div>' +
    '<div class="bnum">掌握 <b>' + tot.mastered + '</b> · 学习中 ' + tot.learned +
    '<br>未学 ' + (tot.total - tot.mastered - tot.learned) + ' · ' + tp + '%</div></div>';

  rows.forEach(r => {
    const cls = "brow" + (weak && r.b === weak.b ? " weak" : "");
    html +=
      '<div class="' + cls + '" data-b="' + r.b + '">' +
      '<div class="bl">' + BAND_NAMES[r.b] + '<small>' + r.total + ' 词</small></div>' +
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
    if (q && D.words[i].toLowerCase().indexOf(q) < 0) continue;
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
  $("listBody").innerHTML = show.length
    ? show.map(i =>
        '<span class="lw s' + statusOf(i) + (i === current ? " on" : "") + '" data-i="' + i +
        '" title="' + (b ? "" : BAND_NAMES[D.band[i]] + " · ") +
        String(D.trans[i] || "").replace(/"/g, "").slice(0, 40) + '">' +
        D.words[i] + "</span>").join("")
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
  $("listModal").classList.add("hidden");
  go(+w.dataset.i);
});

/* ---------- progress export / import ---------- */
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
      const clean = {};
      let skipped = 0;
      for (const k in p) {
        const v = p[k];
        /* 导入是「以这份文件为准」的显式操作，统一用当前时间打戳，
           这样随后与云端合并时，不会被旧数据覆盖回去 */
        if (D.idx[k] !== undefined && v && (v.s === 1 || v.s === 2)) clean[k] = { s: v.s, t: Date.now() };
        else skipped++;
      }
      const n = Object.keys(clean).length;
      if (!n) { alert("没有找到有效的进度记录（需要是本应用导出的文件）"); return; }
      const cur = learnedCount();
      if (!confirm("读到 " + n + " 条有效进度" + (skipped ? "（跳过 " + skipped + " 条无效）" : "") +
        "。\n当前进度 " + cur + " 条，导入将覆盖现有进度。继续吗？")) return;
      prog = clean;
      saveProg();
      renderStats();
      renderMap();
      if (!$("listModal").classList.contains("hidden")) renderList(true);
      if (current !== null) renderPanel(current);
      draw();
      const _h = window.COCASyncHooks;
      if (_h && _h.onLocalChange) { try { _h.onLocalChange(); } catch (e) {} }
    };
    rd.readAsText(f);
  };
  inp.click();
};

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
  if (e.key === "m" || e.key === "M") { renderMap(); $("mapModal").classList.remove("hidden"); }
  if (e.key === "l" || e.key === "L") {
    if ($("listModal").classList.contains("hidden")) { renderList(true); $("listModal").classList.remove("hidden"); }
    else $("listModal").classList.add("hidden");
  }
});

window.addEventListener("resize", () => { if (sim) { sim.force("center", d3.forceCenter(width() / 2, height() / 2)); sim.alpha(0.3).restart(); } });

/* ---------- 跨设备同步挂钩（供 sync.js 调用；未启用云端时完全闲置） ---------- */
window.COCASyncHooks = {
  getProg: () => prog,
  learnedCount,
  applyProg: p => {
    prog = (p && typeof p === "object") ? p : {};
    saveProg();
    renderStats();
    if (!$("mapModal").classList.contains("hidden")) renderMap();
    if (!$("listModal").classList.contains("hidden")) renderList(true);
    if (current !== null) renderPanel(current);
    draw();
  },
  onLocalChange: null
};

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
