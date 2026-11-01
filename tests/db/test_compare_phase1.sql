-- Compare, phase 1: tables, row access, specs validation, tax maths, photos.
-- Each check raises on failure, so the first broken rule stops the run.
\set QUIET on
\pset tuples_only on
\pset format unaligned
create schema if not exists t;
create or replace function t.ok(cond boolean, label text) returns void language plpgsql as $$
begin if cond is not true then raise exception 'FAILED: %', label; end if; raise notice 'ok  %', label; end $$;
-- Run a statement that must fail with this SQLSTATE.
create or replace function t.err(stmt text, code text, label text) returns void language plpgsql as $$
begin
  begin execute stmt;
  exception when others then
    if sqlstate = code then raise notice 'ok  % (%)', label, code; return; end if;
    raise exception 'FAILED: % — expected %, got % %', label, code, sqlstate, sqlerrm;
  end;
  raise exception 'FAILED: % — expected error %, but it succeeded', label, code;
end $$;
create or replace function t.signin(uid uuid) returns void language sql as
  $$ select set_config('request.jwt.claim.sub', uid::text, false) $$;
grant usage on schema t to authenticated, anon;
grant execute on all functions in schema t to authenticated, anon;
set client_min_messages = notice;

-- A = you (operator → editor), B = another allow-listed person, C = signed in but not allowed.
insert into public.authentication_mode_user_roles (email, auth_user_id, role) values
  ('a@x.jp', '00000000-0000-0000-0000-00000000000a', 'operator'),
  ('b@x.jp', '00000000-0000-0000-0000-00000000000b', 'editor');
-- C signs in through a path the gate does not cover, to prove row access alone stops it.
alter table auth.users disable trigger user;
insert into auth.users values ('00000000-0000-0000-0000-00000000000a', 'a@x.jp'),
  ('00000000-0000-0000-0000-00000000000b', 'b@x.jp'), ('00000000-0000-0000-0000-00000000000c', 'c@x.jp');
alter table auth.users enable trigger user;

set role authenticated;

-- ── starters ──
select t.signin('00000000-0000-0000-0000-00000000000a');
select t.ok(public.chatak_cmp_seed_starters() = 3, 'seed adds 3 starter categories');
select t.ok(public.chatak_cmp_seed_starters() = 0, 'seeding again adds nothing');
select t.ok((select count(*) from chatak_cmp_fields) = 22, 'starters carry 22 fields (9 + 6 + 7)');
select t.ok((select better from chatak_cmp_fields f join chatak_cmp_categories c on c.id = f.category_id
             where c.name = 'Folding bed table' and f.key = 'load') = 'higher', 'load capacity is higher-is-better');

-- ── options and specs ──
insert into chatak_cmp_options (id, category_id, name, brand, source_kind, cost_shop_id, pack_qty, pack_unit, size_label, specs)
select '11111111-0000-0000-0000-000000000001', id, 'MY space table', 'Donki', 'shop', '17', 1, 'pc', '60x40 cm',
       '{"width": 60, "depth": 40, "material": "MDF", "tablet_slot": false}'
from chatak_cmp_categories where name = 'Folding bed table';
select t.ok((select count(*) from chatak_cmp_options) = 1, 'option with valid specs is saved');
select t.err($$ update chatak_cmp_options set specs = '{"colour": "red"}' $$, '22023', 'unknown spec key refused');
select t.err($$ update chatak_cmp_options set specs = '{"width": "60cm"}' $$, '22023', 'text in a number field refused');
select t.err($$ update chatak_cmp_options set specs = '{"material": "Glass"}' $$, '22023', 'choice outside the list refused');
select t.ok((select count(*) from chatak_cmp_options where specs->>'width' = '60') = 1, 'refused edits left the row unchanged');
select t.err($$ insert into chatak_cmp_options (category_id, name, source_kind, shop_name, pack_unit)
                select id, 'No size', 'shop', 'Donki', 'pc' from chatak_cmp_categories limit 1 $$, '23502', 'option without pack size refused');
select t.err($$ insert into chatak_cmp_options (category_id, name, source_kind, shop_name, pack_qty, pack_unit)
                select id, 'Odd unit', 'shop', 'Donki', 1, 'boxes' from chatak_cmp_categories limit 1 $$, '23514', 'unknown pack unit refused');
select t.err($$ insert into chatak_cmp_options (category_id, name, source_kind, store_id, pack_qty, pack_unit)
                select id, 'VECELO', 'online', 2, 1, 'pc' from chatak_cmp_categories limit 1 $$, '23514', 'online option without URL refused');
insert into chatak_cmp_options (id, category_id, name, brand, source_kind, store_id, url, pack_qty, pack_unit, specs)
select '11111111-0000-0000-0000-000000000002', id, 'Lap desk 70x48', 'VECELO', 'online', 2, 'https://www.amazon.co.jp/dp/EXAMPLE', 1, 'pc',
       '{"width": 70, "depth": 48, "height": 30}'
from chatak_cmp_categories where name = 'Folding bed table';
select t.ok((select count(*) from chatak_cmp_options where source_kind = 'online') = 1, 'online option with store + URL is saved');

-- ── prices on one tax basis ──
insert into chatak_cmp_prices (option_id, cost_shop_id, price, tax_basis, price_kind) values
  ('11111111-0000-0000-0000-000000000001', '17', 1639, 'excl', 'shelf');
