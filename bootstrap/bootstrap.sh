#!/usr/bin/env bash

# Caminho do ficheiro de log
LOG_FILE="/var/log/bootstrap.log"

# Garante que o diretório do log existe
mkdir -p "$(dirname "$LOG_FILE")"

# Função centralizada para logs (Escreve no ecrã e no ficheiro em simultâneo)
log() {
    local type="$1"
    local message="$2"
    local timestamp
    timestamp=$(date +"%Y-%m-%d %H:%M:%S")
    echo "[$timestamp] [$type] $message" | tee -a "$LOG_FILE"
}

# Forçar que o script corra como root
if [ "$EUID" -ne 0 ]; then
    log "ERROR" "Por favor, corre este script como root!"
    exit 1
fi

log "INFO" "=================================================="
log "INFO" "Iniciando a verificacao de estado do servidor..."
log "INFO" "Log gravado em: $LOG_FILE"
log "INFO" "=================================================="

# Variáveis de Configuração
USER_NAME="chat-admin"
GIT_NAME="Filipe Almeida"
GIT_EMAIL="fja.ipca@gmail.com"
INTERFACE="enp0s3"

# ==========================================
# 1. CONFIGURAÇÃO DE REDE (SYSTEMD-NETWORKD)
# ==========================================
log "INFO" "[1/5] Verificando configuracao de rede..."

if [ -f "/etc/systemd/network/20-${INTERFACE}.network" ] && systemctl is-active --quiet systemd-networkd; then
    log "CHECK" "Rede (systemd-networkd) ja esta configurada e ativa."
else
    log "ACTION" "Configuracao moderna de rede nao encontrada. Aplicando..."
    
    # Desativar o sistema antigo do Debian
    systemctl disable --now networking.service --force 2>/dev/null
    if [ -f /etc/network/interfaces ] && [ ! -f /etc/network/interfaces.old ]; then
        mv /etc/network/interfaces /etc/network/interfaces.old
        log "ACTION" "Ficheiro /etc/network/interfaces legado movido para .old"
    fi

    # Criar o ficheiro moderno de rede
    mkdir -p /etc/systemd/network
    cat <<EOF > /etc/systemd/network/20-${INTERFACE}.network
[Match]
Name=${INTERFACE}

[Network]
DHCP=yes
EOF
    systemctl enable systemd-networkd systemd-resolved >/dev/null 2>&1
    systemctl restart systemd-networkd systemd-resolved
    log "SUCCESS" "Interface de rede e servicos systemd ativados com sucesso."
fi

# Verificar o link do DNS (systemd-resolved)
if [ "$(readlink /etc/resolv.conf)" = "/run/systemd/resolve/stub-resolv.conf" ]; then
    log "CHECK" "Link simbolico do DNS (/etc/resolv.conf) ja esta correto."
else
    log "ACTION" "Ajustando link simbolico do DNS para o stub-resolv.conf..."
    ln -sf /run/systemd/resolve/stub-resolv.conf /etc/resolv.conf
    log "SUCCESS" "DNS resolv.conf atualizado."
fi

# ==========================================
# 2. INSTALAÇÃO DE PACOTES ESSENCIAIS
# ==========================================
log "INFO" "[2/5] Verificando ferramentas essenciais..."

if command -v nala &>/dev/null; then
    log "CHECK" "Gerenciador Nala ja esta instalado."
else
    log "ACTION" "Nala nao encontrado. Instalando via apt-get..."
    apt-get update -y >/dev/null && apt-get install -y nala >/dev/null
    log "SUCCESS" "Nala instalado com sucesso."
fi

log "ACTION" "Garantindo presenca de pacotes utilitarios (sudo, curl, git, btop, neovim, htop)..."
nala install -y sudo curl ca-certificates gnupg btop neovim git htop >/dev/null 2>&1
log "SUCCESS" "Verificacao de pacotes utilitarios concluida."

# ==========================================
# 3. CRIAÇÃO E CONFIGURAÇÃO DO UTILIZADOR
# ==========================================
log "INFO" "[3/5] Verificando o utilizador $USER_NAME..."

if id "$USER_NAME" &>/dev/null; then
    log "CHECK" "Utilizador '$USER_NAME' ja existe no sistema."
else
    log "ACTION" "Utilizador '$USER_NAME' nao existe. Criando utilizador..."
    useradd -m -s /bin/bash "$USER_NAME"
    log "SUCCESS" "Utilizador criado. Por favor, define a password abaixo:"
    passwd "$USER_NAME"
fi

