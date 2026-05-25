create extension if not exists "pgcrypto";

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'Untitled project',
  thumbnail_path text,
  duration double precision not null default 0,
  editor_state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.project_assets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('video', 'audio', 'image')),
  file_name text not null,
  storage_path text not null,
  thumbnail_path text,
  file_size bigint not null default 0,
  duration double precision,
  width integer,
  height integer,
  created_at timestamptz not null default now()
);

create index if not exists projects_user_updated_idx
  on public.projects (user_id, updated_at desc);

create index if not exists project_assets_project_created_idx
  on public.project_assets (project_id, created_at desc);

alter table public.projects enable row level security;
alter table public.project_assets enable row level security;

drop policy if exists "Users can read their projects" on public.projects;
create policy "Users can read their projects"
  on public.projects for select
  using (auth.uid() = user_id);

drop policy if exists "Users can create their projects" on public.projects;
create policy "Users can create their projects"
  on public.projects for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their projects" on public.projects;
create policy "Users can update their projects"
  on public.projects for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their projects" on public.projects;
create policy "Users can delete their projects"
  on public.projects for delete
  using (auth.uid() = user_id);

drop policy if exists "Users can read their project assets" on public.project_assets;
create policy "Users can read their project assets"
  on public.project_assets for select
  using (auth.uid() = user_id);

drop policy if exists "Users can create their project assets" on public.project_assets;
create policy "Users can create their project assets"
  on public.project_assets for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their project assets" on public.project_assets;
create policy "Users can update their project assets"
  on public.project_assets for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their project assets" on public.project_assets;
create policy "Users can delete their project assets"
  on public.project_assets for delete
  using (auth.uid() = user_id);

insert into storage.buckets (id, name, public)
values ('project-assets', 'project-assets', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('project-thumbnails', 'project-thumbnails', false)
on conflict (id) do nothing;

drop policy if exists "Users can read own project assets objects" on storage.objects;
create policy "Users can read own project assets objects"
  on storage.objects for select
  using (
    bucket_id in ('project-assets', 'project-thumbnails')
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "Users can write own project assets objects" on storage.objects;
create policy "Users can write own project assets objects"
  on storage.objects for insert
  with check (
    bucket_id in ('project-assets', 'project-thumbnails')
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "Users can update own project assets objects" on storage.objects;
create policy "Users can update own project assets objects"
  on storage.objects for update
  using (
    bucket_id in ('project-assets', 'project-thumbnails')
    and auth.uid()::text = (storage.foldername(name))[1]
  )
  with check (
    bucket_id in ('project-assets', 'project-thumbnails')
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "Users can delete own project assets objects" on storage.objects;
create policy "Users can delete own project assets objects"
  on storage.objects for delete
  using (
    bucket_id in ('project-assets', 'project-thumbnails')
    and auth.uid()::text = (storage.foldername(name))[1]
  );
