-- Usuarios del panel /admin gestionables desde la propia página.
-- Sustituye (y tiene prioridad sobre) la variable de entorno ADMIN_USERS, que
-- se mantiene como respaldo para no quedarse fuera si la tabla está vacía.
--
-- Idempotente y no destructiva. Solo crea un objeto nuevo de Aldeas; no toca
-- ninguna tabla existente ni nada del otro bot.
--
-- La contraseña NUNCA se guarda en claro: se almacena como scrypt$salt$hash.
-- countries: '*' (todos) o códigos ISO separados por '|', p. ej. 'PE|CO'.

create table if not exists public.admin_users (
  id            uuid        not null default gen_random_uuid(),
  username      text        not null,
  password_hash text        not null,
  countries     text        not null default '*',
  active        boolean     not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (id)
);

create unique index if not exists admin_users_username_key
  on public.admin_users (lower(username));
