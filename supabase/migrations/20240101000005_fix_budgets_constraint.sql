-- Fix budgets table CHECK constraint to use main_category_id instead of category_id
-- First make user_id nullable
ALTER TABLE budgets ALTER COLUMN user_id DROP NOT NULL;

-- Drop old constraint
ALTER TABLE budgets DROP CONSTRAINT IF EXISTS budgets_category_check;

-- Add new constraint that uses main_category_id
ALTER TABLE budgets ADD CONSTRAINT budgets_category_check CHECK (
    (main_category_id IS NOT NULL AND subcategory_id IS NULL) OR
    (main_category_id IS NULL AND subcategory_id IS NOT NULL) OR
    (main_category_id IS NOT NULL AND subcategory_id IS NOT NULL)
);
