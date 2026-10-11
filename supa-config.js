/* ============================================================
   COCAWordNet · 云端同步配置
   ------------------------------------------------------------
   留空 = 不启用同步，应用完全按原来的本地模式工作（不会报错）。

   填法：Supabase 后台 → 你的项目 → Project Settings → API Keys
     url      = Project URL      （形如 https://abcdefghijkl.supabase.co）
     anonKey  = anon / publishable key（形如 eyJhbGciOi... 或 sb_publishable_...）

   关于 anonKey 的安全：它设计上就是公开的（浏览器里必然可见），
   本身不带任何权限。真正的隔离由数据库的 RLS 策略完成 ——
   见 supabase-setup.sql，用户只能读写自己那一行。
   切勿把 service_role key 写进这里。
   ============================================================ */
window.COCA_SUPABASE = {
  url:     "",
  anonKey: "",

  /* "password" = 邮箱 + 密码（推荐，登录不发邮件，无速率限制）
     "otp"      = 邮箱验证码（需先在 Supabase 配好自定义 SMTP 并修改邮件模板
                  加入 {{ .Token }}，否则只会收到链接，在 iPad 主屏幕应用里拿不到登录态） */
  method: "password"
};
