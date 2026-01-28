-- Create a bot user for budgets (since Telegram uses numeric IDs, not UUIDs)
INSERT INTO users (id, email, created_at, updated_at)
VALUES (
    '00000000-0000-0000-0000-000000000000',
    'bot@chatracker.local',
    NOW(),
    NOW()
)
ON CONFLICT (id) DO NOTHING;
