-- ============================================================
--  COCAWordNet · 学习进度表 + 行级安全（RLS）
--  用法：Supabase 后台 → 左侧 SQL Editor → New query → 粘贴全文 → Run
--  可重复执行（幂等）。
-- ============================================================

create table if not exists public.progress (
  user_id    uuid        primary key references auth.users(id) on delete cascade,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- 行级安全：没有它，任何人拿到 anon key 都能读别人进度
alter table public.progress enable row level security;

drop policy if exists "own progress select" on public.progress;
drop policy if exists "own progress insert" on public.progress;
drop policy if exists "own progress update" on public.progress;

create policy "own progress select" on public.progress
  for select using (auth.uid() = user_id);

create policy "own progress insert" on public.progress
  for insert with check (auth.uid() = user_id);

create policy "own progress update" on public.progress
  for update using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 说明：不需要 delete 策略。用户只能读写 user_id = 自己 的那一行。
