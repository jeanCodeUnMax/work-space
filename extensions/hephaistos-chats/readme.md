# Hephaistos Chats

Extension d'onglets de chat agentique multi-sessions pour l'écosystème **Hephaistos2-Kit** (*The Developer's Forge*).

Chaque conversation vit comme un document d'éditeur natif : elle se scinde, s'empile, se déplace à côté de vos fichiers de code et conserve son état et son historique.

## 🚀 Fonctionnalités Clés

- 💬 **Multi-Onglets d'Éditeur** : Ouvrez autant de discussions que vous le souhaitez, organisez-les en split-screen côte à côte avec votre code source.
- 🎯 **4 Modes Opérationnels Spécialisés** :
  - **Agent** (Bleu) : Ingénierie, génération et manipulation de code direct.
  - **Plan** (Violet) : Architecture logicielle, planification stratégique et découpage par étapes.
  - **Ask** (Vert) : Questions/réponses précises et explications sans effet de bord.
  - **Debug** (Orange) : Analyse causale de bugs, traçabilité et résolution de dysfonctionnements.
- ⚡ **Multi-Fournisseurs avec Streaming en Direct** :
  - **OpenRouter Free** (`liquid/lfm-2.5-2.6b:free`, `poolside/laguna-s-2.1:free`, etc.)
  - **Ollama Local** (`http://127.0.0.1:11434` — 37+ modèles locaux disponibles)
  - **Ollama Cloud** (`gpt-oss:120b-cloud`, `nemotron-3-ultra:cloud`)
  - **NVIDIA NIM** (API directe ou démon REST Hephaistos)
- 📝 **Rendu Markdown Intégré** : Blocs de code avec coloration et bouton de copie instantané en un clic, citations, listes et titres.
- 🔍 **Sélecteur de Modèles Intelligent** : Filtrez et recherchez instantanément parmi plus de 60 modèles avec regroupement automatique par fournisseur.
- 💾 **Persistance Renforcée** : Sauvegarde dans le `workspaceState` doublée d'un archivage local sous `.agent/chats/sessions.json`.
- 🛠️ **Gestion des Discussions** : Renommage à la volée, vidage de l'historique et suppression définitive en un clic.

## 📦 Commandes

- `Ctrl+Alt+H` : Ouvrir ou basculer sur le dernier chat actif.
- `Hephaistos : Nouveau chat` : Créer instantanément une nouvelle session.
- `Hephaistos : Ouvrir le chat` : Afficher la vue de discussion.
