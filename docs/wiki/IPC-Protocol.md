# IPC-Protocol — named pipe `hphe-index`

Canal de communication entre les clients (`hphe-mcp`, `hphe-rest`,
`pipe_client.py`) et le démon `hphe-indexd`. Remplace le protocole v1
`WM_COPYDATA`/`QUERY2` d'Everything.exe.

## Transport

- **Named pipe Windows** : `\\.\pipe\hphe-index`
- **Framing** : NDJSON — un objet JSON par ligne UTF-8, `\n` terminé
- **Pattern** : request/response corrélé par `id` unique (UUID ou compteur) ;
  la méthode `watch` ouvre un flux d'événements jusqu'à unsubscribe

## Méthodes

| Méthode | Params | Réponse |
|---|---|---|
| `ping` | `{}` | `PingResponse` (statut démon) |
| `stats` | `{}` | `IndexStats` (entrées, volumes, âge snapshot) |
| `search` | `{query, limit=100, offset=0, include_deleted=false}` | `SearchResponse` (lignes + `FileEntry[]`) |
| `resolve` | `{row}` | `ResolveResponse` (chemin complet d'une ligne index) |
| `watch` | `{subscribe, volume?}` | flux `UsnEvent` jusqu'à `{subscribe:false}` |

## Exemple de session

```jsonc
→ {"id":"r1","method":"search","params":{"query":"hephaistos ext:rs","limit":20}}
← {"id":"r1","ok":true,"result":{"total":3,"entries":[{...}],"took_ms":12}}

→ {"id":"r2","method":"watch","params":{"subscribe":true,"volume":"F"}}
← {"id":"r2","ok":true,"result":{"subscribed":true}}
← {"event":"usn","volume":"F","path":"F:/...","kind":"create","ts":"..."}   // stream
```

## Erreurs

Réponse `{"id":...,"ok":false,"error":{"code":...,"message":...}}` —
codes dans `ErrorCode` (crate `hphe-ipc`, `protocol.rs`).

## Clients de référence

- Rust : crate `hphe-ipc` (`client.rs`, reconnect + retry unique sur pipe cassé)
- Python : `extension/server/pipe_client.py` (`HphePipeClient`, tests
  `tests/test_pipe_client.py`)

> Historique : v1 parlait `WM_COPYDATA`/`QUERY2` à Everything.exe — doc
> archivée, ne plus utiliser.
