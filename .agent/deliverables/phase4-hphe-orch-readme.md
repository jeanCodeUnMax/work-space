# Documentation CLI `hphe-orch` (Phase 4.3)

## 1. Architecture et emplacement du binaire

- **Projet source** : `hphe/crates/hphe-orch`
- **Binaire compilé** : `hphe-orch.exe`
- **Chemin d’installation** : `C:\Program Files\servers\hephaistos2-kit\hphe-orch.exe`

Le binaire intègre directement la bibliothèque `hphe-kit` (aucune exécution de sous‑processus stdio).

---

## 2. Sous‑commandes détaillées

Toutes les sous‑commandes acceptent l’option facultative `--json` pour obtenir une sortie au format JSON lisible par machine.

### 2.1 `list`

Liste les tâches enregistrées.

```bash
hphe-orch list [--status <pending|in_progress|completed|failed>] [--limit <n>] [--json]
```

**Exemples**

```bash
# Toutes les tâches, affichage texte
hphe-orch list

# Seulement les tâches en cours, limité à 10 entrées
hphe-orch list --status in_progress --limit 10

# Sortie JSON pour traitement automatisé
hphe-orch list --json
```

---

### 2.2 `dispatch`

Crée et envoie une nouvelle tâche vers un agent spécifié.

```bash
hphe-orch dispatch \
  --title "<titre>" \
  --task-type <code|debug|review|docs|test|explore> \
  --agent <nim1|nim2|devin> \
  --provider <nvidia-nim|nvidia-nim2> \
  --model "<model>" \
  --workspace "<path>" \
  [--expected-artifact "<path>"] \
  [--context "<desc>"] \
  [--json]
```

**Exemples**

```bash
hphe-orch dispatch \
  --title "Implémenter la fonction de tri rapide" \
  --task-type code \
  --agent nim1 \
  --provider nvidia-nim \
  --model "nemotron-3-super-120b-a12b" \
  --workspace "C:/Program Files/Projet-complet/hephaistos2-kit/src" \
  --expected-artifact "src/sort.rs" \
  --context "Implémenter en Rust, respecter le style clippy" \
  --json
```

---

### 2.3 `update`

Met à jour le statut (et éventuellement le résultat) d’une tâche existante.

```bash
hphe-orch update --id <task_id> --status <in_progress|completed|failed> [--result "<texte>"] [--json]
```

**Exemples**

```bash
hphe-orch update --id 42 --status completed --result "Tri rapide intégré et testé" --json
hphe-orch update --id 7 --status failed --result "Erreur de compilation: type mismatch"
```

---

### 2.4 `agents`

Affiche la liste des agents connus et leur état.

```bash
hphe-orch agents [--json]
```

**Exemple**

```bash
hphe-orch agents --json
```

---

### 2.5 `discipline`

Applique une sanction, une récompense ou consulte le statut de discipline d’un agent.

```bash
hphe-orch discipline --agent <name> --action <sanction|reward|status> [--reason "<motif>"] [--delta <points>] [--json]
```

**Exemples**

```bash
# Sanctionner l'agent nim2 de 5 points pour non‑respect du délai
hphe-orch discipline --agent nim2 --action sanction --reason "Dépassement de délai sur tâche #13" --delta 5 --json

# Récompenser l'agent devin de 10 points pour qualité exceptionnelle
hphe-orch discipline --agent devin --action reward --reason "Implémentation optimale du module de logging" --delta 10

# Consulter le statut de discipline de nim1
hphe-orch discipline --agent nim1 --action status --json
```

---

### 2.6 `health`

Renvoie l’état de santé du service (base de données, connexions, etc.).

```bash
hphe-orch health [--json]
```

**Exemple**

```bash
hphe-orch health --json
```

---

## 3. Codes de sortie

| Code | Signification                                                                 |
|------|-------------------------------------------------------------------------------|
| 0    | Succès – la commande s’est exécutée sans erreur.                              |
| 1    | Refus de gate ou erreur de validation (FR‑01, FR‑02, FR‑03, FR‑05).          |
| 2    | Erreur de base de données ou erreur système interne.                         |

Tout autre code de sortie est réservé à des erreurs imprévues et doit être traité comme une failure système.