# Verificar grupo sudo
if groups "$USER_NAME" | grep -q "\bsudo\b"; then
    log "CHECK" "O utilizador '$USER_NAME' ja pertence ao grupo Sudo."
else
    log "ACTION" "Adicionando '$USER_NAME' ao grupo sudo..."
    usermod -aG sudo "$USER_NAME"
    log "SUCCESS" "Permissoes de Sudo atribuidas."
fi

# ==========================================
# 4. INSTALAÇÃO DO DOCKER (FONTE OFICIAL)
# ==========================================
log "INFO" "[4/5] Verificando instalacao do Docker..."

if [ -f /etc/apt/sources.list.d/docker.sources ] && command -v docker &>/dev/null; then
    log "CHECK" "Repositorio e binarios do Docker ja estao instalados."
else
    log "ACTION" "Docker nao detectado. Configurando repositorio oficial..."
    mkdir -p /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc >/dev/null 2>&1
    chmod a+r /etc/apt/keyrings/docker.asc

    cat <<EOF > /etc/apt/sources.list.d/docker.sources
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: $(. /etc/os-release && echo "$VERSION_CODENAME")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
    log "ACTION" "Atualizando indices de pacotes e instalando Docker Engine..."
    nala update >/dev/null 2>&1
    nala install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null 2>&1
    log "SUCCESS" "Docker Engine e plugins instalados com sucesso."
fi

# Verificar se o utilizador já está no grupo docker
if groups "$USER_NAME" | grep -q "\bdocker\b"; then
    log "CHECK" "O utilizador '$USER_NAME' ja pertence ao grupo Docker."
else
    log "ACTION" "Adicionando '$USER_NAME' ao grupo docker..."
    usermod -aG docker "$USER_NAME"
    log "WARN" "Grupo Docker adicionado. Nota: Sera necessario iniciar uma nova sessao para aplicar."
fi

# ==========================================
# 5. CONFIGURAÇÃO DO GIT E CHAVE SSH
# ==========================================
log "INFO" "[5/5] Verificando chaves SSH e Git do utilizador..."

CURRENT_GIT_USER=$(sudo -u "$USER_NAME" git config --global user.name 2>/dev/null)
if [ "$CURRENT_GIT_USER" = "$GIT_NAME" ]; then
    log "CHECK" "Configuracoes globais do Git ja estao corretas para o utilizador."
else
    log "ACTION" "Configurando a identidade global do Git para o utilizador..."
    sudo -u "$USER_NAME" git config --global user.name "$GIT_NAME"
    sudo -u "$USER_NAME" git config --global user.email "$GIT_EMAIL"
    log "SUCCESS" "Identidade Git configurada."
fi

# Validar Chave SSH do utilizador
if [ -f "/home/$USER_NAME/.ssh/id_ed25519" ]; then
    log "CHECK" "Chave SSH Ed25519 do utilizador encontrada e pronta."
else
    if [ -f /root/.ssh/id_ed25519 ]; then
        log "ACTION" "Chave do root detectada. Migrando chaves SSH para o utilizador '$USER_NAME'..."
        mkdir -p /home/$USER_NAME/.ssh
        cp /root/.ssh/id_ed25519* /home/$USER_NAME/.ssh/
        chown -R $USER_NAME:$USER_NAME /home/$USER_NAME/.ssh
        chmod 700 /home/$USER_NAME/.ssh
        chmod 600 /home/$USER_NAME/.ssh/id_ed25519
        chmod 644 /home/$USER_NAME/.ssh/id_ed25519.pub
        log "SUCCESS" "Chaves SSH migradas e permissoes de seguranca aplicadas."
    else
        log "ACTION" "Nenhuma chave encontrada no root. Gerando nova chave SSH para '$USER_NAME'..."
        mkdir -p /home/$USER_NAME/.ssh
        chown $USER_NAME:$USER_NAME /home/$USER_NAME/.ssh
        chmod 700 /home/$USER_NAME/.ssh
        sudo -u "$USER_NAME" ssh-keygen -t ed25519 -C "$GIT_EMAIL" -N "" -f /home/$USER_NAME/.ssh/id_ed25519 >/dev/null
        log "SUCCESS" "Nova chave SSH gerada automaticamente."
        log "WARN" "Lembra-te de adicionar a chave pública ao teu perfil do GitHub:"
        cat /home/$USER_NAME/.ssh/id_ed25519.pub
    fi
fi

# Limpar o ficheiro indesejado do root, caso exista
[ -f /root/.gitconfig ] && rm -f /root/.gitconfig

log "INFO" "=================================================="
log "SUCCESS" "Validacao concluida com sucesso! O servidor esta pronto."
log "INFO" "=================================================="