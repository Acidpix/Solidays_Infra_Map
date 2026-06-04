#!/bin/bash
# ============================================================
#  NetMap — Script d'installation Debian 11 LXC
#  Usage: sudo bash install.sh
# ============================================================
set -e

INSTALL_DIR="/opt/netmap"
SERVICE_USER="netmap"
PORT=3000

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
die()     { echo -e "${RED}[ERR]${NC} $1"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Ce script doit être exécuté en root (sudo bash install.sh)"

echo -e "${CYAN}"
echo "  ███╗   ██╗███████╗████████╗███╗   ███╗ █████╗ ██████╗ "
echo "  ████╗  ██║██╔════╝╚══██╔══╝████╗ ████║██╔══██╗██╔══██╗"
echo "  ██╔██╗ ██║█████╗     ██║   ██╔████╔██║███████║██████╔╝"
echo "  ██║╚██╗██║██╔══╝     ██║   ██║╚██╔╝██║██╔══██║██╔═══╝ "
echo "  ██║ ╚████║███████╗   ██║   ██║ ╚═╝ ██║██║  ██║██║     "
echo "  ╚═╝  ╚═══╝╚══════╝   ╚═╝   ╚═╝     ╚═╝╚═╝  ╚═╝╚═╝     "
echo -e "${NC}"
echo "  Network Monitoring Map — Installation Debian 11 LXC"
echo ""

# ── 1. Node.js ───────────────────────────────────────────────
info "Vérification de Node.js..."
if ! command -v node &>/dev/null || [ "$(node -e 'process.exit(parseInt(process.version.slice(1)) < 18 ? 1 : 0)' && echo ok)" != "ok" ]; then
  info "Installation de Node.js 20 LTS..."
  apt-get update -qq
  apt-get install -y curl gnupg ca-certificates
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
  success "Node.js $(node -v) installé"
else
  success "Node.js $(node -v) déjà présent"
fi

# ── 2. Dépendances système ───────────────────────────────────
info "Installation des dépendances système..."
apt-get install -y python3 make g++ sqlite3 2>/dev/null || true
success "Dépendances OK"

# ── 3. Répertoire installation ───────────────────────────────
info "Création du répertoire $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR/db"
mkdir -p "$INSTALL_DIR/server"
mkdir -p "$INSTALL_DIR/public"

# ── 4. Copie des fichiers ────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
info "Copie des fichiers depuis $SCRIPT_DIR..."

if [ ! -f "$SCRIPT_DIR/package.json" ]; then
  die "package.json introuvable. Lancez ce script depuis le répertoire netmap/."
fi

cp -r "$SCRIPT_DIR/package.json" "$INSTALL_DIR/"
cp -r "$SCRIPT_DIR/server/"*    "$INSTALL_DIR/server/"
cp -r "$SCRIPT_DIR/public/"*    "$INSTALL_DIR/public/"
success "Fichiers copiés"

# ── 5. npm install ───────────────────────────────────────────
info "Installation des dépendances npm (better-sqlite3 compile en natif, ~1 min)..."
cd "$INSTALL_DIR"
npm install --omit=dev 2>&1 | tail -5
success "npm install OK"

# ── 6. Utilisateur système ───────────────────────────────────
info "Création de l'utilisateur système '$SERVICE_USER'..."
if ! id "$SERVICE_USER" &>/dev/null; then
  useradd --system --no-create-home --shell /bin/false "$SERVICE_USER"
  success "Utilisateur '$SERVICE_USER' créé"
else
  warn "Utilisateur '$SERVICE_USER' déjà existant"
fi
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

# ── 7. Service systemd ───────────────────────────────────────
info "Création du service systemd..."
cat > /etc/systemd/system/netmap.service << EOF
[Unit]
Description=NetMap — Network Monitoring Map
Documentation=https://github.com/netmap
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
ExecStart=/usr/bin/node ${INSTALL_DIR}/server/index.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=netmap
Environment=NODE_ENV=production
Environment=PORT=${PORT}

# Sécurité
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=${INSTALL_DIR}/db

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable netmap
systemctl restart netmap
sleep 2

# ── 8. Vérification ─────────────────────────────────────────
if systemctl is-active --quiet netmap; then
  success "Service netmap démarré avec succès"
else
  warn "Le service ne semble pas démarré. Logs:"
  journalctl -u netmap -n 20 --no-pager
fi

# ── 9. Firewall (optionnel) ──────────────────────────────────
if command -v ufw &>/dev/null; then
  ufw allow $PORT/tcp comment 'NetMap' 2>/dev/null || true
  info "Règle UFW ajoutée pour le port $PORT"
fi

# ── Résumé ───────────────────────────────────────────────────
IP=$(hostname -I | awk '{print $1}')
echo ""
echo -e "${GREEN}══════════════════════════════════════════════${NC}"
echo -e "${GREEN}  ✓ NetMap installé avec succès !${NC}"
echo -e "${GREEN}══════════════════════════════════════════════${NC}"
echo ""
echo -e "  URL : ${CYAN}http://${IP}:${PORT}${NC}"
echo ""
echo "  Commandes utiles :"
echo "    systemctl status netmap      # état du service"
echo "    systemctl restart netmap     # redémarrage"
echo "    journalctl -u netmap -f      # logs en direct"
echo "    sqlite3 $INSTALL_DIR/db/netmap.db  # console DB"
echo ""
echo -e "${YELLOW}  ➜ Configurez Zabbix dans l'interface → Paramètres${NC}"
echo ""
