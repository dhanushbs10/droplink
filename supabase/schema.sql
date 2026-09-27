-- DropLink accounts and history schema.
-- Run this in the Supabase SQL editor after enabling Auth.

-- User profiles. One row per authenticated user, created from the
-- auth.users table so profile rows live and die with the account.
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null,
  created_at timestamptz not null default now()
);

-- Connection history. A row marks a transfer buddy: the authenticated
-- user and the peer they last connected with, plus the room code used.
create table if not exists public.buddies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  buddy_id uuid references public.profiles (id) on delete cascade,
  room_code text,
  last_connected timestamptz not null default now()
);

-- Row level security: users only see and edit their own rows.
alter table public.profiles enable row level security;
alter table public.buddies enable row level security;

drop policy if exists "Profiles are viewable by everyone" on public.profiles;
drop policy if exists "Profiles are readable by authenticated users" on public.profiles;
create policy "Profiles are readable by authenticated users"
  on public.profiles
  for select
  using (auth.role() = 'authenticated');

drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
  on public.profiles
  for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

drop policy if exists "Users can insert their own profile" on public.profiles;
create policy "Users can insert their own profile"
  on public.profiles
  for insert
  with check (auth.uid() = id);

drop policy if exists "Users can view their own buddies" on public.buddies;
create policy "Users can view their own buddies"
  on public.buddies
  for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own buddies" on public.buddies;
create policy "Users can insert their own buddies"
  on public.buddies
  for insert
  with check (
    auth.uid() = user_id
    and buddy_id <> user_id
    and exists (select 1 from public.profiles p where p.id = buddy_id)
  );

drop policy if exists "Users can update their own buddies" on public.buddies;
create policy "Users can update their own buddies"
  on public.buddies
  for update
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and buddy_id <> user_id
    and exists (select 1 from public.profiles p where p.id = buddy_id)
  );

drop policy if exists "Users can delete their own buddies" on public.buddies;
create policy "Users can delete their own buddies"
  on public.buddies
  for delete
  using (auth.uid() = user_id);

-- Keep the profiles table in sync with auth.users.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  candidate text;
  attempt int := 0;
begin
  candidate := lower(regexp_replace(coalesce(new.raw_user_meta_data ->> 'username', ''), '[^a-z0-9_-]', '', 'g'));
  candidate := left(candidate, 24);
  if candidate = '' then
    candidate := 'user_' || substr(new.id::text, 1, 8);
  end if;
  loop
    begin
      insert into public.profiles (id, username) values (new.id, candidate);
      return new;
    exception when unique_violation then
      if attempt >= 4 then raise; end if;
      attempt := attempt + 1;
      candidate := candidate || '_' || substr(md5(new.id::text || attempt), 1, 6);
    end;
  end loop;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Mechanical indexes for buddy lookups.
create index if not exists buddies_user_id_idx on public.buddies (user_id);
create index if not exists buddies_buddy_id_idx on public.buddies (buddy_id);

-- A user records each peer at most once; last_connected keeps the latest.
create unique index if not exists buddies_user_buddy_unique on public.buddies (user_id, buddy_id);

-- Usernames are unique case-insensitively so peers cannot impersonate each other.
create unique index if not exists profiles_username_unique on public.profiles (lower(username));