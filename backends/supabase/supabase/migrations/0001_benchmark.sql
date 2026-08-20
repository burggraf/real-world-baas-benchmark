begin;

create extension if not exists pg_trgm with schema extensions;
create schema if not exists private authorization postgres;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create table public.profiles (
  id text primary key check (id ~ '^[a-z0-9]{15}$'),
  auth_id uuid not null unique,
  email text not null unique,
  display_name text not null check (length(display_name) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.organizations (
  id text primary key check (id ~ '^[a-z0-9]{15}$'),
  name text not null check (length(name) > 0),
  owner_id text not null references public.profiles(id),
  created_at timestamptz not null default now()
);
create table public.memberships (
  id text primary key check (id ~ '^[a-z0-9]{15}$'),
  organization_id text not null references public.organizations(id),
  user_id text not null references public.profiles(id),
  role text not null check (role in ('owner','admin','member')),
  created_at timestamptz not null default now(),
  unique (organization_id, user_id)
);
create table public.projects (
  id text primary key check (id ~ '^[a-z0-9]{15}$'),
  organization_id text not null references public.organizations(id),
  name text not null check (length(name) > 0),
  status text not null check (length(status) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id)
);
create table public.tasks (
  id text primary key check (id ~ '^[a-z0-9]{15}$'),
  organization_id text not null,
  project_id text not null,
  creator_id text not null,
  assignee_id text,
  title text not null check (length(title) > 0),
  description text not null,
  status text not null check (status in ('todo','in_progress','done','cancelled')),
  priority text not null check (priority in ('low','medium','high','urgent')),
  due_date timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (project_id, organization_id) references public.projects(id, organization_id),
  foreign key (organization_id, creator_id) references public.memberships(organization_id, user_id),
  foreign key (organization_id, assignee_id) references public.memberships(organization_id, user_id),
  unique (id, project_id, organization_id)
);
create table public.comments (
  id text primary key check (id ~ '^[a-z0-9]{15}$'),
  organization_id text not null,
  project_id text not null,
  task_id text not null,
  author_id text not null,
  body text not null check (length(body) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (task_id, project_id, organization_id) references public.tasks(id, project_id, organization_id),
  foreign key (organization_id, author_id) references public.memberships(organization_id, user_id)
);
create table public.activities (
  id text primary key check (id ~ '^[a-z0-9]{15}$'),
  organization_id text not null references public.organizations(id),
  project_id text,
  actor_id text not null,
  action text not null check (length(action) > 0),
  subject_type text not null check (length(subject_type) > 0),
  subject_id text not null check (subject_id ~ '^[a-z0-9]{15}$'),
  created_at timestamptz not null default now(),
  foreign key (project_id, organization_id) references public.projects(id, organization_id),
  foreign key (organization_id, actor_id) references public.memberships(organization_id, user_id)
);

create index memberships_user_idx on public.memberships(user_id, organization_id);
create index projects_organization_idx on public.projects(organization_id, created_at, id);
create index tasks_project_idx on public.tasks(organization_id, project_id, created_at, id);
create index tasks_assignee_idx on public.tasks(organization_id, assignee_id);
create index tasks_title_idx on public.tasks using gin (title extensions.gin_trgm_ops);
create index comments_task_idx on public.comments(organization_id, project_id, task_id, created_at, id);
create index activities_organization_idx on public.activities(organization_id, created_at desc, id desc);

create function private.current_profile_id()
returns text language sql stable security definer set search_path = ''
as $$ select p.id from public.profiles p where p.auth_id = (select auth.uid()) $$;
alter function private.current_profile_id() owner to postgres;
revoke all on function private.current_profile_id() from public;
grant execute on function private.current_profile_id() to authenticated;

create function private.is_member(org_id text)
returns boolean language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.memberships m where m.organization_id = org_id and m.user_id = private.current_profile_id()) $$;
alter function private.is_member(text) owner to postgres;
revoke all on function private.is_member(text) from public;
grant execute on function private.is_member(text) to authenticated;

create function private.is_manager(org_id text)
returns boolean language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.memberships m where m.organization_id = org_id and m.user_id = private.current_profile_id() and m.role in ('owner','admin')) $$;
alter function private.is_manager(text) owner to postgres;
revoke all on function private.is_manager(text) from public;
grant execute on function private.is_manager(text) to authenticated;

create function private.can_read_profile(target_id text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select target_id = private.current_profile_id() or exists (
    select 1 from public.memberships mine join public.memberships peer using (organization_id)
    where mine.user_id = private.current_profile_id() and peer.user_id = target_id
  )
$$;
alter function private.can_read_profile(text) owner to postgres;
revoke all on function private.can_read_profile(text) from public;
grant execute on function private.can_read_profile(text) to authenticated;

create function private.enforce_immutable_keys()
returns trigger language plpgsql set search_path = '' as $$
declare before_row jsonb := to_jsonb(old); after_row jsonb := to_jsonb(new);
begin
  if tg_table_name = 'profiles' and (after_row->>'id', after_row->>'auth_id', after_row->>'email') is distinct from (before_row->>'id', before_row->>'auth_id', before_row->>'email') then raise exception 'immutable profile keys'; end if;
  if tg_table_name = 'organizations' and (after_row->>'id', after_row->>'owner_id') is distinct from (before_row->>'id', before_row->>'owner_id') then raise exception 'immutable organization keys'; end if;
  if tg_table_name = 'memberships' and (after_row->>'id', after_row->>'organization_id', after_row->>'user_id') is distinct from (before_row->>'id', before_row->>'organization_id', before_row->>'user_id') then raise exception 'immutable membership keys'; end if;
  if tg_table_name = 'projects' and (after_row->>'id', after_row->>'organization_id') is distinct from (before_row->>'id', before_row->>'organization_id') then raise exception 'immutable project keys'; end if;
  if tg_table_name = 'tasks' and (after_row->>'id', after_row->>'organization_id', after_row->>'project_id', after_row->>'creator_id') is distinct from (before_row->>'id', before_row->>'organization_id', before_row->>'project_id', before_row->>'creator_id') then raise exception 'immutable task keys'; end if;
  if tg_table_name = 'comments' and (after_row->>'id', after_row->>'organization_id', after_row->>'project_id', after_row->>'task_id', after_row->>'author_id') is distinct from (before_row->>'id', before_row->>'organization_id', before_row->>'project_id', before_row->>'task_id', before_row->>'author_id') then raise exception 'immutable comment keys'; end if;
  if tg_table_name = 'activities' and (after_row->>'id', after_row->>'organization_id', after_row->>'project_id', after_row->>'actor_id') is distinct from (before_row->>'id', before_row->>'organization_id', before_row->>'project_id', before_row->>'actor_id') then raise exception 'immutable activity keys'; end if;
  return new;
end $$;
alter function private.enforce_immutable_keys() owner to postgres;
revoke all on function private.enforce_immutable_keys() from public;

create function private.enforce_membership_role()
returns trigger language plpgsql set search_path = '' as $$
declare org_owner text;
begin
  select o.owner_id into org_owner from public.organizations o where o.id = new.organization_id;
  if (new.role = 'owner') <> (new.user_id = org_owner) then raise exception 'membership owner mismatch'; end if;
  return new;
end $$;
alter function private.enforce_membership_role() owner to postgres;
revoke all on function private.enforce_membership_role() from public;

create function private.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$ begin new.updated_at = now(); return new; end $$;
alter function private.touch_updated_at() owner to postgres;
revoke all on function private.touch_updated_at() from public;

create function private.log_workflow_activity()
returns trigger language plpgsql security definer set search_path = '' as $$
declare actor text; payload jsonb := to_jsonb(new);
begin
  if (select auth.role()) <> 'authenticated' then return new; end if;
  actor := private.current_profile_id();
  insert into public.activities(id, organization_id, project_id, actor_id, action, subject_type, subject_id)
  values (
    substr(replace(gen_random_uuid()::text, '-', ''), 1, 15), payload->>'organization_id', payload->>'project_id', actor,
    case when tg_table_name = 'comments' then case when tg_op = 'INSERT' then 'commented' else 'comment_updated' end else case when tg_op = 'INSERT' then 'created' else 'updated' end end,
    'task', case when tg_table_name = 'comments' then payload->>'task_id' else payload->>'id' end
  );
  return new;
end $$;
alter function private.log_workflow_activity() owner to postgres;
revoke all on function private.log_workflow_activity() from public;

create trigger profiles_immutable before update on public.profiles for each row execute function private.enforce_immutable_keys();
create trigger organizations_immutable before update on public.organizations for each row execute function private.enforce_immutable_keys();
create trigger memberships_immutable before update on public.memberships for each row execute function private.enforce_immutable_keys();
create trigger memberships_role before insert or update on public.memberships for each row execute function private.enforce_membership_role();
create trigger projects_immutable before update on public.projects for each row execute function private.enforce_immutable_keys();
create trigger tasks_immutable before update on public.tasks for each row execute function private.enforce_immutable_keys();
create trigger comments_immutable before update on public.comments for each row execute function private.enforce_immutable_keys();
create trigger activities_immutable before update on public.activities for each row execute function private.enforce_immutable_keys();
create trigger profiles_touch before update on public.profiles for each row execute function private.touch_updated_at();
create trigger projects_touch before update on public.projects for each row execute function private.touch_updated_at();
create trigger tasks_touch before update on public.tasks for each row execute function private.touch_updated_at();
create trigger comments_touch before update on public.comments for each row execute function private.touch_updated_at();
create trigger tasks_activity after insert or update on public.tasks for each row execute function private.log_workflow_activity();
create trigger comments_activity after insert or update on public.comments for each row execute function private.log_workflow_activity();

revoke all on all tables in schema public from public, anon, authenticated;
grant select on public.profiles to authenticated;
grant update(display_name) on public.profiles to authenticated;
grant select on public.organizations, public.projects to authenticated;
grant select on public.memberships to authenticated;
grant update(role) on public.memberships to authenticated;
grant select, insert, update, delete on public.tasks, public.comments to authenticated;
grant select, insert on public.activities to authenticated;
grant all on all tables in schema public to service_role;

alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.projects enable row level security;
alter table public.tasks enable row level security;
alter table public.comments enable row level security;
alter table public.activities enable row level security;

create policy profiles_peer_select on public.profiles for select to authenticated using (private.can_read_profile(id));
create policy profiles_self_update on public.profiles for update to authenticated using (id = private.current_profile_id()) with check (id = private.current_profile_id());
create policy organizations_member_select on public.organizations for select to authenticated using (private.is_member(id));
create policy memberships_roster_select on public.memberships for select to authenticated using (private.is_member(organization_id));
create policy memberships_manager_update on public.memberships for update to authenticated using (private.is_manager(organization_id)) with check (private.is_manager(organization_id));
create policy projects_member_select on public.projects for select to authenticated using (private.is_member(organization_id));
create policy tasks_member_select on public.tasks for select to authenticated using (private.is_member(organization_id));
create policy tasks_member_insert on public.tasks for insert to authenticated with check (private.is_member(organization_id) and creator_id = private.current_profile_id());
create policy tasks_member_update on public.tasks for update to authenticated using (private.is_member(organization_id)) with check (private.is_member(organization_id));
create policy tasks_member_delete on public.tasks for delete to authenticated using (private.is_member(organization_id));
create policy comments_member_select on public.comments for select to authenticated using (private.is_member(organization_id));
create policy comments_member_insert on public.comments for insert to authenticated with check (private.is_member(organization_id) and author_id = private.current_profile_id());
create policy comments_member_update on public.comments for update to authenticated using (private.is_member(organization_id)) with check (private.is_member(organization_id));
create policy comments_member_delete on public.comments for delete to authenticated using (private.is_member(organization_id));
create policy activities_member_select on public.activities for select to authenticated using (private.is_member(organization_id));
create policy activities_member_insert on public.activities for insert to authenticated with check (private.is_member(organization_id) and actor_id = private.current_profile_id());

commit;
