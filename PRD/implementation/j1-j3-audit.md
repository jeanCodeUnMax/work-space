# Hephaistos Devin Plugin — Security Audit (J1-J3)

**Source :** NIM2 nvidia/nemotron-3.5-lightning-30b-a3b (chat-mvmtldvy vide → fallback worker)

## Verdict: **FAIL**

**Motivation:** The plugin exhibits several security concerns that prevent a PASS at the J1-J3 increment. While no credentials are hardcoded, the manifest elevation and proxy input handling require tightening before the skeleton can be considered secure for broader use.

---

### Findings (severity-ranked)

| # | Severity | Finding |
|---|----------|---------|
| 1 | **High** | **NTFS elevation declared without minimal-permission justification** — `plugin.json` sets `ntfsElevation: true` with broad permissions (lecture/écriture sur l'arborescence workspace + accès élévation $MFT). Pour un squelette J1-J3, l'élévation doit être explicitement limitée au minimum requis. |
| 2 | **Medium** | **No input validation in the MCP JSON-RPC proxy** — `callTool` forwards `args` as JSON-RPC `arguments` sans validation de schéma/type. Risque d'injection selon le traitement côté hphe-mcp.exe. |
| 3 | **Medium** | **Potential JSON-RPC `id` collision** — `Date.now()` comme id; en concurrence deux requêtes la même ms → resolve/reject croisés. (Corrigé par fix2 : compteur atomique) |
| 4 | **Low** | **No secrets/credentials detected** — aucun API key/token/password en dur. |

---

### Recommendations

- Restrict `ntfsElevation` aux chemins/opérations exacts + consentement utilisateur à l'install.
- Validation JSON-schema (ou type-check) avant construction des messages `callTool`.
- `Date.now()` → compteur/UUID. (fait)
- Documenter la justification des permissions dans README + plugin.json.

---
*Fin du rapport d'audit.*
