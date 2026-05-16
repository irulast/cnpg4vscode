# Contract — PostgreSQL introspection queries

Hand-written `pg_catalog` queries fired lazily per Schema Tree Node
expand, cached for 60 s in memory keyed by `(connectionId, oid)`. No
`information_schema`, no introspection libraries.

All queries run with `pg`'s parameterized form (`$1`, `$2`, ...) — no
identifier interpolation. Catalog OIDs are stable across renames and
are the canonical node identity (data-model § Schema Tree Node).

Each section lists the **Trigger**, **Inputs**, **Output columns**, and
**Notes**.

---

## Databases (after connect; rarely re-fetched)

- **Trigger**: connection established.
- **Inputs**: none.
- **Output columns**: `oid`, `name (datname)`, `owner`, `encoding`,
  `is_template`.
- **Notes**: filter out templates from the default tree view; expose
  via a "Show template DBs" toggle.

```sql
SELECT d.oid, d.datname AS name, r.rolname AS owner,
       pg_encoding_to_char(d.encoding) AS encoding, d.datistemplate AS is_template
  FROM pg_database d
  JOIN pg_roles r ON r.oid = d.datdba
 WHERE has_database_privilege(d.oid, 'CONNECT')
 ORDER BY d.datname;
```

## Schemas (on database expand)

- **Inputs**: none.
- **Output columns**: `oid`, `name (nspname)`, `owner`,
  `is_system` (true for `pg_*` and `information_schema`).

```sql
SELECT n.oid, n.nspname AS name, r.rolname AS owner,
       (n.nspname = 'information_schema' OR n.nspname LIKE 'pg_%') AS is_system
  FROM pg_namespace n
  JOIN pg_roles r ON r.oid = n.nspowner
 WHERE has_schema_privilege(n.oid, 'USAGE')
 ORDER BY n.nspname;
```

## Tables / Views / Materialized views / Foreign tables (on schema expand)

- **Inputs**: `schemaOid`.
- **Output columns**: `oid`, `name (relname)`, `kind` ('table' | 'view'
  | 'materializedView' | 'foreign'), `owner`, `est_rows` (planner
  estimate), `size_bytes` (`pg_table_size` when readable).

```sql
SELECT c.oid, c.relname AS name,
       CASE c.relkind WHEN 'r' THEN 'table'
                      WHEN 'p' THEN 'table'  -- partitioned
                      WHEN 'v' THEN 'view'
                      WHEN 'm' THEN 'materializedView'
                      WHEN 'f' THEN 'foreign'
       END AS kind,
       r.rolname AS owner,
       c.reltuples::bigint AS est_rows,
       CASE WHEN has_table_privilege(c.oid, 'SELECT')
            THEN pg_table_size(c.oid) END AS size_bytes
  FROM pg_class c
  JOIN pg_roles r ON r.oid = c.relowner
 WHERE c.relnamespace = $1
   AND c.relkind IN ('r','p','v','m','f')
 ORDER BY c.relname;
```

## Columns (on table/view expand)

- **Inputs**: `relOid`.
- **Output columns**: `attnum`, `name`, `type`, `not_null`, `default`,
  `is_pk` (boolean).

```sql
SELECT a.attnum, a.attname AS name,
       format_type(a.atttypid, a.atttypmod) AS type,
       a.attnotnull AS not_null,
       pg_get_expr(d.adbin, d.adrelid) AS default,
       EXISTS (
         SELECT 1 FROM pg_index i
          WHERE i.indrelid = a.attrelid
            AND i.indisprimary
            AND a.attnum = ANY (i.indkey)
       ) AS is_pk
  FROM pg_attribute a
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
 WHERE a.attrelid = $1
   AND a.attnum > 0
   AND NOT a.attisdropped
 ORDER BY a.attnum;
```

## Indexes (on table expand)

- **Inputs**: `relOid`.
- **Output columns**: `oid`, `name`, `is_unique`, `is_primary`,
  `is_partial`, `columns[]` (in key order).

```sql
SELECT i.indexrelid AS oid, c.relname AS name,
       i.indisunique AS is_unique,
       i.indisprimary AS is_primary,
       (i.indpred IS NOT NULL) AS is_partial,
       (
         SELECT array_agg(a.attname ORDER BY ord)
           FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
       ) AS columns
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
 WHERE i.indrelid = $1
 ORDER BY c.relname;
```

