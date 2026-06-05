#!/bin/bash
# ============================================================
#  Soliday Map — Script de mise à jour Debian 11 LXC
#  Usage: sudo bash update.sh
# ============================================================
set -e

INSTALL_DIR="/opt/netmap"
SERVICE_USER="netmap"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;35m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
die()     { echo -e "${RED}[ERR]${NC} $1"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Ce script doit être exécuté en root (sudo bash update.sh)"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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
[ -f "$SCRIPT_DIR/package.json" ] || die "package.json introuvable. Lancez ce script depuis le répertoire netmap/."
[ -d "$INSTALL_DIR" ]             || die "NetMap n'est pas installé dans $INSTALL_DIR. Lancez install.sh d'abord."

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

# ── 3. Copie des fichiers (sans DB) ──────────────────────
info "Mise à jour des fichiers..."
cp -r "$SCRIPT_DIR/package.json" "$INSTALL_DIR/"
cp -r "$SCRIPT_DIR/server/"*     "$INSTALL_DIR/server/"
cp -r "$SCRIPT_DIR/public/"*     "$INSTALL_DIR/public/"
success "Fichiers mis à jour"

# ── 4. npm install (dépendances éventuellement nouvelles) ─
info "Mise à jour des dépendances npm..."
cd "$INSTALL_DIR"
npm install --omit=dev 2>&1 | tail -5
success "npm install OK"

# ── 5. Permissions ────────────────────────────────────────
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
echo -e "  URL : ${CYAN}http://${IP}:${PORT}${NC}"
echo ""
echo "  Commandes utiles :"
echo "    systemctl status netmap      # état du service"
echo "    journalctl -u netmap -f      # logs en direct"
echo ""
