#!/bin/bash
# ============================================================
#  Soliday Map — Script de mise à jour Debian 11 LXC
#  Usage: sudo bash update.sh
# ============================================================
set -e

INSTALL_DIR="/opt/netmap"
SRC_DIR="$INSTALL_DIR/src"
REPO_URL="${REPO_URL:-https://github.com/Acidpix/Solidays_Infra_Map.git}"
BRANCH="${BRANCH:-main}"
SERVICE_USER="netmap"
HTTPS_PORT=3443
SSL_DIR="$INSTALL_DIR/ssl"
SSL_KEY="$SSL_DIR/netmap.key"
SSL_CERT="$SSL_DIR/netmap.crt"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;35m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
die()     { echo -e "${RED}[ERR]${NC} $1"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Ce script doit être exécuté en root (sudo bash update.sh)"

echo -e "${CYAN}"
echo "  ███████╗ ██████╗ ██╗     ██╗██████╗  █████╗ ██╗   ██╗███████╗    ███╗   ███╗ █████╗ ██████╗ "
echo "  ██╔════╝██╔═══██╗██║     ██║██╔══██╗██╔══██╗╚██╗ ██╔╝██╔════╝    ████╗ ████║██╔══██╗██╔══██╗"
echo "  ███████╗██║   ██║██║     ██║██║  ██║███████║ ╚████╔╝ ███████╗    ██╔████╔██║███████║██████╔╝"
echo "  ╚════██║██║   ██║██║     ██║██║  ██║██╔══██║  ╚██╔╝  ╚════██║    ██║╚██╔╝██║██╔══██║██╔═══╝ "
echo "  ███████║╚██████╔╝███████╗██║██████╔╝██║  ██║   ██║   ███████║    ██║ ╚═╝ ██║██║  ██║██║     "
echo "  ╚══════╝ ╚═════╝ ╚══════╝╚═╝╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚══════╝    ╚═╝     ╚═╝╚═╝  ╚═╝╚═╝     "
echo -e "${NC}"
echo "  Soliday Map — Mise à jour"
echo ""

# ── Vérifications ─────────────────────────────────────────
[ -d "$INSTALL_DIR" ] || die "NetMap n'est pas installé dans $INSTALL_DIR. Lancez install.sh d'abord."
command -v git &>/dev/null || { info "Installation de git..."; apt-get install -y git 2>/dev/null || die "Impossible d'installer git"; }

# ── 1. Arrêt du service ───────────────────────────────────
info "Arrêt du service netmap..."
systemctl stop netmap
success "Service arrêté"

# ── 2. Sauvegarde de la DB ────────────────────────────────
DB_FILE="$INSTALL_DIR/db/netmap.db"
if [ -f "$DB_FILE" ]; then
  BACKUP="$INSTALL_DIR/db/netmap.db.bak-$(date +%Y%m%d-%H%M%S)"
  cp "$DB_FILE" "$BACKUP"
  success "Base de données sauvegardée → $BACKUP"
fi

# ── 3. Mise à jour du code depuis Git ────────────────────
git config --global --add safe.directory "$SRC_DIR" 2>/dev/null || true
if [ -d "$SRC_DIR/.git" ]; then
  info "git pull ($BRANCH)..."
  git -C "$SRC_DIR" remote set-url origin "$REPO_URL"
  git -C "$SRC_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$SRC_DIR" reset --hard FETCH_HEAD
else
  warn "Source git absente, clonage initial dans $SRC_DIR..."
  rm -rf "$SRC_DIR"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$SRC_DIR"
fi
[ -f "$SRC_DIR/package.json" ] || die "package.json introuvable dans le dépôt cloné."

info "Déploiement des fichiers (la DB n'est pas touchée)..."
cp -f  "$SRC_DIR/package.json" "$INSTALL_DIR/"
cp -rf "$SRC_DIR/server/"*     "$INSTALL_DIR/server/"
cp -rf "$SRC_DIR/public/"*     "$INSTALL_DIR/public/"
success "Fichiers mis à jour"

# ── 4. npm install (dépendances éventuellement nouvelles) ─
info "Mise à jour des dépendances npm..."
cd "$INSTALL_DIR"
npm install --omit=dev 2>&1 | tail -5
success "npm install OK"

# ── 5. Dossier data (fond de carte) ──────────────────────
mkdir -p "$INSTALL_DIR/data"
mkdir -p "$SSL_DIR"

# ── 5b. Certificat SSL ───────────────────────────────────
if [ -f "$SSL_CERT" ] && [ -f "$SSL_KEY" ]; then
  success "Certificats SSL existants conservés"
else
  info "Certificats SSL manquants, génération..."
  IP_ADDR=$(hostname -I | awk '{print $1}')
  openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
    -keyout "$SSL_KEY" -out "$SSL_CERT" \
    -subj "/C=FR/ST=France/L=Local/O=NetMap/CN=${IP_ADDR}" \
    -addext "subjectAltName=IP:${IP_ADDR},IP:127.0.0.1" \
    2>/dev/null
  chmod 640 "$SSL_KEY" "$SSL_CERT"
  chown root:"$SERVICE_USER" "$SSL_KEY" "$SSL_CERT"
  success "Certificats SSL générés → $SSL_CERT"
fi

# ── 5c. Mise à jour du service systemd ───────────────────
SERVICE_FILE="/etc/systemd/system/netmap.service"
needs_reload=false

if [ -f "$SERVICE_FILE" ] && ! grep -q "$INSTALL_DIR/data" "$SERVICE_FILE"; then
  info "Mise à jour du service systemd (ReadWritePaths)..."
  sed -i "s|ReadWritePaths=.*|ReadWritePaths=${INSTALL_DIR}/db ${INSTALL_DIR}/data|" "$SERVICE_FILE"
  needs_reload=true
fi

if [ -f "$SERVICE_FILE" ] && ! grep -q "SSL_KEY" "$SERVICE_FILE"; then
  info "Ajout de la configuration SSL au service systemd..."
  sed -i "/Environment=PORT=/a Environment=HTTPS_PORT=${HTTPS_PORT}\nEnvironment=SSL_KEY=${SSL_KEY}\nEnvironment=SSL_CERT=${SSL_CERT}" "$SERVICE_FILE"
  needs_reload=true
fi

if $needs_reload; then
  systemctl daemon-reload
  success "Service systemd mis à jour"
fi

# ── 6. Permissions ────────────────────────────────────────
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

# ── 6. Redémarrage du service ─────────────────────────────
info "Redémarrage du service netmap..."
systemctl start netmap
sleep 2

if systemctl is-active --quiet netmap; then
  success "Service netmap redémarré avec succès"
else
  warn "Le service ne semble pas démarré. Logs:"
  journalctl -u netmap -n 20 --no-pager
  exit 1
fi

# ── Résumé ────────────────────────────────────────────────
IP=$(hostname -I | awk '{print $1}')
PORT=$(systemctl show netmap --property=Environment | grep -o 'PORT=[0-9]*' | cut -d= -f2)
PORT=${PORT:-3000}

echo ""
echo -e "${GREEN}══════════════════════════════════════════════${NC}"
echo -e "${GREEN}  ✓ NetMap mis à jour avec succès !${NC}"
echo -e "${GREEN}══════════════════════════════════════════════${NC}"
echo ""
echo -e "  HTTP  : ${CYAN}http://${IP}:${PORT}${NC}"
echo -e "  HTTPS : ${CYAN}https://${IP}:${HTTPS_PORT}${NC}  ${YELLOW}(certificat auto-signé)${NC}"
echo ""
echo "  Commandes utiles :"
echo "    systemctl status netmap                    # état du service"
echo "    journalctl -u netmap -f                    # logs en direct"
echo "    openssl x509 -in $SSL_CERT -noout -dates   # validité du certificat"
echo ""
