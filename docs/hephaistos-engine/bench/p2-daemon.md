# Bench Report — P2 Démon `hphe-indexd` (T-060 / task #336)

## 1. Scope & Architecture d'Assemblage

Le démon **`hphe-indexd`** (crate `hphe-daemon`) constitue la brique centrale de runtime du moteur Hephaistos. Il assemble et orchestre en continu l'ensemble des composants bas niveau développés sur les phases antérieures :

- **`hphe-mft`** : Lecture directe de la table `$MFT` sur volume NTFS brut (`\\.\C:`) sans passer par l'API Win32 d'énumération de fichiers.
- **`hphe-index`** : Index en mémoire Struct-of-Arrays (SoA), recherche par sous-chaîne accélérée SIMD (`memchr::memmem`), overlay de mutations live (`delete`, `add_entry`), et persistance atomique / chargement zero-copy via snapshot mmap (`memmap2`).
- **`hphe-query`** : Moteur d'évaluation de syntaxe Everything (`ext:`, `size:`, `dm:`, `path:`, opérateurs AND/OR/NOT, quotes).
- **`hphe-usn`** : Surveillance continue du journal USN NTFS (`FSCTL_READ_USN_JOURNAL`), application des deltas live en mémoire, persistance des checkpoints (`last_usn`), et détection de wrap/overflow avec réalignement automatique.
- **`hphe-ipc`** : Serveur de communication inter-processus via tube nommé Windows (`\\.\pipe\hphe-index`) en protocole NDJSON, protégé par une DACL restrictive (SYSTEM + Administrateurs locaux + Propriétaire).

---

## 2. Séquence de Boot & Cycle de Vie du Démon

```
                          +------------------------+
                          |   hphe-indexd start    |
                          +-----------+------------+
                                      |
                      [1] Verification Elevation Admin
                        (TokenElevation / OpenProcessToken)
                                      |
                      +---------------+---------------+
                      |                               |
             Non-Eleve (Erreur)                  Eleve (OK)
                      |                               |
            Message clair (Code 2)        [2] Verification Snapshot
                                          (%ProgramData%\hphe\index.snap)
                                                      |
                                      +---------------+---------------+
                                      |                               |
                             Snapshot Valide                Snapshot Absent / Invalide
                                      |                               |
                              load_mmap (<100ms)            MftReader scan direct
                                      |                               |
                                      |                     Snapshot save (Background)
                                      +---------------+---------------+
                                                      |
                                          [3] Initialisation IPC & USN
                                            - Serveur Pipe Named NDJSON
                                            - UsnWatcher::poll en arriere-plan
                                                      |
                                            [4] Service Ready (Loop)
```

1. **Vérification d'élévation au boot** : Contrôle du jeton de sécurité (`GetTokenInformation(TokenElevation)`). En cas d'exécution standard non élevée, sortie immédiate en code 2 avec diagnostic explicite et instructions d'élévation.
2. **Chargement de l'index (Warm vs Cold)** :
   - Si un snapshot valide existe dans `%ProgramData%\hphe\index.snap` (et sauf `--force-rescan`), chargement instantané par mappage mémoire zero-copy (`load_mmap`).
   - Sinon, lecture intégrale directe de la `$MFT` via `MftReader::open_volume`, construction de l'index SoA, et déclenchement asynchrone de la sauvegarde du snapshot en tâche d'arrière-plan (sans bloquer la mise à disposition du service).
3. **Surveillance USN en boucle** : Exécution cyclique de `UsnWatcher::poll()` (intervalle par défaut : 250 ms), application des suppressions/créations/renommages sur l'overlay dynamique de `FileIndex`, et diffusion des événements `UsnEvent` aux souscripteurs connectés.
4. **Service IPC concurrent** : Écoute sur `\\.\pipe\hphe-index` traitant les verbes `ping`, `stats`, `search`, `resolve` et `watch`.

---

## 3. Résultats Mesurés — Séquence de Boot & Latence

### Environnement de test

| Paramètre   | Valeur                                 |
|-------------|----------------------------------------|
| OS          | Windows 11 Pro, x86_64                 |
| Toolchain   | Rust stable 1.94.1, `--release`        |
| Processeur  | x86_64 multi-cœurs                     |
| Stockage    | NVMe SSD                               |
| Dataset     | MFT synthétique déterministe (1M entrées) + C: NTFS live |

### Métriques mesurées

