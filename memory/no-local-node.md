---
name: no-local-node
description: Pas de Node.js sur la machine Windows de dev — impossible d'exécuter/tester le serveur en local
metadata:
  type: project
---

La machine de dev Windows (Pixi) n'a **pas** Node.js installé (ni dans PATH, ni dans Program Files / LOCALAPPDATA). Le serveur `server/` ne peut donc pas être lancé ni vérifié syntaxiquement en local.

**Why:** Le projet Solidays_Infra_Map se déploie sur un LXC Debian 11 (`install.sh` / `update.sh`) ; le dev local sert seulement à éditer les fichiers.

**How to apply:** Ne pas tenter `node ...` pour vérifier les modifs serveur — faire une relecture manuelle soignée à la place. Le test réel se fait après déploiement sur le LXC (`sudo bash update.sh`, `journalctl -u netmap -f`).