## Constraints (on table expand)

- **Inputs**: `relOid`.
- **Output columns**: `oid`, `name`, `kind` ('p' | 'f' | 'u' | 'c' |
  'x'), `definition` (from `pg_get_constraintdef`).

```sql
SELECT c.oid, c.conname AS name, c.contype AS kind,
       pg_get_constraintdef(c.oid, true) AS definition
  FROM pg_constraint c
 WHERE c.conrelid = $1
 ORDER BY c.contype, c.conname;
```

## Foreign keys for ER diagram

- **Inputs**: `schemaOid` (or set of `relOid`s).
- **Output columns**: `from_oid`, `to_oid`, `from_columns[]`,
  `to_columns[]`, `name`.

```sql
SELECT c.conrelid AS from_oid,
       c.confrelid AS to_oid,
       (SELECT array_agg(a.attname ORDER BY k.ord)
          FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
         AS from_columns,
       (SELECT array_agg(a.attname ORDER BY k.ord)
          FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum)
         AS to_columns,
       c.conname AS name
  FROM pg_constraint c
  JOIN pg_class fc ON fc.oid = c.conrelid
 WHERE c.contype = 'f'
   AND fc.relnamespace = $1;
```

## Sequences (on schema expand, secondary)

```sql
SELECT c.oid, c.relname AS name
  FROM pg_class c
 WHERE c.relnamespace = $1
   AND c.relkind = 'S'
 ORDER BY c.relname;
```

## Functions & Procedures

```sql
SELECT p.oid, p.proname AS name,
       p.prokind AS kind,           -- 'f' function | 'p' procedure | 'a' aggregate | 'w' window
       pg_get_function_arguments(p.oid) AS args,
       pg_get_function_result(p.oid) AS returns,
       l.lanname AS language
  FROM pg_proc p
  JOIN pg_language l ON l.oid = p.prolang
 WHERE p.pronamespace = $1
 ORDER BY p.proname;
```

## Triggers (on table expand, secondary)

```sql
SELECT t.oid, t.tgname AS name,
       pg_get_triggerdef(t.oid, true) AS definition
  FROM pg_trigger t
 WHERE t.tgrelid = $1
   AND NOT t.tgisinternal
 ORDER BY t.tgname;
```

## Types (on schema expand, secondary)

```sql
SELECT t.oid, t.typname AS name, t.typtype AS kind  -- 'c' composite | 'e' enum | 'd' domain
  FROM pg_type t
 WHERE t.typnamespace = $1
   AND t.typtype IN ('c','e','d')
 ORDER BY t.typname;
```

## Extensions (cluster-wide)

```sql
SELECT e.oid, e.extname AS name, e.extversion AS version
  FROM pg_extension e
 ORDER BY e.extname;
```

## Roles (cluster-wide; requires connect privilege)

```sql
SELECT r.oid, r.rolname AS name, r.rolsuper, r.rolcanlogin, r.rolinherit
  FROM pg_roles r
 ORDER BY r.rolname;
```

## Browse top-N rows (US5 "Browse top 100 rows")

Identifier is interpolated server-side after AST validation — never via
JS string concatenation against user input.

```sql
SELECT * FROM <qualified_table_ident> LIMIT $1 OFFSET $2;
```

## Row count (US5 "Count rows")

```sql
SELECT count(*) AS rows FROM <qualified_table_ident>;
```

## Result-set descriptor for cell-edit eligibility

After running an arbitrary SELECT, the connection layer fetches:

```sql
SELECT i.indrelid::regclass AS table, array_agg(a.attname ORDER BY ord) AS pk_columns
  FROM pg_index i
  JOIN unnest(i.indkey) WITH ORDINALITY k(attnum, ord) ON true
  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
 WHERE i.indrelid = $1::regclass
   AND i.indisprimary
 GROUP BY i.indrelid;
```

`$1` is the resolved single-source table from the AST. Multiple-source
or computed-column SELECTs do not yield a usable PK descriptor; the
grid renders read-only.

---

## Test surface

- `test/contract/pg/introspect.test.ts` runs each query above against a
  `pg-mem` fixture seeded with a representative schema and asserts the
  output shape.
- A separate testcontainers-based e2e covers the 10% of queries
  pg-mem cannot honor (e.g., `pg_table_size`, true `format_type`
  resolution).
