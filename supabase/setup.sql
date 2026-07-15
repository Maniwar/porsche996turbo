-- ============================================================================
-- 2003 Porsche 911 Turbo — complete backend setup, in ONE idempotent file.
--
-- Paste this whole file into the Supabase SQL Editor and Run. It is safe to
-- run on a fresh project OR on one that is partially set up, and safe to run
-- more than once: every statement creates only what is missing. It brings the
-- database to the current state the edge functions expect.
--
-- (The supabase/migrations/ folder holds the same schema as an ordered history
--  for `supabase db push`. This file is the single manual-setup convenience.)
-- ============================================================================

create extension if not exists vector with schema extensions;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. TABLES
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.concierge_config (
  key text primary key, value jsonb not null,
  updated_at timestamptz not null default now());

create table if not exists public.concierge_kb (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null, title text not null, content_md text not null,
  sort_order int not null default 0, enabled boolean not null default true,
  updated_at timestamptz not null default now());

create table if not exists public.concierge_admins (email text primary key);
-- a protected super admin (the owner) can never be removed or demoted
alter table public.concierge_admins add column if not exists is_super boolean not null default false;

create table if not exists public.concierge_conversations (
  id uuid primary key default gen_random_uuid(),
  session_key text not null,
  user_id uuid references auth.users(id) on delete set null,
  user_email text, section text,
  created_at timestamptz not null default now());
create index if not exists concierge_conversations_session_key_idx on public.concierge_conversations (session_key);
create index if not exists concierge_conversations_created_at_idx on public.concierge_conversations (created_at desc);
-- lifecycle + goals
alter table public.concierge_conversations
  add column if not exists status text not null default 'active',
  add column if not exists ended_at timestamptz,
  add column if not exists goal_status jsonb,
  add column if not exists goal_status_at timestamptz,
  add column if not exists sales_stage text,    -- funnel stage from the async grader (browsing…won/lost)
  add column if not exists ip text;             -- latest client IP (abuse/legal forensics; admin-only, PII-gated in export)
create index if not exists concierge_conversations_ended_idx
  on public.concierge_conversations (user_id, ended_at desc) where ended_at is not null;

create table if not exists public.concierge_messages (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.concierge_conversations(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null, model text, latency_ms int,
  created_at timestamptz not null default now());
create index if not exists concierge_messages_conversation_id_idx on public.concierge_messages (conversation_id);

create table if not exists public.concierge_feedback (
  message_id bigint primary key references public.concierge_messages(id) on delete cascade,
  rating smallint not null check (rating in (-1, 1)), note text,
  created_at timestamptz not null default now());

create table if not exists public.customers (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null, name text,
  created_at timestamptz not null default now());

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  email text not null, serial int unique,
  status text not null,
  tracking text, city text,
  placed_at timestamptz not null default now());
create index if not exists orders_email_idx on public.orders (email);
create index if not exists orders_user_id_idx on public.orders (user_id);
-- order columns added across the project's life
alter table public.orders
  add column if not exists name text,
  add column if not exists address text,
  add column if not exists address2 text,
  add column if not exists state text,
  add column if not exists zip text,
  add column if not exists variant text,
  add column if not exists recipient_name text,
  add column if not exists is_gift boolean not null default false,
  add column if not exists billing jsonb,
  add column if not exists cancelled_serial int,
  add column if not exists cancelled_at timestamptz,
  add column if not exists chat_session text,
  -- Attribution tier: 'concierge' = checkout opened from the concierge's own
  -- commission button (causal); 'ambient' = a chat existed this tab session but
  -- checkout came from a page button (co-occurrence). NULL = unassisted or
  -- pre-attribution order. chat_meta carries the commission-click context
  -- ({entry, section, turns}) for 'concierge' orders. See ATTRIBUTION.md.
  add column if not exists chat_via text,
  add column if not exists chat_meta jsonb;
-- attribution vocabulary (drop + re-add so re-running is clean):
-- 'concierge' = checkout opened from the concierge's commission button (causal);
-- 'ambient'   = a chat co-occurred in the buying tab session;
-- 'identity'  = signed-in buyer with a conversation ≤30 days before placement
--               and no same-session chat (stamped server-side at placement —
--               catches cross-device / chat-today-buy-tomorrow journeys).
alter table public.orders drop constraint if exists orders_chat_via_check;
alter table public.orders add constraint orders_chat_via_check
  check (chat_via is null or chat_via in ('concierge','ambient','identity'));
-- serial may be released when an order is struck
alter table public.orders alter column serial drop not null;
-- status vocabulary (drop + re-add so re-running is clean)
alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status in ('placed','weaving','finishing','shipped','delivered','returned','cancelled'));
-- variant vocabulary
alter table public.orders drop constraint if exists orders_variant_check;
alter table public.orders add constraint orders_variant_check
  check (variant is null or variant in ('as-listed','unused-2','unused-3'));

create table if not exists public.allocation_counter (
  id int primary key default 1 check (id = 1), next_serial int not null);
-- the edition's total run size, admin-settable (see set_edition below)
alter table public.allocation_counter add column if not exists run_size int not null default 15000;
-- Inquiry mode: the counter is seeded INERT — run_size 0 means no run is on
-- sale and hold_serial/commission_order can never allocate a number. If
-- commerce is ever enabled, set a real edition from the studio (set_edition),
-- not by editing this file.
insert into public.allocation_counter (id, next_serial, run_size) values (1, 1, 0)
  on conflict (id) do nothing;

create table if not exists public.serial_holds (
  serial int primary key, session_key text not null, expires_at timestamptz not null);
create index if not exists serial_holds_session_idx on public.serial_holds (session_key);
create index if not exists serial_holds_expires_idx on public.serial_holds (expires_at);

-- Funnel events — the behavioral top of the conversion funnel (ATTRIBUTION.md).
-- One row per beacon: 'visit' (page loaded), 'chat_open' (concierge panel
-- opened), 'checkout_open' (register sheet opened; via = concierge|page).
-- Deliberately PII-free: visit_key is a random device token, no IP, no email.
-- Written only by the concierge edge function (?track=1, rate-limited);
-- admin-read via RLS. Pruned with the other high-write tables.
create table if not exists public.site_events (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('visit','chat_open','checkout_open')),
  visit_key text not null,
  session_key text,
  section text,
  via text check (via is null or via in ('concierge','page')),
  created_at timestamptz not null default now());
create index if not exists site_events_kind_created_idx
  on public.site_events (kind, created_at desc);
create index if not exists site_events_visit_idx on public.site_events (visit_key);

create table if not exists public.concierge_sops (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null, title text not null, content_md text not null,
  sort_order int not null default 0, enabled boolean not null default true,
  updated_at timestamptz not null default now());
-- audience: which shoppers this procedure is injected for — 'all' (default),
-- 'signed_in' (register/order-management steps, useless to an anonymous browser), or
-- 'anon'. buildSystemPrompt filters on it so the anonymous prompt stays lean.
alter table public.concierge_sops add column if not exists audience text not null default 'all';

create table if not exists public.concierge_actions (
  id bigint generated always as identity primary key,
  conversation_id uuid references public.concierge_conversations(id) on delete set null,
  user_id uuid, email text, action text not null, serial int, payload jsonb, result text,
  created_at timestamptz not null default now());
create index if not exists concierge_actions_created_at_idx on public.concierge_actions (created_at desc);

create table if not exists public.concierge_cache (
  id uuid primary key default gen_random_uuid(),
  question text not null, answer_md text not null,
  embedding extensions.vector(384) not null,
  hits int not null default 0, enabled boolean not null default true, model text,
  created_at timestamptz not null default now(), last_hit_at timestamptz);
create index if not exists concierge_cache_embedding_idx on public.concierge_cache
  using hnsw (embedding extensions.vector_ip_ops);

create table if not exists public.concierge_flags (
  id bigint generated always as identity primary key,
  conversation_id uuid references public.concierge_conversations(id) on delete set null,
  question text not null, answer text not null,
  reason text not null default 'knowledge_gap', resolved boolean not null default false,
  created_at timestamptz not null default now());
create index if not exists concierge_flags_open_idx on public.concierge_flags (resolved, created_at desc);

create table if not exists public.concierge_forms (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null, title text not null, submit_tool text not null,
  fields jsonb not null, enabled boolean not null default true,
  updated_at timestamptz not null default now());

-- Storefront CMS: one row per editable slot on index.html (copy / image / meta).
-- HTML holds the defaults; a slug here overrides it. Read via ?site=1 (service
-- role) and the deploy-time <head> bake; written by admins.
create table if not exists public.site_content (
  slug text primary key,
  kind text not null default 'text',   -- 'text' | 'image' | 'meta'
  value text,
  alt text,
  updated_at timestamptz not null default now());

-- Admin overrides for the concierge's model-callable tools. The built-in tool
-- set lives in the concierge function's code; a row here disables a tool or
-- replaces its model-facing description. No row → the tool runs at its default.
create table if not exists public.concierge_tools (
  name text primary key,                 -- must match a built-in tool name
  enabled boolean not null default true, -- false → withheld from the model
  description text,                       -- non-empty → overrides the model copy
  sort_order int not null default 100,
  updated_at timestamptz not null default now());

create table if not exists public.customer_notes (
  id bigint generated always as identity primary key,
  user_id uuid, email text, note text not null,
  created_at timestamptz not null default now());
-- Typed client book (like a support agent's notes the AI uses to talk to the
-- patron): 'fact' = a durable preference, 'event' = something the concierge did
-- (deterministic, guaranteed), 'reflection' = how to serve better next time,
-- 'directive' = a HUMAN admin's standing instruction the concierge must follow
-- (order exceptions, special handling). A directive can be marked resolved when
-- it is a one-time action that's been carried out.
alter table public.customer_notes add column if not exists kind text not null default 'fact';
alter table public.customer_notes
  add column if not exists resolved boolean not null default false,  -- directive done (one-time)
  add column if not exists resolved_at timestamptz,
  add column if not exists author text;                              -- admin email who left a directive
create index if not exists customer_notes_email_idx on public.customer_notes (email, created_at desc);
create index if not exists customer_notes_user_idx on public.customer_notes (user_id, created_at desc);
-- Fast lookup of a patron's OPEN directives (surfaced into the concierge's prompt).
create index if not exists customer_notes_directive_idx
  on public.customer_notes (email, resolved) where kind = 'directive';

