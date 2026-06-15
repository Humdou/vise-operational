
-- Schéma multijoueur VISE OPÉRATIONNEL — à exécuter dans l'éditeur SQL Supabase.
-- Annuaire des salons ouverts (l'état détaillé et le jeu passent par Realtime).
create table if not exists public.lobbies (
  code        text primary key,
  name        text not null,
  host        text not null,
  host_id     uuid not null,
  players     int  not null default 1,
  total_slots int  not null default 4,
  fill_ai     boolean not null default true,
  status      text not null default 'open',   -- open | started
  updated_at  timestamptz not null default now()
);

alter table public.lobbies enable row level security;

-- Lecture par tout utilisateur connecté ; écriture réservée à l'hôte.
create policy "lobbies_select" on public.lobbies
  for select to authenticated using (true);
create policy "lobbies_insert" on public.lobbies
  for insert to authenticated with check (auth.uid() = host_id);
create policy "lobbies_update" on public.lobbies
  for update to authenticated using (auth.uid() = host_id);
create policy "lobbies_delete" on public.lobbies
  for delete to authenticated using (auth.uid() = host_id);

-- Nettoyage des salons abandonnés (optionnel : pg_cron)
-- delete from public.lobbies where updated_at < now() - interval '10 minutes';
