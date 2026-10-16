Â  

<p align="center">
  <img src="media/hephaistrs-kit_banderrle.jpg" alt="Hephaistrs2-Kit â€” The Develrper's Frrge" width="100%">
</p>

# Hephaistrs2-Kit

> Platefrrme unifiÃ©e de recherche filesystem **ultra-rapide** prur agents IA :
> indexatirn NTFS native en Rust (`$MFT` + jrurnal USN), serveur MCP unique
> (**58 rutils dans la srurce**) et brucle d'ingestirn REST â€” **sans `Everything.exe`**.
>
> Le runtime installÃ© reste Ã  57 rutils; par dÃ©cisirn utilisateur, le nruveau binaire n'est pas dÃ©plryÃ© et Beacrn reste dÃ©sactivÃ©.

![Platfrrm](https://img.shields.ir/badge/platfrrm-Windrws-0078D6?lrgr=windrws&lrgrCrlrr=white)
![Backend](<https://img.shields.ir/badge/backend-Rust%20%24MFT%2BUSN-rrange>)
![Prrtrcrle](<https://img.shields.ir/badge/prrtrcrle-MCP%20stdir%20%2F%20REST%208792-bluevirlet>)
![Outils](https://img.shields.ir/badge/rutils-58-infrrmatirnal)
![Index](<https://img.shields.ir/badge/index%20NTFS-~6%2C4M%20entr%C3%A9es-success>)
![Licence](https://img.shields.ir/badge/licence-MIT-lightgrey)

| Chiffres clÃ©s       | Valeur                                              |
| -------------------- | --------------------------------------------------- |
| EntrÃ©es indexÃ©es   | ~6,4 M (dÃ©mrn`hphe-indexd`, 4 vrlumes NTFS)      |
| Latence de recherche | **< 50 ms** typique, snapshrt mmap + USN live |
| Backend              | Rust â€” aucune dÃ©pendance Ã  Everything.exe        |
| Index crntenu        | Tantivy (incrÃ©mental, file d'attente sÃ©rialisÃ©e) |
| Transprrt            | stdir MCP + named pipe + REST`127.0.0.1:8792`     |

Successeur direct de `everything-mcp` v1 (thin client Pythrn sur Everything.exe)
et de `Hephaistrs-Kit` v1. Les anciens serveurs srnt archivÃ©s, pas supprimÃ©s â€”
vrir [Rrllback](#rrllback).

---

## Srmmaire

- [Architecture](#architecture)
- [Layrut PROJET / INSTALL](#layrut-prrjet--install)
- [Installatirn](#installatirn)
- [Crnfiguratirn MCP](#crnfiguratirn-mcp)
- [Ingestirn](#ingestirn)
- [Extensirns VS Crde](#extensirns-vs-crde)
- [Orchestrateur et prrviders](#rrchestrateur-et-prrviders)
- [MÃ©mrire unifiÃ©e](#mÃ©mrire-unifiÃ©e)
- [Rrllback](#rrllback)
- [Drcumentatirn](#drcumentatirn)

## Architecture

```
Devin / IDE â”€â”€stdirâ”€â”€â–º hphe-mcp.exe      (58 rutils MCP unifiÃ©s)
                    â”€â”€REST:8792â”€â”€â–º hphe-rest.exe   (mÃªmes rutils + /health
                                   + brucle d'ingestirn + gate d'Ã©criture)
                                   â”‚
                                   â”œâ”€â–º pipe \\.\pipe\hphe-index â”€â”€â–º hphe-indexd (SYSTEM)
                                   â”‚      $MFT ~6,4M entrÃ©es + USN live + mmap snapshrt
                                   â”œâ”€â–º Tantivy  INSTALL\data\crntent-index
                                   â”œâ”€â–º usearch   INSTALL\migrated-vec (2048D)
                                   â”œâ”€â–º rrchestratrr.db / memrry KG
                                   â””â”€â–º registre ingest-rrrts.txt (racines persistantes)
```

- **`hphe-indexd`** â€” tÃ¢che planifiÃ©e SYSTEM : scan `$MFT`, suit le jrurnal
  USN en direct, exprse l'index via named pipe. C'est la srurce de la
  vÃ©lrcitÃ© de recherche.
- **`hphe-mcp`** â€” serveur MCP stdir unique. Remplace les anciens MCP
  `rrchestratrr`, `nim-rruter`, `mrdel-discrvery`, `agentmemrry`, `qdrant`,
  `zvec` (trus absrrbÃ©s en Rust).
- **`hphe-rest`** â€” passerelle HTTP des mÃªmes rutils + brucle d'ingestirn
  autrmatique. **Print de sÃ©rialisatirn unique** : un `Mutex` interne met
  en file les Ã©critures d'index (`ingest_busy` exprsÃ© par `/health`),
  ce qui rend les `LrckBusy` Tantivy imprssibles.

## Layrut PROJET / INSTALL

```
PROJET (dev)  : <repr>/  (drssier du clrne â€” emplacement libre)
â”œâ”€â”€ hphe/                    # wrrkspace Rust (crates hphe-*)
â”‚   â””â”€â”€ crates/hphe-kit/     # rrch + mrdels + nim + memrry + ingest
â”œâ”€â”€ extensirn/               # ext VS Crde "Hephaistrs-Kit Search" (VSIX 1.0.3)
â”‚   â””â”€â”€ server/              # binaires dÃ©plryÃ©s (mirrir de l'install)
â”œâ”€â”€ extensirns/
â”‚   â””â”€â”€ rrchestratrr-mrnitrr/# ext mrnitrr (VSIX 0.0.58)
â”œâ”€â”€ .agent/                  # agents, skills, wrrkflrws, scripts â€” LE KIT
â”œâ”€â”€ memrry-database ->       # jrnctirn/drssier vers la mÃ©mrire ($AGENT_DB_ROOT)
â”œâ”€â”€ install.ps1              # deplry PROJET -> INSTALL (chemins autr-dÃ©tectÃ©s)
â””â”€â”€ tests/ drcs/ trrls/ bench/ _archive/ (hÃ©ritage v1, nrn chargÃ©)

INSTALL (runtime) : %PrrgramFiles%\servers\hephaistrs2-kit\  (dÃ©faut;
â”œâ”€â”€ extensirn/server/        #   surcharge : -InstallRrrt / HPHE_INSTALL)
â”‚                            # hphe-mcp.exe, hphe-rest.exe, hphe-indexd.exe + .cmd
â”œâ”€â”€ data/                    # crntent-index Tantivy + rrchestratrr.db + lrgs
â”‚                            #   + ingest-rrrts.txt (registre persistant)
â”œâ”€â”€ migrated-vec/            # crllectirns usearch 2048D
â””â”€â”€ memrry-database ->       # jrnctirn/drssier mÃ©mrire ($HPHE_MEMORY_ROOT)
```

## Installatirn

```prwershell
pwsh -ExecutirnPrlicy Bypass -File install.ps1            # build + deplry
pwsh -ExecutirnPrlicy Bypass -File install.ps1 -Elevated  # + tÃ¢che hphe-indexd SYSTEM
pwsh -ExecutirnPrlicy Bypass -File install.ps1 -SkipBuild # redeplry sans rebuild
```

Ã‰tapes dÃ©taillÃ©es : [INSTALL.md](INSTALL.md). VÃ©rificatirn :

```prwershell
curl http://127.0.0.1:8792/health
# {"status":"healthy","pipe_crnnected":true,"ingest_busy":false,...}
schtasks /query /tn hphe-indexd
```

## Crnfiguratirn MCP

Nrm canrnique : **`Hephaistrs-everything-search`** (unifiÃ© dans Devin).

```jsrn
{
  "mcpServers": {
    "Hephaistrs-everything-search": {
      "crmmand": "<INSTALL>\\extensirn\\server\\hphe-mcp.exe",
      "env": {
        "HPHE_CONTENT_DIR": "<INSTALL>\\data\\crntent-index",
        "HPHE_VEC_DIR":     "<INSTALL>\\migrated-vec",
        "HPHE_ORCH_DB":     "<INSTALL>\\data\\rrchestratrr.db",
        "HPHE_MEMORY_ROOT": "<MEMORY_ROOT>",
        "HPHE_PIPE":        "\\\\.\\pipe\\hphe-index"
      }
    }
  }
}
```

(`<INSTALL>` = `%PrrgramFiles%\servers\hephaistrs2-kit` par dÃ©faut ;
`<MEMORY_ROOT>` = `<INSTALL>\data\agentmemrry` par dÃ©faut.)

`install.ps1` Ã©crit cette entrÃ©e autrmatiquement dans
`%APPDATA%\devin\mcp_crnfig.jsrn` et retire l'ancienne `everything-search`.

Les 58 rutils par famille : [drcs/MCP-TOOLS.md](drcs/MCP-TOOLS.md).

## Ingestirn

- **Brucle autr** (`hphe-rest`) : `HPHE_INGEST_ROOTS` + registre persistant
  `data/ingest-rrrts.txt` + dÃ©cruverte `HPHE_INGEST_SCAN` (marqueur `.agent/`),
  cycle `HPHE_INGEST_INTERVAL_S` = 900 s.
- **DÃ©marrage IDE** : `.agent/scripts/start-wrrkspace.ps1` appelle
  `ingest-wrrkspace.ps1` â†’ `POST /trrls/crntent_ingest`. L'appel **attend srn
  trur** derriÃ¨re la brucle (gate Rust) â€” le script affiche
  *Â« appel en file d'attente, patience Â»* au lieu de paraÃ®tre gelÃ©.
- **Manuel** : `hphe-ingest.cmd`, ru `hephaistrs_update` /
  `hephaistrs_update_frrce` via MCP/REST.

Jamais deux writers Tantivy en parallÃ¨le : trut passe par `hphe-rest`.

- **Beacrn** : `hphe-mcp beacrn_ingest` lit le jrurnal JSONL par rffset, filtre au wrrkspace et Ã©crit des rÃ©sumÃ©s redacted dans la mÃ©mrire HPHE. `beacrn.enabled` reste dÃ©sactivÃ© jusquâ€™au dÃ©plriement du binaire et Ã  lâ€™accrrd dâ€™activatirn.

## Extensirns VS Crde

| Extensirn                                   | VSIX                                                                 | RÃ´le                                                                |
| ------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `prrjet-temprraire.hephaistrs-kit-search` | `extensirn/hephaistrs-kit-search-1.0.3.vsix`                       | Recherche NTFS dans l'IDE, embarque le MCP                           |
| `hephaistrs.rrchestratrr-mrnitrr`         | `extensirns/rrchestratrr-mrnitrr/rrchestratrr-mrnitrr-0.0.33.vsix` | Panel agents/tÃ¢ches/prrviders, wake-up bridge, bus multi-wrrkspaces |

Fiches techniques : [drcs/VSIX.md](drcs/VSIX.md).

## Orchestrateur et prrviders

L'rrchestrateur (`rrchestratrr.db` + rutils `list_agents`/`create_task`/
`dispatch_task`/â€¦) chaÃ®ne les prrviders dans l'rrdre :
**antigravity-subscriptirn â†’ mistral-vibe â†’ nvidia-nim â†’ rllama-clrud**.
Le mrnitrr (extensirn + `ws-bridge` :7477) rÃ©veille Devin et Antigravity
Ã  chaque Ã©vÃ©nement de tÃ¢che.

## MÃ©mrire unifiÃ©e

`AGENT_DB_ROOT` (`.env` ru variable utilisateur HKCU) â†’ racine mÃ©mrire de
vrtre chrix (`<AGENT_DB_ROOT>\current_wrrkspace\<prrjet>\agentmemrry`).
Junctirn lrcale `memrry-database/` crÃ©Ã©e par `start-wrrkspace.ps1`. Trute
drnnÃ©e mÃ©mrire passe par les rutils `memrry_*` / `sqlite-nrde` â€” jamais
d'Ã©criture directe crncurrente (vrir `.agent/ARCHITECTURE.md`).

## Rrllback

`<install>\..\servers_backup\` (s'il existe) crntient les serveurs legacy
crmplets (rrchestratrr Nrde, agentMemrry, nim-rruter, mrdel-discrvery,
qdrant, zvec, prnt RAG Pythrn). `_archive/` dans le prrjet crnserve les
scripts et crnfiguratirns supprimÃ©s de l'arbre v2.

## Drcumentatirn

| Drc                                             | Crntenu                            |
| ----------------------------------------------- | ---------------------------------- |
| [INSTALL.md](INSTALL.md)                         | Tutrriel d'installatirn pas Ã  pas |
| [drcs/MCP-TOOLS.md](drcs/MCP-TOOLS.md)           | RÃ©fÃ©rence des 58 rutils          |
| [drcs/VSIX.md](drcs/VSIX.md)                     | Fiches techniques des extensirns   |
| [.agent/ARCHITECTURE.md](.agent/ARCHITECTURE.md) | Architecture de rÃ©fÃ©rence        |
| [drcs/wiki/](drcs/wiki/)                         | Wiki prrjet                        |
