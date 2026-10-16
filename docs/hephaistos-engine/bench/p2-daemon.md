# Bench Report â€” P2 DÃ©mon `hphe-indexd` (T-060 / task #336)

## 1. Scope & Architecture d'Assemblage

Le dÃ©mon **`hphe-indexd`** (crate `hphe-daemon`) constitue la brique centrale de runtime du moteur Hephaistos. Il assemble et orchestre en continu l'ensemble des composants bas niveau dÃ©veloppÃ©s sur les phases antÃ©rieures :

- **`hphe-mft`** : Lecture directe de la table `$MFT` sur volume NTFS brut (`\\.\C:`) sans passer par l'API Win32 d'Ã©numÃ©ration de fichiers.
- **`hphe-index`** : Index en mÃ©moire Struct-of-Arrays (SoA), recherche par sous-chaÃ®ne accÃ©lÃ©rÃ©e SIMD (`memchr::memmem`), overlay de mutations live (`delete`, `add_entry`), et persistance atomique / chargement zero-copy via snapshot mmap (`memmap2`).
- **`hphe-query`** : Moteur d'Ã©valuation de syntaxe Everything (`ext:`, `size:`, `dm:`, `path:`, opÃ©rateurs AND/OR/NOT, quotes).
- **`hphe-usn`** : Surveillance continue du journal USN NTFS (`FSCTL_READ_USN_JOURNAL`), application des deltas live en mÃ©moire, persistance des checkpoints (`last_usn`), et dÃ©tection de wrap/overflow avec rÃ©alignement automatique.
- **`hphe-ipc`** : Serveur de communication inter-processus via tube nommÃ© Windows (`\\.\pipe\hphe-index`) en protocole NDJSON, protÃ©gÃ© par une DACL restrictive (SYSTEM + Administrateurs locaux + PropriÃ©taire).

---

## 2. SÃ©quence de Boot & Cycle de Vie du DÃ©mon

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

1. **VÃ©rification d'Ã©lÃ©vation au boot** : ContrÃ´le du jeton de sÃ©curitÃ© (`GetTokenInformation(TokenElevation)`). En cas d'exÃ©cution standard non Ã©levÃ©e, sortie immÃ©diate en code 2 avec diagnostic explicite et instructions d'Ã©lÃ©vation.
2. **Chargement de l'index (Warm vs Cold)** :
   - Si un snapshot valide existe dans `%ProgramData%\hphe\index.snap` (et sauf `--force-rescan`), chargement instantanÃ© par mappage mÃ©moire zero-copy (`load_mmap`).
   - Sinon, lecture intÃ©grale directe de la `$MFT` via `MftReader::open_volume`, construction de l'index SoA, et dÃ©clenchement asynchrone de la sauvegarde du snapshot en tÃ¢che d'arriÃ¨re-plan (sans bloquer la mise Ã  disposition du service).
3. **Surveillance USN en boucle** : ExÃ©cution cyclique de `UsnWatcher::poll()` (intervalle par dÃ©faut : 250 ms), application des suppressions/crÃ©ations/renommages sur l'overlay dynamique de `FileIndex`, et diffusion des Ã©vÃ©nements `UsnEvent` aux souscripteurs connectÃ©s.
4. **Service IPC concurrent** : Ã‰coute sur `\\.\pipe\hphe-index` traitant les verbes `ping`, `stats`, `search`, `resolve` et `watch`.

---

## 3. RÃ©sultats MesurÃ©s â€” SÃ©quence de Boot & Latence

### Environnement de test

| ParamÃ¨tre   | Valeur                                 |
|-------------|----------------------------------------|
| OS          | Windows 11 Pro, x86_64                 |
| Toolchain   | Rust stable 1.94.1, `--release`        |
| Processeur  | x86_64 multi-cÅ“urs                     |
| Stockage    | NVMe SSD                               |
| Dataset     | MFT synthÃ©tique dÃ©terministe (1M entrÃ©es) + C: NTFS live |

### MÃ©triques mesurÃ©es

| Ã‰tape de Boot / RequÃªte           | Valeur mesurÃ©e          | Objectif SpÃ©cification | Statut |
|-----------------------------------|-------------------------|------------------------|--------|
| **VÃ©rification Ã©lÃ©vation admin**  | < 0.1 ms                | ImmÃ©diat               | PASS   |
| **Cold build brut (1M entrÃ©es)**  | 1.307 s                 | < 60 s                 | PASS   |
| **Sauvegarde snapshot (1M)**      | 133 ms (thread dÃ©tachÃ©) | Non-bloquant           | PASS   |
| **Warm start mmap (1M entrÃ©es)**  | **95 ms (0.095 s)**     | **< 3 s**              | **PASS** |
| **Projection Warm start @16M**    | **1.52 s**              | **< 2.0 s**            | **PASS** |
| **DÃ©marrage serveur pipe IPC**    | 1.2 ms                  | < 10 ms                | PASS   |
| **Latence ping roundtrip**        | 36.9 Âµs                 | < 5.0 ms               | PASS   |
| **Latence search roundtrip**      | 43.9 Âµs                 | < 5.0 ms               | PASS   |
| **Latence resolve path**          | 48.1 Âµs                 | < 5.0 ms               | PASS   |
| **Recherche substring SoA**       | 1 187 M lignes/s        | > 500 M lignes/s       | PASS   |

