/* ============================================================
   COCAWordNet · 账号 + 跨设备学习进度同步（Supabase）
   ------------------------------------------------------------
   完全可选：supa-config.js 未填时本模块不启用，应用按原样本地运行。

   同步模型
     · 进度以「单词 → {状态, 时间戳}」为单位存储，天然可合并
     · 每次同步：拉云端 → 逐词比较时间戳（取更新的）→ 双向回写
     · 因此两台设备各改各的不会互相覆盖，也不需要任何服务端逻辑
     · 取消标记保留为 s=0 的「墓碑」，否则另一台设备的旧数据会把它复活
   ============================================================ */
(function () {
  "use strict";

  var cfg = window.COCA_SUPABASE || {};
  var URL_ = String(cfg.url || "").trim().replace(/\/+$/, "");
  var KEY = String(cfg.anonKey || "").trim();
  var METHOD = cfg.method === "otp" ? "otp" : "password";
  var ON = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(URL_) &&
           KEY.length > 20 &&
           /^https?:$/.test(location.protocol);

  var $ = function (id) { return document.getElementById(id); };
  var hooks = function () { return window.COCASyncHooks || null; };

  var syncBtn = $("syncBtn");

  if (!ON) { if (syncBtn) syncBtn.style.display = "none"; return; }

  var client = null, user = null, timer = null, running = false;

  /* ---------------- UI ---------------- */
  function setBtn(state, text) {
    if (!syncBtn) return;
    syncBtn.dataset.state = state;
    var l = $("syncLabel");
    if (l) l.textContent = text;
  }
  function msg(text, kind) {
    var m = $("syncMsg");
    if (!m) return;
    m.textContent = text || "";
    m.className = "syncmsg" + (kind ? " " + kind : "");
  }
  function tsLabel(t) {
    if (!t) return "尚未同步";
    var d = new Date(t), n = new Date();
    var hh = ("0" + d.getHours()).slice(-2), mm = ("0" + d.getMinutes()).slice(-2);
    return d.toDateString() === n.toDateString()
      ? "今天 " + hh + ":" + mm
      : (d.getMonth() + 1) + " 月 " + d.getDate() + " 日 " + hh + ":" + mm;
  }
  function getStamp() { try { return +(localStorage.getItem("coca10000.syncedAt") || 0); } catch (e) { return 0; } }
  function refreshWho(stamp) {
    var w = $("syncWho");
    if (w) w.textContent = (user && (user.email || user.id)) || "";
    var l = $("syncLast");
    if (l) l.textContent = tsLabel(stamp || getStamp());
  }
  function showGate() {
    var g = $("syncGate"), p = $("syncPanel");
    if (g) g.classList.remove("hidden");
    if (p) p.classList.add("hidden");
  }
  function showPanel() {
    var g = $("syncGate"), p = $("syncPanel");
    if (g) g.classList.add("hidden");
    if (p) p.classList.remove("hidden");
  }
  function openModal() { var m = $("syncModal"); if (m) m.classList.remove("hidden"); }
  function closeModal() { var m = $("syncModal"); if (m) m.classList.add("hidden"); }

  function friendly(e) {
    var m = (e && (e.message || e.error_description || e.msg)) || String(e || "");
    if (/NEED_CONFIRM/.test(m)) return "注册成功，但项目还开着「Confirm email」。请到 Supabase → Authentication → Sign In / Providers → Email 里关掉它，然后用同一个邮箱重新注册一次。";
    if (/Invalid login credentials/i.test(m)) return "邮箱或密码不正确";
    if (/Email not confirmed/i.test(m)) return "该账号邮箱尚未确认，请先在 Supabase 关闭 Confirm email";
    if (/already registered|User already registered/i.test(m)) return "这个邮箱已注册过了，请直接登录";
    if (/Password should be at least/i.test(m)) return "密码太短，至少 6 位";
    if (/Unable to validate email/i.test(m)) return "邮箱格式不对";
    if (/rate limit|over_email_send_rate_limit/i.test(m)) return "请求过于频繁，请稍后再试";
    if (/Failed to fetch|NetworkError|Load failed|fetch failed/i.test(m)) return "连不上云端（离线或被网络拦截）";
    if (/\b540\b/.test(m)) return "云端项目已被暂停，请到 Supabase 后台点 Resume project";
    return m.slice(0, 140);
  }

  /* ---------------- 合并 ---------------- */
  function merge(base, over) {
    var out = {}, k;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    for (k in over) {
      if (!Object.prototype.hasOwnProperty.call(over, k)) continue;
      var a = over[k], b = out[k];
      if (!a) continue;
      if (!b || (a.t || 0) > (b.t || 0)) out[k] = a;
    }
    return out;
  }
  function countLearned(p) {
    var n = 0;
    for (var k in p) if (Object.prototype.hasOwnProperty.call(p, k) && p[k] && p[k].s) n++;
    return n;
  }

  /* ---------------- 同步 ---------------- */
  async function fullSync(quiet) {
    if (!client || !user || running) return;
    running = true;
    if (!quiet) setBtn("syncing", "同步中…");
    try {
      var h = hooks();
      var local = (h && h.getProg()) || {};

      var r = await client.from("progress").select("data").eq("user_id", user.id).maybeSingle();
      if (r.error) throw r.error;

      var remote = (r.data && r.data.data) || {};
      var merged = merge(remote, local);

      var up = await client.from("progress").upsert(
        { user_id: user.id, data: merged, updated_at: new Date().toISOString() },
        { onConflict: "user_id" }
      );
      if (up.error) throw up.error;

      if (h && h.applyProg) h.applyProg(merged);

      var stamp = Date.now();
      try { localStorage.setItem("coca10000.syncedAt", String(stamp)); } catch (e) {}

      var gained = countLearned(merged) - countLearned(local);
      setBtn("ok", "已同步");
      msg("已同步 · 共 " + countLearned(merged) + " 词" + (gained > 0 ? "（云端补入 " + gained + " 词）" : ""), "good");
      refreshWho(stamp);
    } catch (e) {
      setBtn("err", "同步失败");
      msg("同步失败：" + friendly(e), "bad");
    } finally {
      running = false;
    }
  }

  /* ---------------- 登录 / 注册 ---------------- */
  async function handleSignIn() {
    var email = ($("syncEmail").value || "").trim();
    var pass = $("syncPass").value || "";
    if (!email || !pass) { msg("请填写邮箱和密码", "bad"); return; }
    msg("登录中…");
    setBtn("syncing", "登录中…");
    try {
      var r = await client.auth.signInWithPassword({ email: email, password: pass });
      if (r.error) throw r.error;
      msg("登录成功，正在同步…", "good");
      setTimeout(closeModal, 900);
    } catch (e) {
      setBtn("off", "登录同步");
      msg(friendly(e), "bad");
    }
  }

  async function handleSignUp() {
    var email = ($("syncEmail").value || "").trim();
    var pass = $("syncPass").value || "";
    if (!email || !pass) { msg("请填写邮箱和密码", "bad"); return; }
    if (pass.length < 6) { msg("密码至少 6 位", "bad"); return; }
    if (!confirm("用 " + email + " 创建账号？\n\n请记好这个密码 —— 换设备登录时要用。")) return;
    msg("创建中…");
    setBtn("syncing", "创建中…");
    try {
      var r = await client.auth.signUp({ email: email, password: pass });
      if (r.error) throw r.error;
      if (!r.data.session) throw new Error("NEED_CONFIRM");
      msg("账号已创建，正在同步…", "good");
      setTimeout(closeModal, 900);
    } catch (e) {
      setBtn("off", "登录同步");
      msg(friendly(e), "bad");
    }
  }

  async function handleSendOtp() {
    var email = ($("syncEmail").value || "").trim();
    if (!email) { msg("请填写邮箱", "bad"); return; }
    msg("发送中…");
    try {
      var r = await client.auth.signInWithOtp({ email: email });
      if (r.error) throw r.error;
      $("syncOtpRow").classList.remove("hidden");
      msg("验证码已发送，请查看邮箱（含垃圾箱）", "good");
    } catch (e) { msg(friendly(e), "bad"); }
  }

  async function handleVerifyOtp() {
    var email = ($("syncEmail").value || "").trim();
    var token = ($("syncOtp").value || "").trim();
    if (!token) { msg("请输入 6 位验证码", "bad"); return; }
    msg("验证中…");
    try {
      var r = await client.auth.verifyOtp({ email: email, token: token, type: "email" });
      if (r.error) throw r.error;
      msg("登录成功，正在同步…", "good");
      setTimeout(closeModal, 900);
    } catch (e) { msg(friendly(e), "bad"); }
  }

  async function handleSignOut() {
    if (!confirm("退出登录？\n\n本机进度会保留，云端记录不动。")) return;
    try { await client.auth.signOut(); } catch (e) {}
    msg("");
    closeModal();
  }

  /* ---------------- 启动 ---------------- */
  function loadSdk() {
    return new Promise(function (res, rej) {
      if (window.supabase && window.supabase.createClient) return res();
      var s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
      s.onload = function () {
        (window.supabase && window.supabase.createClient) ? res() : rej(new Error("SDK 异常"));
      };
      s.onerror = function () { rej(new Error("同步模块加载失败（可能离线）")); };
      document.head.appendChild(s);
    });
  }

  async function init() {
    try { await loadSdk(); }
    catch (e) { syncBtn.style.display = ""; setBtn("err", "离线"); syncBtn.title = e.message; return; }

    client = window.supabase.createClient(URL_, KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        /* 关掉：本应用用 #单词 做深链，不能让 SDK 去解析 location.hash */
        detectSessionInUrl: false
      }
    });

    syncBtn.style.display = "";

    var h = hooks();
    if (h) {
      h.onLocalChange = function () {
        if (!client || !user) return;
        setBtn("pending", "待同步…");
        clearTimeout(timer);
        timer = setTimeout(function () { fullSync(true); }, 2500);
      };
    }

    syncBtn.onclick = openModal;
    if ($("syncClose")) $("syncClose").onclick = closeModal;
    if ($("syncModal")) $("syncModal").onclick = function (e) { if (e.target === $("syncModal")) closeModal(); };
    if ($("syncSignIn")) $("syncSignIn").onclick = handleSignIn;
    if ($("syncSignUp")) $("syncSignUp").onclick = handleSignUp;
    if ($("syncNow")) $("syncNow").onclick = function () { msg("同步中…"); fullSync(false); };
    if ($("syncOut")) $("syncOut").onclick = handleSignOut;
    if ($("syncPass")) $("syncPass").onkeydown = function (e) { if (e.key === "Enter") handleSignIn(); };
    if ($("syncOtpSend")) $("syncOtpSend").onclick = handleSendOtp;
    if ($("syncOtpGo")) $("syncOtpGo").onclick = handleVerifyOtp;

    if (METHOD === "otp") {
      if ($("syncPassRow")) $("syncPassRow").classList.add("hidden");
      if ($("syncPwBtns")) $("syncPwBtns").classList.add("hidden");
      if ($("syncOtpBox")) $("syncOtpBox").classList.remove("hidden");
    }

    var g = await client.auth.getSession();
    user = (g.data && g.data.session && g.data.session.user) || null;

    client.auth.onAuthStateChange(function (ev, session) {
      /* 延迟一拍，避免在 SDK 回调里再次调用 auth 造成死锁 */
      setTimeout(function () {
        user = (session && session.user) || null;
        if (user) { showPanel(); refreshWho(); fullSync(true); }
        else { showGate(); setBtn("off", "登录同步"); }
      }, 0);
    });

    if (user) { showPanel(); refreshWho(); setBtn("ok", "已同步"); fullSync(true); }
    else { showGate(); setBtn("off", "登录同步"); }

    /* iPad 上从后台切回来时补一次同步 */
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && user && client) fullSync(true);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