insert into chatak_cmp_prices (option_id, cost_shop_id, price, tax_basis, price_kind, member_program) values
  ('11111111-0000-0000-0000-000000000001', '17', 1419, 'excl', 'member', 'majica');
insert into chatak_cmp_prices (option_id, shop_name, price, tax_basis) values
  ('11111111-0000-0000-0000-000000000001', 'Nitori', 3168, 'incl');
insert into chatak_cmp_prices (option_id, store_id, price, tax_basis, tax_rate, price_kind, source) values
  ('11111111-0000-0000-0000-000000000002', 2, 216, 'excl', 8, 'online', 'url');
select t.ok((select price_incl from chatak_cmp_prices where price = 1639) = 1802, 'Donki ¥1,639 excl → ¥1,802 incl (rounded down)');
select t.ok((select price_incl from chatak_cmp_prices where price = 1419) = 1560, 'majica ¥1,419 excl → ¥1,560 incl');
select t.ok((select price_incl from chatak_cmp_prices where price = 3168) = 3168, 'Nitori tag already incl stays ¥3,168');
select t.ok((select price_incl from chatak_cmp_prices where price = 216) = 233, '8% food rate: ¥216 excl → ¥233');
select t.err($$ insert into chatak_cmp_prices (option_id, shop_name, price, tax_basis, price_kind)
                values ('11111111-0000-0000-0000-000000000001', 'Donki', 1400, 'excl', 'member') $$, '23514', 'member price without a programme refused');
select t.err($$ insert into chatak_cmp_prices (option_id, price, tax_basis)
                values ('11111111-0000-0000-0000-000000000001', 999, 'incl') $$, '23514', 'price with no shop or store refused');
select t.err($$ insert into chatak_cmp_prices (option_id, shop_name, price, tax_basis)
                values ('11111111-0000-0000-0000-000000000001', 'Donki', 999, 'tax-free') $$, '23514', 'unknown tax basis refused');
do $$ declare n int; begin
  update chatak_cmp_prices set price = 1 where price = 1639; get diagnostics n = row_count;
  perform t.ok(n = 0, 'prices cannot be edited (history kept)');
end $$;

-- ── photos and storage ──
select t.err($$ insert into chatak_cmp_photos (option_id, storage_path)
                values ('11111111-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000b/x.jpg') $$, '23514', 'photo path outside own folder refused');
select t.err($$ insert into chatak_cmp_photos (option_id, storage_path, bytes)
                values ('11111111-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a/big.jpg', 3500000) $$, '23514', 'unshrunk 3.5 MB photo refused');
insert into chatak_cmp_photos (option_id, storage_path, original_name, bytes, width, height) values
  ('11111111-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a/11111111-0000-0000-0000-000000000001/IMG20261024192355.jpg',
   'IMG20261024192355.jpg', 310000, 1600, 1200);
insert into storage.objects (bucket_id, name) values
  ('chatak-compare', '00000000-0000-0000-0000-00000000000a/11111111-0000-0000-0000-000000000001/IMG20261024192355.jpg');
select t.ok((select count(*) from storage.objects) = 1, 'own photo uploads into own folder');
select t.err($$ insert into storage.objects (bucket_id, name) values ('chatak-compare', '00000000-0000-0000-0000-00000000000b/stolen.jpg') $$,
             '42501', 'upload into someone else''s folder refused');

-- ── other people ──
select t.signin('00000000-0000-0000-0000-00000000000b');
select t.ok((select count(*) from chatak_cmp_categories) = 0, 'B sees none of A''s categories');
select t.ok((select count(*) from chatak_cmp_options) + (select count(*) from chatak_cmp_prices) + (select count(*) from chatak_cmp_photos) = 0,
            'B sees none of A''s options, prices or photos');
select t.ok((select count(*) from storage.objects) = 0, 'B cannot read A''s photo file');
select t.ok(public.chatak_cmp_seed_starters() = 3, 'B gets an independent set of starters');

select t.signin('00000000-0000-0000-0000-00000000000c');
select t.ok((select count(*) from chatak_cmp_categories) = 0, 'not on the allow-list: sees nothing');
select t.err($$ insert into chatak_cmp_categories (name) values ('Mine') $$, '42501', 'not on the allow-list: cannot create');

-- A child row under someone else's parent, even with a known id.
select t.signin('00000000-0000-0000-0000-00000000000b');
reset role;
do $$ declare a_cat uuid; begin
  select id into a_cat from chatak_cmp_categories where user_id = '00000000-0000-0000-0000-00000000000a' and name = 'Slicer';
  perform set_config('t.a_cat', a_cat::text, false);
end $$;
set role authenticated;
select t.err(format($$ insert into chatak_cmp_options (category_id, name, source_kind, shop_name, pack_qty, pack_unit)
                       values (%L, 'Sneaky', 'shop', 'Donki', 1, 'pc') $$, current_setting('t.a_cat')),
             '42501', 'B cannot add an option under A''s category id');

-- ── delete cascades ──
select t.signin('00000000-0000-0000-0000-00000000000a');
delete from chatak_cmp_categories where name = 'Folding bed table';
select t.ok((select count(*) from chatak_cmp_options) = 0 and (select count(*) from chatak_cmp_prices) = 0
            and (select count(*) from chatak_cmp_photos) = 0, 'deleting a category removes its options, prices and photo rows');

reset role;
set role anon;
select t.err($$ select public.chatak_cmp_seed_starters() $$, '42501', 'signed-out visitors cannot seed');
reset role;
