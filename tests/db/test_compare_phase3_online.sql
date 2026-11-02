-- Online options without a link, and the upgrade from the first schema that
-- required one. Runs after test_compare_phase1.sql (alphabetical), as postgres.
\set QUIET on
\pset tuples_only on
\pset format unaligned
set client_min_messages = notice;

-- Put the database back in the first version's shape: the old rule, no new one.
alter table public.chatak_cmp_options drop constraint chatak_cmp_options_online_source;
alter table public.chatak_cmp_options add constraint chatak_cmp_options_check2
  check (source_kind <> 'online' or (store_id is not null and url is not null)) not valid;
select t.ok((select count(*) from pg_constraint where conrelid = 'public.chatak_cmp_options'::regclass
             and pg_get_constraintdef(oid) like '%url IS NOT NULL%') = 1, 'old shape restored for the upgrade test');

\ir ../../supabase/schema.sql
set client_min_messages = notice;

select t.ok((select count(*) from pg_constraint where conrelid = 'public.chatak_cmp_options'::regclass
             and pg_get_constraintdef(oid) like '%url IS NOT NULL%') = 0, 'upgrade removes the store-and-link rule');
select t.ok((select count(*) from pg_constraint where conrelid = 'public.chatak_cmp_options'::regclass
             and conname = 'chatak_cmp_options_online_source') = 1, 'upgrade adds the store-or-seller rule');
select t.ok((select count(*) from pg_constraint where conrelid = 'public.chatak_cmp_options'::regclass
             and pg_get_constraintdef(oid) like '%source_kind <> ''shop''%') = 1, 'the in-shop rule is untouched');

set role authenticated;
select t.signin('00000000-0000-0000-0000-00000000000a');
insert into chatak_cmp_options (category_id, name, source_kind, store_id, pack_qty, pack_unit, import_key)
select id, 'ProCase folio 9.7"', 'online', 2, 1, 'pc', 'test:1' from chatak_cmp_categories where name = 'Slicer';
insert into chatak_cmp_options (category_id, name, source_kind, shop_name, pack_qty, pack_unit, import_key)
select id, 'MC-AA01-AA cover, blue', 'online', 'ANA Mall', 1, 'pc', 'test:2' from chatak_cmp_categories where name = 'Slicer';
select t.ok((select count(*) from chatak_cmp_options where import_key like 'test:%') = 2, 'online without a link: by store, or by seller name');
select t.err($$ insert into chatak_cmp_options (category_id, name, source_kind, store_id, pack_qty, pack_unit, import_key)
                select id, 'twin', 'online', 2, 1, 'pc', 'test:1' from chatak_cmp_categories where name = 'Slicer' $$, '23505', 'same import key twice refused');
-- A price for a seller-by-name option.
insert into chatak_cmp_prices (option_id, shop_name, price, tax_basis, price_kind, source)
select id, 'Zojirushi official', 1210, 'incl', 'online', 'import' from chatak_cmp_options where import_key = 'test:2';
select t.ok((select price_incl from chatak_cmp_prices where shop_name = 'Zojirushi official') = 1210, 'price from a seller by name');
reset role;

-- Phase 4: the request id an option sent to Cost.
set role authenticated;
select t.signin('00000000-0000-0000-0000-00000000000a');
update chatak_cmp_options set wish_request_id = 'cmp_test1', wish_sent_at = now() where import_key = 'test:1';
select t.ok((select wish_request_id from chatak_cmp_options where import_key = 'test:1') = 'cmp_test1', 'an option keeps the wishlist request it sent');
reset role;
