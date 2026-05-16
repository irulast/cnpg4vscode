CREATE SUBSCRIPTION sub1 CONNECTION 'host=remote port=5432 user=repl password=hunter2 dbname=app' PUBLICATION pub1;
CREATE SERVER fdw FOREIGN DATA WRAPPER postgres_fdw OPTIONS (dsn 'host=h user=u password=p');