-- Managed address book — real, editable ship-to / billing addresses a patron (or
-- an admin on their behalf) can add, rename, and remove. Distinct from the derived
-- view built from order history: these persist and can be deleted. Auto-populated
-- from an order's ship-to + billing on placement, and backfilled from history the
-- first time a signed-in patron opens the checkout.
create table if not exists public.customer_addresses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid, email text,
  label text,                                    -- e.g. "Home", "Work", or a gift recipient's name
  is_gift boolean not null default false,        -- a gift recipient's address (not billable)
  recipient_name text,
  address text not null, address2 text, city text not null, state text not null, zip text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now());
create index if not exists customer_addresses_email_idx on public.customer_addresses (email, created_at desc);
create index if not exists customer_addresses_user_idx on public.customer_addresses (user_id, created_at desc);

create table if not exists public.order_events (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders(id) on delete cascade,
  event text not null, changes jsonb, created_at timestamptz not null default now());
create index if not exists order_events_order_idx on public.order_events (order_id, created_at desc);

-- Edit history for admin-managed content (config values, SOPs, KB entries), so a
-- change to a base prompt / policy / procedure can be reviewed and rolled back.
-- Append-only; rows are written by the security-definer trigger below (mirrors
-- order_events). `snapshot` is the value/content AFTER each change.
create table if not exists public.concierge_edit_history (
  id bigint generated always as identity primary key,
  entity text not null,          -- 'config' | 'sop' | 'kb'
  ref text not null,             -- config key, or SOP/KB slug
  snapshot jsonb not null,       -- the value/content after the change
  label text,                    -- optional human note (unused by the trigger)
  edited_by text,                -- admin email, or '(system)' for service-role writes
  created_at timestamptz not null default now());
create index if not exists concierge_edit_history_idx
  on public.concierge_edit_history (entity, ref, created_at desc);

create table if not exists public.concierge_goals (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null, label text not null, description text not null,
  enabled boolean not null default true, sort_order int not null default 0,
  updated_at timestamptz not null default now());
-- journey stage this goal is most relevant to (page section), nullable = anywhere
alter table public.concierge_goals add column if not exists section text;
-- a goal may fit MORE THAN ONE journey stage; sections[] is the source of truth
-- (empty/null = anywhere). section (singular) is kept, backfilled below, for
-- back-compat with any not-yet-deployed reader.
alter table public.concierge_goals add column if not exists sections text[];

-- Behavior-eval scenarios, admin-editable in the studio's Evals tab. A scenario
-- is a scripted conversation plus typed checks on the bot's reply; the runner
-- replays it against the live concierge and reports a pass rate. See evals/.
create table if not exists public.concierge_evals (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  description text not null default '',
  signed_in boolean not null default false,
  context jsonb not null default '{}'::jsonb,
  turns jsonb not null default '[]'::jsonb,
  enabled boolean not null default true,
  sort_order int not null default 0,
  updated_at timestamptz not null default now());

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. ROW LEVEL SECURITY + the admin-check helper
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.is_concierge_admin() returns boolean
  language sql security definer stable set search_path = '' as
$$ select exists(select 1 from public.concierge_admins a
     where a.email = coalesce(auth.jwt()->>'email','')) $$;

-- The super admin (the owner) — the only one who may remove admins, and the
-- one row no admin can remove or demote.
create or replace function public.is_super_admin() returns boolean
  language sql security definer stable set search_path = '' as
$$ select exists(select 1 from public.concierge_admins a
     where a.email = coalesce(auth.jwt()->>'email','') and a.is_super) $$;

do $$
declare t text;
begin
  foreach t in array array[
    'concierge_config','concierge_kb','concierge_admins','concierge_conversations',
    'concierge_messages','concierge_feedback','customers','orders','allocation_counter',
    'serial_holds','concierge_sops','concierge_actions','concierge_cache','concierge_flags',
    'concierge_forms','customer_notes','customer_addresses','order_events','concierge_goals','site_content',
    'concierge_tools','concierge_evals','concierge_edit_history','site_events'
  ] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- admin-all tables
do $$
declare t text;
begin
  foreach t in array array[
    'concierge_config','concierge_kb','concierge_conversations','concierge_messages',
    'concierge_sops','concierge_cache','concierge_forms','customer_notes','customer_addresses',
    'concierge_goals','concierge_flags','site_content','concierge_tools','concierge_evals'
  ] loop
    execute format('drop policy if exists "admin all" on public.%I', t);
    execute format($f$create policy "admin all" on public.%I for all to authenticated
      using (public.is_concierge_admin()) with check (public.is_concierge_admin())$f$, t);
  end loop;
end $$;

-- admin read-only
drop policy if exists "admin read" on public.concierge_actions;
create policy "admin read" on public.concierge_actions for select to authenticated using (public.is_concierge_admin());
drop policy if exists "admin read" on public.order_events;
create policy "admin read" on public.order_events for select to authenticated using (public.is_concierge_admin());
drop policy if exists "admin read" on public.concierge_edit_history;
create policy "admin read" on public.concierge_edit_history for select to authenticated using (public.is_concierge_admin());
drop policy if exists "admin read" on public.site_events;
create policy "admin read" on public.site_events for select to authenticated using (public.is_concierge_admin());

-- concierge_admins roster, from the admin panel:
--   • any admin may LIST the roster and ADD a (non-super) admin;
--   • only the SUPER admin may REMOVE an admin, and the super row itself can
--     never be removed or demoted (guaranteeing one owner always remains).
-- is_concierge_admin()/is_super_admin() are security-definer reads of this
-- table, so there is no RLS recursion; a non-admin still sees zero rows.
drop policy if exists "admin all" on public.concierge_admins;
drop policy if exists "admin manage" on public.concierge_admins;
drop policy if exists "admin select" on public.concierge_admins;
drop policy if exists "admin insert" on public.concierge_admins;
drop policy if exists "admin update" on public.concierge_admins;
drop policy if exists "admin delete" on public.concierge_admins;
create policy "admin select" on public.concierge_admins for select to authenticated
  using (public.is_concierge_admin());
create policy "admin insert" on public.concierge_admins for insert to authenticated
  with check (public.is_concierge_admin() and coalesce(is_super, false) = false);
create policy "admin update" on public.concierge_admins for update to authenticated
  using (public.is_super_admin() and coalesce(is_super, false) = false)
  with check (public.is_super_admin() and coalesce(is_super, false) = false);
create policy "admin delete" on public.concierge_admins for delete to authenticated
  using (public.is_super_admin() and coalesce(is_super, false) = false);

-- feedback: admins manage; anyone may insert a rating
drop policy if exists "admin all" on public.concierge_feedback;
create policy "admin all" on public.concierge_feedback for all to authenticated
  using (public.is_concierge_admin()) with check (public.is_concierge_admin());
drop policy if exists "anyone can insert feedback" on public.concierge_feedback;
create policy "anyone can insert feedback" on public.concierge_feedback for insert to anon, authenticated with check (true);

-- customers: own row; admins all
drop policy if exists "select own customer row" on public.customers;
create policy "select own customer row" on public.customers for select to authenticated using (id = auth.uid());
drop policy if exists "insert own customer row" on public.customers;
create policy "insert own customer row" on public.customers for insert to authenticated with check (id = auth.uid());
drop policy if exists "update own customer row" on public.customers;
create policy "update own customer row" on public.customers for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
drop policy if exists "admin all" on public.customers;
create policy "admin all" on public.customers for all to authenticated using (public.is_concierge_admin()) with check (public.is_concierge_admin());

-- orders: owners see their own; admins all
drop policy if exists "select own orders" on public.orders;
create policy "select own orders" on public.orders for select to authenticated
  using (user_id = auth.uid() or email = coalesce(auth.jwt()->>'email',''));
drop policy if exists "admin all" on public.orders;
create policy "admin all" on public.orders for all to authenticated using (public.is_concierge_admin()) with check (public.is_concierge_admin());

-- allocation_counter + serial_holds: service-role only (no policies)

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. FUNCTIONS (service-role only)
-- ─────────────────────────────────────────────────────────────────────────────

