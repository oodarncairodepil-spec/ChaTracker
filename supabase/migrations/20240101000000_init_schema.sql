-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Check and add missing columns to existing transactions table if it exists
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'transactions') THEN
        -- Add missing columns if they don't exist
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'status') THEN
            ALTER TABLE transactions ADD COLUMN status TEXT CHECK (status IN ('pending', 'completed', 'rejected'));
        END IF;
        
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'happened_at') THEN
            ALTER TABLE transactions ADD COLUMN happened_at TIMESTAMPTZ;
        END IF;
        
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'direction') THEN
            ALTER TABLE transactions ADD COLUMN direction TEXT CHECK (direction IN ('debit', 'credit'));
        END IF;
        
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'category_id') THEN
            ALTER TABLE transactions ADD COLUMN category_id UUID;
        END IF;
        
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'subcategory_id') THEN
            ALTER TABLE transactions ADD COLUMN subcategory_id UUID;
        END IF;
        
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'source_of_fund_id') THEN
            ALTER TABLE transactions ADD COLUMN source_of_fund_id UUID;
        END IF;
        
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'parse_meta') THEN
            ALTER TABLE transactions ADD COLUMN parse_meta JSONB;
        END IF;
    END IF;
END $$;

-- 3.1 raw_emails (Create only if doesn't exist)
CREATE TABLE IF NOT EXISTS raw_emails (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    received_at TIMESTAMPTZ NOT NULL,
    from_email TEXT,
    to_email TEXT,
    subject TEXT,
    date_header TIMESTAMPTZ,
    gmail_message_id TEXT UNIQUE,
    thread_id TEXT,
    email_label TEXT,
    text_body TEXT,
    html_body TEXT,
    raw_payload JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3.3 categories (Use existing table or create new one)
-- We'll check if the table exists and has the right structure
CREATE TABLE IF NOT EXISTS categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3.4 subcategories (Create only if doesn't exist)
CREATE TABLE IF NOT EXISTS subcategories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category_id UUID REFERENCES categories(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(category_id, name)
);

-- 3.5 source_of_funds (Create only if doesn't exist)
CREATE TABLE IF NOT EXISTS source_of_funds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL, -- bank|ewallet|cash|other
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes only if transactions table has the columns
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'transactions' AND column_name = 'happened_at'
    ) AND EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'transactions' AND column_name = 'status'
    ) THEN
        CREATE INDEX IF NOT EXISTS idx_transactions_status_happened_at 
        ON transactions(status, happened_at);
    END IF;
    
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'transactions' AND column_name = 'source'
    ) AND EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'transactions' AND column_name = 'source_ref'
    ) THEN
        CREATE INDEX IF NOT EXISTS idx_transactions_source_source_ref 
        ON transactions(source, source_ref);
    END IF;
END $$;

-- 3.6 budgets (Create only if doesn't exist)
CREATE TABLE IF NOT EXISTS budgets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    period TEXT NOT NULL DEFAULT 'monthly',
    month DATE NOT NULL,
    category_id UUID REFERENCES categories(id) ON DELETE CASCADE,
    subcategory_id UUID REFERENCES subcategories(id) ON DELETE CASCADE,
    amount BIGINT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT check_budget_target CHECK (
        (category_id IS NOT NULL AND subcategory_id IS NULL) OR 
        (category_id IS NULL AND subcategory_id IS NOT NULL) OR
        (category_id IS NOT NULL AND subcategory_id IS NOT NULL)
    )
);

-- 3.7 bot_sessions (Create only if doesn't exist)
CREATE TABLE IF NOT EXISTS bot_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    state TEXT NOT NULL,
    context JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(chat_id, user_id)
);
