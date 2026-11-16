-- ============================================================
--  نداء الطلاب (VoiceSchool) — قاعدة البيانات
--  كل الوصول يتم عبر دوال RPC فقط؛ الجداول مغلقة أمام العموم.
-- ============================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------- الجداول ----------
create table if not exists public.vs_stations (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique,
  token            text not null,
  pin_hash         text not null,
  pin_fails        int  not null default 0,
  pin_locked_until timestamptz,
  lat              double precision,
  lng              double precision,
  radius_m         int  not null default 2000 check (radius_m between 100 and 2000),
  tz               text not null default 'Asia/Riyadh',
  mode             text not null default 'auto' check (mode in ('auto','open','closed')),
  windows          jsonb not null default '[{"days":[0,1,2,3,4],"from":"11:30","to":"14:00"}]'::jsonb,
  created_at       timestamptz not null default now(),
  last_seen        timestamptz
);

create table if not exists public.vs_calls (
  id          bigint generated always as identity primary key,
  station_id  uuid not null references public.vs_stations(id) on delete cascade,
  device_id   text not null,
  audio       text not null,          -- base64
  mime        text not null,
  duration_ms int  not null,
  status      text not null default 'queued' check (status in ('queued','played','skipped')),
  created_at  timestamptz not null default now(),
  queued_at   timestamptz not null default now(),
  played_at   timestamptz
);
create index if not exists vs_calls_station_idx on public.vs_calls (station_id, status, queued_at);
create index if not exists vs_calls_device_idx  on public.vs_calls (station_id, device_id, created_at desc);
create index if not exists vs_calls_created_idx on public.vs_calls (created_at);

create table if not exists public.vs_blocked (
  station_id uuid not null references public.vs_stations(id) on delete cascade,
  device_id  text not null,
  created_at timestamptz not null default now(),
  primary key (station_id, device_id)
);

alter table public.vs_stations enable row level security;
alter table public.vs_calls    enable row level security;
alter table public.vs_blocked  enable row level security;
revoke all on public.vs_stations, public.vs_calls, public.vs_blocked from anon, authenticated;

-- ---------- دوال داخلية ----------
create or replace function public.vs__cleanup() returns void
language sql security definer set search_path = '' as $$
  delete from public.vs_calls   where created_at < now() - interval '2 hours';
  delete from public.vs_blocked where created_at < now() - interval '24 hours';
$$;

create or replace function public.vs__dist(lat1 double precision, lng1 double precision,
                                           lat2 double precision, lng2 double precision)
returns double precision language sql immutable set search_path = '' as $$
  select 2 * 6371000 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)
  ));
$$;

create or replace function public.vs__is_open(s public.vs_stations) returns boolean
language plpgsql stable set search_path = '' as $$
declare
  t  timestamp := now() at time zone s.tz;
  d  int  := extract(dow from t)::int;          -- 0 = الأحد
  hm text := to_char(t, 'HH24:MI');
  w  jsonb;
begin
  if s.mode = 'open'   then return true;  end if;
  if s.mode = 'closed' then return false; end if;
  for w in select * from jsonb_array_elements(s.windows) loop
    if (w->'days') @> to_jsonb(d) and hm >= (w->>'from') and hm < (w->>'to') then
      return true;
    end if;
  end loop;
  return false;
end $$;

create or replace function public.vs__settings(s public.vs_stations) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'code', s.code, 'lat', s.lat, 'lng', s.lng, 'radius_m', s.radius_m,
    'tz', s.tz, 'mode', s.mode, 'windows', s.windows,
    'is_open', public.vs__is_open(s), 'has_location', s.lat is not null and s.lng is not null);
$$;

-- التحقق من الرقم السري للإدارة مع قفل مؤقت بعد 5 محاولات خاطئة
create or replace function public.vs__admin(p_code text, p_pin text,
                                            out st public.vs_stations, out err text)
language plpgsql security definer set search_path = '' as $$
declare s public.vs_stations;
begin
  select * into s from public.vs_stations where code = upper(trim(p_code));
  if not found then err := 'not_found'; return; end if;
  if s.pin_locked_until is not null and s.pin_locked_until > now() then err := 'locked'; return; end if;
  if s.pin_hash = extensions.crypt(coalesce(p_pin, ''), s.pin_hash) then
    update public.vs_stations set pin_fails = 0, pin_locked_until = null where id = s.id;
    st := s; return;
  end if;
  update public.vs_stations
     set pin_fails = case when pin_fails + 1 >= 5 then 0 else pin_fails + 1 end,
         pin_locked_until = case when pin_fails + 1 >= 5 then now() + interval '5 minutes' else null end
   where id = s.id;
  err := 'bad_pin';
