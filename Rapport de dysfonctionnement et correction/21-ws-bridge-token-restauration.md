# 21 — Restauration du token du bridge WebSocket

**Date :** 2026-11-04
**Taches :** —
**Composant :** `orchestrator-monitor`, bridge local `127.0.0.1:7477`

## Symptome et impact

Le panneau Hephaistos Chats ne se connectait pas au bridge et le chat ne
demarrait pas. L'injection ACP fonctionnait toujours, car elle emprunte un
transport distinct du WebSocket du panneau.

## Diagnostic et cause racine

Le port `7477` etait deja occupe par l'instance officielle de
`ws-bridge/bridge.js` lancee par Devin. Le workspace actif ne disposait pas de
`.agent/ws-bridge.token`. Le client de l'extension, qui cherche d'abord
`ORCH_MONITOR_TOKEN` puis le fichier du workspace, envoyait donc l'upgrade sans
secret. Le bridge le rejetait avec `HTTP 401`.

Un ancien demarrage en double avait aussi produit `EADDRINUSE`. Ce journal
historique ne justifiait pas de tuer le listener valide.

Le token n'est pas un credential de fournisseur IA et ne change pas a chaque
connexion. C'est un secret d'authentification du bridge. Il est stable tant
qu'il n'est pas remplace. Le secret configure actuellement est partage entre
plusieurs workspaces; une variable utilisateur `ORCH_MONITOR_TOKEN` le rend
disponible aux processus lances sous ce compte. Sans cette variable, le client
utilise le fichier `.agent/ws-bridge.token`.

## Retablissement

### Restaurer un token existant

Depuis la racine du workspace, utiliser le token utilisateur deja provisionne
ou restaurer le fichier depuis une source locale autorisee. Ne jamais afficher
le contenu du fichier, le coller dans un rapport ou le committer.

```powershell
$root = (Get-Location).Path
$agent = Join-Path $root '.agent'
$tokenPath = Join-Path $agent 'ws-bridge.token'
$token = [Environment]::GetEnvironmentVariable('ORCH_MONITOR_TOKEN', 'User')

if ([string]::IsNullOrWhiteSpace($token) -and (Test-Path $tokenPath)) {
    $token = [IO.File]::ReadAllText($tokenPath).Trim()
}

if ([string]::IsNullOrWhiteSpace($token)) {
    throw 'Aucun token autorise trouve; utiliser la procedure de regeneration.'
}

[IO.Directory]::CreateDirectory($agent) | Out-Null
[IO.File]::WriteAllText($tokenPath, $token, [Text.UTF8Encoding]::new($false))
if (-not (Test-Path (Join-Path $agent 'comms.jsonl'))) {
    [IO.File]::WriteAllText((Join-Path $agent 'comms.jsonl'), '')
}
$token = $null
Write-Output 'Token provisionne; valeur non affichee.'
```

### Regenerer si aucune copie autorisee n'existe

Generer un secret cryptographiquement aleatoire, puis ecrire la meme valeur dans
la variable utilisateur et dans le fichier du workspace. Une regeneration
invalide les anciennes copies : les clients et bridges doivent ensuite utiliser
la nouvelle valeur. Ne jamais placer cette valeur dans `.env.example`.

```powershell
$root = (Get-Location).Path
$agent = Join-Path $root '.agent'
[IO.Directory]::CreateDirectory($agent) | Out-Null
$bytes = [byte[]]::new(32)
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()
$token = [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
[Environment]::SetEnvironmentVariable('ORCH_MONITOR_TOKEN', $token, 'User')
[IO.File]::WriteAllText(
    (Join-Path $agent 'ws-bridge.token'),
    $token,
    [Text.UTF8Encoding]::new($false)
)
if (-not (Test-Path (Join-Path $agent 'comms.jsonl'))) {
    [IO.File]::WriteAllText((Join-Path $agent 'comms.jsonl'), '')
}
$token = $null
[Array]::Clear($bytes, 0, $bytes.Length)
Write-Output 'Nouveau token provisionne; valeur non affichee.'
```

La variable utilisateur n'est heritee par Devin qu'apres son redemarrage
complet. Pour un nouveau workspace, s'assurer que celui-ci est visible du
bridge via `HEPHAISTOS_WORKSPACE`, `HEPHAISTOS_WORKSPACES` ou
`data/ingest-roots.txt`; le bridge ne peut pas autoriser un token d'une racine
qu'il ne connait pas.

## Verification

1. Confirmer que le seul listener `127.0.0.1:7477` est
   `ws-bridge/bridge.js`, enfant de Devin. Ne pas tuer ce listener sain pour
   resoudre un `EADDRINUSE` historique.
2. Tester l'upgrade WebSocket sans afficher le token : le client doit recevoir
   `open` puis le snapshot initial; un client sans token est rejete en `401`.
3. Verifier l'etat connecte du panneau Hephaistos Chats. Si Devin vient de
   recevoir une nouvelle variable utilisateur, le redemarrer pour l'appliquer.
4. Verifier que `.agent/.gitignore` ignore `ws-bridge.token` et `comms.jsonl`.

Le `ORCH_MONITOR_TOKEN` dans `.env.example` reste vide : ce fichier est un
template versionnable, jamais un emplacement pour un secret reel.