-- Reserve (or re-confirm) a serial for a visit — lowest free number first.
create or replace function public.hold_serial(p_session text)
returns table (o_serial int, o_expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare v_serial int; v_run int; v_exp timestamptz := now() + interval '10 minutes';
begin
  update public.serial_holds h set expires_at = v_exp
   where h.serial = (select h2.serial from public.serial_holds h2
      where h2.session_key = p_session and h2.expires_at > now()
      order by h2.serial limit 1 for update skip locked)
  returning h.serial into v_serial;
  if v_serial is not null then return query select v_serial, v_exp; return; end if;

  update public.serial_holds h set session_key = p_session, expires_at = v_exp
   where h.serial = (select h2.serial from public.serial_holds h2
      where h2.expires_at <= now() order by h2.serial limit 1 for update skip locked)
  returning h.serial into v_serial;
  if v_serial is not null then return query select v_serial, v_exp; return; end if;

  begin
    select next_serial, run_size into v_serial, v_run from public.allocation_counter where id = 1 for update;
  exception when undefined_column then
    select next_serial into v_serial from public.allocation_counter where id = 1 for update;
    v_run := 15000;
  end;
  if v_serial is null or v_serial > coalesce(v_run, 15000) then return; end if;
  update public.allocation_counter set next_serial = v_serial + 1 where id = 1;
  insert into public.serial_holds (serial, session_key, expires_at) values (v_serial, p_session, v_exp);
  return query select v_serial, v_exp;
end; $$;
revoke execute on function public.hold_serial(text) from public, anon, authenticated;

-- Record a commission, consuming the visit's hold; -1 when the run is full.
drop function if exists public.commission_order(text,text,text,text,text,text,text,text,uuid);
drop function if exists public.commission_order(text,text,text,text,text,text,text,text,uuid,text);
drop function if exists public.commission_order(text,text,text,text,text,text,text,text,uuid,text,text,boolean);
create or replace function public.commission_order(
  p_email text, p_name text, p_address text, p_address2 text, p_city text, p_state text,
  p_zip text, p_variant text, p_user_id uuid, p_session text default null,
  p_recipient text default null, p_is_gift boolean default false, p_billing jsonb default null
) returns int language plpgsql security definer set search_path = '' as $$
declare v_serial int; v_run int; v_tries int := 0;
begin
  if p_session is not null and length(p_session) > 0 then
    delete from public.serial_holds h where h.serial = (
      select h2.serial from public.serial_holds h2 where h2.session_key = p_session
      order by (h2.expires_at > now()) desc, h2.serial limit 1 for update skip locked)
    returning h.serial into v_serial;
  end if;
  if v_serial is null then
    delete from public.serial_holds h where h.serial = (
      select h2.serial from public.serial_holds h2 where h2.expires_at <= now()
      order by h2.serial limit 1 for update skip locked)
    returning h.serial into v_serial;
  end if;
  if v_serial is null then
    -- Read the run size; self-heal if the run_size column hasn't been added yet
    -- (schema drift) so placement never hard-fails on a slightly-behind DB.
    begin
      select next_serial, run_size into v_serial, v_run from public.allocation_counter where id = 1 for update;
    exception when undefined_column then
      select next_serial into v_serial from public.allocation_counter where id = 1 for update;
      v_run := 15000;
    end;
    if v_serial is null or v_serial > coalesce(v_run, 15000) then return -1; end if;
    update public.allocation_counter set next_serial = v_serial + 1 where id = 1;
  end if;
  -- Insert, self-healing if the chosen number is somehow already on the register
  -- (serial / hold / counter drift, e.g. after heavy testing or a reused hold):
  -- advance to the next genuinely-free number and keep the counter ahead, rather
  -- than hard-failing the placement on the unique(serial) constraint.
  loop
    begin
      insert into public.orders (user_id, email, name, address, address2, city, state, zip, variant,
          serial, status, recipient_name, is_gift, billing)
        values (p_user_id, p_email, p_name, p_address, nullif(p_address2,''), p_city, p_state, p_zip,
          p_variant, v_serial, 'placed', nullif(p_recipient,''), coalesce(p_is_gift,false), p_billing);
      return v_serial;
    exception when unique_violation then
      v_tries := v_tries + 1;
      if v_tries > 100 then raise; end if;
      select run_size into v_run from public.allocation_counter where id = 1;
      select greatest(
               coalesce((select max(o.serial) from public.orders o), 0) + 1,
               coalesce((select c.next_serial from public.allocation_counter c where c.id = 1), 1)
             ) into v_serial;
      if v_serial > coalesce(v_run, 15000) then return -1; end if;
      update public.allocation_counter set next_serial = v_serial + 1 where id = 1;
    end;
  end loop;
end; $$;
revoke execute on function public.commission_order(text,text,text,text,text,text,text,text,uuid,text,text,boolean,jsonb) from public, anon, authenticated;

-- Read / set the edition run (admin only; the counter itself stays private).
create or replace function public.get_edition()
returns table (o_next int, o_run int, o_claimed int, o_remaining int)
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_concierge_admin() then raise exception 'not authorized'; end if;
  return query
    select a.next_serial, a.run_size, (a.next_serial - 1), greatest(a.run_size - (a.next_serial - 1), 0)
    from public.allocation_counter a where a.id = 1;
end; $$;
grant execute on function public.get_edition() to authenticated;
revoke execute on function public.get_edition() from public, anon;

create or replace function public.set_edition(p_next_serial int, p_run_size int)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_concierge_admin() then raise exception 'not authorized'; end if;
  if p_run_size is null or p_run_size < 1 then raise exception 'run size must be at least 1'; end if;
  if p_next_serial is null or p_next_serial < 1 then raise exception 'next number must be at least 1'; end if;
  if p_next_serial > p_run_size + 1 then raise exception 'next number cannot exceed run size + 1'; end if;
  update public.allocation_counter set next_serial = p_next_serial, run_size = p_run_size where id = 1;
end; $$;
grant execute on function public.set_edition(int, int) to authenticated;
revoke execute on function public.set_edition(int, int) from public, anon;

-- Cancel a placed order and release its number back to the edition.
create or replace function public.cancel_order_return(p_serial int, p_user_id uuid, p_email text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  select o.id into v_id from public.orders o
   where o.serial = p_serial and (o.user_id = p_user_id or (p_email is not null and o.email = p_email)) for update;
  if v_id is null then return 'no such order on this owner''s register'; end if;
  update public.orders o set status = 'cancelled', cancelled_serial = p_serial, serial = null, cancelled_at = now()
   where o.id = v_id and o.status = 'placed';
  if not found then return 'only ''placed'' orders can be cancelled'; end if;
  insert into public.serial_holds (serial, session_key, expires_at)
    values (p_serial, 'released', now() - interval '1 second')
    on conflict (serial) do update set session_key = 'released', expires_at = now() - interval '1 second';
  return 'ok';
end; $$;
revoke execute on function public.cancel_order_return(int, uuid, text) from public, anon, authenticated;

-- Nearest cached answer above the threshold (pgvector operator qualified).
create or replace function public.match_cached_answer(
  query_embedding extensions.vector(384), match_threshold float default 0.90)
returns table (id uuid, question text, answer_md text, similarity float)
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  select c.id into v_id from public.concierge_cache c where c.enabled
    order by c.embedding operator(extensions.<#>) query_embedding limit 1;
  if v_id is null then return; end if;
  return query update public.concierge_cache c set hits = c.hits + 1, last_hit_at = now()
    where c.id = v_id and (c.embedding operator(extensions.<#>) query_embedding) * -1 >= match_threshold
    returning c.id, c.question, c.answer_md, (c.embedding operator(extensions.<#>) query_embedding) * -1;
end; $$;
revoke execute on function public.match_cached_answer(extensions.vector, float) from public, anon, authenticated;

-- The semantic answer cache memorizes ANSWERS; the knowledge base, the SOPs,
-- and the prompt configuration are their SOURCE. Any edit to a source table
-- invalidates whatever the cache memorized from it — an edited fact must never
-- keep serving its stale cached answer until someone notices. Statement-level:
-- one admin save = one flush; the cache re-warms from live traffic. (Seed
-- statements in this file fire it too — a deploy is also a source change.)
create or replace function public.flush_concierge_cache() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.concierge_cache where true;
  return null;
end; $$;
do $$
declare t text;
begin
  foreach t in array array['concierge_kb','concierge_config','concierge_sops'] loop
    execute format('drop trigger if exists flush_cache on public.%I', t);
    execute format(
      'create trigger flush_cache after insert or update or delete on public.%I for each statement execute function public.flush_concierge_cache()', t);
  end loop;
end $$;

-- Order audit trigger: full row on create, field-level diffs on update.
create or replace function public.log_order_event() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_changes jsonb := '{}'::jsonb; v_key text; v_old jsonb; v_new jsonb;
begin
  if tg_op = 'INSERT' then
    insert into public.order_events (order_id, event, changes) values (new.id, 'created', to_jsonb(new) - 'id');
    return new;
  end if;
  v_old := to_jsonb(old); v_new := to_jsonb(new);
  for v_key in select jsonb_object_keys(v_new) loop
    if (v_old -> v_key) is distinct from (v_new -> v_key) then
      v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_object('old', v_old -> v_key, 'new', v_new -> v_key));
    end if;
  end loop;
  if v_changes <> '{}'::jsonb then
    insert into public.order_events (order_id, event, changes) values (new.id, 'updated', v_changes);
  end if;
  return new;
end; $$;
drop trigger if exists orders_audit on public.orders;
create trigger orders_audit after insert or update on public.orders
  for each row execute function public.log_order_event();

-- Edit-history trigger: snapshot an admin-managed row after every real change, so
-- it can be reviewed and rolled back. One function branches by table. Captures the
-- editing admin from the JWT (service-role writes have none → '(system)').
create or replace function public.log_edit_history() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_entity text; v_ref text; v_snap jsonb; v_changed boolean;
begin
  if tg_table_name = 'concierge_config' then
    v_entity := 'config'; v_ref := new.key; v_snap := new.value;
    v_changed := (tg_op = 'INSERT') or (old.value is distinct from new.value);
  elsif tg_table_name = 'concierge_sops' then
    v_entity := 'sop'; v_ref := new.slug;
    v_snap := jsonb_build_object('title', new.title, 'content_md', new.content_md,
      'enabled', new.enabled, 'sort_order', new.sort_order);
    v_changed := (tg_op = 'INSERT')
      or (old.content_md is distinct from new.content_md)
      or (old.title is distinct from new.title)
      or (old.enabled is distinct from new.enabled);
  elsif tg_table_name = 'concierge_kb' then
    v_entity := 'kb'; v_ref := new.slug;
    v_snap := jsonb_build_object('title', new.title, 'content_md', new.content_md,
      'enabled', new.enabled, 'sort_order', new.sort_order);
    v_changed := (tg_op = 'INSERT')
      or (old.content_md is distinct from new.content_md)
      or (old.title is distinct from new.title)
      or (old.enabled is distinct from new.enabled);
  else
    return new;
  end if;
  if v_changed then
    insert into public.concierge_edit_history (entity, ref, snapshot, edited_by)
    values (v_entity, v_ref, v_snap, coalesce(nullif(auth.jwt() ->> 'email', ''), '(system)'));
  end if;
  return new;
end; $$;
drop trigger if exists config_history on public.concierge_config;
create trigger config_history after insert or update on public.concierge_config
  for each row execute function public.log_edit_history();
drop trigger if exists sops_history on public.concierge_sops;
create trigger sops_history after insert or update on public.concierge_sops
  for each row execute function public.log_edit_history();
drop trigger if exists kb_history on public.concierge_kb;
create trigger kb_history after insert or update on public.concierge_kb
  for each row execute function public.log_edit_history();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3b. AUDIT-SEARCH INDEXES — make the admin surfaces filterable at scale
--     (date range, email, keyword). Keyword/ILIKE needs trigram (pg_trgm).
-- ─────────────────────────────────────────────────────────────────────────────
create extension if not exists pg_trgm with schema extensions;

create index if not exists orders_placed_at_idx on public.orders (placed_at desc);
create index if not exists orders_status_idx on public.orders (status);
create index if not exists orders_email_trgm_idx
  on public.orders using gin (email extensions.gin_trgm_ops);
create index if not exists orders_name_trgm_idx
  on public.orders using gin (name extensions.gin_trgm_ops);
create index if not exists orders_recipient_trgm_idx
  on public.orders using gin (recipient_name extensions.gin_trgm_ops);

create index if not exists concierge_actions_email_idx
  on public.concierge_actions (email, created_at desc);
create index if not exists concierge_actions_email_trgm_idx
  on public.concierge_actions using gin (email extensions.gin_trgm_ops);
create index if not exists concierge_actions_action_trgm_idx
  on public.concierge_actions using gin (action extensions.gin_trgm_ops);
create index if not exists concierge_actions_result_trgm_idx
  on public.concierge_actions using gin (result extensions.gin_trgm_ops);

create index if not exists concierge_conversations_email_idx
  on public.concierge_conversations (user_email, created_at desc);
create index if not exists concierge_conversations_email_trgm_idx
  on public.concierge_conversations using gin (user_email extensions.gin_trgm_ops);

create index if not exists concierge_messages_content_trgm_idx
  on public.concierge_messages using gin (content extensions.gin_trgm_ops);
create index if not exists concierge_messages_created_at_idx
  on public.concierge_messages (created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3c. SHARED RATE LIMITING — DB-backed fixed-window counter so the limit holds
--     across all edge instances (the in-memory Map was per-instance only).
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.rate_limits (
  bucket        text not null,
  window_start  timestamptz not null,
  count         int not null default 0,
  primary key (bucket, window_start)
);
alter table public.rate_limits enable row level security;  -- service-role only

create or replace function public.rate_hit(p_key text, p_limit int, p_window_seconds int)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_secs  int := greatest(coalesce(p_window_seconds, 600), 1);
  v_start timestamptz := to_timestamp(floor(extract(epoch from now()) / v_secs) * v_secs);
  v_count int;
begin
  insert into public.rate_limits (bucket, window_start, count)
    values (p_key, v_start, 1)
    on conflict (bucket, window_start)
      do update set count = public.rate_limits.count + 1
    returning count into v_count;
  delete from public.rate_limits where bucket = p_key and window_start < v_start;
  return v_count > coalesce(p_limit, 20);
end; $$;
revoke execute on function public.rate_hit(text, int, int) from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3d. WAITLIST — captured when sold out (form) or by the concierge; admin-managed
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.waitlist (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  name        text,
  variant    text,
  note        text,
  source      text,
  user_id     uuid,
  created_at  timestamptz not null default now(),
  notified_at timestamptz
);
create index if not exists waitlist_created_idx on public.waitlist (created_at desc);
create index if not exists waitlist_email_idx on public.waitlist (email);
-- keyword search (email/name/note ILIKE) — trigram GIN so the admin filter scales
create index if not exists waitlist_email_trgm_idx on public.waitlist using gin (email extensions.gin_trgm_ops);
create index if not exists waitlist_name_trgm_idx  on public.waitlist using gin (name  extensions.gin_trgm_ops);
create index if not exists waitlist_note_trgm_idx  on public.waitlist using gin (note  extensions.gin_trgm_ops);
alter table public.waitlist enable row level security;
drop policy if exists "admin all waitlist" on public.waitlist;
create policy "admin all waitlist" on public.waitlist
  for all to authenticated
  using (public.is_concierge_admin())
  with check (public.is_concierge_admin());

-- ─────────────────────────────────────────────────────────────────────────────
-- 3d-ii. INQUIRIES — inquiry-mode lead capture. A shopper hands the concierge a
--     serious offer, a viewing request, a question, or a callback (via the
--     make-an-offer / book-a-viewing form or the submit_inquiry tool). Works for
--     ANONYMOUS visitors — inserts arrive through the edge function's service role
--     (RLS below has no anon policy, exactly like waitlist), never a direct client
--     write. Admin-managed: read the list and move each new → contacted → closed.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.concierge_inquiries (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  kind        text not null check (kind in ('offer','viewing','question','callback')),
  name        text,
  email       text,
  phone       text,
  amount      numeric,
  message     text,
  session_key text,
  page_url    text,
  status      text not null default 'new' check (status in ('new','contacted','closed')),
  meta        jsonb not null default '{}'::jsonb
);
create index if not exists concierge_inquiries_created_idx on public.concierge_inquiries (created_at desc);
create index if not exists concierge_inquiries_status_idx on public.concierge_inquiries (status, created_at desc);
-- Rate-limit lookups count a session's recent rows (submit_inquiry, 5/hour).
create index if not exists concierge_inquiries_session_idx on public.concierge_inquiries (session_key, created_at desc);
-- Attribution, mirroring orders. An inquiry is the inquiry-mode CONVERSION EVENT
-- — the analog of the commission-button click — but it is a QUALIFIED LEAD, not a
-- sale (the deal closes off-platform), so these columns feed a COUNT-only lead
-- metric, never revenue. chat_via is always 'concierge': an inquiry is submitted
-- THROUGH the concierge, so it is concierge-attributed by construction. chat_meta
-- carries the session context at capture ({section, turns, origin, captured_at}) —
-- the same shape idea as the commission click's {entry, section, turns}.
alter table public.concierge_inquiries
  add column if not exists chat_via text,
  add column if not exists chat_meta jsonb not null default '{}'::jsonb;
alter table public.concierge_inquiries drop constraint if exists concierge_inquiries_chat_via_check;
alter table public.concierge_inquiries add constraint concierge_inquiries_chat_via_check
  check (chat_via is null or chat_via = 'concierge');
alter table public.concierge_inquiries enable row level security;
-- Mirrors the waitlist policy exactly: authenticated admins get full access; no
-- anon policy at all, so a direct client insert is denied (RLS on, no matching
-- policy). The edge function writes with the service role, which bypasses RLS.
drop policy if exists "admin all inquiries" on public.concierge_inquiries;
create policy "admin all inquiries" on public.concierge_inquiries
  for all to authenticated
  using (public.is_concierge_admin())
  with check (public.is_concierge_admin());

-- ─────────────────────────────────────────────────────────────────────────────
-- 3e. EMAIL LOG — a record of every transactional email sent, for the admin to
--     review and re-send. Written by the edge functions; admin-read.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.email_log (
  id          uuid primary key default gen_random_uuid(),
  to_email    text not null,
  kind        text not null,
  serial      int,
  subject     text,
  ok          boolean not null default false,
  provider_id text,
  error       text,
  created_at  timestamptz not null default now()
);
create index if not exists email_log_serial_idx on public.email_log (serial, created_at desc);
create index if not exists email_log_created_idx on public.email_log (created_at desc);
alter table public.email_log enable row level security;
drop policy if exists "admin read email_log" on public.email_log;
create policy "admin read email_log" on public.email_log
  for select to authenticated
  using (public.is_concierge_admin());

-- ─────────────────────────────────────────────────────────────────────────────
-- 3f. RETENTION — bound the high-write tables' growth (SCALING.md #2). Deleting
--     old conversations cascades to their messages/feedback; actions, email_log,
--     and stale rate-limit rows prune by their own timestamps. Schedule with
--     pg_cron (see the commented example) or a scheduled job.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.prune_high_write(p_days int default 180)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  cutoff   timestamptz := now() - make_interval(days => greatest(coalesce(p_days, 180), 1));
  c_convos bigint; c_actions bigint; c_email bigint; c_rate bigint; c_events bigint;
begin
  delete from public.concierge_conversations where created_at < cutoff;
  get diagnostics c_convos = row_count;
  delete from public.concierge_actions where created_at < cutoff;
  get diagnostics c_actions = row_count;
  delete from public.email_log where created_at < cutoff;
  get diagnostics c_email = row_count;
  delete from public.site_events where created_at < cutoff;
  get diagnostics c_events = row_count;
  delete from public.rate_limits where window_start < now() - interval '2 hours';
  get diagnostics c_rate = row_count;
  return jsonb_build_object('cutoff', cutoff, 'conversations_deleted', c_convos,
    'actions_deleted', c_actions, 'email_log_deleted', c_email,
    'site_events_deleted', c_events, 'rate_limits_deleted', c_rate);
end $$;
revoke execute on function public.prune_high_write(int) from public, anon, authenticated;
-- Nightly with pg_cron (enable the extension first), uncomment:
--   select cron.schedule('prune-high-write', '0 3 * * *', $$select public.prune_high_write(180)$$);

-- ─── Coach feedback loop — the "what's actually working" digest ───────────────
-- Closes the loop for the sales-strategist coach (COACH.md): it lets the coach
-- reason over OUTCOMES the drafter never sees. For every proactive beat that
-- SPOKE (a beat_action row, payload.outcome='spoke'), did the shopper answer —
-- a user turn in the same conversation within 30 min? We bucket that reply rate
-- by beat kind + move over a trailing window, so the coach can bias toward what
-- is landing for THIS house rather than theory. Self-caching into
-- concierge_insights so the hot path reads one row; it recomputes only past the
-- TTL. Honest about thin data: buckets under p_min_n are dropped, and a quiet
-- house simply returns few or none (the coach then falls back to method-only).
create table if not exists public.concierge_insights (
  kind text primary key,
  payload jsonb not null,
  computed_at timestamptz not null default now());
alter table public.concierge_insights enable row level security;
-- No policy: reachable only through the security-definer function below (service
-- role / definer bypasses RLS); direct anon/authenticated reads are denied.

create or replace function public.beat_learning_digest(
  p_days int default 14, p_ttl_min int default 20, p_min_n int default 3)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_row     public.concierge_insights;
  v_days    int := greatest(coalesce(p_days, 14), 1);
  v_ttl     int := greatest(coalesce(p_ttl_min, 20), 1);
  v_min     int := greatest(coalesce(p_min_n, 3), 1);
  v_payload jsonb;
begin
  -- Serve the cached digest while it is fresh.
  select * into v_row from public.concierge_insights where kind = 'beat_learning';
  if found and v_row.computed_at > now() - make_interval(mins => v_ttl) then
    return v_row.payload;
  end if;

  with spoke as (
    select a.conversation_id, a.created_at,
           coalesce(nullif(a.payload->>'beat', ''), 'other')   as beat,
           coalesce(nullif(a.payload->>'action', ''), 'other') as move
    from public.concierge_actions a
    where a.action = 'beat_action'
      and a.payload->>'outcome' = 'spoke'
      and a.created_at > now() - make_interval(days => v_days)
  ),
  scored as (
    select s.beat, s.move,
      exists (
        select 1 from public.concierge_messages m
        where m.conversation_id = s.conversation_id
          and m.role = 'user'
          and m.created_at >  s.created_at
          and m.created_at <  s.created_at + interval '30 minutes'
      ) as answered
    from spoke s
  ),
  agg as (
    select beat, move, count(*) as n, count(*) filter (where answered) as answered
    from scored group by beat, move
  )
  select jsonb_build_object(
    'window_days', v_days,
    'total_spoke', coalesce((select count(*) from scored), 0),
    'buckets', coalesce((
      select jsonb_agg(jsonb_build_object(
               'beat', beat, 'move', move, 'n', n,
               'reply_rate', round((answered::numeric / n), 2))
             order by (answered::numeric / n) desc, n desc)
      from agg where n >= v_min), '[]'::jsonb)
  ) into v_payload;

  insert into public.concierge_insights (kind, payload, computed_at)
  values ('beat_learning', v_payload, now())
  on conflict (kind) do update
    set payload = excluded.payload, computed_at = excluded.computed_at;

  return v_payload;
end $$;
revoke execute on function public.beat_learning_digest(int, int, int) from public, anon, authenticated;

-- ─── NPS — closed-loop feedback capture ──────────────────────────────────────
-- The survey is a beat (see NPS.md + beats.ts npsTriggerGate); this is its data
-- model + the dashboard/aggregate calculation. Deliberately dormant until the
-- REQUEST_NPS beat + submit_nps tool are wired — the tables and the math ship
-- first so the design is testable and the schema is canonical.
--
-- One row per submitted rating. customer_id is nullable (anonymous ratings are
-- allowed, like inquiries); coach_id names whoever/whatever ran the session
-- (the concierge instance, or a human agent). segment is DERIVED, never stored
-- loose. categories is [{slug, confidence}] set by the LLM classifier (or a
-- human via re-categorisation).
create table if not exists public.nps_responses (
  id              bigint generated always as identity primary key,
  conversation_id uuid references public.concierge_conversations(id) on delete set null,
  customer_id     uuid,
  coach_id        text,
  score           smallint not null check (score between 0 and 10),
  segment         text generated always as (
                    case when score >= 9 then 'promoter'
                         when score >= 7 then 'passive'
                         else 'detractor' end) stored,
  reason_text     text,
  categories      jsonb not null default '[]'::jsonb,
  category_source text not null default 'llm' check (category_source in ('llm','human')),
  response_time_seconds int,
  survey_version  text,
  created_at      timestamptz not null default now());
create index if not exists nps_responses_customer_idx on public.nps_responses (customer_id, created_at desc);
create index if not exists nps_responses_created_idx  on public.nps_responses (created_at desc);
alter table public.nps_responses enable row level security;
-- Admin-read only; writes go through the service role / the submit_nps tool.
-- Customers do NOT read their own NPS (out of scope) — and the concierge never
-- quotes a score back regardless (the reach-out judge + renderCustomerNps guard).
drop policy if exists nps_responses_admin_read on public.nps_responses;
create policy nps_responses_admin_read on public.nps_responses
  for select using (public.is_concierge_admin());

-- Admin-managed classification vocabulary. detractor_focus flags the actionable
-- "why unhappy" themes the coach + dashboards emphasise. prompt_hint steers the
-- LLM classifier (the same config-over-code pattern as goals/hooks).
create table if not exists public.nps_categories (
  slug            text primary key,
  label           text not null,
  prompt_hint     text not null default '',
  detractor_focus boolean not null default false,
  enabled         boolean not null default true,
  sort            int not null default 100);
alter table public.nps_categories enable row level security;
drop policy if exists nps_categories_admin_all on public.nps_categories;
create policy nps_categories_admin_all on public.nps_categories
  for all using (public.is_concierge_admin()) with check (public.is_concierge_admin());

-- Seed a detractor-forward starter vocabulary (only when empty — never clobbers
-- an operator's edits).
insert into public.nps_categories (slug, label, prompt_hint, detractor_focus, sort) values
  ('scheduling',    'Scheduling & availability',   'booking difficulty, timing, flexibility, delays, waiting', true,  10),
  ('communication', 'Communication & responsiveness','slow or unclear replies, not kept informed, felt ignored', true,  20),
  ('value',         'Value & price',                'felt too expensive, unclear worth, cost concerns',        true,  30),
  ('expectations',  'Expectations mismatch',        'over-promised / under-delivered, surprised, misled',      true,  40),
  ('outcome',       'Outcome & results',            'did or did not get the result they wanted',               true,  50),
  ('guidance',      'Expertise & guidance',         'quality of advice, competence, helpfulness',              true,  60),
  ('experience',    'Overall experience & warmth',  'felt cared for vs. rushed / impersonal',                  false, 70),
  ('product',       'Product & selection',          'the item itself, range, quality',                         false, 80),
  ('praise',        'General praise',               'loved it, enthusiastic, no specific issue',               false, 90),
  ('other',         'Other / unclear',              'does not fit any category above',                         false, 999)
on conflict (slug) do nothing;

-- The dashboard + aggregate calculation (mirrors the pure npsScore in beats.ts):
-- overall NPS (%promoters − %detractors), the segment split, and the theme
-- frequencies — with the DETRACTOR themes broken out, since that is the
-- actionable signal. Optionally scoped to one coach. Live-computed over a
-- window (indexed); cache with concierge_insights if it ever gets hot.
create or replace function public.nps_metrics(p_days int default 30, p_coach text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_days int := greatest(coalesce(p_days, 30), 1);
  v jsonb;
begin
  -- Callable by the admin studio (JWT must be a concierge admin) and by the
  -- edge function (service role) — the get_edition() guard pattern. Aggregate
  -- only; never exposes an individual row.
  if not (public.is_concierge_admin()
          or coalesce((select auth.jwt()->>'role'), '') = 'service_role') then
    raise exception 'not authorized';
  end if;
  with resp as (
    select r.score, r.segment, r.categories
    from public.nps_responses r
    where r.created_at > now() - make_interval(days => v_days)
      and (p_coach is null or r.coach_id = p_coach)
  ),
  seg as (
    select count(*) filter (where segment = 'promoter')  as prom,
           count(*) filter (where segment = 'passive')   as pass,
           count(*) filter (where segment = 'detractor') as det,
           count(*) as n
    from resp
  ),
  cats as (
    select c->>'slug' as slug,
           count(*) as n,
           count(*) filter (where segment = 'detractor') as det_n
    from resp, lateral jsonb_array_elements(coalesce(categories, '[]'::jsonb)) c
    where nullif(c->>'slug', '') is not null
    group by 1
  )
  select jsonb_build_object(
    'window_days', v_days,
    'coach', p_coach,
    'responses',  (select n from seg),
    'nps', case when (select n from seg) > 0
                then round(((select prom from seg) - (select det from seg))::numeric
                           / (select n from seg) * 100)
                else null end,
    'promoters',  (select prom from seg),
    'passives',   (select pass from seg),
    'detractors', (select det from seg),
    'themes', coalesce((
      select jsonb_agg(jsonb_build_object('slug', slug, 'n', n) order by n desc, slug)
      from cats), '[]'::jsonb),
    'detractor_themes', coalesce((
      select jsonb_agg(jsonb_build_object('slug', slug, 'n', det_n) order by det_n desc, slug)
      from cats where det_n > 0), '[]'::jsonb)
  ) into v;
  return v;
end $$;
grant execute on function public.nps_metrics(int, text) to authenticated;
revoke execute on function public.nps_metrics(int, text) from public, anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. SEED DATA (admins, config, KB, SOPs, forms, goals) — safe to re-run
-- ─────────────────────────────────────────────────────────────────────────────

-- IMPORTANT: change this to YOUR admin email.
insert into public.concierge_admins (email, is_super) values ('mberenji@gmail.com', true)
  on conflict (email) do update set is_super = true;

insert into public.concierge_config (key, value) values
  ('enabled','false'::jsonb),   -- MASTER OFF — everything ships as a draft; enable after review.
  ('model',to_jsonb($cfg$claude-haiku-4-5-20251001$cfg$::text)),
  ('model_fallback',to_jsonb($cfg$claude-haiku-4-5-20251001$cfg$::text)),
  ('max_tokens','1024'::jsonb),
  ('greeting',to_jsonb($cfg$Good evening — I keep the desk for 2003 Porsche 911 Turbo. Ask me anything about the car; I'll answer straight from the record.

{{reply:Tell me about the history}}
{{reply:What's the price?}}
{{reply:Just looking}}$cfg$::text)),
  ('voice_notes',to_jsonb($cfg$$cfg$::text)),
  ('inquiry_notify_email',to_jsonb($cfg$mberenji@gmail.com$cfg$::text)),   -- Where a submitted offer / viewing / callback is emailed. Editable in the Studio — point it at whatever inbox should receive leads.
  ('assertiveness','3'::jsonb),   -- warm consultant (1 restrained .. 5 closer)
  ('hooks',$cfg$[
  "Zanzibar Red (L1A8) · Factory Special Color 00501 · Tiptronic S · McKinney, TX",
  "Serious offers considered — PPI welcome and encouraged",
  "21 photos — click any image to open the full viewer. The shot at the top captures the color perfectly at golden sunset. Swipe or use arrow keys to navigate.",
  "Every visit to RAC Performance (RUF Auto Centre) in Carrollton, TX is backed by an itemized invoice with OEM Porsche part numbers. This is not a car that was deferred — it was driven by someone who maintained it properly.",
  "Zanzibar Red (L1A8) was a factory Sonderfarbe — an upcharge Special Color ordered in Zuffenhausen. It contains deep copper and burgundy undertones that read completely differently at noon, golden hour, and dusk."
]$cfg$::jsonb),   -- true, house-approved selling angles — every line traces to a scanned fact
  ('objections',$cfg$[
  {
    "trigger": "the price",
    "response": "A fair thing to weigh. The listed number is $59,900; give ONE true piece of context from KNOWLEDGE, no more. The price is firm and you never negotiate or hint at a floor — but a serious buyer is welcome to make an offer the owner will see: present {{form:make-an-offer}} on its own line and let them enter it. The owner follows up directly; you never counter or discuss a number yourself."
  },
  {
    "trigger": "condition / reliability worries",
    "response": "Point to the documented history in KNOWLEDGE — records, dates, figures — and offer the honest next step: a viewing or pre-purchase inspection. Never promise future condition."
  }
]$cfg$::jsonb)
on conflict (key) do nothing;

-- KB, SOPs, forms, and goals seed only if the table is empty, so your edits in
-- the Studio are never overwritten by re-running this file. To reset any of
-- them, delete the rows first, then re-run.

-- Goals: seed only if the table is empty, so Studio edits are never
-- overwritten by re-running this file. DRAFTS-FIRST: every goal seeds
-- enabled=false; the owner reviews and enables them in the Studio.
insert into public.concierge_goals (slug, label, description, enabled, sort_order, section, sections)
select * from (values
  ('welcome-and-read','Welcome & read the visitor','Greet warmly, read what brought them to the car, and open ONE genuine door — never an interrogation.',false,10,'hero',array['hero']::text[]),
  ('discover-their-situation','Discover their situation','Learn who the car is for and what role it would play, before recommending anything.',false,20,'every-angle-every-light',array['every-angle-every-light']::text[]),
  ('match-to-their-need','Match the facts to their need','Translate the documented facts into what matters for THIS visitor — never a spec dump.',false,30,'what-makes-it-special',array['what-makes-it-special']::text[]),
  ('settle-doubts-honestly','Settle doubts honestly','Meet hesitations with the documented record only; never promise beyond it.',false,40,'sec-20-407-invested-all-documented',array['sec-20-407-invested-all-documented']::text[]),
  ('invite-the-inquiry','Invite the inquiry','When genuine interest shows, propose the concrete next step: a note to mberenji@gmail.com, a viewing, or an inspection.',false,50,'serious-buyers-get-serious-answers',array['serious-buyers-get-serious-answers']::text[])
) as v(slug,label,description,enabled,sort_order,section,sections)
where not exists (select 1 from public.concierge_goals);

-- The full knowledge base, SOPs, and forms follow — so this ONE file stands
-- alone as a complete, runnable setup. Each block seeds only if its table is
-- empty; your Studio edits are never overwritten by re-running this file.

-- Knowledge base (12 sections), generated from the adopted site: seed only when
-- the table is empty, so Studio edits are never overwritten by re-running this
-- file. DRAFTS-FIRST: every section seeds enabled=false — the owner reviews
-- each one in the Studio and enables it deliberately. To reset, delete the
-- rows then re-run.
do $seed$
begin
  if not exists (select 1 from public.concierge_kb) then

insert into public.concierge_kb (slug, title, content_md, enabled, sort_order) values

('hero', '2003 Porsche 911 Turbo', $kb$- Zanzibar Red (L1A8) · Factory Special Color 00501 · Tiptronic S · McKinney, TX$kb$, false, 10),

('asking-price', 'Asking Price', $kb$- Serious offers considered — PPI welcome and encouraged
- Copied!: $59,900$kb$, false, 20),

('every-angle-every-light', 'Every Angle, Every Light', $kb$- 21 photos — click any image to open the full viewer. The shot at the top captures the color perfectly at golden sunset. Swipe or use arrow keys to navigate.
- The Color at Golden Hour: Zanzibar Red in Perfect Light$kb$, false, 30),

('sec-20-407-invested-all-documented', '$20,407 Invested. All Documented.', $kb$- Every visit to RAC Performance (RUF Auto Centre) in Carrollton, TX is backed by an itemized invoice with OEM Porsche part numbers. This is not a car that was deferred — it was driven by someone who maintained it properly.
- Every corner. New B4 rear struts, front strut mounts, bearings, bellows, both trailing arms, both lower control arms — fresh four-wheel alignment. The car drives on new suspension geometry.
- Factory-spec green-tint glass with integrated rain sensor, antenna, solar coating, and electrochromic mirror. Properly installed with OEM seal and molding. Insurance-covered rock damage claim.
- ATF pan dropped, new filter installed, full fresh fluid refill. The Tiptronic S is serviced and shifting cleanly — new shifter cables installed as well. This transmission is properly maintained.
- One of the most labor-intensive repairs on a 996 — requires significant disassembly of the dashboard. It's been done, with a new OEM heater core. The system works correctly.
- Consistent Mobil 1 5W-40 full-synthetic oil changes with OEM filters at RAC Performance. The Mezger engine runs on the correct fluid, changed on schedule, every time.
- Every invoice has itemized OEM Porsche part numbers, labor line items, mileage stamps, and dated service records. Nothing is claimed without documentation to back it up.
- Factory Windshield Seal (OEM Part 996 541 531 01)
- Oil Change — Mobil 1 5W-40: OEM Oil Filter (996 107 225 53)
- Hood Latch (New OEM): Hood Actuator (New OEM)
- Heater Core (New OEM): Brake Booster Vacuum Hose (New OEM)
- Oil Pressure Sender (New OEM): License Plate Bulbs (Complimentary)
- 4-Wheel Alignment (Fresh): Oil Change — Mobil 1 5W-40: OEM Oil Filter$kb$, false, 40),

('a-color-that-shifts-with-the-light', 'A Color That Shifts With The Light', $kb$- — an upcharge Special Color ordered in Zuffenhausen. It contains deep copper and burgundy undertones that read completely differently at noon, golden hour, and dusk.
- Zanzibar Red was a Sonderfarbe available across the Porsche lineup but extraordinarily rare when ordered on the 996 Turbo. The build-sheet option code 00501 confirms it was applied at the factory — never resprayed, never touched. The color reads as factory-fresh because it is.
- Searches spanning Bring a Trailer, PCarMarket, Classic.com, Rennbow, ElferSpot, and Porsche enthusiast forums have found no other Zanzibar Red 996 Turbo Tiptronic in US specification. Factory
- Porsche’s bespoke-color program is now one of the most coveted options in the catalog. Ordered through Porsche Exclusive Manufaktur, Paint to Sample adds $12,830 to a new 911 Turbo — and for a color outside the catalog, up to $25,660 plus a factory feasibility study that can run eleven months. Buyers pay it gladly, because special-color Porsches occupy a different tier of the market: they are the cars collectors search for by name, and the ones that draw the crowd at auction.
- — “color of choice.” There was no waitlist and no hashtag. It was simply an expensive box almost nobody ticked, requiring a buyer who knew exactly what they wanted and a factory willing to paint one
- The paint isn’t a feature of this car. It’s the reason there is likely only one.
- Golden Sunset: The color at its most cinematic
- Midday Sun: Fiery orange-red, impossible to miss
- Blue Dusk: Deep complex red against cool sky
- $12,830: Paint to Sample upcharge on a new 911 Turbo
- 11 Months: Factory feasibility study for a non-catalog color
- 00501: The special-color option on this build sheet$kb$, false, 50),

('what-makes-it-special', 'What Makes It Special', $kb$- Zero other Zanzibar Red 996 Turbo Tiptronics have appeared in any US auction archive, registry, or marketplace after extensive research. Factory code 00501 is on the build sheet.
- GT1 Le Mans-derived 3.6L twin-turbo flat-six. No IMS bearing. No intermediate shaft. The same block architecture as the GT3 and GT2 of the era — legendary for durability at high mileage.
- Original Mezger engine, original Tiptronic, factory paint. VIN-verifiable. Not rebuilt, not re-skinned, not a color change. Exactly as it left Zuffenhausen in 2003.
- Seven itemized service visits at RAC Performance (RUF Auto Centre), a Porsche specialist in Carrollton, TX. Every invoice, every OEM part number, available to serious buyers.
- Garage-kept, regularly driven, consistently maintained by someone who understood what they had. The paint, interior, and mechanicals all reflect that level of care.
- XPEL’s highest-tier ceramic tint, all glass. 98% infrared heat rejection, 99% UV block rated SPF 1000. Non-conductive nano-ceramic film — no interference with GPS, radar, or Bluetooth. Professional installation, full vehicle coverage.
- Sony’s flagship Mobile ES receiver. 6.75″ 1280×720 touchscreen, 24-bit/192kHz DSP across 6 addressable channels, native FLAC and DSD playback, LDAC Bluetooth for lossless wireless audio. Wireless Apple CarPlay and Android Auto.
- Option #408: 18-inch hollow-spoke Turbo Twist wheels, manufactured by BBS. Specific to the 996 Turbo, among the lightest 18-inch wheels Porsche ever offered, and among the rarest. Complete sets trade at $4,000+ when they surface at all.
- The Tiptronic S fitted here carries a Mercedes-Benz 722.6 (W5A580) — the same transmission Mercedes-AMG trusted behind the supercharged V8s of the E55 AMG and S55 AMG, cars that
- Porsche knew the standard ZF unit used in base Carreras could not handle the twin-turbocharged Mezger’s torque, so the Turbo received the Mercedes 722.6 instead — notoriously over-engineered, with
- Porsche built approximately 3,700 examples of the 996 Turbo worldwide in 2003. A fraction were Tiptronics. A smaller fraction were ordered in factory Special Colors. Of those, Zanzibar Red was among the rarest choices — a complex, light-shifting color that required a factory surcharge.
- After searching Bring a Trailer, PCarMarket, Classic.com, Rennbow, ElferSpot, and every major Porsche enthusiast community,
- This car may genuinely not exist anywhere else.
- MB 722.6: Transmission Unit
- 415 lb-ft: Torque Capacity
- Lockup: Direct Drive Above 50 mph
- 0 Clutch: Wear Components
- 1: Known US-Spec Zanzibar Red 996 Turbo Tip$kb$, false, 60),

('the-details', 'The Details', $kb$- Year: 2003
- Make / Model: Porsche 911 Turbo (996)
- VIN: WP0AB29983S687118
- Exterior Color: Zanzibar Red (L1A8)
- Factory Color Code: 00501 — Special Color
- Interior: Black Full Leather
- Mileage: ~94,600
- Title: Clean — Texas
- Accident History: None on record
- Location: McKinney, TX
- Engine: 3.6L Twin-Turbo Flat-6 (Mezger)
- Horsepower: 420 hp
- Torque: 415 lb-ft @ 2,700 rpm
- Transmission: 5-speed Tiptronic S
- Drivetrain: All-Wheel Drive
- 0–60 mph: ~4.0 seconds
- Top Speed: 189 mph
- IMS Risk: None — Mezger block
- Seats: Sport seats, painted backs
- Heated Seats: Yes
- Sunroof: Electric steel
- Headlights: Xenon (Litronic)
- Stability Control: PSM
- Audio: Bose Premium Sound
- Wheels: 18" Factory Turbo 5-Spoke
- Tires: Continental SportPlus
- Brake Calipers: Factory Porsche red
- Windshield: New OEM (2025) — rain sensor, solar tint
- Last Oil Change: May 2026 (Mobil 1)
- Last Alignment: May 2026
- Suspension: Fully rebuilt Mar 2025
- Transmission: ATF service Mar 2025
- Brakes: Flushed Mar 2025
- Heater Core: New Nov 2025
- Accidents: None reported
- Service Records: All 7 invoices available
- PPI: Welcome — encouraged
- Asking Price: $59,900$kb$, false, 70),

('clean-record', 'Clean Record', $kb$- · VIN WP0AB29983S687118$kb$, false, 80),

('the-mezger-sound', 'The Mezger Sound', $kb$- 420 hp, twin sequential turbos, 3.6-litre flat-six. Turn up the volume.$kb$, false, 90),

('interior-trim-condition', 'Interior Trim Condition', $kb$- The mechanicals and paint are correct. The interior soft-touch plastic is not perfect. The factory soft-coat on several panels has broken down — a known issue on every 996 after two decades — leaving
- Significant scratch marks in the soft-touch surface. Used OEM panels are readily available and a straightforward swap.
- Soft-coat crazing on the switch surround — the classic 996 plastic issue. Cosmetic only; the switch works perfectly.
- Factory soft-coat breaking down, leaving white residue. Every function works; replacement surrounds are inexpensive.
- Same soft-coat wear as the left side. PSM and seat heat switches all function as they should.
- Soft-coat wear around the dash vent. Known issue on every 996 after two decades — used OEM pieces are cheap.
- Honest wear around the key from 23 years of starts. Purely cosmetic — replacement trim is available.
- The full context shot — nothing hidden. Everything you see is documented in the photos above.$kb$, false, 100),

('serious-buyers-get-serious-answers', 'Serious Buyers Get Serious Answers', $kb$- All seven service invoices are available to qualified buyers. Pre-purchase inspections are welcome and encouraged. Cars in this exact configuration don’t come up — when they do, they don’t last.
- VIN, paint code, and all service documentation are verifiable. Located in McKinney, TX. Happy to work with transport brokers for out-of-state buyers. PPI at a local Porsche specialist can be arranged.$kb$, false, 110),

('photos-and-documents', 'Photos & documents the concierge may show', $kb$Show at most ONE image per reply, as a bare {{img:token}} line, and only when it genuinely serves the question ("may I see the interior" → an interior token; "proof of the options" → the option sticker). Never invent tokens beyond this list.
- {{img:samsung-frame-tv-image-1}} — Zanzibar Red at golden sunset — cinematic side profile
- {{img:full-side-profile-spring-roses}} — Full side profile — spring roses background
- {{img:front-3-4-midday-sun}} — Front 3/4 — midday sun
- {{img:side-profile-garage-blue-dusk}} — Side profile — garage, blue dusk
- {{img:rear-3-4-clean}} — Rear 3/4 — clean
- {{img:rear-turbo-script}} — Rear — Turbo script
- {{img:side-profile-dusk}} — Side profile — dusk
- {{img:wheel-red-porsche-caliper}} — Wheel — red Porsche caliper
- {{img:fender-roses}} — Fender + roses
- {{img:interior-black-leather}} — Interior — black leather
- {{img:side-profile-home}} — Side profile — home
- {{img:interior-steering}} — 996 Turbo cockpit — Porsche crest steering wheel
- {{img:interior-gauges}} — Gauge cluster — 94,702 miles documented
- {{img:front-3-4-parking-lot}} — Front 3/4 — parking lot
- {{img:rear-3-4-parking-lot}} — Rear 3/4 — parking lot
- {{img:front-overhead-door-open}} — Front overhead — door open
- {{img:option-sticker}} — Factory option sticker
- {{img:spring-roses-alt-angle}} — Spring roses — alt angle
- {{img:interior-door-open}} — Interior — door open
- {{img:interior-detail}} — Interior detail
- {{img:trim-door-panel}} — Driver door panel scratches
- {{img:trim-mirror-control}} — Mirror control trim cracking
- {{img:trim-switch-left}} — Switch panel soft-coat
- {{img:trim-switch-right}} — PSM panel soft-coat
- {{img:trim-vent-dash}} — Dash vent area soft-coat
- {{img:trim-ignition-surround}} — Ignition surround wear
- {{img:trim-console-overview}} — Center console overview
- {{img:document-screenshot}} — a screenshot provided by the seller
No file for the service receipts / invoices ships with this page: say it is available on request via mberenji@gmail.com — NEVER claim to have it or offer to show it.
No file for the CARFAX / vehicle history report ships with this page: say it is available on request via mberenji@gmail.com — NEVER claim to have it or offer to show it.$kb$, false, 120);

  end if;
end $seed$;

-- Standard operating procedures, generated for the adopted brand: seed only
-- when the table is empty, so Studio edits are never overwritten by re-running
-- this file. DRAFTS-FIRST: every procedure seeds enabled=false. (The engine
-- file's historical SOP migrations and the stale voice_base guard are dropped
-- here on purpose: a fresh stamped install seeds its FINAL state directly and
-- has no pre-retune history to reconcile.)
do $seed$
begin
  if not exists (select 1 from public.concierge_sops) then

insert into public.concierge_sops (slug, title, content_md, enabled, sort_order, audience) values

('price-question', 'A price question', $sop$1. State the listed price plainly: **$59,900**.
2. Add at most ONE true piece of context from KNOWLEDGE, chosen by what they've told you.
3. Do not apologize for it, stack justifications, or hint at flexibility.
4. The price is firm — you never negotiate, counter, or name a floor.
5. If they float an offer or ask whether it's negotiable: don't discuss a number yourself. Present **{{form:make-an-offer}}** on its own line so they can enter a serious offer; it reaches the owner, who follows up directly.$sop$, false, 10, 'all'),

('serious-offers', 'A serious offer or a buyer ready to proceed', $sop$The car is priced firm at **$59,900**. You never haggle, split the difference, or suggest the owner might take less.
1. When a shopper signals a real offer, or is ready to move, acknowledge plainly — no ceremony.
2. CAPTURE IT PROPERLY. Hand them the form on its own line — **{{form:make-an-offer}}** for an offer, **{{form:book-a-viewing}}** for a viewing or pre-purchase inspection — so they enter their own details. The inquiry is stored and the owner is emailed; no account is needed.
3. If a form is unavailable, you may take their name and contact in chat and record it with submit_inquiry (kind = offer / viewing / question / callback).
4. Offer to summarize, in one short block they can keep, the facts they cared about.
5. Close warmly and stop selling once the details are captured.$sop$, false, 20, 'all'),

('viewing-logistics', 'Viewing / PPI logistics', $sop$The page does not publish specific viewing or handover times and places. NEVER invent them.
1. Say what is true: viewings and pre-purchase inspections are arranged directly with the owner, and a PPI is welcome and encouraged.
2. Capture the request with **{{form:book-a-viewing}}** so the owner can reach them; if the form is unavailable, take the details in chat and record them with submit_inquiry (kind = viewing).
3. Record the interest in the client book.$sop$, false, 30, 'all'),

('unknown-fact', 'Asked something not in KNOWLEDGE', $sop$1. Say plainly you don't have that on file — one sentence, no apology theater.
2. If they'd like the owner to follow up, take a name and contact in chat and record it with submit_inquiry (kind = question or callback); the owner is emailed. Reserve the forms for actual offers ({{form:make-an-offer}}) and viewings ({{form:book-a-viewing}}).
3. Answer the nearest question you CAN answer from KNOWLEDGE, if one exists.
4. Never guess, estimate, or extrapolate a fact that is not written down.$sop$, false, 40, 'all');

  end if;
end $seed$;

-- Voice handoff: this listing has a dedicated AI voice concierge phone line.
-- Seed the fact (KB) and the handoff procedure (SOP) IDEMPOTENTLY (by slug) so
-- they land even on an already-seeded database. DRAFTS-FIRST: both seed
-- enabled=false — the owner reviews and enables them in the Studio. Honesty is
-- preserved: the copy states plainly it is an AI line, not the owner, and does
-- not let the phone replace the offer/viewing forms.
insert into public.concierge_kb (slug, title, content_md, enabled, sort_order) values
('phone-voice-concierge', 'Call & talk — AI voice concierge',
 $kb$- Prefer to talk it through? Call the AI voice concierge for this car: **+1 (424) 799-1987**.
- It is an AI voice line (not the owner) that answers questions about this 2003 911 Turbo by phone. For a serious offer, a viewing, or a PPI, use the forms so the owner is emailed and follows up directly.$kb$,
 false, 25)
on conflict (slug) do nothing;

insert into public.concierge_sops (slug, title, content_md, enabled, sort_order, audience) values
('voice-handoff', 'Shopper wants to talk / prefers a call',
 $sop$Use when a shopper asks to speak to someone, prefers voice, has a lot of back-and-forth questions, or is on mobile and would rather talk than type.
1. Offer the line plainly: **+1 (424) 799-1987** — say it is an AI voice concierge for this car that answers questions by phone. Be honest that it is not the owner.
2. Keep it optional. They are welcome to keep asking here; do not push them off-chat.
3. For an actual offer or a viewing/PPI, still capture it with **{{form:make-an-offer}}** or **{{form:book-a-viewing}}** so the owner is emailed — the phone line does not replace those.
4. Never imply the number reaches the owner directly, or that the call can close a sale or negotiate price; it answers questions about the car.$sop$,
 false, 25, 'all')
on conflict (slug) do nothing;

-- Register forms: seed only when the table is empty. DRAFTS-FIRST: enabled=false
-- (and in inquiry mode there are no orders for the form to act on anyway); the
-- engine never emits a {{form:…}} token for a disabled form, so this is inert
-- until the owner enables it.
do $seed$
begin
  if not exists (select 1 from public.concierge_forms) then

insert into public.concierge_forms (slug, title, submit_tool, fields, enabled) values
('address-change', 'New shipping address', 'update_shipping_address', $frm$[
  {
    "name": "address",
    "label": "Street address",
    "type": "text",
    "required": true,
    "maxlength": 120,
    "autocomplete": "address-line1"
  },
  {
    "name": "address2",
    "label": "Apt, suite — if needed",
    "type": "text",
    "required": false,
    "maxlength": 120,
    "autocomplete": "address-line2"
  },
  {
    "name": "city",
    "label": "City",
    "type": "text",
    "required": true,
    "maxlength": 80,
    "autocomplete": "address-level2"
  },
  {
    "name": "state",
    "label": "State",
    "type": "state",
    "required": true
  },
  {
    "name": "zip",
    "label": "ZIP",
    "type": "zip",
    "required": true,
    "autocomplete": "postal-code"
  }
]$frm$::jsonb, false),
('make-an-offer', 'Make an offer', 'submit_inquiry', $frm$[
  {
    "name": "kind",
    "type": "hidden",
    "value": "offer"
  },
  {
    "name": "name",
    "label": "Your name",
    "type": "text",
    "required": true,
    "maxlength": 120,
    "autocomplete": "name"
  },
  {
    "name": "email",
    "label": "Email",
    "type": "text",
    "required": true,
    "maxlength": 200,
    "autocomplete": "email"
  },
  {
    "name": "phone",
    "label": "Phone — if you prefer a call",
    "type": "text",
    "required": false,
    "maxlength": 40,
    "autocomplete": "tel"
  },
  {
    "name": "amount",
    "label": "Your offer (USD)",
    "type": "text",
    "required": true,
    "maxlength": 20,
    "inputmode": "numeric"
  },
  {
    "name": "message",
    "label": "Anything to add",
    "type": "text",
    "required": false,
    "maxlength": 600
  }
]$frm$::jsonb, false),
('book-a-viewing', 'Book a viewing or PPI', 'submit_inquiry', $frm$[
  {
    "name": "kind",
    "type": "hidden",
    "value": "viewing"
  },
  {
    "name": "name",
    "label": "Your name",
    "type": "text",
    "required": true,
    "maxlength": 120,
    "autocomplete": "name"
  },
  {
    "name": "email",
    "label": "Email",
    "type": "text",
    "required": true,
    "maxlength": 200,
    "autocomplete": "email"
  },
  {
    "name": "phone",
    "label": "Phone",
    "type": "text",
    "required": false,
    "maxlength": 40,
    "autocomplete": "tel"
  },
  {
    "name": "message",
    "label": "Preferred day & how to reach you — viewings and PPIs arranged with the owner",
    "type": "text",
    "required": false,
    "maxlength": 600
  }
]$frm$::jsonb, false);

  end if;
end $seed$;

-- Inquiry-mode lead-capture forms (make-an-offer / book-a-viewing, both bound
-- to submit_inquiry, drafts-first enabled=false) are emitted from the generated
-- forms seed above. A fresh stamped install seeds its final state directly, so
-- the engine's separate "land in an already-populated database" insert is
-- dropped here — its copy would be the engine brand's, not the stamped brand's.

-- Behavior-eval scenarios (studio Evals tab): seed only if empty. These seed
-- enabled=TRUE — the evals are the safety net that runs BEFORE the owner
-- switches anything on, so they are the one seed that is not a draft.
do $seed$
begin
  if not exists (select 1 from public.concierge_evals) then

insert into public.concierge_evals (slug, name, description, signed_in, context, turns, enabled, sort_order) values

('price-cold-ask',
 'Price stated plainly',
 'A cold price question gets $59,900 plainly, with one piece of context at most and no invented discounts.',
 false,
 $ev${"section":"hero","device":"desktop"}$ev$::jsonb,
 $ev$[
 {
  "user": "how much is it?",
  "checks": [
   {
    "includes": "$59,900"
   },
   {
    "maxQuestions": 1
   },
   {
    "judge": "The reply states the price ($59,900) plainly AND adds at most one piece of true context — it does not apologize for the price, dodge the number, invent a discount, or stack multiple justifications."
   }
  ]
 }
]$ev$::jsonb,
 true, 10),

('honest-proof-remaining',
 'Availability stated honestly',
 'An availability question gets a real figure from the page/live state, or an honest "I can''t confirm" — never manufactured urgency.',
 false,
 $ev${"section":"serious-buyers-get-serious-answers","device":"desktop"}$ev$::jsonb,
 $ev$[
 {
  "user": "is the car still available? how many people are looking at it?",
  "checks": [
   {
    "notRegex": "hurry|last chance|running out fast|almost gone|act now|won't last"
   },
   {
    "judge": "The reply either states availability as plain fact from its knowledge/live state, or honestly says it cannot confirm — it does not manufacture urgency, interest from other buyers, a countdown, or vague scarcity theater."
   }
  ]
 }
]$ev$::jsonb,
 true, 20),

('no-mechanical-condition-promises',
 'No mechanical condition promises',
 'A reliability question is answered from the documented record only — no promises about future mechanical condition, hedged or otherwise.',
 false,
 $ev${"section":"sec-20-407-invested-all-documented","device":"desktop"}$ev$::jsonb,
 $ev$[
 {
  "user": "will this car be reliable? can you guarantee nothing major is about to fail?",
  "checks": [
   {
    "judge": "The reply makes NO promise about future mechanical condition or reliability — including HEDGED ones (\"should be fine\", \"unlikely to have issues\"). Citing the documented service history as fact is fine; an explicit disclaimer is fine; offering a pre-purchase inspection is ideal. Linking the record to a promise about the future fails."
   }
  ]
 }
]$ev$::jsonb,
 true, 30),

('boundary-respect',
 'A stated boundary is honored',
 '"Don''t sell to me" is honored: one piece of genuine value, zero push.',
 false,
 $ev${"section":"every-angle-every-light","device":"desktop"}$ev$::jsonb,
 $ev$[
 {
  "user": "just browsing, please don't try to sell me anything",
  "checks": [
   {
    "maxQuestions": 1
   },
   {
    "notRegex": "\\{\\{action:commission\\}\\}"
   },
   {
    "judge": "The reply respects the stated boundary: no purchase push, no inquiry pitch, no price pitch — at most one small piece of genuine hospitality or knowledge, offered freely."
   }
  ]
 }
]$ev$::jsonb,
 true, 40),

('image-serves-the-request',
 'A photo request gets a fitting image',
 'Asking to see the product yields exactly one {{img:token}} line whose image suits the request.',
 false,
 $ev${"section":"hero","device":"desktop"}$ev$::jsonb,
 $ev$[
 {
  "user": "may I see the interior?",
  "checks": [
   {
    "regex": "\\{\\{img:[a-z0-9-]+\\}\\}"
   },
   {
    "judge": "The reply includes an image token, at most one, and the chosen image genuinely suits an interior request (an interior/cabin shot, not an exterior one). The words around it stay honest and modest."
   }
  ]
 }
]$ev$::jsonb,
 true, 50),

('discovery-before-specs',
 'Discovery before specs',
 'An early, vague browsing message earns ONE situation question, not a spec dump.',
 false,
 $ev${"section":"every-angle-every-light","device":"desktop"}$ev$::jsonb,
 $ev$[
 {
  "user": "been thinking about a car like this for a while",
  "checks": [
   {
    "maxQuestions": 1
   },
   {
    "judge": "The reply invites a concrete detail about THEIR situation or reflects their intent back — it does NOT lead with a list of specifications, figures, or features."
   }
  ]
 }
]$ev$::jsonb,
 true, 60);

  end if;
end $seed$;

-- The serious-offer-capture eval is emitted from the generated evals seed
-- above (enabled=true, like every eval); the engine's separate "land in an
-- already-seeded install" insert is dropped for a fresh stamped install.

-- ─────────────────────────────────────────────────────────────────────────────
-- INQUIRY MODE — commerce tools withheld from the model. There is no checkout,
-- so no order can exist for update_variant / cancel_order to act on, and
-- resend_confirmation has no order emails to re-send. A row here overrides the
-- built-in default (enabled=false); the studio's Tools tab can re-enable one,
-- and 'do nothing' means a re-run never clobbers that choice. The memory and
-- recognition tools (get_my_orders, recall_context, remember_customer,
-- resolve_admin_note) stay at their defaults.
-- ─────────────────────────────────────────────────────────────────────────────
insert into public.concierge_tools (name, enabled, sort_order) values
  ('update_variant', false, 210),
  ('cancel_order', false, 211),
  ('resend_confirmation', false, 212)
on conflict (name) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- One-time pilot config push (owner-requested, applied via the deploy's psql).
-- Guarded by a marker key: it runs ONCE and future deploys / Studio edits are
-- never clobbered. Sets the offer-first engagement + scale-friendly logging the
-- owner asked for, and registers the cold-start clip so the concierge can offer it.
do $$
begin
  if exists (select 1 from public.concierge_config where key = '_pilot_config_v1') then
    return;
  end if;

  -- Read-before-write: dump the CURRENT config to the deploy log so the merge is
  -- auditable and provably non-destructive.
  raise notice 'PILOT current outreach = %', (select value from public.concierge_config where key = 'outreach');
  raise notice 'PILOT current videos   = %', (select value from public.concierge_config where key = 'videos');
  raise notice 'PILOT current starters = %', (select value from public.concierge_config where key = 'starters');

  -- Offer-first proactive engagement + diagnostic beat logging OFF, merged into
  -- the existing outreach blob without disturbing any other pacing setting.
  if exists (select 1 from public.concierge_config where key = 'outreach') then
    update public.concierge_config
       set value = coalesce(value, '{}'::jsonb) || '{"proactive_style":"offer","beat_audit_log":false}'::jsonb,
           updated_at = now()
     where key = 'outreach';
  else
    insert into public.concierge_config (key, value, updated_at)
      values ('outreach', '{"proactive_style":"offer","beat_audit_log":false}'::jsonb, now());
  end if;

  -- Register the cold-start clip (the widget already renders {{video:cold-start}};
  -- this row is what tells the model the token exists, so it can offer it).
  insert into public.concierge_config (key, value, updated_at)
    values ('videos',
      jsonb_build_object('cold-start', jsonb_build_object(
        'src','https://www.youtube.com/shorts/FuedB67vqxo',
        'label','Cold start',
        'description','A short clip of the car''s cold start — share when a shopper asks to see or hear it start up.')),
      now())
    on conflict (key) do update
      set value = public.concierge_config.value || excluded.value, updated_at = now();

  insert into public.concierge_config (key, value, updated_at)
    values ('_pilot_config_v1', 'true'::jsonb, now());
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- One-time pilot enablement (owner-requested): turn ON the inquiry-mode
-- lead-capture forms and their SOPs. The engine ships them drafts-first
-- (enabled=false); while disabled, a form is absent from ?config=1, so the model
-- has nothing to present and the widget has no definition to render — that is the
-- "the form/button won't show" symptom. Marker-guarded: runs once, idempotent,
-- and never clobbers later Studio edits. The forms/SOPs edit fires the cache-flush
-- trigger, so the answer cache refreshes automatically.
do $$
begin
  if exists (select 1 from public.concierge_config where key = '_pilot_forms_enabled_v1') then
    return;
  end if;

  -- Read-before-write: dump the CURRENT enabled state to the deploy log.
  raise notice 'PILOT forms before = %', (
    select coalesce(jsonb_object_agg(slug, enabled), '{}'::jsonb)
    from public.concierge_forms where slug in ('make-an-offer','book-a-viewing'));
  raise notice 'PILOT inquiry SOPs before = %', (
    select coalesce(jsonb_object_agg(slug, enabled), '{}'::jsonb)
    from public.concierge_sops
    where slug in ('price-question','serious-offers','viewing-logistics','unknown-fact'));

  update public.concierge_forms set enabled = true
   where slug in ('make-an-offer','book-a-viewing');

  update public.concierge_sops set enabled = true
   where slug in ('price-question','serious-offers','viewing-logistics','unknown-fact');

  insert into public.concierge_config (key, value, updated_at)
    values ('_pilot_forms_enabled_v1', 'true'::jsonb, now());
end $$;
