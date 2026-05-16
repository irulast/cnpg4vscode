SELECT id, name, created_at FROM users WHERE id = $1;
INSERT INTO orders (user_id, total) VALUES ($1, $2);
UPDATE accounts SET balance = balance - 10 WHERE id = $1;
