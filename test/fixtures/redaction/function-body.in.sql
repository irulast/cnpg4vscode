CREATE OR REPLACE FUNCTION call_remote() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM dblink_connect('h', 'host=x user=u password=oops');
END;
$$;
