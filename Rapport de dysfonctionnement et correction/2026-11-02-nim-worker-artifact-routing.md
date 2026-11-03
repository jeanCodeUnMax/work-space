# Dysfonctionnement — routage des livrables nim-worker

> Date : 2026-11-02 · Projet source : VIdo_Prod · Signalé par : Devin (Cash)

## Symptôme

Les tasks dispatchées via `dispatch_task` vers `nim1`/`nim2` s'exécutent (pid réel, appels NIM OK quand le modèle est vivant) mais retombent systématiquement en `failed` avec :

```
expected_artifact non satisfait: artifact absent ou illisible: <workspace>\...
```

## Cause identifiée

`nim-worker.mjs` écrit le livrable dans **son propre répertoire `.agent`** du kit :
`C:\Program Files\Projet-complet\hephaistos2-kit\.agent\agent-bridge\<fichier>`
au lieu du workspace cible de la tâche (`{workspace}` de la commande agent).

La porte `expected_artifact` vérifie le fichier **dans le workspace** → absent → `failed`,
même quand le worker a réellement produit un fichier.

## Contraintes de la porte (confirmées)

- `expected_artifact` doit être un **chemin de fichier existant** (pas une description).
- Le fichier doit être **postérieur au dispatch** (mtime > created_at).
- Le fichier doit être **dans le workspace** (path traversal refusé sinon).

## Second problème associé

- `dispatch_task` refuse les agents dont le provider est `enabled=0` ou sans modèle live : hermes, agy, ollama-cloud, omniroute-local (HTTP 401 upstream).
- Modèles morts côté compte NIM : `nemotron-3-super-120b-a12b`, `starcoder2-15b` (404 fonction révoquée). `ultra-550b` répond mais très lent — à réserver.
- Modèles 30B vivants : `nemotron-3.5-lightning-30b-a3b`, `nano-omni-30b-a3b-reasoning`, `muse-glimmer-30b`, `gpt-oss-20b`.

## Correctif proposé (à faire DANS le kit)

1. `nim-worker.mjs` : écrire le livrable dans `process.cwd()` (la commande fait déjà `cd /d "{workspace}"`) ou résoudre le chemin absolu de `expected_artifact` contre `{workspace}`.
2. `model_health` : refresh périodique des modèles NIM (les 404 fonctions devraient marquer le modèle unavailable).
3. Documenter dans les agents : `expected_artifact` = chemin relatif workspace obligatoire.

## Impact

Orchestration SWAT inutilisable pour les livrables fichiers tant que non corrigé (contournement : livrable produit par l'orchestrateur lui-même, comme fait sur VIdo_Prod).
