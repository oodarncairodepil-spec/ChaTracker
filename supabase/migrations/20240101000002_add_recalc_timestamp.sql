-- Add column to track when the summary was last updated
ALTER TABLE budget_performance_summary 
ADD COLUMN IF NOT EXISTS last_recalculated_at TIMESTAMPTZ DEFAULT NOW();
