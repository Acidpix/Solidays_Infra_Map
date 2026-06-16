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
server/routes.js      # Endpoints REST (/api/*) : devices, config, sync, caméra/WebRTC…
server/db.js          # SQLite init, prepared statements, helpers
server/zabbix.js      # Client Zabbix JSON-RPC (auth, hosts, catégories, macros)
server/milestone.js   # Client Milestone XProtect (OAuth IDP + signalisation WebRTC)
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
- `updateGpsScale()` — en mode GPS, dérive `scale` (taille des icônes) du zoom Leaflet pour
  que points et équipements grossissent/rétrécissent avec le plan

### Points (groupes) — modèle « zone »

Un point (groupe) est rendu comme une **zone** = boîte englobant ses équipements (plus un padding
et un bandeau de titre), calculée par `gBB(g)`. Chaque équipement d'un point a une position propre
(`memberPos` : sa position si déplacé/placé, sinon une grille par défaut autour de l'ancre `g.x,g.y`).
On peut **déplacer un équipement dans un point** (le contour s'adapte) ou **déplacer le point entier**
(translation de tous ses membres). Helpers : `dragApply` (drag), `dragCommitGroup` (persistance),
`dropDevice` (drop = change de point ou enregistre la position). Un équipement membre d'un point
n'apparaît plus dans sa catégorie en haut de la sidebar (`inAnyGroup`). La sidebar (section « Points »)
et la carte partagent `groups` ; toute mutation rappelle `buildSidebar()` pour rester synchronisées.
La création de point se fait par clic droit → « Créer un point » (le bouton « Grouper » a été retiré).

## Backend — endpoints principaux

```
GET  /api/devices              Équipements (Zabbix ou mock)
POST /api/devices/refresh      Force le rechargement depuis Zabbix
GET  /api/config               Config complète (zabbix, display, gps)
POST /api/config               Sauvegarde config
GET  /api/alerts               Historique alertes (filtres: severity, active, depuis)
GET  /api/map/background       Image de fond (base64)
POST /api/map/background       Upload image de fond
POST /api/sync                 Synchro Device Assigner : 1 groupe par point + matériel relié
POST /api/camera/test          Teste l'auth Milestone (basic user) contre une IP serveur
POST /api/camera/session       Crée une session WebRTC {deviceId, server(IP), streamId}
PATCH/api/camera/session/:id   Transmet l'answerSDP du navigateur
POST /api/camera/session/:id/ice   Pousse les candidats ICE du navigateur
GET  /api/camera/session/:id/ice   Récupère les candidats ICE du serveur (polling)
DEL  /api/camera/session/:id   Ferme la session (best-effort) + nettoie le mapping
```

### Synchronisation Device Assigner

`POST /api/sync` interroge une API externe (Device Assigner, `GET <url>/api/v1/points/`) et,
pour chaque point distant, crée ou met à jour un **groupe** (1 groupe = 1 point). Le matériel du
point est relié aux équipements Zabbix par **correspondance de nom** (`normName()` : majuscules,
sans séparateurs ; exact puis partiel sur le meilleur candidat). L'`id` du point distant est
stocké dans `groups.source_id` pour rendre la synchro idempotente. Config dans `config.sync`
(`{url, apiKey}`), réglée dans l'onglet **Synchronisation** des Paramètres. Les groupes
synchronisés s'affichent sur la carte (grille auto) **et** dans la sidebar (section « Points »,
repliable via triangle). Retour : `{groupsCreated, groupsUpdated, devicesMatched, unmatched[]}`.

### Flux vidéo caméra (Milestone XProtect, WebRTC)

Sur une caméra, la popup `showDP` affiche un bouton **📹 Voir le flux** qui ouvre un modal
(`#ov-cam`) jouant le **live WebRTC** dans une balise `<video>`. Le login est **centralisé
côté serveur** (un *basic user* Milestone partagé) : le navigateur n'obtient jamais
d'identifiants ni de token — `server/index.js`/`routes.js` **proxifient** toute la signalisation.

**Authentification (`server/milestone.js`)** : `getToken()` fait un OAuth `grant_type=password`
sur `POST {serverUrl}/IDP/connect/token` (champ `client_id`, défaut `GrantValidatorClient`).
L'IDP est le service d'identité Milestone (sur le Management Server). Token mis en cache **par
serveur** (clé `serverUrl|username|clientId`). Agent HTTPS tolérant aux certificats auto-signés.

**Signalisation WebRTC** : `createSession` → `POST {serverUrl}/API/REST/v1/WebRTC/Session`
(`{deviceId, includeAudio, iceServers}`) renvoie `{sessionId, offerSDP}` ; le navigateur répond
via `PATCH …/Session/{id}` (`answerSDP`) et échange les candidats via `…/IceCandidates/{id}`
(POST + GET en polling). Le serveur Milestone est l'**offerer**, le navigateur l'**answerer**.

**Multi-sites / fédéré** : chaque caméra remonte l'**IP de son serveur** Milestone via une macro
Zabbix `{$MILESTONE.IP}` (→ `device.milestoneServer`). Le backend dérive l'URL
(`serverUrlFromIp` : `proto`/`port` globaux, défaut `https`/443) et y applique le basic user
**global**. `sessionServers` (Map `sessionId→IP`) route les appels suivants (answer/ICE/close)
vers le **même** serveur. **Anti-SSRF** : `isAllowedServer()` n'autorise que les IP réellement
remontées par Zabbix (présentes dans `devicesCache`).

**Macros Zabbix par hôte caméra** (lues via `selectMacros` dans `getHosts`) :

| Macro | Exemple | Rôle |
|-------|---------|------|
| `{$MILESTONE.IP}` | `10.0.0.5` | IP du serveur Milestone de la caméra → `device.milestoneServer` |
| `{$MILESTONE_ID}` | `<GUID>` | GUID caméra, flux 1 |
| `{$MILESTONE_ID2}`, `…ID3`… | `<GUID>` | flux supplémentaires (modal multi-onglets « Flux N ») |

Les GUID sont collectés (préfixe + suffixe numérique, base = 1) dans `device.milestoneIds[]`
(trié, valeurs vides filtrées). Les noms de macros sont configurables.

**Config** `config.milestone` = `{username, password, clientId, proto, port, macroName,
ipMacroName, stunUrl, turnUrl, turnUser, turnPass}` — onglet **Vidéo** des Paramètres.
Le `password` est masqué (`••••••••`) à l'envoi et restauré côté serveur s'il n'a pas changé
(même convention que Zabbix/sync). STUN/TURN optionnels (inutiles en LAN).

**Frontend** (`index.html`) : `openCam(d)` → `startWebRTC(deviceId)` (RTCPeerConnection,
`server=camServer`=IP), `showStream(i)` bascule de flux (nouvelle session par flux), `closeCam()`
ferme + DELETE la session. `milestoneCfg` (chargé au boot et à l'ouverture des Paramètres) ;
`msEnabled()` = basic user configuré. Bouton affiché si `milestoneIds.length` **et**
`milestoneServer` **et** `msEnabled()`.

> Limite : l'iframe du Web Client a été abandonnée (pas de login serveur possible, OIDC).
> Le WebRTC requiert le composant **XProtect API Gateway** installé et joignable sur `{IP}/API`,
> avec l'IDP sur `{IP}/IDP`. Le *basic user* doit avoir un rôle donnant accès aux caméras.

### Métriques équipements (Zabbix)

`server/zabbix.js` → `ITEM_KEY_MAP` mappe les clés d'items Zabbix vers des champs du device.
La clé est normalisée (`toLowerCase()` + suppression des `[...]`) avant lookup.
Champs disponibles (= métriques utilisables dans les triggers, voir `TRIG_METRICS` côté front) :
`ping`, `latency`, `signal` (clés `rssi`/`signal`/`tx.signal`/`link.signal`), `clients`
(`wireless.clients`/`association.count`/`clients`), `connFailure` (`connection.failure`),
`power` (`total.power`), `temp` (`Board.[Board Temp]` → `board.`), `fps`, `portsUp`, `ports`,
`traffic_in/out`, `uptime`. Ces champs s'affichent dans la popup équipement (`showDP`) quand présents.
Les triggers (onglet Triggers des Paramètres) permettent de choisir métrique + opérateur + seuil + sévérité.

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
