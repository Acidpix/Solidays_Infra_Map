# Solidays Infra Map — CLAUDE.md

## Projet

Application web de cartographie d'infrastructure réseau pour événements (festival Solidays). Permet de placer des équipements réseau (WAVE, AP, switch, caméra) sur un plan, avec monitoring temps réel via Zabbix et superposition GPS/OSM.

## Stack

- **Backend** : Node.js 20 + Express, SQLite (better-sqlite3, WAL)
- **Frontend** : SPA vanilla JS, canvas 2D, Leaflet.js + leaflet-rotate
- **Intégration** : Zabbix JSON-RPC API v5.4+
- **Déploiement** : Debian 11 LXC, systemd, HTTP :3000 + HTTPS :3443 (cert auto-signé openssl)

## Structure

```
public/index.html     # SPA complète — CSS + HTML + JS dans un seul fichier (~1600 lignes)
server/index.js       # Bootstrap Express, HTTP + HTTPS optionnel
server/routes.js      # 27 endpoints REST (/api/*)
server/db.js          # SQLite init, prepared statements, helpers
server/zabbix.js      # Client Zabbix JSON-RPC (auth, hosts, catégories)
server/triggers.js    # Moteur d'évaluation des alertes
install.sh            # Installation Debian LXC (Node, npm, systemd, SSL)
update.sh             # Mise à jour sans réinstaller Node
```

## Frontend — architecture index.html

Tout le frontend est dans `public/index.html`. Il n'y a pas de build, pas de framework.

### État global clé

| Variable | Rôle |
|----------|------|
| `devices`, `groups`, `categories` | Données métier |
| `scale`, `offX`, `offY` | Zoom/pan canvas (mode non-GPS) |
| `iconScale` | Taille des icônes (persisté localStorage) |
| `locked` | Verrouillage du déplacement des équipements |
| `gpsMode` | Mode OSM/Leaflet activé |
| `gpsBounds` | `{nw:{lat,lng}, se:{lat,lng}}` — calibration du plan sur la carte |
| `overlayRotation` | Rotation du plan en degrés |
| `mapBearing` | Rotation de la carte OSM en degrés |
| `placeMode` | Mode placement GPS actif |
| `_plScale` | Facteur d'échelle courant en mode placement |

### Mode GPS / placement

- `startPlaceMode()` / `stopPlaceMode()` — barre `#gps-place-bar`
- `applyRatio(ar)` — applique un ratio W/H aux bounds (NW fixe, ajuste SE.lat)
- `fixBoundsAspect()` — applique le ratio natif de `bgImage` et met à jour l'input `#pl-ratio-num`
- `scaleBounds(f)` — redimensionne les bounds autour de leur centre
- `canvasToGps()` / `gpsToCanvas()` — transformations coordonnées avec rotation

### Rendu canvas

- `render()` — boucle de dessin : grille, groupes, équipements, halos, labels
- `toS(rx, ry)` — coordonnées relatives → pixels écran (mode GPS ou canvas)
- `toR(sx, sy)` — pixels écran → coordonnées relatives

## Backend — endpoints principaux

```
GET  /api/devices              Équipements (Zabbix ou mock)
POST /api/devices/refresh      Force le rechargement depuis Zabbix
GET  /api/config               Config complète (zabbix, display, gps)
POST /api/config               Sauvegarde config
GET  /api/alerts               Historique alertes (filtres: severity, active, depuis)
GET  /api/map/background       Image de fond (base64)
POST /api/map/background       Upload image de fond
```

## Base de données

Tables SQLite dans `/opt/netmap/db/netmap.db` :
`config`, `categories`, `device_positions`, `groups`, `group_devices`, `triggers`, `alert_history`

## Conventions

- **Pas de build** : modifier directement `public/index.html`
- **CSS** : custom properties `--bg*`, `--text*`, `--border*` dans `:root` et `[data-theme=light]`
- **Sliders** : chaque slider `<input type=range>` a un `<input type=number>` jumeau synchronisé en bidirectionnel
- **Ratio W/H** : le champ `#pl-ratio-num` accepte un décimal (ex: `1.778`) et est synchronisé avec `fixBoundsAspect()` / `applyRatio()`
- **localStorage** : `solidayMap.bearing`, `solidayMap.overlayRot`, `solidayMap.iconScale`, `solidayMap.theme`, etc.

## Déploiement

```bash
# Installation initiale (LXC Debian)
sudo bash install.sh

# Mise à jour
sudo bash update.sh

# Logs
journalctl -u netmap -f

# Service
systemctl restart netmap
```

Variables d'environnement du service systemd :
- `PORT` (défaut 3000), `HTTPS_PORT` (défaut 3443)
- `SSL_KEY`, `SSL_CERT` — chemins vers les certificats (générés par install.sh dans `/opt/netmap/ssl/`)
