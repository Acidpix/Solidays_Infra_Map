# NetMap — Cartographie réseau Zabbix

Application web de supervision réseau avec carte interactive, intégration Zabbix, groupes de devices et historique des alertes persisté en SQLite.

---

## Installation rapide (LXC Debian 11)

```bash
# 1. Copier le dossier netmap/ sur le LXC (depuis Proxmox host)
pct push <VMID> netmap.tar.gz /root/netmap.tar.gz
# ou via scp :
scp -r netmap/ root@<IP_LXC>:/root/

# 2. Sur le LXC
cd /root/netmap
sudo bash install.sh
```

L'installateur :
- Installe Node.js 20 LTS (si absent)
- Compile `better-sqlite3` nativement
- Crée un utilisateur système `netmap`
- Installe et démarre le service systemd `netmap`

**Accès** : `http://<IP_LXC>:3000`

---

## Structure du projet

```
netmap/
├── install.sh          ← script d'installation
├── package.json
├── server/
│   ├── index.js        ← point d'entrée Express (port 3000)
│   ├── db.js           ← SQLite schema + requêtes préparées
│   ├── zabbix.js       ← client API Zabbix
│   ├── triggers.js     ← moteur d'évaluation des triggers
│   └── routes.js       ← API REST complète
├── public/
│   └── index.html      ← frontend (canvas, popups, settings)
└── db/
    └── netmap.db       ← base SQLite (créée au démarrage)
```

---

## Schéma SQLite

| Table             | Contenu                                        |
|-------------------|------------------------------------------------|
| `config`          | Config Zabbix, display, couleurs (JSON)        |
| `device_positions`| Position X/Y de chaque device sur la carte    |
| `groups`          | Groupes avec position                          |
| `group_devices`   | Liaison groupe ↔ device                        |
| `triggers`        | Règles d'alerte par catégorie                  |
| `alert_history`   | Historique complet des alertes (fired/resolved)|

---

## API REST

| Méthode | Route                         | Description                    |
|---------|-------------------------------|--------------------------------|
| GET     | `/api/devices`                | Devices avec status évalué     |
| POST    | `/api/devices/refresh`        | Force re-fetch Zabbix          |
| PATCH   | `/api/devices/:id/position`   | Sauvegarde position            |
| GET     | `/api/groups`                 | Liste des groupes              |
| POST    | `/api/groups`                 | Créer un groupe                |
| PUT     | `/api/groups/:id`             | Modifier un groupe             |
| DELETE  | `/api/groups/:id`             | Supprimer un groupe            |
| GET     | `/api/config`                 | Config courante                |
| POST    | `/api/config`                 | Sauvegarder config             |
| POST    | `/api/config/test`            | Tester connexion Zabbix        |
| GET     | `/api/triggers`               | Triggers par catégorie         |
| POST    | `/api/triggers`               | Sauvegarder triggers           |
| DELETE  | `/api/triggers/:id`           | Supprimer un trigger           |
| GET     | `/api/alerts`                 | Historique (filtres disponibles)|
| PATCH   | `/api/alerts/:id/resolve`     | Résoudre une alerte manuellement|

---

## Détection des catégories Zabbix

Les devices sont classés automatiquement selon le nom du host, ses groupes et ses templates :

| Catégorie | Mots-clés détectés                               |
|-----------|--------------------------------------------------|
| `wave`    | WAVE, RADWIN, AIRFIBER, UBNT                     |
| `cam`     | CAMERA, CAM, CCTV, HIKVISION, DAHUA, AXIS       |
| `sw`      | SWITCH, SW-, SW_, L2, L3, VLAN                  |
| `ap`      | AP-, AP_, WIFI, WI-FI, ACCESS POINT, UNIFI, ARUBA|

Si aucun mot-clé ne correspond, le device est classé `sw` par défaut.

---

## Mapping clés Zabbix → métriques

| Clé Zabbix          | Métrique interne | Transformation         |
|---------------------|------------------|------------------------|
| `icmpping`          | `ping`           | booléen                |
| `icmppingsec`       | `latency`        | × 1000 → ms           |
| `system.uptime`     | `uptime`         | secondes → "Xj Yh"    |
| `rssi` / `signal`   | `signal`         | dBm                    |
| `wireless.clients`  | `clients`        | entier                 |
| `fps`               | `fps`            | float                  |

---

## Commandes utiles en production

```bash
# Logs en direct
journalctl -u netmap -f

# Redémarrer
systemctl restart netmap

# Inspecter la base
sqlite3 /opt/netmap/db/netmap.db
sqlite> SELECT * FROM alert_history ORDER BY fired_at DESC LIMIT 20;
sqlite> SELECT * FROM config;
sqlite> .quit

# Mettre à jour (copier les nouveaux fichiers puis)
systemctl restart netmap
```

---

## Configuration Zabbix

Dans l'interface → **Paramètres → Connexion Zabbix** :

- **IP** : adresse de votre Zabbix Server
- **Port** : typiquement `80`, `443`, ou `8080`
- **Chemin** : `/zabbix` (ou `/` si installé à la racine)
- **Protocole** : `http` ou `https`
- **User/Pass** : compte Zabbix avec accès en lecture

Utilisez **Tester la connexion** pour valider avant de sauvegarder.

En l'absence de Zabbix configuré, l'app affiche 14 devices de démonstration.

---

## Sans Zabbix (mode démo)

L'application fonctionne immédiatement sans Zabbix avec des données fictives représentant une installation événementielle typique (ponts WAVE, AP WiFi, switches, caméras). Les positions, groupes et triggers sont persistés normalement.
