-- Creates the app databases. Idempotent; runs on the compose volume's first start,
-- or against an existing server: psql postgresql://postgres:postgres@127.0.0.1:5432/postgres -f docker/postgres-init.sql
SELECT 'CREATE DATABASE chat' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'chat')\gexec
SELECT 'CREATE DATABASE chat_test' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'chat_test')\gexec