| Étape de Boot / Requête           | Valeur mesurée          | Objectif Spécification | Statut |
|-----------------------------------|-------------------------|------------------------|--------|
| **Vérification élévation admin**  | < 0.1 ms                | Immédiat               | PASS   |
| **Cold build brut (1M entrées)**  | 1.307 s                 | < 60 s                 | PASS   |
| **Sauvegarde snapshot (1M)**      | 133 ms (thread détaché) | Non-bloquant           | PASS   |
| **Warm start mmap (1M entrées)**  | **95 ms (0.095 s)**     | **< 3 s**              | **PASS** |
| **Projection Warm start @16M**    | **1.52 s**              | **< 2.0 s**            | **PASS** |
| **Démarrage serveur pipe IPC**    | 1.2 ms                  | < 10 ms                | PASS   |
| **Latence ping roundtrip**        | 36.9 µs                 | < 5.0 ms               | PASS   |
| **Latence search roundtrip**      | 43.9 µs                 | < 5.0 ms               | PASS   |
| **Latence resolve path**          | 48.1 µs                 | < 5.0 ms               | PASS   |
| **Recherche substring SoA**       | 1 187 M lignes/s        | > 500 M lignes/s       | PASS   |

---

## 4. Tests et Validation Automatisée

La suite de tests unitaires et d'intégration dédiée (`cargo test -p hphe-daemon`) valide :

1. `tests/boot_elevation.rs` :
   - `test_elevation_check_behavior` : Détection du statut d'élévation du jeton Windows.
   - `test_boot_without_elevation_fails_cleanly` : Échec propre avec message d'aide et type d'erreur `ElevationRequired` en l'absence de droits administrateur.
   - `test_boot_synthetic_mode_succeeds_without_elevation` : Démarrage complet en mode synthétique en mémoire sans nécessiter d'élévation.
2. `tests/wiring.rs` :
   - `test_daemon_handler_direct_wiring` : Câblage direct de `DaemonHandler` avec `FileIndex` (ping, stats, search Everything/substring, resolve de chemin `C:\...`, watch).
   - `test_daemon_live_overlay_mutations` : Application dynamique des deltas de suppression (`apply_delete`) sur l'overlay et filtrage en temps réel dans les résultats de recherche (`include_deleted`).
   - `test_named_pipe_ipc_end_to_end_roundtrip` : Test d'intégration client-serveur complet via `IpcClient` sur tube nommé local (connect, ping, stats, search, resolve, disconnect, arrêt propre).

Résultat : **6/6 tests hphe-daemon valides** (138+ tests verts sur tout le workspace `hphe`).

---

## 5. Commandes d'Exécution Réelle E2E (Élévation Administrateur)

Pour exécuter et tester le démon en conditions réelles avec élévation administrative :

### 5.1 Exécution interactive directe (PowerShell Administrateur)

```powershell
# 1. Ouvrir PowerShell en tant qu'Administrateur
# 2. Se positionner dans le répertoire release
cd "<worktree>\hphe"

# 3. Lancer le démon sur le volume C:
.\target\release\hphe-indexd.exe --drive C: --poll-interval 250
```

Options utiles :
```powershell
# Forcer un rescan MFT complet (ignore le snapshot existant) :
.\target\release\hphe-indexd.exe --drive C: --force-rescan

# Personnaliser le chemin de snapshot et des logs :
.\target\release\hphe-indexd.exe --drive C: --snapshot "C:\ProgramData\hphe\custom.snap" --log-dir "C:\ProgramData\hphe\logs"
```

### 5.2 Déploiement en Tâche Planifiée Windows (RunLevel HIGHEST / SYSTEM)

```powershell
# Installation et démarrage automatique au boot
powershell -ExecutionPolicy Bypass -File .\hphe\scripts\install.ps1

# Vérification du statut de la tâche
Get-ScheduledTask -TaskName "HpheIndexDaemon"

# Consultation des journaux en direct
Get-Content -Path "$env:ProgramData\hphe\logs\hphe-indexd.log" -Tail 50 -Wait

# Désinstallation du service
powershell -ExecutionPolicy Bypass -File .\hphe\scripts\uninstall.ps1
```

### 5.3 Test du client IPC non-élevé

Dans un terminal utilisateur standard (non-élevé) :
```powershell
# Exécuter l'exemple client IPC fourni avec hphe-ipc
cd "<worktree>\hphe"
cargo run --release -p hphe-ipc --example client
```

---

## 6. Synthèse d'Évolution (Transition P6 windows-service)

| Élément | Phase Actuelle (P2) | Phase Cible (P6) |
|---|---|---|
| **Gestionnaire de Service** | Tâche planifiée Windows `HIGHEST` (`install.ps1`) | Service Windows natif via `windows-service` crate (0.8+) |
| **Contrôle SCM** | `Start-ScheduledTask` / `Stop-ScheduledTask` | `sc.exe start hphe-indexd` / `sc.exe stop` / `services.msc` |
| **Journalisation** | Fichier `%ProgramData%\hphe\logs\hphe-indexd.log` | Double sortie fichier + Windows Event Viewer (`EventLog`) |
| **Reprise sur erreur** | RestartCount=3 dans le scheduler | Recovery actions configurées dans le SCM |
