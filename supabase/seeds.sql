-- Seeds Script - Use EXISTING categories only!

-- DO NOT insert any categories or subcategories
-- This script only adds source_of_funds which doesn't exist in your schema

-- Source of Funds (safe insert)
INSERT INTO source_of_funds (name, type) VALUES
('BCA', 'bank'),
('Mandiri', 'bank'),
('OVO', 'ewallet'),
('GoPay', 'ewallet'),
('Dana', 'ewallet'),
('Cash', 'cash')
ON CONFLICT (name) DO NOTHING;
