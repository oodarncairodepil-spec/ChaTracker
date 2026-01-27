-- Create a compatibility view for categories to work with bot logic
-- This maps your existing structure to the expected bot format

DROP VIEW IF EXISTS categories_view;

CREATE VIEW categories_view AS
SELECT 
    id,
    name,
    created_at,
    updated_at
FROM main_categories
WHERE deleted_at IS NULL OR deleted_at = '1970-01-01 00:00:00+00';  -- Filter out deleted categories

-- Create a compatibility view for subcategories
DROP VIEW IF EXISTS subcategories_view;

CREATE VIEW subcategories_view AS
SELECT 
    sch.id,
    sch.name,
    mc.id AS category_id,
    sch.created_at,
    sch.updated_at
FROM categories_with_hierarchy sch
JOIN main_categories mc ON sch.parent_id = mc.id
WHERE (sch.deleted_at IS NULL OR sch.deleted_at = '1970-01-01 00:00:00+00')
  AND (mc.deleted_at IS NULL OR mc.deleted_at = '1970-01-01 00:00:00+00');