end $$;

create or replace function public.vs__by_token(p_code text, p_token text) returns public.vs_stations
language sql stable security definer set search_path = '' as $$
  select * from public.vs_stations where code = upper(trim(p_code)) and token = p_token;
$$;

-- فحوص ما قبل النداء: مفتوح؟ داخل النطاق؟ غير محظور؟ مرّت 5 دقائق؟
create or replace function public.vs__precheck(s public.vs_stations, p_device text,
                                               p_lat double precision, p_lng double precision)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare d double precision; last_at timestamptz; wait_s int; n int;
begin
  if p_device is null or length(p_device) not between 8 and 64 then
    return jsonb_build_object('ok', false, 'error', 'bad_device'); end if;
  if not public.vs__is_open(s) then
    return jsonb_build_object('ok', false, 'error', 'closed'); end if;
  if s.lat is null or s.lng is null then
    return jsonb_build_object('ok', false, 'error', 'no_location'); end if;
  if exists (select 1 from public.vs_blocked b where b.station_id = s.id and b.device_id = p_device) then
    return jsonb_build_object('ok', false, 'error', 'blocked'); end if;
  if p_lat is null or p_lng is null or abs(p_lat) > 90 or abs(p_lng) > 180 then
    return jsonb_build_object('ok', false, 'error', 'no_position'); end if;
  d := public.vs__dist(s.lat, s.lng, p_lat, p_lng);
  if d > s.radius_m then
    return jsonb_build_object('ok', false, 'error', 'too_far', 'distance_m', round(d)); end if;
  select max(created_at) into last_at from public.vs_calls
   where station_id = s.id and device_id = p_device;
  if last_at is not null then
    wait_s := 300 - extract(epoch from now() - last_at)::int;
    if wait_s > 0 then
      return jsonb_build_object('ok', false, 'error', 'cooldown', 'wait_s', wait_s); end if;
  end if;
  select count(*) into n from public.vs_calls where station_id = s.id and status = 'queued';
  if n >= 80 then
    return jsonb_build_object('ok', false, 'error', 'queue_full'); end if;
  return null;
end $$;

-- ---------- واجهة الإدارة (بالرقم السري) ----------
create or replace function public.vs_station_create(p_pin text, p_lat double precision,
                                                    p_lng double precision, p_tz text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text; v_token text; v_tz text := coalesce(nullif(trim(p_tz), ''), 'Asia/Riyadh');
begin
  if p_pin is null or length(p_pin) not between 4 and 32 then
    return jsonb_build_object('ok', false, 'error', 'pin_short'); end if;
  begin perform now() at time zone v_tz; exception when others then v_tz := 'Asia/Riyadh'; end;
  loop
    select string_agg(substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1), '')
      into v_code from generate_series(1, 6);
    exit when not exists (select 1 from public.vs_stations where code = v_code);
  end loop;
  v_token := encode(extensions.gen_random_bytes(18), 'hex');
  insert into public.vs_stations (code, token, pin_hash, lat, lng, tz)
  values (v_code, v_token, extensions.crypt(p_pin, extensions.gen_salt('bf')), p_lat, p_lng, v_tz);
  return jsonb_build_object('ok', true, 'code', v_code, 'token', v_token);
end $$;

