-- Defensive: the redactor must catch unusual whitespace patterns.
CREATE ROLE x WITH
  PASSWORD
    'multi-line-secret';
ALTER USER y
  WITH PASSWORD	'tab-separated-secret';
