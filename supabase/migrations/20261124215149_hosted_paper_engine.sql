create schema if not exists paper_engine;
revoke all on schema paper_engine from public, anon, authenticated, service_role;

create table paper_engine.state (
  singleton boolean primary key default true check (singleton),
  slot bigint not null default -1,
  seq bigint not null default -1,
  hash text not null default 'GENESIS',
  checkpoint jsonb,
  deck jsonb not null default '{}'
);
create table paper_engine.ledger (
  seq bigint primary key check (seq >= 0),
  ts bigint not null,
  type text not null check (type in ('decision', 'fill', 'equity', 'risk', 'settle', 'checkpoint')),
  "prevHash" text not null,
  hash text not null,
  payload text not null
);
alter table paper_engine.state enable row level security;
alter table paper_engine.ledger enable row level security;
insert into paper_engine.state default values;

create function public.paper_engine_load()
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('slot', slot, 'seq', seq, 'hash', hash,
    'checkpoint', checkpoint, 'deck', deck - 'candles')
  from paper_engine.state where singleton;
$$;

create function public.paper_engine_read(p_key text, p_symbol text)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select case p_key
    when 'snapshot' then deck -> 'snapshot'
    when 'decisions' then deck -> 'decisions'
    when 'candles' then deck -> 'candles' -> p_symbol
  end from paper_engine.state where singleton;
$$;

create function public.paper_engine_commit(
  p_slot bigint, p_seq bigint, p_hash text, p_checkpoint jsonb, p_deck jsonb, p_records jsonb
)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare
  head paper_engine.state%rowtype;
  record paper_engine.ledger%rowtype;
begin
  select * into strict head from paper_engine.state where singleton for update;
  if p_slot is null or p_slot <= head.slot or p_seq is distinct from head.seq
      or p_hash is distinct from head.hash then
    return false;
  end if;
  if jsonb_typeof(p_records) is distinct from 'array'
      or jsonb_typeof(p_checkpoint) is distinct from 'object'
      or jsonb_typeof(p_deck -> 'snapshot') is distinct from 'object' then
    raise exception 'invalid paper cycle payload';
  end if;

  for record in select * from jsonb_populate_recordset(null::paper_engine.ledger, p_records) loop
    if record.seq is distinct from head.seq + 1 or record."prevHash" is distinct from head.hash
        or record.hash is distinct from encode(sha256(convert_to(
          record."prevHash" || ':' || record.seq || ':' || record.type || ':' || record.payload, 'UTF8'
        )), 'hex') then
      raise exception 'invalid paper ledger chain';
    end if;
    insert into paper_engine.ledger select record.*;
    head.seq := record.seq;
    head.hash := record.hash;
  end loop;

  if head.seq = p_seq or record.type not in ('equity', 'checkpoint') then
    raise exception 'incomplete paper cycle';
  end if;
  update paper_engine.state set slot = p_slot, seq = head.seq, hash = head.hash,
    checkpoint = p_checkpoint, deck = p_deck where singleton;
  return true;
end;
$$;

revoke all on function public.paper_engine_load() from public, anon, authenticated;
revoke all on function public.paper_engine_read(text, text) from public, anon, authenticated;
revoke all on function public.paper_engine_commit(bigint, bigint, text, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.paper_engine_load() to service_role;
grant execute on function public.paper_engine_read(text, text) to service_role;
grant execute on function public.paper_engine_commit(bigint, bigint, text, jsonb, jsonb, jsonb) to service_role;