-- 1. Cria a base de dados dedicada ao Authelia
CREATE DATABASE authelia_db;

-- 2. Cria um utilizador exclusivo para o Authelia
CREATE USER authelia_admin WITH PASSWORD 'senha_authelia_secreta';

-- 3. Garante que este utilizador só manda na base de dados dele
GRANT ALL PRIVILEGES ON DATABASE authelia_db TO authelia_admin;