<p align="center">
  <img src="media/banner.png" alt="Everything Search — Sherlock suit les pistes" width="100%" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Platform-Windows%2010%20%7C%2011-blue.svg" alt="Platform" />
  <img src="https://img.shields.io/badge/Backend-Everything%20IPC%20(WM__COPYDATA)-orange.svg" alt="Backend" />
  <img src="https://img.shields.io/badge/Search-%3C50ms-brightgreen.svg" alt="Speed" />
  <img src="https://img.shields.io/badge/Index-Zero%20redondance-success.svg" alt="Index" />
  <img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License" />
</p>

---

## 🔍 Présentation

> *« Élémentaire, mon cher Watson : le fichier que vous cherchez est déjà indexé. »*

**Everything Search** transforme votre IDE en poste de détection : un panneau de recherche de fichiers **instantané**, branché directement sur l'index vivant d'[Everything](https://www.voidtools.com/) (voidtools) — le moteur de recherche NTFS qui répond en millisecondes.

Pas d'index maison, pas de scan récursif, pas de base de données dupliquée : l'extension interroge le processus Everything en cours via son protocole IPC officiel (`WM_COPYDATA` / QUERY2), exactement comme le SDK officiel. **Une seule base, celle d'Everything — zéro redondance.**

- ⚡ **Vitesse Everything** : résultats en <50 ms sur des millions de fichiers, tous disques NTFS confondus.
- 🧭 **Explorateur intégré** : vue « PC » (tous les lecteurs + cloud détectés), navigation par breadcrumbs, historique ◀ ▶.
- 🕵️ **Syntaxe native Everything** : `ext:`, `size:>10mb`, `dm:today`, `path:`, `regex:`, `!not`, `a|b`… toute la puissance du moteur.
- 📁 **Outils filesystem complets** : lecture, écriture, déplacement, suppression, création — les capacités du MCP filesystem officiel, servies à la vitesse d'Everything.
- 🤖 **Soumission à l'agent** : fichiers et dossiers injectés dans le chat Devin via `fileMention` natif, avec chemin absolu.
- 🌍 **Multilingue** : FR / EN / ES / DE.

---

## ✨ Fonctionnalités

### 1. Recherche instantanée
- Résultats live pendant la frappe, triables par nom / chemin / taille / date / extension.
- Filtres rapides (dossier, fichier, audio, vidéo, document, exécutable, image, archive…).
- En-tête fixe, colonnes **redimensionnables et réordonnables** par glisser-déposer.
- Multi-sélection (Ctrl/Shift), ouverture, révélation dans l'explorateur, copie de chemin.

### 2. Navigateur de fichiers
- Écran d'accueil **PC** : tous les lecteurs locaux + racines cloud détectées (OneDrive, Google Drive, Dropbox, iCloud).
- Descente dans les dossiers, retour par breadcrumbs, historique avant/arrière type navigateur.
- Champ vide = retour automatique à la vue PC — « tant qu'on n'a pas cherché, on est là ».

### 3. Aperçu universel
- Preview texte pour **tout fichier** (détection binaire automatique) — `.env`, logs, scripts, configs sans extension.
- Aperçu images (PNG, JPG, GIF, BMP, WebP, ICO, SVG).
- Panneau redimensionnable, dépliable/repliable.

### 4. Favoris & productivité
- Dossiers favoris en tuiles dans la barre de navigation, fichiers favoris en liste déroulante.
- Glisser-déposer direct depuis les résultats pour épingler.
- Création de fichiers/dossiers in-place, suppression, renommage.

### 5. Intégration agent
- Sélection → **Submit to agent** : puces `fileMention` natives dans le chat Devin (même mécanisme que le drag-to-Cascade du workbench), chaque mention précédée du chemin absolu exact — aucune ambiguïté entre homonymes sur des lecteurs différents.
- Le MCP sous-jacent expose aussi `everything_search`, `everything_count`, `fs_*` pour les autres agents via stdio.

---

## 🏗️ Architecture

```text
┌──────────────────────────┐
│  Everything Search (IDE) │   panneau webview — UI uniquement
│  extension/media/panel.* │
└───────────┬──────────────┘
            │ postMessage
┌───────────▼──────────────┐
│  searchView.js + fs natif│   ops fichiers hôtes (preview, favs, injection)
└───────────┬──────────────┘
            │ stdio JSON-RPC
┌───────────▼──────────────┐
│  everything-mcp server   │   server.py — stdio, aucun port réseau
│  (profil default = user) │
└───────────┬──────────────┘
            │ WM_COPYDATA / QUERY2
┌───────────▼──────────────┐
│   Everything.exe (live)  │   index MFT NTFS temps réel — UNE seule DB
│   %LOCALAPPDATA%\…\.db   │
└──────────────────────────┘
```

**Everything 1.4+ doit être installé et lancé** — c'est la condition sine qua non. Le serveur retrouve l'exécutable même hors du chemin d'installation par défaut (processus en cours → registre → chemins standards).

---

## 🔐 Sécurité

- **stdio uniquement** : le serveur MCP n'ouvre aucun socket, aucun port — pas de surface réseau.
- **`.mcp-access`** : politique d'accès par agent externe (whitelist gitignore-style) ; l'extension locale tourne en profil `default` — vos fichiers, vos droits.
- Les serveurs HTTP/ETP optionnels d'Everything ne sont **pas** utilisés — laissez-les désactivés.

---

## 🙏 Crédits

**Everything** © [voidtools](https://www.voidtools.com/) — David Carpenter.
Ce projet est un client fin au-dessus de l'index vivant d'Everything, via le même protocole IPC que le SDK officiel. Sans Everything, pas de magie : installez-le, il le mérite.

---

<p align="center">
  <img src="media/hephaistos-kit_banderole.jpg" alt="Hephaistos-Kit" width="70%" />
</p>

**Everything Search** est un module du **[Hephaistos-Kit](https://github.com/projet-temporaire/hephaistos2-kit)** — le forgeron des environnements de développement agentiques — développé par l'organisation **projet-temporaire**.

### ☕ Offrir un café

Le projet est gratuit et open source (MIT). S'il vous fait gagner du temps :

<p align="center">
  <img src="media/paypal-qr.png" alt="QR Code PayPal — offrir un café" width="180"/>
  <br/><sub>Scannez pour offrir un café via PayPal</sub>
</p>
