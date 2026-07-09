-- Esquema base del RAG multi-país (reconstruido desde el uso en el código).
--
-- ⚠️  ALCANCE: esta migración es la REFERENCIA para levantar una base de datos
--     NUEVA desde cero (reproducibilidad del repo). La base de datos de producción
--     ya tiene estos objetos y es COMPARTIDA con otro servicio (bot de protección
--     digital infantil). NO hace falta correrla contra la BD existente.
--
--     Aun así, es segura por construcción si alguien la ejecuta:
--       · Tablas e índices → CREATE ... IF NOT EXISTS (omite lo que ya existe).
--       · Función RPC       → se crea SOLO si no existe (nunca sobrescribe una
--                             función homónima que otro servicio pudiera usar).
--     Solo toca los objetos de Aldeas (knowledge_flows, knowledge_steps,
--     conversations, conversation_state, match_flows_by_country). No referencia
--     ninguna tabla del otro bot.
--
-- Tablas: knowledge_flows, knowledge_steps, conversations, conversation_state.
-- Función RPC: match_flows_by_country (búsqueda vectorial por país).
-- Embeddings: OpenAI text-embedding-3-small → vector de 1536 dimensiones.

-- pgvector para el tipo `vector` y los operadores de distancia.
create extension if not exists vector;
-- gen_random_uuid() para el id de conversation_state.
create extension if not exists pgcrypto;

-- ── knowledge_flows ───────────────────────────────────────────
-- Un flow = una fila del Excel/Sheets (pregunta+respuesta) por país.
-- PK compuesta (flow_id, country_code): el mismo flow_id se reutiliza entre países.
create table if not exists public.knowledge_flows (
  flow_id      text        not null,
  country_code text        not null,
  category     text,
  subtopic     text,
  question     text        not null,
  answer       text        not null,
  flow_type    text        not null,
  embedding    vector(1536),
  source_name  text,
  updated_at   timestamptz not null default now(),
  primary key (flow_id, country_code)
);

-- Índice ANN para la búsqueda por similitud coseno (match_flows_by_country).
create index if not exists knowledge_flows_embedding_hnsw
  on public.knowledge_flows
  using hnsw (embedding vector_cosine_ops);

-- Filtro por país previo al ANN.
create index if not exists knowledge_flows_country_code_idx
  on public.knowledge_flows (country_code);

-- ── knowledge_steps ───────────────────────────────────────────
-- Pasos de un flow "paso a paso". PK (flow_id, country_code, step_number).
create table if not exists public.knowledge_steps (
  flow_id      text        not null,
  country_code text        not null,
  step_number  integer     not null,
  step_summary text,
  step_detail  text,
  source_name  text,
  updated_at   timestamptz not null default now(),
  primary key (flow_id, country_code, step_number)
);

create index if not exists knowledge_steps_flow_country_idx
  on public.knowledge_steps (flow_id, country_code);

-- ── conversations ─────────────────────────────────────────────
-- Historial de mensajes (user/assistant) por usuario y país.
create table if not exists public.conversations (
  id           uuid        not null default gen_random_uuid(),
  user_id      text        not null,
  country_code text        not null,
  role         text        not null,
  message      text        not null,
  source       text        not null default 'api',
  metadata     jsonb       not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  primary key (id)
);

-- getRecentHistory: filtra por (user_id, country_code) y ordena por created_at desc.
create index if not exists conversations_user_country_created_idx
  on public.conversations (user_id, country_code, created_at desc);

-- ── conversation_state ────────────────────────────────────────
-- Estado del flujo activo/histórico por usuario. Solo una fila 'active'
-- por (user_id, country_code) — el índice parcial lo garantiza en la
-- migración 20260603133000.
create table if not exists public.conversation_state (
  id           uuid        not null default gen_random_uuid(),
  user_id      text        not null,
  country_code text        not null,
  flow_id      text,
  flow_type    text,
  current_step integer     not null default 0,
  total_steps  integer     not null default 0,
  status       text        not null default 'active',
  updated_at   timestamptz not null default now(),
  primary key (id)
);

create index if not exists conversation_state_user_country_idx
  on public.conversation_state (user_id, country_code);

-- ── RPC: match_flows_by_country ───────────────────────────────
-- Búsqueda vectorial por similitud coseno, filtrada por país.
-- similarity = 1 - distancia_coseno (∈ [0,1]; mayor = más parecido).
-- Devuelve las columnas que consume el reranker de Claude en rag-service.js.
--
-- Se crea SOLO si no existe. Deliberadamente NO se usa CREATE OR REPLACE:
-- la BD es compartida y no debemos sobrescribir una función que otro servicio
-- ya tenga en producción. Para actualizar la definición a propósito, hazlo en
-- una migración nueva y explícita.
do $do$
begin
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'match_flows_by_country'
  ) then
    execute $fn$
      create function public.match_flows_by_country(
        query_embedding vector(1536),
        filter_country  text,
        match_count     integer default 5,
        min_similarity  double precision default 0.35
      )
      returns table (
        flow_id      text,
        country_code text,
        category     text,
        subtopic     text,
        question     text,
        answer       text,
        flow_type    text,
        source_name  text,
        updated_at   timestamptz,
        similarity   double precision
      )
      language sql
      stable
      as $body$
        select
          kf.flow_id,
          kf.country_code,
          kf.category,
          kf.subtopic,
          kf.question,
          kf.answer,
          kf.flow_type,
          kf.source_name,
          kf.updated_at,
          1 - (kf.embedding <=> query_embedding) as similarity
        from public.knowledge_flows kf
        where kf.country_code = filter_country
          and kf.embedding is not null
          and 1 - (kf.embedding <=> query_embedding) >= min_similarity
        order by kf.embedding <=> query_embedding asc
        limit match_count;
      $body$;
    $fn$;
  end if;
end
$do$;
