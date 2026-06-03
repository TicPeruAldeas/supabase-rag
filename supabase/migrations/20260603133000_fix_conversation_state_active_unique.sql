-- conversation_state should allow many historical rows per user/country.
-- Only one active flow should be unique.

alter table if exists public.conversation_state
  drop constraint if exists conversation_state_user_id_country_code_status_key;

drop index if exists public.conversation_state_user_id_country_code_status_key;

update public.conversation_state
set status = status || ':' || id::text
where status in ('cancelled', 'completed');

with ranked_active as (
  select
    id,
    row_number() over (
      partition by user_id, country_code
      order by updated_at desc nulls last, id desc
    ) as active_rank
  from public.conversation_state
  where status = 'active'
)
update public.conversation_state as state
set
  status = 'cancelled:' || state.id::text,
  updated_at = now()
from ranked_active
where state.id = ranked_active.id
  and ranked_active.active_rank > 1;

create unique index if not exists conversation_state_one_active_per_user_country
  on public.conversation_state (user_id, country_code)
  where status = 'active';