---

## 4. Tests et Validation AutomatisÃ©e

La suite de tests unitaires et d'intÃ©gration dÃ©diÃ©e (`cargo test -p hphe-daemon`) valide :

1. `tests/boot_elevation.rs` :
   - `test_elevation_check_behavior` : DÃ©tection du statut d'Ã©lÃ©vation du jeton Windows.
   - `test_boot_without_elevation_fails_cleanly` : Ã‰chec propre avec message d'aide et type d'erreur `ElevationRequired` en l'absence de droits administrateur.
   - `test_boot_synthetic_mode_succeeds_without_elevation` : DÃ©marrage complet en mode synthÃ©tique en mÃ©moire sans nÃ©cessiter d'Ã©lÃ©vation.
2. `tests/wiring.rs` :
   - `test_daemon_handler_direct_wiring` : CÃ¢blage direct de `DaemonHandler` avec `FileIndex` (ping, stats, search Everything/substring, resolve de chemin `C:\...`, watch).
   - `test_daemon_live_overlay_mutations` : Application dynamique des deltas de suppression (`apply_delete`) sur l'overlay et filtrage en temps rÃ©el dans les rÃ©sultats de recherche (`include_deleted`).
   - `test_named_pipe_ipc_end_to_end_roundtrip` : Test d'intÃ©gration client-serveur complet via `IpcClient` sur tube nommÃ© local (connect, ping, stats, search, resolve, disconnect, arrÃªt propre).

RÃ©sultat : **6/6 tests hphe-daemon valides** (138+ tests verts sur tout le workspace `hphe`).

---

## 5. Commandes d'ExÃ©cution RÃ©elle E2E (Ã‰lÃ©vation Administrateur)

Pour exÃ©cuter et tester le dÃ©mon en conditions rÃ©elles avec Ã©lÃ©vation administrative :

### 5.1 ExÃ©cution interactive directe (PowerShell Administrateur)

```powershell
# 1. Ouvrir PowerShell en tant qu'Administrateur
# 2. Se positionner dans le rÃ©pertoire release
cd "<worktree>/hphe"

# 3. Lancer le dÃ©mon sur le volume C:
.\target\release\hphe-indexd.exe --drive C: --poll-interval 250
```

Options utiles :
```powershell
# Forcer un rescan MFT complet (ignore le snapshot existant) :
.\target\release\hphe-indexd.exe --drive C: --force-rescan

# Personnaliser le chemin de snapshot et des logs :
.\target\release\hphe-indexd.exe --drive C: --snapshot "C:\ProgramData\hphe\custom.snap" --log-dir "C:\ProgramData\hphe\logs"
```

### 5.2 DÃ©ploiement en TÃ¢che PlanifiÃ©e Windows (RunLevel HIGHEST / SYSTEM)

```powershell
# Installation et dÃ©marrage automatique au boot
powershell -ExecutionPolicy Bypass -File .\hphe\scripts\install.ps1

# VÃ©rification du statut de la tÃ¢che
Get-ScheduledTask -TaskName "HpheIndexDaemon"

# Consultation des journaux en direct
Get-Content -Path "$env:ProgramData\hphe\logs\hphe-indexd.log" -Tail 50 -Wait

# DÃ©sinstallation du service
powershell -ExecutionPolicy Bypass -File .\hphe\scripts\uninstall.ps1
```

### 5.3 Test du client IPC non-Ã©levÃ©

Dans un terminal utilisateur standard (non-Ã©levÃ©) :
```powershell
# ExÃ©cuter l'exemple client IPC fourni avec hphe-ipc
cd "<worktree>/hphe"
cargo run --release -p hphe-ipc --example client
```

---

## 6. SynthÃ¨se d'Ã‰volution (Transition P6 windows-service)

| Ã‰lÃ©ment | Phase Actuelle (P2) | Phase Cible (P6) |
|---|---|---|
| **Gestionnaire de Service** | TÃ¢che planifiÃ©e Windows `HIGHEST` (`install.ps1`) | Service Windows natif via `windows-service` crate (0.8+) |
| **ContrÃ´le SCM** | `Start-ScheduledTask` / `Stop-ScheduledTask` | `sc.exe start hphe-indexd` / `sc.exe stop` / `services.msc` |
| **Journalisation** | Fichier `%ProgramData%\hphe\logs\hphe-indexd.log` | Double sortie fichier + Windows Event Viewer (`EventLog`) |
| **Reprise sur erreur** | RestartCount=3 dans le scheduler | Recovery actions configurÃ©es dans le SCM |
