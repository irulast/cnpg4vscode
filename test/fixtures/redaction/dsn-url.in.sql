-- libpq DSN URL: scheme + user kept, password redacted.
SELECT dblink_connect('host', 'postgres://app:hunter2@db.example/main');
SELECT dblink_connect('host', 'postgresql://app:s3cret@db/main');
