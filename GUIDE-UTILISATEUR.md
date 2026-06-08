# Guide utilisateur — Solidays Infra Map

Cartographie de l'infrastructure réseau sur un plan, avec supervision en temps réel
(Zabbix), regroupement du matériel par **points** et superposition GPS sur une carte réelle.

> Accès à l'application : `http://<adresse-du-serveur>:3000` (ou `https://<adresse>:3443`).

---

## 1. Vue d'ensemble de l'écran

```
┌───────────────────────────────────────────────────────────────┐
│  [Barre d'outils]  ← légende, zoom, verrou, alertes, réglages  │
├──────────────┬────────────────────────────────────────────────┤
│              │                                                 │
│   Panneau    │                                                 │
│   de gauche  │              Plan / Carte                       │
│  (Équipements│         (canvas interactif)                     │
│   + Points)  │                                                 │
│              │                                                 │
├──────────────┴────────────────────────────────────────────────┤
│  [Barre d'état]  ← compteurs OK / Warn / Crit, zoom, sync      │
└───────────────────────────────────────────────────────────────┘
```

- **Panneau de gauche** : la liste du matériel (par catégorie) et la liste des **points**.
- **Carte** : le plan où l'on place les équipements et les points.
- **Barre d'état** (en bas) : nombre d'équipements placés, compteurs de statut, niveau de zoom.

---

## 2. La barre d'outils

| Bouton | Rôle |
|--------|------|
| ▥ **Panneau** | Affiche / masque le panneau de gauche |
| 🔒 **Positions / Verrouillé** | Verrouille le déplacement des équipements (évite de bouger un élément par erreur) |
| 🔔 **Alertes** | Ouvre l'historique des alertes (un badge rouge indique les alertes critiques actives) |
| 🔍➕ / 🔍➖ | Zoom avant / arrière |
| ⟲ **Reset** | Recentre et remet le zoom à 100 % |
| ↻ **Rafraîchir** | Force une relecture immédiate des données Zabbix |
| 🗺️ **Placer le plan** | (mode GPS uniquement) ouvre les outils de calage du plan sur la carte |
| ⚙ **Paramètres** | Connexion Zabbix, triggers, affichage, GPS, synchronisation |
| 🌙 / ☀️ | Bascule thème sombre / clair |

---

## 3. Le panneau de gauche

### Section « Équipements »
Les équipements **pas encore placés** sur le plan sont listés par catégorie (Pont WAVE,
AP WiFi, Switch, Caméra…). Chaque catégorie se déplie/replie en cliquant sur son en-tête (▶).

- Le bouton **+** en haut crée une nouvelle catégorie.
- Au survol d'une catégorie, **✎** (modifier) et **✕** (supprimer) apparaissent.

> Un équipement déjà placé sur la carte ou rangé dans un point **n'apparaît plus** ici
> (pas de doublon).

### Section « Points »
Sous les catégories, la liste de tous les **points** (zones de regroupement du matériel).
- Cliquez sur le triangle ▶ d'un point pour voir le matériel qu'il contient.
- Le bouton **◎** recentre la carte sur le point et ouvre sa fiche.

Le panneau de gauche et la carte sont **toujours synchronisés** : un changement d'un côté
se reflète immédiatement de l'autre.

---

## 4. Placer du matériel sur le plan

1. Ouvrez le panneau de gauche et dépliez une catégorie.
2. **Glissez-déposez** un équipement depuis la liste vers la carte.
3. Relâchez à l'endroit voulu.

- Pour **déplacer** un équipement déjà placé : cliquez-glissez dessus.
- Pour **le retirer** de la carte : clic droit dessus → **Retirer de la carte** (il revient
  dans le panneau de gauche).
- Au **survol** d'un équipement, une fiche s'affiche avec ses infos (IP, ping, latence,
  signal, clients, température, puissance, FPS, uptime…) et un lien **GPS** cliquable
  (ouvre Google Maps).

> 🔒 Pensez au bouton **Verrouillé** pour figer les positions une fois le plan en place.

