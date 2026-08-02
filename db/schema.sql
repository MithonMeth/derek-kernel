-- Anonymous public voting, pre-bond. One vote per voter_id per round per
-- rolling 24h, enforced atomically in the INSERT itself (see app/api/vote).
-- Superseded by the wallet/snapshot voting in SPEC.md once $TACO bonds.
create table if not exists public_votes (
  id           serial primary key,
  round_number int not null,
  voter_id     text not null,
  choice       text not null check (choice in ('taco', 'no_taco')),
  created_at   timestamptz not null default now()
);

create index if not exists public_votes_lookup
  on public_votes (round_number, voter_id, created_at);
