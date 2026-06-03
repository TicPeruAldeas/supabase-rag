-- Multi-country uniqueness for RAG content.
-- Run this in Supabase before deploying the code that upserts with
-- onConflict: flow_id,country_code.
--
-- If your database still has older unique constraints on only flow_id,
-- remove or replace them first; otherwise different countries cannot reuse
-- the same flow_id.

create unique index if not exists knowledge_flows_flow_id_country_code_key
  on public.knowledge_flows (flow_id, country_code);

create unique index if not exists knowledge_chunks_flow_id_country_code_key
  on public.knowledge_chunks (flow_id, country_code);

create unique index if not exists knowledge_steps_flow_id_country_step_number_key
  on public.knowledge_steps (flow_id, country_code, step_number);