---

## 5. Les points (regroupement du matériel)

Un **point** représente un emplacement (ex. « Scène principale », « Régie ») qui contient
plusieurs équipements. Sur la carte, c'est une **zone** dont le contour s'adapte
automatiquement au matériel qu'elle contient.

### Créer un point
- **Clic droit** sur une zone vide du plan → **Créer un point**, donnez-lui un nom.

### Remplir / organiser un point
- **Glissez un équipement dans la zone** d'un point pour l'y ranger.
- **Déplacez un équipement à l'intérieur** : le contour du point s'agrandit/rétrécit pour
  le suivre.
- **Déplacez le point entier** : cliquez-glissez sur une zone vide du contour, tout le
  matériel suit.
- Pour faire passer un équipement d'un point à un autre, glissez-le sur l'autre zone.

### La fiche d'un point
Cliquez sur un point (ou sur **◎** dans le panneau) pour ouvrir sa fiche :

| Action | Effet |
|--------|-------|
| ✎ (ou clic sur le nom) | Renommer le point |
| ✕ à côté d'un équipement | Sortir cet équipement du point |
| ✓ **Posé** | Marque le point comme installé (pastille verte) |
| ⏸ **Désactiver** | Met le point en pause (ignoré dans les alertes) |
| 🗑 **Supprimer** | Supprime le point (le matériel n'est pas supprimé) |
| 📍 lien GPS | Ouvre la position du point dans Google Maps |

> **Code couleur d'un point** : vert = posé / OK, orange = avertissement,
> rouge = au moins un équipement en défaut critique, gris = désactivé.

---

## 6. Synchronisation avec Device Assigner

Permet de créer automatiquement **un point par point de distribution** défini dans
l'application Device Assigner, et d'y ranger le matériel correspondant.

1. **Paramètres → Synchronisation**.
2. Saisissez l'**URL** de l'API (ex. `http://10.230.0.43`) et, si besoin, une **clé API**.
3. Cliquez **🔄 Synchroniser maintenant**.

Résultat affiché : nombre de points créés / mis à jour, matériel relié, et la liste du
matériel **non trouvé** (sans équipement Zabbix correspondant).

> La correspondance se fait **par nom** entre le matériel distant et les équipements Zabbix.
> Relancer la synchro met à jour les points existants sans créer de doublons.

---

## 7. Mode GPS (carte réelle)

Superpose le plan sur une carte OpenStreetMap pour situer l'infrastructure dans le monde réel.

### Activer
**Paramètres → GPS / Carte → Activer OpenStreetMap.**
On peut régler l'**opacité** du plan et afficher **sa propre position GPS** (point bleu).

### Caler le plan sur la carte
1. **Paramètres → GPS / Carte → Calibration** : entrez les coins **NW** (haut-gauche) et
   **SE** (bas-droite), ou cliquez **📍 Pointer NW / SE** puis cliquez sur la carte.
2. Ou utilisez l'outil **🗺️ Placer le plan** (barre en haut) pour ajuster visuellement :
   - **Taille** du plan,
   - **Plan** : rotation du plan,
   - **OSM** : rotation de la carte,
   - **⊡ Auto / W H** : applique le ratio largeur/hauteur de l'image,
   - **📍 Vue de départ** : mémorise la vue affichée à l'ouverture,
   - **💾 Enregistrer**.

> En mode GPS, la taille des équipements et des points **suit le zoom** de la carte.

---

## 8. Catégories

Une catégorie regroupe un type de matériel (couleur + icône) et détermine **comment les
équipements Zabbix sont triés**.

**Créer / modifier** : bouton **+** du panneau, ou **✎** sur une catégorie.

| Champ | Description |
|-------|-------------|
| **Nom** | Libellé affiché |
| **Couleur** | Couleur des pastilles |
| **Icône** | 1 caractère affiché dans la pastille |
| **Host groups Zabbix** | Un ou plusieurs noms de groupes Zabbix, **un par ligne** |

Le tri se fait par **correspondance exacte** du host group : un équipement dont le groupe
Zabbix est `Wave-AP` va dans la catégorie configurée avec `Wave-AP`, et **pas** dans celle
configurée avec `Wave`. Un champ de saisie propose automatiquement les groupes existants.

> Toute modification d'une catégorie **re-trie immédiatement** les équipements concernés.

---

## 9. Triggers (règles d'alerte)

**Paramètres → Triggers.** Les triggers sont organisés par catégorie. Pour chaque règle :

- **Activer / désactiver** (case à cocher),
- **Sévérité** : cliquez sur le badge pour basculer **Warn ↔ Crit**,
- **Métrique** : la donnée surveillée (latence, signal, clients, température, puissance,
  échecs de connexion, FPS, ports…),
- **Opérateur** : `>`, `<`, `>=`, `<=`, `==`, `!=`,
- **Seuil** : la valeur de déclenchement.

Pour **ajouter** un trigger : remplissez la ligne du bas (nom optionnel, métrique,
opérateur, seuil, sévérité) puis **+ Ajouter**. Cliquez **Enregistrer** en bas de la
fenêtre pour sauvegarder.

> Exemple : catégorie *Pont WAVE*, métrique *Température*, `>`, `60`, sévérité *Crit*
> → alerte critique dès qu'un pont dépasse 60 °C.

---

## 10. Alertes

Le bouton **🔔 Alertes** ouvre l'historique :
- Statistiques sur 7 jours (critiques, warnings, actives),
- Filtres : Toutes / Critiques / Warnings / Actives / 7 derniers jours,
- Chaque ligne indique l'équipement, le trigger, la valeur, l'état (Active/Résolue) et la date.

Sur la carte, les équipements et points en défaut **pulsent** (halo orange = warning,
rouge = critique). Le badge rouge sur le bouton Alertes compte les défauts critiques actifs.

---

## 11. Affichage

**Paramètres → Affichage** :

| Option | Effet |
|--------|-------|
| **Labels des équipements** | Affiche le nom sous chaque pastille |
| **Halos d'alerte animés** | Pulsation sur les défauts |
| **Grille de fond** | Quadrillage d'aide au positionnement |
| **Échelle des icônes** | Taille des pastilles |
| **Fond de carte** | Importer une image de plan personnalisée |
| **Fond de carte clair** | Textes/grille en sombre (pour un plan blanc) |
| **Couleurs des catégories** | Personnaliser chaque couleur |

---

## 12. Connexion Zabbix

**Paramètres → Connexion Zabbix** :

- **IP / Hostname**, **Port** (80, 443, 8080…), **Chemin** (`/zabbix` ou vide), **Protocole**,
- **Utilisateur / Mot de passe** (compte en lecture),
- **Tester la connexion** avant d'enregistrer,
- **Rafraîchissement** : intervalle automatique de relecture des données.

> Sans Zabbix configuré, l'application affiche des données de démonstration.

---

## 13. Questions fréquentes

**Un équipement n'apparaît nulle part.**
Il est sans doute déjà placé sur la carte ou rangé dans un point (il ne s'affiche alors plus
dans la liste de gauche). Vérifiez aussi sa catégorie.

**Je modifie une catégorie mais le matériel ne change pas de groupe.**
Le re-tri est immédiat à l'enregistrement. S'il ne se passe rien, vérifiez que le **host
group** saisi correspond exactement au groupe Zabbix de l'équipement.

**Je ne peux plus déplacer un équipement.**
Le bouton **Verrouillé** est probablement actif — recliquez dessus pour le repasser en
« Positions ».

**La fiche d'un équipement disparaît avant que je clique le lien GPS.**
Amenez la souris directement sur la fiche : elle reste affichée le temps de cliquer.

**Après une synchro, des points sont vides ou en double.**
Vérifiez le rapport de synchro (matériel non trouvé) : la liaison se fait par nom, il faut
que le nom du matériel corresponde à celui de l'équipement dans Zabbix.
