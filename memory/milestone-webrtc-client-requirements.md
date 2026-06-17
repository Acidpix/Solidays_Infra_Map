---
name: milestone-webrtc-client-requirements
description: Conditions navigateur pour que le flux caméra Milestone WebRTC fonctionne (HTTPS, STUN, codec H.264)
metadata:
  type: project
---

Pour que le live caméra Milestone (WebRTC) s'affiche dans le navigateur, trois conditions
découvertes en debug (juin 2026) :

1. **Page servie en HTTPS** (`https://IP:3443`), pas en HTTP — sinon Chrome bride la récolte des
   candidats ICE (uniquement des placeholders TCP `0.0.0.0:9`, ICE bloqué à `new`).
2. **Sur le même subnet : HTTPS + mDNS Chrome activé (défaut) suffisent** — testé OK en prod juin 2026,
   sans STUN. Le STUN (`stunUrl`, coturn) n'est utile que si navigateur et serveur Milestone sont sur des
   **subnets différents** : le serveur WebRTC de Milestone est **sipsorcery** (offre SDP `s=sipsorcery`)
   qui ne résout pas les candidats mDNS `.local` à travers les subnets ; le STUN fournit alors un `srflx`
   avec la vraie IP. TURN seulement si l'UDP média est bloqué entre les deux.
3. **Le flux doit être en H.264.** Chrome ne décode PAS le **H.265/HEVC** en WebRTC → image figée
   (keyframe seule) alors que ICE/`ontrack` sont OK. C'est le symptôme exact observé sur les caméras H.265.
   Vérifier `a=rtpmap` dans l'offre SDP. Côté Milestone : profil/flux H.264 pour les GUID `{$MILESTONE_ID*}`.

L'IP du candidat host serveur vient du **Recording Server** (peut différer du subnet de l'API Gateway) ;
si elle est injoignable c'est une config réseau Milestone, pas notre code (on relaie l'SDP verbatim).
Voir [[no-local-node]].