create or replace function public.vs_station_login(p_code text, p_pin text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.vs_stations; e text; r record;
begin
  select * into r from public.vs__admin(p_code, p_pin);
  s := r.st; e := r.err;
  if e is not null then return jsonb_build_object('ok', false, 'error', e); end if;
  return jsonb_build_object('ok', true, 'code', s.code, 'token', s.token, 'station', public.vs__settings(s));
end $$;

create or replace function public.vs_station_update(p_code text, p_pin text, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.vs_stations; e text; w jsonb; v_tz text; r record;
begin
  select * into r from public.vs__admin(p_code, p_pin);
  s := r.st; e := r.err;
  if e is not null then return jsonb_build_object('ok', false, 'error', e); end if;

  if p ? 'windows' then
    if jsonb_typeof(p->'windows') <> 'array' or jsonb_array_length(p->'windows') > 20 then
      return jsonb_build_object('ok', false, 'error', 'bad_windows'); end if;
    for w in select * from jsonb_array_elements(p->'windows') loop
      if jsonb_typeof(w->'days') <> 'array'
         or coalesce(w->>'from', '') !~ '^[0-2][0-9]:[0-5][0-9]$'
         or coalesce(w->>'to', '')   !~ '^[0-2][0-9]:[0-5][0-9]$' then
        return jsonb_build_object('ok', false, 'error', 'bad_windows'); end if;
    end loop;
  end if;
  if p ? 'mode' and (p->>'mode') not in ('auto','open','closed') then
    return jsonb_build_object('ok', false, 'error', 'bad_mode'); end if;
  if p ? 'new_pin' and length(p->>'new_pin') not between 4 and 32 then
    return jsonb_build_object('ok', false, 'error', 'pin_short'); end if;
  v_tz := s.tz;
  if p ? 'tz' then
    begin perform now() at time zone (p->>'tz'); v_tz := p->>'tz'; exception when others then null; end;
  end if;

  update public.vs_stations set
    lat      = case when p ? 'lat' then (p->>'lat')::double precision else lat end,
    lng      = case when p ? 'lng' then (p->>'lng')::double precision else lng end,
    radius_m = case when p ? 'radius_m' then least(2000, greatest(100, (p->>'radius_m')::int)) else radius_m end,
    mode     = coalesce(p->>'mode', mode),
    windows  = coalesce(p->'windows', windows),
    tz       = v_tz,
    pin_hash = case when p ? 'new_pin' then extensions.crypt(p->>'new_pin', extensions.gen_salt('bf')) else pin_hash end
  where id = s.id
  returning * into s;
  return jsonb_build_object('ok', true, 'station', public.vs__settings(s));
end $$;

-- ---------- واجهة شاشة البث (برمز الجهاز) ----------
create or replace function public.vs_station_poll(p_code text, p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.vs_stations;
begin
  s := public.vs__by_token(p_code, p_token);
  if s.id is null then return jsonb_build_object('ok', false, 'error', 'auth'); end if;
  perform public.vs__cleanup();
  update public.vs_stations set last_seen = now() where id = s.id;
  return jsonb_build_object(
    'ok', true,
    'station', public.vs__settings(s),
    'queue', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'duration_ms', c.duration_ms, 'queued_at', c.queued_at)
                                        order by c.queued_at, c.id)
                         from public.vs_calls c where c.station_id = s.id and c.status = 'queued'), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(x.j) from (
                 select jsonb_build_object('id', c.id, 'status', c.status, 'duration_ms', c.duration_ms,
                                           'at', coalesce(c.played_at, c.queued_at)) j
                   from public.vs_calls c
                  where c.station_id = s.id and c.status <> 'queued'
                  order by coalesce(c.played_at, c.queued_at) desc limit 12) x), '[]'::jsonb),
    'blocked', (select count(*) from public.vs_blocked b where b.station_id = s.id));
end $$;

