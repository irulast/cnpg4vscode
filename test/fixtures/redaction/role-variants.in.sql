-- ROLE / USER / GROUP variants.
CREATE GROUP grp1 WITH PASSWORD 'grouppass';
ALTER ROLE u1 WITH ENCRYPTED PASSWORD 'newpw';
CREATE USER MAPPING FOR alice SERVER s OPTIONS (user 'remote', password 'mappass');
