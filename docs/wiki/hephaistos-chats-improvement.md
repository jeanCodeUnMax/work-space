# Hephaistos Chats — Spécifications, Analyse & Améliorations Majeures

*Document de référence pour le sous-système de chat interactif multi-onglets de Hephaistos2-Kit.*

---

## 1. Contexte & Rôle dans Hephaistos2-Kit

Dans l'architecture de la forge Hephaistos2-Kit, trois briques complémentaires équipent l'environnement IDE :
1. **`hephaistos-kit-search`** : Moteur de recherche local instantané exploitant la MFT NTFS ($MFT/USN) et Tantivy pour retrouver fichiers et symboles sans latence.
2. **`orchestrator-monitor`** : Tableau de bord de supervision des workers asynchrones, des agents et des files de tâches via le pont WebSocket (`ws://127.0.0.1:7477`).
3. **`hephaistos-chats`** : **L'interface de conversation agentique native dans l'éditeur**. 
   - Chaque fil de discussion est instancié comme un document d'éditeur VS Code (`WebviewPanel`), permettant de scinder l'écran en deux (code d'un côté, agent de l'autre), d'empiler plusieurs discussions et d'organiser son espace de travail librement.
   - Les modes opérationnels (**Agent**, **Plan**, **Ask**, **Debug**) orientent le comportement et le prompt système injecté à chaque tour.
   - Le moteur s'interface directement avec l'infrastructure locale et cloud de Hephaistos : **Ollama local** (`http://127.0.0.1:11434`), **Ollama Cloud** (`gpt-oss:120b-cloud`, `nemotron-3-ultra:cloud`), **OpenRouter Free** (`liquid/lfm-2.5-2.6b:free`, `poolside/laguna-s-2.1:free`), **NVIDIA NIM** et le démon REST centralisé (`http://127.0.0.1:8792`).

---

## 2. Diagnostic Critique de l'Implémentation Initiale

Un audit approfondi du code initial a mis en lumière de graves défaillances techniques et ergonomiques :

### A. Moteur d'exécution brisé (0% de succès)
- **Verrouillage injustifié des providers tiers** : Dans l'ancienne version de `runtime.ts`, une exception levée en dur bloquait 100% des requêtes vers Ollama, Ollama-Cloud et OpenRouter :
  ```typescript
  if (provider !== 'nim' && provider !== 'nim2') {
      throw new Error(`Le fournisseur ${provider} est activé. Son tour ACP demande une session déjà ouverte. NIM et NIM 2 répondent directement.`);
  }
  ```
- **Défaillance de NIM** : L'appel de secours sur le démon REST échouait avec `NVIDIA_API_KEY absente`, alors même que les clés API `OPENROUTER_API_KEY` et `NVIDIA_API_KEY` étaient présentes dans l'environnement de travail de l'IDE.
- **Pollution de l'historique** : En cas d'erreur réseau ou d'API, l'erreur était poussée dans la collection de messages comme si elle venait de l'assistant, corrompant définitivement le fil de discussion.
- **Absence totale de streaming** : Aucune mise à jour temps réel, UI gelée jusqu'à complétion ou crash.

### B. Défaillances Ergonomiques et Laideur Visuelle
- **Absence de Markdown** : Les réponses du modèle étaient insérées avec `node.textContent = message.text;` dans un conteneur en texte brut sans aucune mise en forme, ni coloration syntaxique, ni possibilité de copier du code proprement.
- **Sélecteur de modèles chaotique** : Une liste brute de plus de 60 modèles était affichée dans un petit menu déroulant fixe de 260px sans aucune barre de recherche ni filtrage par fournisseur.
- **Composer rigide** : Hauteur fixe sans adaptation au texte tapé, pas de distinction d'état pendant la frappe, bouton d'envoi non réactif.
- **Gestion des sessions absente** :
  - Titre dérivé uniquement du modèle (10 discussions avec le même modèle portaient le même nom générique).
  - Impossibilité de renommer une conversation.
  - Impossibilité de supprimer une session (pas de méthode de purge ni de bouton corbeille).
  - Aucune persistance sur disque en cas de rechargement du cache IDE.

---

## 3. Améliorations Apportées & Refonte Complète

### A. Moteur d'Exécution Multi-Fournisseurs Résilient (`src/runtime.ts`)
1. **Support OpenRouter natif** : Détection automatique de `OPENROUTER_API_KEY` et appel direct en streaming SSE vers l'endpoint officiel (`https://openrouter.ai/api/v1/chat/completions`).
2. **Support Ollama Local & Ollama Cloud** : Connexion directe sur `http://127.0.0.1:11434/api/chat` avec streaming NDJSON ligne par ligne.
3. **Support NVIDIA NIM** : Utilisation directe de `NVIDIA_API_KEY` avec streaming ou repli sur le démon REST local.
4. **Interruption en direct (Abort)** : Intégration d'un `AbortController` permettant d'interrompre une réponse en cours de génération à tout moment via le bouton Stop.

