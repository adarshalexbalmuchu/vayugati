-- Atomic report status transition: updates reports.status AND inserts a
-- report_events audit row in a single transaction. Replaces the two
-- sequential client-side calls in data.ts updateReportStatus(), which had
-- no error check between them — a failure on the first write could leave
-- the audit log recording a transition that never took effect, or a network
-- drop between the two writes could update status with no audit record.
--
-- Called as: supabase.rpc('update_report_status', { p_report_id, p_status,
--            p_actor_id, p_note })
-- Returns void. Raises an exception (surfaced as a PostgREST 4xx) if the
-- report row doesn't exist.

create or replace function update_report_status(
  p_report_id  int,
  p_status     report_status,
  p_actor_id   uuid,
  p_note       text default null
)
returns void
language plpgsql
security definer
as $$
begin
  update reports
  set status = p_status
  where id = p_report_id;

  if not found then
    raise exception 'report % not found', p_report_id;
  end if;

  insert into report_events (report_id, status, actor_id, note)
  values (p_report_id, p_status, p_actor_id, p_note);
end;
$$;
