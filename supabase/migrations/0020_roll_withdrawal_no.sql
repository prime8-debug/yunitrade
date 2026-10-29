-- =====================================================================
-- Yards / Partial roll withdrawals record a Withdrawal No. (job order),
-- like Roll / PC withdrawals already do.
--
-- Old function signatures are dropped first so PostgREST doesn't see two
-- overloads. Safe to run more than once.
-- =====================================================================
alter table public.yards_transactions add column if not exists withdrawal_no text;
alter table public.partial_roll_transactions add column if not exists withdrawal_no text;

drop function if exists public.withdraw_yards(uuid, numeric, date, text, text);
drop function if exists public.withdraw_partial_roll(uuid, numeric, date, text, text);

create or replace function public.withdraw_yards(
  p_roll_id uuid, p_quantity numeric, p_entry_date date default current_date,
  p_customer text default null, p_remarks text default null, p_withdrawal_no text default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_remaining numeric;
begin
  if not public.is_active_user() then raise exception 'Not authorized'; end if;
  if p_quantity <= 0 then raise exception 'Quantity must be greater than 0'; end if;

  perform 1 from yards_rolls where id = p_roll_id for update;
  if not found then raise exception 'Roll not found'; end if;

  select coalesce(sum(quantity), 0) into v_remaining from yards_transactions where roll_id = p_roll_id;
  if p_quantity > v_remaining then
    raise exception 'Insufficient yards on this roll: % remaining, % requested', v_remaining, p_quantity;
  end if;

  insert into yards_transactions (roll_id, transaction_date, transaction_type, quantity, customer, withdrawal_no, remarks, created_by)
  values (p_roll_id, p_entry_date, 'WITHDRAWAL', -p_quantity, nullif(trim(p_customer), ''), nullif(trim(p_withdrawal_no), ''), p_remarks, auth.uid())
  returning id into v_id;

  insert into audit_logs (user_id, action, entity_type, entity_id, new_data)
  values (auth.uid(), 'CREATE', 'yards_transactions', v_id,
          jsonb_build_object('roll_id', p_roll_id, 'quantity', -p_quantity, 'customer', p_customer, 'withdrawal_no', p_withdrawal_no));

  return v_id;
end;
$$;

create or replace function public.withdraw_partial_roll(
  p_partial_roll_id uuid, p_quantity numeric, p_entry_date date default current_date,
  p_customer text default null, p_remarks text default null, p_withdrawal_no text default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_remaining numeric;
begin
  if not public.is_active_user() then raise exception 'Not authorized'; end if;
  if p_quantity <= 0 then raise exception 'Quantity must be greater than 0'; end if;

  perform 1 from partial_rolls where id = p_partial_roll_id for update;
  if not found then raise exception 'Partial roll not found'; end if;

  select coalesce(sum(quantity), 0) into v_remaining from partial_roll_transactions where partial_roll_id = p_partial_roll_id;
  if p_quantity > v_remaining then
    raise exception 'Insufficient quantity on this partial roll: % remaining, % requested', v_remaining, p_quantity;
  end if;

  insert into partial_roll_transactions (partial_roll_id, transaction_date, transaction_type, quantity, customer, withdrawal_no, remarks, created_by)
  values (p_partial_roll_id, p_entry_date, 'WITHDRAWAL', -p_quantity, nullif(trim(p_customer), ''), nullif(trim(p_withdrawal_no), ''), p_remarks, auth.uid())
  returning id into v_id;

  insert into audit_logs (user_id, action, entity_type, entity_id, new_data)
  values (auth.uid(), 'CREATE', 'partial_roll_transactions', v_id,
          jsonb_build_object('partial_roll_id', p_partial_roll_id, 'quantity', -p_quantity, 'customer', p_customer, 'withdrawal_no', p_withdrawal_no));

  return v_id;
end;
$$;

revoke execute on function public.withdraw_yards, public.withdraw_partial_roll from anon, public;
grant execute on function public.withdraw_yards, public.withdraw_partial_roll to authenticated;