### B. Refonte UI/UX Complète (`media/chat.css`, `media/chat.js`, `src/chatHtml.ts`)
1. **Rendu Markdown Intégré** :
   - Traitement des blocs de code avec barre d'en-tête affichant le langage et bouton interactif **Copier** (avec retour visuel instantané).
   - Prise en charge des titres, du gras, de l'italique, des listes à puces (`ul`/`ol`), des citations (`blockquote`) et du code inline.
2. **Présentation des Messages** :
   - Avatars distinctifs : utilisateur vs assistant Hephaistos (`⚡`).
   - Métadonnées complètes : horodatage et nom du modèle employé.
   - Gestion spécifique des messages d'erreur dans un bloc d'alerte stylisé non persistant.
   - Animation de pensée (points de suspension pulsants) pendant le streaming initial.
3. **Composer Moderne & Intelligent** :
   - Auto-redimensionnement dynamique de la hauteur selon le volume de texte saisi (entre 48px et 180px).
   - Pastille colorée dynamique pour chaque mode :
     - 🔵 **Agent** (`#0e639c`) : Ingénierie & génération de code
     - 🟣 **Plan** (`#8957e5`) : Stratégie & découpage architectural
     - 🟢 **Ask** (`#2ea043`) : Questions & explications sans effets de bord
     - 🟠 **Debug** (`#d29922`) : Traçabilité & analyse causale
   - Bouton d'action contextuel : devient un bouton d'arrêt rouge carré pendant la génération.
4. **Sélecteur de Modèles avec Filtrage en Temps Réel** :
   - Barre de recherche intégrée (`🔍 Rechercher un modèle...`) pour trouver instantanément un modèle parmi les dizaines de modèles disponibles.
   - Regroupement clair par fournisseur (Ollama Local, Ollama Cloud, OpenRouter Free, NVIDIA NIM).

### C. Gestion des Sessions & Sidebar (`src/homeView.ts`, `src/sessionStore.ts`)
1. **Cycle de vie complet** : Bouton de renommage (au clic sur le titre ou via l'icône ✏️), vidage de l'historique (🧹) et suppression définitive (🗑️).
2. **Double persistance** : Sauvegarde dans le `workspaceState` couplée à une copie locale sur disque dans `.agent/chats/sessions.json`.
3. **Sidebar enrichie** : Recherche de conversations, affichage des dates relatives, badges de mode et statut réel des fournisseurs.

---

## 4. Protocole Binôme, Commandes Slash & Alignement Orchestrator Monitor

### A. Header du Chat & Protocole Binôme
- **Fournisseur en haut à gauche** : Affichage explicite du provider actif (`⚡ OpenRouter`, `⚡ Ollama`, etc.).
- **Bouton Chat ID Binôme** : Placé à droite du fournisseur, un clic copie instantanément dans le presse-papier l'identité complète au format Hephaistos Binôme :
  `Chat ID: <sessionId> | Provider: <provider> | Model: <model> | Mode: <mode>` avec confirmation visuelle (`✓ Copié !`).
- **Accès à l'historique dans chaque fenêtre** : Bouton `🕒 Historique ▾` en haut à droite ouvrant un menu déroulant listant toutes les sessions enregistrées avec bascule instantanée sans fermer l'éditeur.
- **Nettoyage visuel** : Retrait du balai, du crayon et de la corbeille du header.

### B. Commandes Slash `/` dans le Composer
- Saisie de `/` dans le composer déclenchant un menu d'auto-complétion flottant :
  - `/help` : Documentation des commandes
  - `/chat-id` : Extraction et copie des métadonnées binôme
  - `/jointes <agent>` : Demande de liaison binôme (AGY, KiloCode, Hermes)
  - `/plan`, `/ask`, `/agent`, `/debug` : Bascule directe de mode
  - `/clear` : Purge de l'historique du fil
  - `/skills` : Rappel des compétences de la forge
  - `/status` : État de santé des modèles et du hub

### C. Sidebar ("la div de l'extension") alignée sur Orchestrator Monitor
- **Banderole officielle Hephaistos** (`hephaistos-banderole.jpg`) avec overlay doré *The Developer's Forge*.
- **Bloc Nouveau Chat recadré** : Largeur maîtrisée (non étirée), sélecteur de fournisseur compact et bouton d'instanciation directe.
- **Liste des fournisseurs actifs** conservée intacte pour le pilotage on/off et synchronisée en temps réel avec le WebSocket de l'orchestrateur (`ws://127.0.0.1:7477`).

---

## 5. Vérification & Prévisualisation

- **Serveur de développement** : `preview/server.js` tourne en tâche de fond sur le port `5174` (`http://127.0.0.1:5174/preview/index.html`).
- **Compilation TypeScript** : Validée sans aucune erreur (`npm run compile`).
- **Jonctions IDE** : Les symlinks pointent correctement dans `.devin/extensions` et `.cursor/extensions`.
