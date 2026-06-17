# Chat IPCA - Infraestrutura Distribuída e Alta Disponibilidade

Este repositório contém a Prova de Conceito (PoC) para a infraestrutura de um sistema de Chat seguro, altamente disponível e distribuído. O ambiente foi testado e desenhado utilizando **Docker Compose** e corre sobre uma máquina virtual **Debian (instalação mínima)**.

## 🏗️ Arquitetura do Sistema

A infraestrutura foi projetada seguindo as melhores práticas de resiliência, tolerância a falhas (*Failover*), conteinerização modular e distribuição de carga (*Load Balancing*):

![Arquitetura Planejada](docs/arquitetura.png)

### Componentes Principais:
* **Camada de Entrada (Proxy Reverso e Load Balancer):** O tráfego de entrada passa primeiramente por um nó **Nginx LB** (Load Balancer L4) puro, que distribui e balanceia ativamente as requisições para um **cluster de proxies Nginx** (Nginx_01 e Nginx_02). Estes por sua vez tratam a terminação SSL, rotas e Forward Auth.
* **Camada de Autenticação (IAM):** Clusterizado com **Authelia** (em modo *Forward Auth*), protegendo as rotas e garantindo SSO centralizado sem precisar reescrever as rotas de autenticação no próprio chat.
* **Camada de Aplicação (Neo-Chat):** Aplicação interativa em tempo real baseada em Vite/React (Frontend) e Node.js+Socket.io (Backend). Integra suporte a inteligência artificial utilizando a **API do Google Gemini**. Empacotada com um Dockerfile dedicado expondo a porta `3000`.
* **Camada de Persistência (Dados):** Cluster **PostgreSQL** com replicação síncrona/assíncrona (Master-Slave) gerido por um instanciamento de **Pgpool-II**, responsável por balanceamento de consultas DQL e failover.

---

## ⚙️ Preparação do Servidor (Provisionamento)

Antes de executar a aplicação, é necessário preparar a máquina virtual Debian. O projeto inclui um script automatizado (`bootstrap.sh`) que deve ser executado obrigatoriamente como **root**. Este script realiza as seguintes configurações essenciais:
* Configura a interface de rede utilizando o sistema moderno `systemd-networkd`.
* Instala o gerenciador de pacotes `nala` e utilitários de sistema (como `git`, `htop`, `btop`, `curl`, entre outros).
* Cria o utilizador `chat-admin` com a respetiva password e com privilégios de `sudo`.
* Configura o repositório oficial e instala a versão mais recente do **Docker Engine** e ferramentas associadas, adicionando o utilizador ao grupo Docker.
* Configura as chaves SSH e o perfil global do Git para controlo de versão.

---

## 📁 Estrutura de Diretórios

O projeto adota o padrão *Monorepo*, organizando o chat e os serviços da infraestrutura de forma partilhada:

```text
chat-ipca/
├── .gitignore                  # Regras de exclusão para o Git
├── README.md                   # Documentação principal do projeto
├── metadata.json               # Metadados de configuração e capabilities (Google AI Studio)
├── package.json                # Configurações e definições globais de scripts/dependências
├── package-lock.json           # Arquivo de integridade de dependências via Node.js
├── bootstrap/                  # Scripts de provisionamento da máquina virtual
│   └── bootstrap.sh            # Script de inicialização (rede, utilizador, repositório e docker)
├── docs/                       # Ficheiros e recursos para a documentação técnica
│   └── arquitetura.png         # Diagrama de topologia do ambiente
└── chat-infra/                 # Ficheiros de configuração da infraestrutura
    ├── docker-compose.yml      # Orquestração do cluster (Postgres, Pgpool, Authelia, Nginx, App)
    ├── .env                    # Variáveis de ambiente secretas (ex: GEMINI_API_KEY)
    ├── nginx-lb-config/        # Configuração do Load Balancer puro (L4)
    ├── nginx-config/           # Configuração dos nós de proxy reverso e Forward Auth
    ├── nginx-certs/            # Chaves e certificados SSL/TLS para comunicações locais HTTPS
    ├── html-stub/              # Documentos HTML estáticos e fallbacks (e.g., erro, manutenção)
    ├── authelia-config/        # Configurações do SSO e do gestor de identidades
    ├── postgres-config/        # Scripts de inicialização do cluster de bases de dados
    └── neo-chat/               # Código base da aplicação do chat propriamente dita (inclui Dockerfile)
```

---

## 🚀 Como Executar Localmente

Para rodar o cluster inteiro via Docker Compose:

1. Aceda ao diretório da infraestrutura:
   ```bash
   cd chat-infra
   ```
2. Crie um arquivo `.env` para inserir as variáveis obrigatórias da aplicação, especialmente a chave do Gemini configurada no backend:
   ```bash
   echo "GEMINI_API_KEY=sua_chave_do_gemini" > .env
   ```
3. Construa a imagem do Chat e inicie toda a camada de containers em background:
   ```bash
   docker compose up -d --build
   ```
4. Aceda à portal principal da aplicação configurado pelo NGINX através do URL seguro estipulado (`https://chat.local/ipca-chat/` assumindo configuração via arquivo HOSTS local).