create or replace function public.vs_station_audio(p_code text, p_token text, p_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.vs_stations; c public.vs_calls;
begin
  s := public.vs__by_token(p_code, p_token);
  if s.id is null then return jsonb_build_object('ok', false, 'error', 'auth'); end if;
  select * into c from public.vs_calls where id = p_id and station_id = s.id;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', true, 'audio', c.audio, 'mime', c.mime, 'duration_ms', c.duration_ms);
end $$;

create or replace function public.vs_station_mark(p_code text, p_token text, p_id bigint, p_status text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.vs_stations;
begin
  s := public.vs__by_token(p_code, p_token);
  if s.id is null then return jsonb_build_object('ok', false, 'error', 'auth'); end if;
  if p_status not in ('played','skipped','queued') then
    return jsonb_build_object('ok', false, 'error', 'bad_status'); end if;
  update public.vs_calls
     set status    = p_status,
         played_at = case when p_status = 'queued' then null else now() end,
         queued_at = case when p_status = 'queued' then now() else queued_at end
   where id = p_id and station_id = s.id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.vs_station_block(p_code text, p_token text, p_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.vs_stations; v_device text;
begin
  s := public.vs__by_token(p_code, p_token);
  if s.id is null then return jsonb_build_object('ok', false, 'error', 'auth'); end if;
  select device_id into v_device from public.vs_calls where id = p_id and station_id = s.id;
  if v_device is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  insert into public.vs_blocked (station_id, device_id) values (s.id, v_device) on conflict do nothing;
  update public.vs_calls set status = 'skipped', played_at = now()
   where station_id = s.id and device_id = v_device and status = 'queued';
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.vs_station_unblock_all(p_code text, p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.vs_stations;
begin
  s := public.vs__by_token(p_code, p_token);
  if s.id is null then return jsonb_build_object('ok', false, 'error', 'auth'); end if;
  delete from public.vs_blocked where station_id = s.id;
  return jsonb_build_object('ok', true);
end $$;

-- ---------- واجهة ولي الأمر ----------
create or replace function public.vs_public_info(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.vs_stations;
begin
  select * into s from public.vs_stations where code = upper(trim(p_code));
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', true, 'code', s.code, 'is_open', public.vs__is_open(s),
    'mode', s.mode, 'windows', s.windows, 'tz', s.tz, 'radius_m', s.radius_m,
    'has_location', s.lat is not null and s.lng is not null);
end $$;

create or replace function public.vs_call_status(p_code text, p_device text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.vs_stations; c public.vs_calls; pos int := 0; wait_s int := 0;
begin
  select * into s from public.vs_stations where code = upper(trim(p_code));
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  select * into c from public.vs_calls
   where station_id = s.id and device_id = p_device order by created_at desc limit 1;
  if c.id is null then
    return jsonb_build_object('ok', true, 'is_open', public.vs__is_open(s), 'has_call', false, 'wait_s', 0);
  end if;
  if c.status = 'queued' then
    select count(*) into pos from public.vs_calls q
     where q.station_id = s.id and q.status = 'queued' and (q.queued_at, q.id) <= (c.queued_at, c.id);
  end if;
  wait_s := greatest(0, 300 - extract(epoch from now() - c.created_at)::int);
  return jsonb_build_object('ok', true, 'is_open', public.vs__is_open(s), 'has_call', true,
    'id', c.id, 'status', c.status, 'position', pos, 'wait_s', wait_s, 'duration_ms', c.duration_ms,
    'blocked', exists (select 1 from public.vs_blocked b where b.station_id = s.id and b.device_id = p_device));
end $$;

create or replace function public.vs_call_submit(p_code text, p_device text,
    p_lat double precision, p_lng double precision, p_audio text, p_mime text, p_duration_ms int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.vs_stations; e jsonb; v_id bigint;
begin
  select * into s from public.vs_stations where code = upper(trim(p_code));
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if p_audio is null or length(p_audio) < 200 or length(p_audio) > 600000
     or coalesce(p_mime, '') !~ '^audio/[a-z0-9.+-]+$'
     or p_duration_ms is null or p_duration_ms < 300 or p_duration_ms > 11000 then
    return jsonb_build_object('ok', false, 'error', 'bad_audio'); end if;
  perform public.vs__cleanup();
  e := public.vs__precheck(s, p_device, p_lat, p_lng);
  if e is not null then return e; end if;
  insert into public.vs_calls (station_id, device_id, audio, mime, duration_ms)
  values (s.id, p_device, p_audio, p_mime, p_duration_ms) returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- تكرار آخر نداء بدون تسجيل جديد
create or replace function public.vs_call_repeat(p_code text, p_device text,
    p_lat double precision, p_lng double precision)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.vs_stations; e jsonb; c public.vs_calls; v_id bigint;
begin
  select * into s from public.vs_stations where code = upper(trim(p_code));
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  perform public.vs__cleanup();
  select * into c from public.vs_calls
   where station_id = s.id and device_id = p_device order by created_at desc limit 1;
  if c.id is null then return jsonb_build_object('ok', false, 'error', 'no_recording'); end if;
  e := public.vs__precheck(s, p_device, p_lat, p_lng);
  if e is not null then return e; end if;
  insert into public.vs_calls (station_id, device_id, audio, mime, duration_ms)
  values (s.id, p_device, c.audio, c.mime, c.duration_ms) returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- ---------- الصلاحيات ----------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'vs\_%' loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    if f.proname not like 'vs\_\_%' then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    end if;
  end loop;
end $$;

-- ---------- حذف تلقائي كل 10 دقائق (كل تسجيل يُحذف بعد ساعتين) ----------
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('vs-cleanup', '*/10 * * * *', 'select public.vs__cleanup()');
exception when others then
  raise notice 'pg_cron غير متاح، الحذف سيتم عند كل نداء: %', sqlerrm;
end $$;
