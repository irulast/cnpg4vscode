-- Defensive: the redactor must catch unusual whitespace patterns.
CREATE ROLE x WITH
  PASSWORD
    '***REDACTED***';
ALTER USER y
  WITH PASSWORD	'***REDACTED***';
