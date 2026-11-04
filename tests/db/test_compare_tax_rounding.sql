-- Tax rounding per price (2026-11), and the upgrade from price_incl that always
-- rounded down. Runs after test_compare_phase3_online.sql (alphabetical), as postgres.
\set QUIET on
\pset tuples_only on
\pset format unaligned
set client_min_messages = notice;

-- Put the table back in the old shape: no tax_rounding, price_incl rounded down.
alter table public.chatak_cmp_prices drop column price_incl;
alter table public.chatak_cmp_prices drop column tax_rounding;
alter table public.chatak_cmp_prices add column price_incl integer generated always as (
  case when tax_basis = 'incl' then price else floor(price * (100 + tax_rate) / 100)::integer end) stored;
set role authenticated;
select t.signin('00000000-0000-0000-0000-00000000000a');
insert into chatak_cmp_prices (option_id, shop_name, price, tax_basis, source, note)
select id, 'Donki Musashi-Urawa', 898, 'excl', 'import', 'old row' from chatak_cmp_options where import_key = 'test:1';
reset role;
select t.ok((select price_incl from chatak_cmp_prices where note = 'old row') = 987, 'old shape: 898 + 10% rounded down to 987');

\ir ../../supabase/schema.sql
set client_min_messages = notice;
\ir ../../supabase/schema.sql
set client_min_messages = notice;

select t.ok((select tax_rounding from chatak_cmp_prices where note = 'old row') = 'down', 'upgrade: existing prices keep rounding down');
select t.ok((select price_incl from chatak_cmp_prices where note = 'old row') = 987, 'upgrade: existing price_incl unchanged');
update chatak_cmp_prices set tax_rounding = 'half_up' where note = 'old row';
select t.ok((select price_incl from chatak_cmp_prices where note = 'old row') = 988, 'half up: 898 → 988, as on the Donki tag');

set role authenticated;
select t.signin('00000000-0000-0000-0000-00000000000a');
insert into chatak_cmp_prices (option_id, shop_name, price, tax_basis, tax_rounding, source, note)
select id, 'Shop', v.price, 'excl', v.r, 'manual', 'case ' || v.price || ' ' || v.r
from chatak_cmp_options, (values (1235, 'half_up'), (1234, 'half_up'), (1234, 'up'), (1234, 'down'), (1490, 'half_up')) v(price, r)
where import_key = 'test:1';
insert into chatak_cmp_prices (option_id, shop_name, price, tax_basis, tax_rate, tax_rounding, source, note)
select id, 'Shop', 216, 'excl', 8, 'half_up', 'manual', 'eight' from chatak_cmp_options where import_key = 'test:1';
select t.ok((select price_incl from chatak_cmp_prices where note = 'case 1235 half_up') = 1359, 'half up: 1358.5 → 1359');
select t.ok((select price_incl from chatak_cmp_prices where note = 'case 1234 half_up') = 1357, 'half up: 1357.4 → 1357');
select t.ok((select price_incl from chatak_cmp_prices where note = 'case 1234 up') = 1358, 'up: 1357.4 → 1358');
select t.ok((select price_incl from chatak_cmp_prices where note = 'case 1234 down') = 1357, 'down: 1357.4 → 1357');
select t.ok((select price_incl from chatak_cmp_prices where note = 'case 1490 half_up') = 1639, 'exact: 1490 → 1639 under any rule');
select t.ok((select price_incl from chatak_cmp_prices where note = 'eight') = 233, '8%: 216 → 233.28 → 233');
select t.err($$ insert into chatak_cmp_prices (option_id, shop_name, price, tax_basis, tax_rounding)
                select id, 'Shop', 100, 'excl', 'nearest' from chatak_cmp_options where import_key = 'test:1' $$, '23514', 'unknown rounding refused');
reset role;
select t.ok((select count(*) from pg_constraint where conrelid = 'public.chatak_cmp_prices'::regclass
             and conname = 'chatak_cmp_prices_tax_rounding_check') = 1, 'one rounding check, not two');
