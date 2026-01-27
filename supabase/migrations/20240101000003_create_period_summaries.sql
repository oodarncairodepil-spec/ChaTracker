-- Create a real table to store period summaries (snapshot of the view)
-- This allows us to manually recalculate and fix numbers as requested

CREATE TABLE IF NOT EXISTS period_summaries (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL,
    period_start_date DATE NOT NULL,
    period_end_date DATE NOT NULL,
    
    -- Budgeted
    total_budgeted_expense NUMERIC DEFAULT 0,
    total_budgeted_income NUMERIC DEFAULT 0,
    
    -- Actuals (Calculated from transactions)
    total_actual_expense NUMERIC DEFAULT 0,
    total_actual_income NUMERIC DEFAULT 0,
    
    last_recalculated_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Ensure one row per period per user
    UNIQUE(user_id, period_start_date, period_end_date)
);

-- Enable RLS
ALTER TABLE period_summaries ENABLE ROW LEVEL SECURITY;

-- Allow read/write access (modify policy as needed for your auth setup)
CREATE POLICY "Allow all access for now" ON period_summaries FOR ALL USING (true);
