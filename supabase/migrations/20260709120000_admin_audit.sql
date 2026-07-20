-- Bitácora de auditoría del panel /admin: quién entró, qué conversación abrió
-- y qué descargó. Datos sensibles de familias => conviene poder rendir cuentas.
--
-- Idempotente y no destructiva (CREATE ... IF NOT EXISTS). Solo crea un objeto
-- nuevo de Aldeas; no toca ninguna tabla existente ni nada del otro bot.
-- Si esta tabla no existe, el panel sigue funcionando y la auditoría queda
-- únicamente en los logs de Railway.

create table if not exists public.admin_audit (
  id           uuid        not null default gen_random_uuid(),
  admin_user   text,                      -- usuario del panel que hizo la acción
  action       text        not null,      -- inicio_sesion | login_fallido | ver_conversacion | descargar_excel
  country_code text,                      -- país sobre el que actuó (si aplica)
  target_user  text,                      -- número de WhatsApp consultado (si aplica)
  ip           text,
  details      jsonb       not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  primary key (id)
);

-- Consulta habitual: los eventos más recientes primero.
create index if not exists admin_audit_created_at_idx
  on public.admin_audit (created_at desc);

-- Para filtrar por persona o por conversación auditada.
create index if not exists admin_audit_admin_user_idx
  on public.admin_audit (admin_user, created_at desc);
