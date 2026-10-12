# Scripts de Déploiement et d'Exploitation du Démon `hphe-indexd`

Ce répertoire contient les scripts d'administration et d'installation du démon **`hphe-indexd`** sur Windows.

---

## 1. Vue d'Ensemble

Le démon `hphe-indexd` nécessite une élévation administrative (`SYSTEM` ou `Administrateur`) pour :
1. Accéder directement au volume NTFS brut (`\\.\C:`) afin de scanner la table `$MFT`.
2. Interroger et lire le journal des modifications NTFS (`FSCTL_READ_USN_JOURNAL`).
3. Créer le tube nommé restrictif `\\.\pipe\hphe-index` protégé par une DACL explicite.

### Architecture de Déploiement Phase 2 (P2)
En Phase 2, le démon est exécuté via le **Planificateur de Tâches Windows** avec :
- **Compte d'exécution** : `NT AUTHORITY\SYSTEM` (ServiceAccount)
- **Privilèges** : `HIGHEST` (RunLevel le plus élevé)
- **Déclencheur** : Au démarrage du système (`AtStartup`)
- **Auto-redémarrage** : Jusqu'à 3 tentatives en cas d'interruption

> **Note d'évolution P6 :**
> L'intégration native du Gestionnaire de Contrôle des Services Windows (SCM) via la crate `windows-service` (0.8+) est planifiée pour la Phase 6 (P6) avec support direct de `sc.exe`, handlers de pause/reprise et Event Viewer.

---

## 2. Procédure d'Installation

### Prérequis
1. Compiler le binaire en mode release :
   ```powershell
   cargo build --release --workspace
   ```
2. Ouvrir une invite PowerShell en tant qu'**Administrateur**.

### Exécution du script d'installation
```powershell
powershell -ExecutionPolicy Bypass -File .\hphe\scripts\install.ps1
```

Options disponibles :
```powershell
.\hphe\scripts\install.ps1 -Drive "C" -InstallDir "C:\Program Files\hphe" -TaskName "HpheIndexDaemon"
```

Le script :
- Vérifie l'élévation administrative.
- Déploie le binaire dans `$env:ProgramFiles\hphe\hphe-indexd.exe`.
- Crée les répertoires `%ProgramData%\hphe\logs` et `%ProgramData%\hphe\checkpoints`.
- Enregistre la tâche planifiée `HpheIndexDaemon` au démarrage système en mode `HIGHEST`.
- Démarre immédiatement le démon et vérifie son exécution.

---

## 3. Vérification du Démon

### Vérifier le statut de la tâche
```powershell
Get-ScheduledTask -TaskName "HpheIndexDaemon"
Get-ScheduledTaskInfo -TaskName "HpheIndexDaemon"
```

### Consulter les logs en temps réel
```powershell
Get-Content -Path "$env:ProgramData\hphe\logs\hphe-indexd.log" -Tail 50 -Wait
```

### Tester la connectivité via le client IPC
```powershell
# Vérifier la présence du tube nommé
[System.IO.Directory]::GetFiles("\\.\\pipe\\") | Select-String "hphe-index"

# Tester via le binaire client IPC
target\release\client.exe
```

---

## 4. Procédure de Désinstallation

Pour arrêter et supprimer le service :
```powershell
powershell -ExecutionPolicy Bypass -File .\hphe\scripts\uninstall.ps1
```

Pour supprimer également les données de cache (snapshots et checkpoints) :
```powershell
powershell -ExecutionPolicy Bypass -File .\hphe\scripts\uninstall.ps1 -CleanData
```
