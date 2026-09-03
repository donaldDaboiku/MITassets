-- Recover MIT Asset data from Supabase (PostgreSQL)
-- Run in Supabase Dashboard → SQL Editor

-- 1) Check whether a backup exists
select
  workspace_id,
  updated_at,
  jsonb_array_length(coalesce(payload->'assets', '[]'::jsonb)) as assets,
  jsonb_array_length(coalesce(payload->'tasks', '[]'::jsonb)) as tasks,
  jsonb_array_length(coalesce(payload->'purchases', '[]'::jsonb)) as purchases
from public.mit_workspace
order by updated_at desc;

-- 2) If assets/tasks are 0, the cloud row is empty — nothing was pushed before cache clear.
--    If counts are > 0, data is still in PostgreSQL. Restore in the app:
--    Settings → paste Project URL + anon key → Storage → Restore from Cloud

-- 3) Export payload JSON for offline import (Storage → Import Backup)
select payload
from public.mit_workspace
where workspace_id = 'main';

-- 4) Optional: download one row as JSON from Table Editor
--    Table Editor → mit_workspace → row → copy payload column
--    Save as mit-asset-backup.json → MIT Asset → Storage → Import Backup
