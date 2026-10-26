-- Part number on every order (maintenance too), stored normalized so the history per PN groups the same product.
UPDATE work_orders SET part_number = nullif(upper(regexp_replace(trim(part_number), '\s+', ' ', 'g')), '') WHERE part_number IS NOT NULL;
CREATE INDEX work_orders_part_number_idx ON work_orders (domain, part_number) WHERE part_number IS NOT NULL;
