-- libpq DSN URL: scheme + user kept, password redacted.
SELECT dblink_connect('host', 'postgres://app:***REDACTED***@db.example/main');
SELECT dblink_connect('host', 'postgresql://app:***REDACTED***@db/main');
