-- ============================================================
-- production_hardening — additive migration (Phase 10)
--
-- Moves Vayu Gati from "locally verified" to "safely deployable pilot":
-- fixes two real correctness bugs found during Phase 10's own RPC review,
-- tightens one storage-evidence-tamper gap, and adds the job-reliability /
-- system-health / feature-flag infrastructure a pilot deployment needs.
-- Nothing here is destructive — every change is additive or strictly
-- narrows an existing permission; no existing table, row, or working
-- behaviour is removed.
--
-- ---- Bugs fixed (found via a systematic replay/idempotency review of
-- every RPC — plan §7's "duplicate execution... replay risk") ----
--
-- 1. `dispatch_intervention_task` recomputed `status` from scratch on
--    EVERY call, with no check on the dispatch's CURRENT status first.
--    Calling it a second time on an action whose dispatch had already
--    progressed to `in_progress` (or any state beyond `routed`) would
--    silently REGRESS it back to `sent` and fire a SECOND `_send_task_
--    notification` call — a real duplicate-notification and lifecycle-
--    corruption bug, not a hypothetical one. Fixed: once a dispatch has
--    progressed past `routed` (i.e. status is anything other than null/
--    drafted/awaiting_approval/approved/routed), a repeat call now only
--    refreshes the routing/registry snapshot fields and returns — it never
--    touches status, timestamps, or notifications again.
-- 2. `transition_task_dispatch`'s own declared transition table didn't
--    allow `completed -> escalated`, but `escalate_stale_task_dispatches`
--    performed exactly that transition directly (bypassing
--    `transition_task_dispatch`'s validation, which the batch driver is
--    allowed to do, but the two must still agree on what's LEGAL). A
--    `completed` task whose verification SLA lapsed with nobody ever
--    confirming the outcome is a real, intended escalation case (plan §8:
--    "impact remains ineffective or inconclusive... after repeated
--    action") — fixed by declaring it as a legal transition, not by
--    disabling the escalation.
--
-- ---- Storage tightened ----
-- `report-photos` allowed an authenticated uploader to UPDATE or DELETE
-- their own object after the fact — unlike `incident_evidence`/
-- `action_evidence` (insert-only, immutable by design), a citizen could
-- silently swap or delete the underlying photo bytes behind an already-
-- submitted `photo_url` with no audit trail. Nothing in this app ever
-- calls storage update/delete (verified — only `.upload()` and
-- `.getPublicUrl()` are used), so removing both policies breaks no
-- existing behaviour and closes an evidence-integrity gap.
--
-- ---- New: job reliability (plan §11) ----
-- `job_runs` — one row per scheduled-job execution, with a PARTIAL UNIQUE
-- INDEX (`job_name, city_code) where status = 'running'`) as the actual
-- overlap guard: a second concurrent run for the same job+city fails the
-- INSERT rather than racing, which is a stronger, more portable guarantee
-- than a `pg_advisory_lock` would be here — every scheduled job in this
-- codebase is orchestrated from Python via the service_role PostgREST
-- client across MULTIPLE separate HTTP calls, not one long-lived psql
-- session, so a session-scoped advisory lock could vanish mid-job when
-- the connection pool recycles it. A unique index has no such failure mode.
--
-- ---- New: system health (plan §10) ----
-- `system_health_summary()` — a read-only rollup of each job's most recent
-- run, whether it's overdue for its expected cadence, and basic data-
-- freshness signals, callable by command/admin for the System Health
-- screen and by the ingest service's own `/health` endpoint.
--
-- ---- New: feature flags (plan §17) ----
-- `city_feature_enabled(city_id, flag, default)` reads
-- `city_config.config -> 'feature_flags' -> flag`, defaulting to the
-- caller-supplied default (never silently disabling something a city
-- never configured an opinion on). Wired into
-- `evaluate_station_pollutant_anomaly`, `run_incident_source_attribution`,
-- and `dispatch_intervention_task` — the three automated/operational
-- engines a pilot might need to pause without a redeploy.
--
-- Idempotent: safe to re-run and safe via `supabase db push`.
-- ============================================================

-- ============================================================
-- Input validation: bounded free-text columns (plan §7 — "bounded input
-- lengths"). A table-level CHECK protects every current AND future write
-- path into these columns (four separate task_dispatches functions write
-- reason/note fields; a per-function guard would need repeating four
-- times and could drift) rather than only the one function that happens
-- to be edited. `not valid` + `validate constraint` so this is safe even
-- if a table somehow already held a longer value (validated separately,
-- never blocking the additive ALTER itself) — though in practice every
-- Phase 9/10 table here is either brand new or still empty in any real
-- deployment (hosted is still on the Phase 0/1 schema per the Phase 10
-- preflight check).
-- ============================================================
do $$ begin
  alter table task_dispatches add constraint task_dispatches_reason_lengths check (
    (rejection_reason is null or char_length(rejection_reason) <= 2000) and
    (reroute_reason is null or char_length(reroute_reason) <= 2000) and
    (cancellation_reason is null or char_length(cancellation_reason) <= 2000) and
    (dispute_resolution_note is null or char_length(dispute_resolution_note) <= 2000) and
    (resource_note is null or char_length(resource_note) <= 2000) and
    (escalation_reason is null or char_length(escalation_reason) <= 2000)
  ) not valid;
exception when duplicate_object then null;
end $$;
alter table task_dispatches validate constraint task_dispatches_reason_lengths;

do $$ begin
  alter table incident_recurrence_reports add constraint incident_recurrence_reports_note_length
    check (note is null or char_length(note) <= 4000) not valid;
exception when duplicate_object then null;
end $$;
alter table incident_recurrence_reports validate constraint incident_recurrence_reports_note_length;

-- ============================================================
-- Storage: report-photos evidence-tamper fix
-- ============================================================
drop policy if exists report_photos_update on storage.objects;
drop policy if exists report_photos_delete on storage.objects;

-- ============================================================
-- job_runs — scheduled-job reliability tracking
-- ============================================================
create table if not exists job_runs (
  id             bigserial primary key,
  job_name       text not null check (job_name in (
    'ingest', 'anomaly_detection', 'forecast', 'attribution',
    'notifications', 'escalation'
  )),
  -- null = a job that isn't per-city (e.g. the notification drain, which
  -- processes every city's queued notifications in one pass)
  city_code      text,
  status         text not null default 'running' check (status in ('running', 'completed', 'failed')),
  started_at     timestamptz not null default now(),
  completed_at   timestamptz,
  duration_ms    int,
  rows_processed int,
  error_message  text,
  error_category text check (error_category is null or error_category in (
    'network', 'database', 'validation', 'timeout', 'provider', 'unknown'
  )),
  attempt        int not null default 1,
  correlation_id uuid not null default gen_random_uuid(),
  created_at     timestamptz not null default now()
);
-- The structural overlap guard (plan §11's "single-run protection"):
-- coalesce() so a null city_code (a non-per-city job) still gets exactly
-- one concurrent "running" row, same as a per-city job does for one city.
create unique index if not exists job_runs_one_running
  on job_runs (job_name, coalesce(city_code, '')) where status = 'running';
create index if not exists job_runs_lookup_idx on job_runs (job_name, city_code, started_at desc);

alter table job_runs enable row level security;
drop policy if exists job_runs_read on job_runs;
create policy job_runs_read on job_runs for select using (
  auth_role() in ('commander', 'admin')
);
-- No authenticated write policy — only the service_role connection (which
-- bypasses RLS entirely, same as every ingest write) ever inserts/updates
-- these rows. Matches forecast_runs/anomaly_candidates precedent exactly.

-- ============================================================
-- start_job_run / complete_job_run / fail_job_run
--
-- Not security definer — the ingest service calls these with its
-- service_role key, which bypasses RLS by definition (same reasoning as
-- every other ingest write in this codebase; these functions need no
-- special privilege escalation because the caller already has full access).
-- ============================================================
create or replace function start_job_run(p_job_name text, p_city_code text default null, p_attempt int default 1)
returns bigint language plpgsql as $$
declare v_id bigint;
begin
  begin
    insert into job_runs (job_name, city_code, status, attempt)
    values (p_job_name, p_city_code, 'running', p_attempt)
    returning id into v_id;
  exception when unique_violation then
    -- Another run for this job+city is already in progress — the caller
    -- must treat a null return as "skip this tick", never as an error to
    -- retry immediately (that would just contend the same lock again).
    return null;
  end;
  return v_id;
end $$;

create or replace function complete_job_run(p_run_id bigint, p_rows_processed int default null)
returns void language plpgsql as $$
begin
  if p_run_id is null then
    return; -- start_job_run returned null (lock contention) — nothing to complete
  end if;
  update job_runs set
    status = 'completed',
    completed_at = now(),
    duration_ms = extract(epoch from (now() - started_at))::int * 1000,
    rows_processed = p_rows_processed
  where id = p_run_id;
end $$;

create or replace function fail_job_run(p_run_id bigint, p_error_message text, p_error_category text default 'unknown')
returns void language plpgsql as $$
begin
  if p_run_id is null then
    return;
  end if;
  update job_runs set
    status = 'failed',
    completed_at = now(),
    duration_ms = extract(epoch from (now() - started_at))::int * 1000,
    error_message = left(coalesce(p_error_message, 'unknown error'), 2000),
    error_category = coalesce(p_error_category, 'unknown')
  where id = p_run_id;
end $$;

revoke all on function start_job_run(text, text, int) from public;
revoke all on function complete_job_run(bigint, int) from public;
revoke all on function fail_job_run(bigint, text, text) from public;
-- Deliberately NOT granted to authenticated — only service_role (which
-- ignores grants entirely) should ever start/complete/fail a job run; a
-- logged-in commander reads job_runs via RLS but never writes to it.

-- ============================================================
-- system_health_summary — read-only rollup for the System Health screen
-- and the ingest /health endpoint. SECURITY DEFINER + role check inside
-- (not RLS) because it aggregates across ALL cities' job_runs, which no
-- single-row RLS policy can express cleanly — mirrors
-- get_incident_responsible_authority's own "function computes, caller's
-- role is checked inside" shape for aggregate reads.
-- ============================================================
create or replace function system_health_summary()
returns table (
  job_name           text,
  city_code          text,
  last_status        text,
  last_started_at    timestamptz,
  last_completed_at  timestamptz,
  last_error_message text,
  is_stale           boolean
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_caller_role user_role;
  -- Expected cadence per job, used only to flag "is_stale" — a job that
  -- hasn't completed successfully within roughly 3x its own schedule
  -- interval is worth a human glancing at, not proof of an outage.
  v_stale_after interval;
begin
  if auth.uid() is not null then
    select role into v_caller_role from profiles where id = auth.uid();
    if coalesce(v_caller_role, 'citizen') not in ('commander', 'admin') then
      raise exception 'Only a commander or admin may read system health.' using errcode = 'insufficient_privilege';
    end if;
  end if;

  return query
  select distinct on (r.job_name, r.city_code)
    r.job_name, r.city_code, r.status, r.started_at, r.completed_at, r.error_message,
    (r.completed_at is null and r.started_at < now() - interval '2 hours')
      or (r.status = 'completed' and r.completed_at < now() -
          case r.job_name
            when 'ingest' then interval '3 hours'
            when 'forecast' then interval '3 hours'
            when 'anomaly_detection' then interval '3 hours'
            when 'attribution' then interval '3 hours'
            when 'notifications' then interval '30 minutes'
            when 'escalation' then interval '30 minutes'
            else interval '3 hours'
          end)
      or (r.status = 'failed')
      as is_stale
  from job_runs r
  order by r.job_name, r.city_code, r.started_at desc;
end $$;

revoke all on function system_health_summary() from public;
grant execute on function system_health_summary() to authenticated;

-- ============================================================
-- Feature flags (plan §17) — city_config.config -> 'feature_flags'
-- ============================================================
create or replace function city_feature_enabled(p_city_id int, p_flag text, p_default boolean default true)
returns boolean language sql stable as $$
  select coalesce(
    (select (config -> 'feature_flags' ->> p_flag)::boolean from city_config where id = p_city_id),
    p_default
  )
$$;

-- Delhi seed: every Phase 6-9 automated/operational engine explicitly
-- enabled by name, so a pilot operator can find and flip exactly one flag
-- without guessing whether an unset key means "on" or "off".
update city_config
set config = config || jsonb_build_object(
  'feature_flags', jsonb_build_object(
    'anomaly_detection', true,
    'validated_forecasting', true,
    'source_attribution', true,
    'citizen_evidence_missions', true,
    'operational_dispatch', true,
    'automatic_escalation', true,
    'notifications_email', true,
    'notifications_sms', false,
    'notifications_whatsapp', false
  )
)
where city_code = 'delhi'
  and not (config ? 'feature_flags');

-- ============================================================
-- Fix 1: dispatch_intervention_task — idempotent/replay-safe
-- ============================================================
create or replace function dispatch_intervention_task(
  p_action_id bigint,
  p_actor_id  uuid
) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_caller_role      user_role;
  v_action           actions%rowtype;
  v_incident         incidents%rowtype;
  v_config           jsonb;
  v_approval_types   text[];
  v_route            record;
  v_requires_approval boolean;
  v_dispatch_id      bigint;
  v_existing_status  task_dispatch_status;
  v_status           task_dispatch_status;
  v_sla              record;
  v_now              timestamptz := now();
  v_past_routing     boolean;
begin
  select role into v_caller_role from profiles where id = p_actor_id;
  if coalesce(v_caller_role, 'citizen') not in ('commander', 'admin') then
    raise exception 'Only a commander or admin may dispatch an intervention task.'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_action from actions where id = p_action_id;
  if not found then
    raise exception 'Action % not found', p_action_id;
  end if;
  if v_action.incident_id is null then
    raise exception 'Action % is not incident-linked; dispatch does not apply to legacy report-scoped actions', p_action_id;
  end if;
  select * into v_incident from incidents where id = v_action.incident_id;

  if not city_feature_enabled(v_incident.city_id, 'operational_dispatch', true) then
    raise exception 'Operational dispatch is disabled for this city (feature flag).' using errcode = 'feature_not_supported';
  end if;

  select id, status into v_dispatch_id, v_existing_status
  from task_dispatches where action_id = p_action_id and is_current;

  -- Idempotency / replay safety (Phase 10, plan §7): once a dispatch has
  -- actually progressed past routing (sent, or anywhere further along the
  -- lifecycle, including rejected/rerouted/cancelled/escalated/overdue), a
  -- repeat call — a retried client request, a double-click, a re-run of an
  -- automation — must NEVER re-fire a notification or regress status back
  -- to 'sent'. Only drafted/awaiting_approval/approved/routed (still
  -- genuinely pre-dispatch) or a brand-new action may proceed past here.
  v_past_routing := v_existing_status is not null
    and v_existing_status not in ('drafted', 'awaiting_approval', 'approved', 'routed');

  select coalesce(config, '{}'::jsonb) into v_config from city_config where id = v_incident.city_id;
  v_approval_types := array(
    select jsonb_array_elements_text(
      coalesce(v_config -> 'dispatch' -> 'requires_approval_types',
               '["penalty","stop_work","closure","restriction","prosecution","sprinkle"]'::jsonb)
    )
  );
  v_requires_approval := v_action.type = any (v_approval_types);

  select * into v_route from _resolve_task_routing(p_action_id);

  if v_past_routing then
    -- Safe to refresh the routing/registry snapshot (agency names, backup
    -- contacts etc. may have changed since) — status, timestamps and
    -- notifications are frozen once real dispatch has happened.
    update task_dispatches set
      registry_id = v_route.registry_id, routing_confidence = v_route.routing_confidence,
      routing_evidence = v_route.routing_evidence, physical_location = v_route.physical_location,
      asset_description = v_route.asset_description, responsible_agency = v_route.responsible_agency,
      division_zone = v_route.division_zone, backup_agency = v_route.backup_agency, backup_team = v_route.backup_team,
      updated_at = v_now
    where id = v_dispatch_id;
    return v_dispatch_id;
  end if;

  -- ---- status decision (plan §3/§5) ----
  if v_requires_approval and v_action.approved_by is null then
    v_status := 'awaiting_approval';
  elsif v_route.routing_confidence = 'unresolved' then
    -- "unresolved routing must not silently dispatch" — stays drafted,
    -- flagged, never advances on its own.
    v_status := 'drafted';
  elsif v_route.routing_confidence = 'disputed' then
    -- "disputed cases should go to command review" — same state as
    -- awaiting approval (a human must look at it), distinguishable via
    -- routing_confidence itself.
    v_status := 'awaiting_approval';
  else
    v_status := 'routed';
  end if;

  -- ---- SLA (plan §7): most specific matching rule wins ----
  select * into v_sla
  from sla_rules
  where is_active
    and (city_id is null or city_id = v_incident.city_id)
    and (severity is null or severity = v_incident.severity)
    and (source_category is null or source_category = (
      select h.source_category from incident_source_hypotheses h
      where h.incident_id = v_incident.id and h.is_current order by h.probability desc limit 1
    ))
    and (evidence_level is null or evidence_level = v_incident.source_confidence)
    and (action_type is null or action_type = v_action.type)
    and (agency is null or agency = v_route.responsible_agency)
  order by priority desc
  limit 1;
  -- documented fallback when no rule matches at all — never leave a
  -- dispatch with no SLA target.
  if v_sla.id is null then
    v_sla.ack_hours := 2; v_sla.accept_hours := 4; v_sla.arrival_hours := 8;
    v_sla.completion_hours := 24; v_sla.verification_hours := 72;
  end if;

  -- ---- idempotent create-or-update ----
  if v_dispatch_id is null then
    insert into task_dispatches (
      action_id, incident_id, city_id, ward_id, registry_id,
      routing_confidence, routing_evidence, physical_location, asset_description,
      responsible_agency, division_zone, primary_officer, primary_team, backup_agency, backup_team,
      status, requires_approval, approved_by, approved_at, routed_at,
      sla_ack_due_at, sla_accept_due_at, sla_arrival_due_at, sla_completion_due_at, sla_verification_due_at,
      created_by
    ) values (
      p_action_id, v_incident.id, v_incident.city_id, v_incident.ward_id, v_route.registry_id,
      v_route.routing_confidence, v_route.routing_evidence, v_route.physical_location, v_route.asset_description,
      v_route.responsible_agency, v_route.division_zone, v_route.primary_officer, v_route.primary_team, v_route.backup_agency, v_route.backup_team,
      v_status, v_requires_approval, v_action.approved_by, v_action.approved_at, case when v_status = 'routed' then v_now else null end,
      v_now + (v_sla.ack_hours * interval '1 hour'), v_now + (v_sla.accept_hours * interval '1 hour'),
      v_now + (v_sla.arrival_hours * interval '1 hour'), v_now + (v_sla.completion_hours * interval '1 hour'),
      v_now + (v_sla.verification_hours * interval '1 hour'),
      p_actor_id
    ) returning id into v_dispatch_id;
  else
    update task_dispatches set
      registry_id = v_route.registry_id, routing_confidence = v_route.routing_confidence,
      routing_evidence = v_route.routing_evidence, physical_location = v_route.physical_location,
      asset_description = v_route.asset_description, responsible_agency = v_route.responsible_agency,
      division_zone = v_route.division_zone, primary_officer = v_route.primary_officer,
      primary_team = v_route.primary_team, backup_agency = v_route.backup_agency, backup_team = v_route.backup_team,
      status = v_status, requires_approval = v_requires_approval,
      approved_by = v_action.approved_by, approved_at = v_action.approved_at,
      routed_at = case when v_status = 'routed' and routed_at is null then v_now else routed_at end,
      updated_at = v_now
    where id = v_dispatch_id;
  end if;

  insert into incident_events (incident_id, event_type, actor_id, note, is_public, payload)
  values (
    v_incident.id, 'routing_decision', p_actor_id,
    format('Routing resolved as %s%s.', v_route.routing_confidence,
      case when v_route.responsible_agency is not null then format(' — %s', v_route.responsible_agency) else '' end),
    false,
    jsonb_build_object('task_dispatch_id', v_dispatch_id, 'routing_confidence', v_route.routing_confidence, 'registry_id', v_route.registry_id)
  );

  if v_status = 'routed' then
    perform _send_task_notification(v_dispatch_id, v_route.primary_officer, 'task_routed',
      format('A %s intervention has been routed to you.', v_action.type));
    update task_dispatches set status = 'sent', sent_at = v_now, updated_at = v_now where id = v_dispatch_id;
    insert into incident_events (incident_id, event_type, actor_id, note, is_public, payload)
      values (v_incident.id, 'dispatch', p_actor_id, 'Intervention dispatched to the responsible unit.', true,
        jsonb_build_object('task_dispatch_id', v_dispatch_id));
  end if;

  return v_dispatch_id;
end $$;

-- ============================================================
-- Fix 2: transition_task_dispatch — completed -> escalated is legal
-- (matches what escalate_stale_task_dispatches already does; previously
-- undeclared in this function's own transition table, an inconsistency
-- between the two write paths)
-- ============================================================
create or replace function transition_task_dispatch(
  p_dispatch_id bigint,
  p_new_status  task_dispatch_status,
  p_actor_id    uuid,
  p_reason      text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_d              task_dispatches%rowtype;
  v_caller_role    user_role;
  v_is_officer     boolean;
  v_allowed        boolean := false;
  v_now            timestamptz := now();
begin
  select * into v_d from task_dispatches where id = p_dispatch_id and is_current;
  if not found then
    raise exception 'Task dispatch % not found (or no longer current)', p_dispatch_id;
  end if;

  select role into v_caller_role from profiles where id = p_actor_id;
  v_is_officer := (v_d.primary_officer = p_actor_id);

  -- ---- transition table ----
  v_allowed := case v_d.status
    when 'drafted'              then p_new_status in ('awaiting_approval', 'routed', 'cancelled')
    when 'awaiting_approval'    then p_new_status in ('approved', 'rejected', 'cancelled')
    when 'approved'             then p_new_status in ('routed', 'cancelled')
    when 'routed'               then p_new_status in ('sent', 'rerouted', 'cancelled')
    when 'sent'                 then p_new_status in ('acknowledged', 'rerouted', 'cancelled', 'overdue')
    when 'acknowledged'         then p_new_status in ('accepted', 'rejected', 'rerouted', 'overdue')
    when 'accepted'             then p_new_status in ('in_progress', 'rejected', 'overdue', 'escalated')
    when 'in_progress'          then p_new_status in ('completed', 'escalated', 'overdue')
    when 'completed'            then p_new_status in ('verification_pending', 'escalated')
    when 'verification_pending' then p_new_status = 'escalated'
    when 'overdue'              then p_new_status in ('acknowledged', 'accepted', 'in_progress', 'escalated', 'cancelled')
    when 'escalated'            then p_new_status in ('rerouted', 'cancelled', 'approved', 'acknowledged', 'accepted')
    when 'rejected'             then p_new_status in ('rerouted', 'cancelled')
    when 'rerouted'             then p_new_status = 'drafted'
    when 'cancelled'            then false
    else false
  end;

  if not v_allowed then
    raise exception 'Cannot move a task dispatch from "%" to "%".', v_d.status, p_new_status
      using errcode = 'check_violation';
  end if;

  -- ---- authorization per transition ----
  if p_new_status in ('approved', 'routed', 'sent', 'escalated', 'cancelled') and coalesce(v_caller_role, 'citizen') not in ('commander', 'admin') then
    raise exception 'Only a commander or admin may set status "%".', p_new_status using errcode = 'insufficient_privilege';
  end if;
  if p_new_status in ('acknowledged', 'accepted', 'in_progress') and not (v_is_officer or coalesce(v_caller_role, 'citizen') in ('commander', 'admin')) then
    raise exception 'Only the assigned officer (or command) may set status "%".', p_new_status using errcode = 'insufficient_privilege';
  end if;
  if p_new_status = 'rerouted' and coalesce(v_caller_role, 'citizen') not in ('commander', 'admin') then
    raise exception 'Only a commander or admin may reroute a task.' using errcode = 'insufficient_privilege';
  end if;

  -- ---- mandatory reasons ----
  if p_new_status in ('rejected', 'rerouted', 'cancelled') and coalesce(trim(p_reason), '') = '' then
    raise exception '"%" requires a reason.' , p_new_status using errcode = 'check_violation';
  end if;
  -- Input validation (Phase 10, plan §7): a free-text reason is still
  -- attacker/mistake-reachable input — bound it rather than trust an
  -- unbounded client payload straight into a text column.
  if p_reason is not null and length(p_reason) > 2000 then
    raise exception 'Reason text is too long (max 2000 characters).' using errcode = 'check_violation';
  end if;

  update task_dispatches set
    status = p_new_status,
    acknowledged_at = case when p_new_status = 'acknowledged' then v_now else acknowledged_at end,
    accepted_at     = case when p_new_status = 'accepted' then v_now else accepted_at end,
    arrived_at      = case when p_new_status = 'in_progress' and arrived_at is null then v_now else arrived_at end,
    started_at      = case when p_new_status = 'in_progress' then v_now else started_at end,
    completed_at    = case when p_new_status = 'completed' then v_now else completed_at end,
    verification_requested_at = case when p_new_status = 'verification_pending' then v_now else verification_requested_at end,
    verified_at     = case when p_new_status = 'verification_pending' and v_d.status = 'completed' then v_now else verified_at end,
    escalated_at    = case when p_new_status = 'escalated' then v_now else escalated_at end,
    escalation_level = case when p_new_status = 'escalated' then escalation_level + 1 else escalation_level end,
    escalation_reason = case when p_new_status = 'escalated' then coalesce(p_reason, escalation_reason) else escalation_reason end,
    rejection_reason  = case when p_new_status = 'rejected' then p_reason else rejection_reason end,
    reroute_reason    = case when p_new_status = 'rerouted' then p_reason else reroute_reason end,
    cancellation_reason = case when p_new_status = 'cancelled' then p_reason else cancellation_reason end,
    approved_by = case when p_new_status = 'approved' then p_actor_id else approved_by end,
    approved_at = case when p_new_status = 'approved' then v_now else approved_at end,
    updated_at = v_now
  where id = p_dispatch_id;

  -- keep actions.workflow_status in sync for the states the two concepts
  -- share (Phase 4's own trigger, enforce_incident_action_rules, still
  -- governs what actions.workflow_status may legally hold — this update is
  -- subject to that trigger exactly like any other, unchanged).
  if p_new_status in ('accepted', 'in_progress') then
    update actions set workflow_status = p_new_status::text::action_workflow_status where id = v_d.action_id;
  end if;

  insert into incident_events (incident_id, event_type, actor_id, note, is_public, payload)
  values (
    v_d.incident_id,
    case p_new_status
      when 'approved' then 'approval' when 'sent' then 'dispatch'
      when 'acknowledged' then 'acknowledgement' when 'accepted' then 'acceptance'
      when 'rejected' then 'rejection' when 'rerouted' then 'rerouting'
      when 'escalated' then 'escalation' when 'completed' then 'completion'
      when 'cancelled' then 'cancellation' else 'status_changed'
    end,
    p_actor_id,
    format('Task %s%s.', p_new_status, case when p_reason is not null then ': ' || p_reason else '' end),
    p_new_status in ('sent', 'acknowledged', 'accepted', 'in_progress', 'completed', 'verification_pending'),
    jsonb_build_object('task_dispatch_id', p_dispatch_id, 'status', p_new_status)
  );

  -- plan §8: "escalate when action is completed without required evidence" —
  -- fires immediately (not on an SLA timer) so a bare "completed" claim with
  -- nothing behind it surfaces to command right away rather than waiting for
  -- the verification-SLA clock to run out.
  if p_new_status = 'completed'
     and not exists (select 1 from action_evidence where action_id = v_d.action_id)
     and (select proof_url from actions where id = v_d.action_id) is null
  then
    update task_dispatches set
      escalation_level = escalation_level + 1,
      escalation_reason = 'Marked completed with no attached evidence (no action_evidence rows, no proof_url).',
      updated_at = v_now
    where id = p_dispatch_id;

    insert into incident_events (incident_id, event_type, actor_id, note, is_public, payload)
    values (v_d.incident_id, 'escalation', null,
      'Task marked completed without required evidence — flagged for command review.', false,
      jsonb_build_object('task_dispatch_id', p_dispatch_id, 'reason', 'completed_without_evidence'));
  end if;
end $$;

-- ============================================================
-- Feature-flag wiring + per-iteration failure isolation: anomaly
-- detection + source attribution.
--
-- Gated at the BATCH-DRIVER level (`run_anomaly_detection`/
-- `run_incident_source_attribution`), not inside the deep per-station/
-- per-incident rule engines (`evaluate_station_pollutant_anomaly`/
-- `calculate_incident_source_attribution`) — those functions are 400+
-- lines each and reproducing them just to add a 3-line guard would be
-- needless risk for no benefit; skipping a city entirely at the
-- orchestration layer has the exact same practical effect ("this engine
-- does nothing for this city while the flag is off") with a far smaller,
-- easier-to-audit diff.
--
-- Per-iteration isolation fix (plan §11 — "isolate one-city failure from
-- other cities"): previously, an unhandled exception evaluating ONE
-- station+pollutant (or ONE incident) aborted the entire function call —
-- and with it, the whole transaction, silently discarding every OTHER
-- city's results in the same batch. Each iteration now runs inside its
-- own sub-transaction (`begin...exception...end`); a failure is logged via
-- RAISE WARNING (visible in Postgres/Supabase logs with the failing id)
-- and the loop continues — one bad station or incident can no longer take
-- the rest of the batch down with it.
-- ============================================================
-- NOTE: run_anomaly_detection is defined twice in this migration.
-- This first definition (pre-is_active) is immediately superseded by the
-- second definition after the ALTER TABLE at line 854 adds stations.is_active.
-- The second definition adds `and s.is_active` to the WHERE clause and is
-- the one Postgres keeps. Editing this copy has no effect — edit the second.
create or replace function run_anomaly_detection(p_city_code text default null)
returns table (station_id bigint, pollutant text, candidate_id bigint)
language plpgsql security definer set search_path = public as $$
declare
  v_caller_role user_role;
  r record;
  v_cid bigint;
begin
  if auth.uid() is not null then
    select role into v_caller_role from profiles where id = auth.uid();
    if coalesce(v_caller_role, 'citizen') not in ('commander', 'admin') then
      raise exception 'Only a commander or admin may run anomaly detection.'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  for r in
    select s.id as station_id, unnest(c.pollutant_priority) as pollutant
    from stations s
    join wards w on w.id = s.ward_id
    join city_config c on c.id = w.city_id
    where c.is_active
      and (p_city_code is null or c.city_code = p_city_code)
      and city_feature_enabled(c.id, 'anomaly_detection', true)
  loop
    begin
      station_id := r.station_id;
      pollutant := r.pollutant;
      candidate_id := evaluate_station_pollutant_anomaly(r.station_id, r.pollutant);
      return next;
    exception when others then
      raise warning 'run_anomaly_detection: station % pollutant % failed: %', r.station_id, r.pollutant, sqlerrm;
    end;
  end loop;
end $$;

create or replace function run_incident_source_attribution(
  p_city_code text default null,
  p_force boolean default false
) returns table (incident_id bigint)
language plpgsql security definer set search_path = public as $$
declare
  v_caller_role user_role;
  r record;
begin
  if auth.uid() is not null then
    select role into v_caller_role from profiles where id = auth.uid();
    if coalesce(v_caller_role, 'citizen') not in ('commander', 'admin') then
      raise exception 'Only a commander or admin may run source attribution.'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  for r in
    select i.id
    from incidents i
    left join wards w on w.id = i.ward_id
    left join city_config c on c.id = coalesce(i.city_id, w.city_id)
    where i.status <> 'closed'
      and (p_city_code is null or c.city_code = p_city_code)
      and (c.is_active is null or c.is_active)
      and (c.id is null or city_feature_enabled(c.id, 'source_attribution', true))
  loop
    begin
      incident_id := r.id;
      perform calculate_incident_source_attribution(r.id, p_force);
      return next;
    exception when others then
      raise warning 'run_incident_source_attribution: incident % failed: %', r.id, sqlerrm;
    end;
  end loop;
end $$;

-- Same per-iteration isolation fix applied to the escalation batch driver.
create or replace function escalate_stale_task_dispatches(p_city_code text default null)
returns table (dispatch_id bigint, new_status task_dispatch_status)
language plpgsql security definer set search_path = public as $$
declare
  v_caller_role user_role;
  r record;
begin
  if auth.uid() is not null then
    select role into v_caller_role from profiles where id = auth.uid();
    if coalesce(v_caller_role, 'citizen') not in ('commander', 'admin') then
      raise exception 'Only a commander or admin may run escalation.' using errcode = 'insufficient_privilege';
    end if;
  end if;

  for r in
    select d.id, d.incident_id, d.status, d.city_id,
      case
        when d.status = 'sent' and d.sla_ack_due_at < now() then 'overdue'
        when d.status = 'acknowledged' and d.sla_accept_due_at < now() then 'overdue'
        when d.status in ('accepted') and d.sla_arrival_due_at < now() then 'overdue'
        when d.status = 'in_progress' and d.sla_completion_due_at < now() then 'overdue'
        when d.status = 'completed' and d.sla_verification_due_at < now() then 'escalated'
        when d.status = 'overdue' and d.escalation_level = 0 then 'escalated'
      end as target_status
    from task_dispatches d
    join incidents i on i.id = d.incident_id
    join city_config c on c.id = i.city_id
    where d.is_current
      and (p_city_code is null or c.city_code = p_city_code)
      and d.status in ('sent', 'acknowledged', 'accepted', 'in_progress', 'completed', 'overdue')
      and city_feature_enabled(i.city_id, 'automatic_escalation', true)
  loop
    if r.target_status is null then
      continue;
    end if;

    begin
      dispatch_id := r.id;
      new_status := r.target_status::task_dispatch_status;

      update task_dispatches set
        status = new_status,
        escalated_at = case when new_status = 'escalated' then now() else escalated_at end,
        escalation_level = case when new_status = 'escalated' then escalation_level + 1 else escalation_level end,
        escalation_reason = case when new_status = 'escalated' then 'SLA deadline missed' else escalation_reason end,
        updated_at = now()
      where id = r.id;

      insert into incident_events (incident_id, event_type, actor_id, note, is_public, payload)
      values (r.incident_id, case when new_status = 'escalated' then 'escalation' else 'status_changed' end, null,
        format('Task automatically marked %s: SLA deadline missed.', new_status), false,
        jsonb_build_object('task_dispatch_id', r.id, 'status', new_status));

      return next;
    exception when others then
      raise warning 'escalate_stale_task_dispatches: dispatch % failed: %', r.id, sqlerrm;
    end;
  end loop;
end $$;

-- ============================================================
-- Feature-flag + input-validation wiring: submit_citizen_verification.
-- Gating a citizen-facing SUBMISSION path (rather than the automated
-- mission-recommendation step buried inside the 400+ line attribution
-- engine) is both the more practical edit and arguably the more useful
-- flag in practice: a pilot that wants to pause new citizen evidence
-- submissions can, while existing missions keep displaying normally.
-- ============================================================
create or replace function submit_citizen_verification(
  p_mission_id bigint,
  p_outcome    text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_m evidence_missions%rowtype;
  v_city_id int;
begin
  if p_outcome not in ('confirmed', 'rejected', 'unresolved') then
    raise exception 'Invalid outcome "%"', p_outcome;
  end if;

  select * into v_m from evidence_missions where id = p_mission_id;
  if not found then
    raise exception 'Mission % not found', p_mission_id;
  end if;

  select coalesce(i.city_id, w.city_id) into v_city_id
  from incidents i left join wards w on w.id = i.ward_id
  where i.id = v_m.incident_id;
  if v_city_id is not null and not city_feature_enabled(v_city_id, 'citizen_evidence_missions', true) then
    raise exception 'Citizen evidence missions are disabled for this city (feature flag).' using errcode = 'feature_not_supported';
  end if;

  -- security definer bypasses RLS: these checks are the whole guard.
  if v_m.assigned_to is distinct from auth.uid() then
    raise exception 'This verification request is not addressed to you';
  end if;
  if v_m.mission_type <> 'citizen_verification' then
    raise exception 'Mission % is not a citizen verification request', p_mission_id;
  end if;
  if v_m.status in ('completed', 'cancelled') then
    raise exception 'This verification request is already closed';
  end if;

  update evidence_missions
     set status             = 'completed',
         outcome            = p_outcome,
         checklist_response = jsonb_build_object('citizen_answer', p_outcome),
         completed_at       = now()
   where id = p_mission_id;

  insert into incident_evidence (incident_id, evidence_type, supports, collected_by, payload)
  values (
    v_m.incident_id,
    'citizen_report',
    case p_outcome when 'confirmed' then true when 'rejected' then false else null end,
    auth.uid(),
    jsonb_build_object('mission_id', p_mission_id, 'citizen_answer', p_outcome, 'authorised_officer', false)
  );

  insert into incident_events (incident_id, event_type, actor_id, note, is_public, payload)
  values (
    v_m.incident_id, 'evidence_added', auth.uid(),
    'A citizen answered a verification request.', true,
    jsonb_build_object('citizen_answer', p_outcome)
  );
end $$;

-- ============================================================
-- stations.is_active — "station activation" (plan §18's pilot admin
-- surface asks for this explicitly). Additive, defaults true so every
-- existing station keeps reporting exactly as before; a command/admin can
-- now pause ingestion attention on a station known to be faulty/offline
-- without deleting its history. Not enforced inside ingest.py itself in
-- this pass (that would touch the ingestion pipeline's own station-loop
-- logic, out of scope for a schema-level pilot control) — enforced at the
-- detection layer instead: run_anomaly_detection's own station loop skips
-- inactive stations, so a paused station stops FEEDING anomaly detection
-- immediately even before ingest.py is updated to skip fetching it.
-- ============================================================
alter table stations add column if not exists is_active boolean not null default true;

create or replace function run_anomaly_detection(p_city_code text default null)
returns table (station_id bigint, pollutant text, candidate_id bigint)
language plpgsql security definer set search_path = public as $$
declare
  v_caller_role user_role;
  r record;
  v_cid bigint;
begin
  if auth.uid() is not null then
    select role into v_caller_role from profiles where id = auth.uid();
    if coalesce(v_caller_role, 'citizen') not in ('commander', 'admin') then
      raise exception 'Only a commander or admin may run anomaly detection.'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  for r in
    select s.id as station_id, unnest(c.pollutant_priority) as pollutant
    from stations s
    join wards w on w.id = s.ward_id
    join city_config c on c.id = w.city_id
    where c.is_active
      and s.is_active
      and (p_city_code is null or c.city_code = p_city_code)
      and city_feature_enabled(c.id, 'anomaly_detection', true)
  loop
    begin
      station_id := r.station_id;
      pollutant := r.pollutant;
      candidate_id := evaluate_station_pollutant_anomaly(r.station_id, r.pollutant);
      return next;
    exception when others then
      raise warning 'run_anomaly_detection: station % pollutant % failed: %', r.station_id, r.pollutant, sqlerrm;
    end;
  end loop;
end $$;

-- `stations` has a broad authenticated READ policy (reference data) but
-- NO authenticated write policy at all — only the service_role ingest
-- connection has ever written to it. Rather than adding a table-level
-- RLS UPDATE policy (which would open every column, not just is_active,
-- to a commander's direct edit), a narrow function matches this
-- codebase's established discipline (task_dispatches, notifications, etc.
-- — the function is the only write path).
create or replace function set_station_active(p_station_id int, p_is_active boolean, p_actor_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_caller_role user_role;
begin
  select role into v_caller_role from profiles where id = p_actor_id;
  if coalesce(v_caller_role, 'citizen') not in ('commander', 'admin') then
    raise exception 'Only a commander or admin may activate/deactivate a station.' using errcode = 'insufficient_privilege';
  end if;
  update stations set is_active = p_is_active where id = p_station_id;
end $$;

revoke all on function set_station_active(int, boolean, uuid) from public;
grant execute on function set_station_active(int, boolean, uuid) to authenticated;
