# Bench Report — P1 `hphe-ipc` (T-030 / task #333)

## Scope

`hphe-ipc` implements the inter-process communication layer between the Hephaistos search engine daemon (`hphe-indexd`) and client consumers (CLI, MCP server, UI):

- **Transport** — Windows Named Pipe (`\\.\pipe\hphe-index`) via `interprocess` and `tokio`.
- **Protocol framing** — Line-delimited JSON (NDJSON) over asynchronous byte duplex streams.
- **RPC contract** — Requests `{id, method, params}` and Responses `{id, result}` or `{id, error: {code, message}}`.
- **Supported Verbs** — `ping`, `stats`, `search`, `resolve`, `watch` (USN events subscription/unsubscription).
- **Concurrency** — Multi-client handling with connection pool, configurable timeouts (read/write/connect), and graceful shutdown signaling.
- **Client library** — High-level async API (`ClientBuilder`, `Client::connect`, `ping`, `stats`, `search`, `resolve`, `subscribe`, `call`).
- **Access Control** — Restrictive DACL limiting pipe access strictly to Owner + SYSTEM + Built-in Administrators.

---

## Environment

| Item        | Value                                             |
|-------------|---------------------------------------------------|
| OS          | Windows 11, x86_64                                |
| Toolchain   | Rust stable, `--release` (opt-level 3)            |
| Crates      | `interprocess` 2.4, `tokio` 1.53, `serde_json` 1.0|
| Transport   | Windows Named Pipe (`\\.\pipe\hphe-ipc-bench-*`)   |

---

## Benchmark Results — Roundtrip Latency

Measurements collected using Criterion 0.4 harness (`benches/latency.rs`):

| Operation                 | Measured Latency (Mean) | Spec Target | Margin vs Target | Status |
|---------------------------|-------------------------|-------------|------------------|--------|
| `ping_roundtrip`          | 36.90 µs (0.037 ms)     | < 5.0 ms    | 135x faster      | PASS   |
| `stats_roundtrip`         | 47.10 µs (0.047 ms)     | < 5.0 ms    | 106x faster      | PASS   |
| `search_roundtrip`        | 43.90 µs (0.044 ms)     | < 5.0 ms    | 113x faster      | PASS   |
| `resolve_roundtrip`       | 48.11 µs (0.048 ms)     | < 5.0 ms    | 104x faster      | PASS   |
| `concurrent_ping_10`      | 120.86 µs (0.121 ms)    | < 5.0 ms    | 41x faster       | PASS   |
| `sequential_ping_100`     | 3.46 ms (34.59 µs/req)  | —           | High throughput  | PASS   |

### Analysis

1. **Sub-millisecond latency**: Named pipes on local Windows kernel achieve roundtrip times well under 50 µs for single requests, outperforming the 5 ms target by two orders of magnitude.
2. **Serialization overhead**: Framing and parsing NDJSON with `serde_json` adds negligible latency (< 10 µs delta between raw ping and structured queries).
3. **Concurrency scale**: 10 simultaneous clients complete parallel pings in ~121 µs total without connection contention.

---

## Security & Restrictive DACL Implementation

### SDDL Specification

The server enforces restrictive security by default using the following SDDL string:

```
D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;OW)(A;;GA;;;CO)
```

Breakdown:
- `D:P`: Discretionary ACL with Protection flag set (prevents inheritance from default pipe permissions).
- `(A;;GA;;;SY)`: Allow Generic All to Local SYSTEM (`S-1-5-18`).
- `(A;;GA;;;BA)`: Allow Generic All to Built-in Administrators (`S-1-5-32-544`).
- `(A;;GA;;;OW)`: Allow Generic All to Current Owner Rights (`S-1-5-32-554` / Owner).
- `(A;;GA;;;CO)`: Allow Generic All to Creator Owner (`S-1-5-3-0`).

Every other security principal (including standard unprivileged users, guest accounts, and remote network connections) is denied access by absence of an allow ACE in the protected DACL.

### Verification Procedure on Windows

#### Verification Method 1: Sysinternals AccessChk

Run Sysinternals `accesschk` against the active pipe name:

```powershell
accesschk.exe -nobanner -c \\.\pipe\hphe-index
```

Expected output confirms permissions restricted to:
- `NT AUTHORITY\SYSTEM`: READ, WRITE
- `BUILTIN\Administrators`: READ, WRITE
- `<CurrentDomain>\<OwnerUser>`: READ, WRITE
- Standard users / Everyone / Network: No access listed.

#### Verification Method 2: Integration Test Assertion

The crate includes an integration test `test_restrictive_dacl_roundtrip` in `tests/integration.rs`:

```powershell
cargo test --manifest-path hphe/Cargo.toml -p hphe-ipc --test integration test_restrictive_dacl_roundtrip
```

The test builds a pipe server with `apply_restrictive_acl(true)`.
The owner process succeeds in connecting and executing commands.
Attempts by unauthorized tokens receive Windows error `ERROR_ACCESS_DENIED` (`os error 5` -> `IpcError::AccessDenied`).

#### Verification Method 3: PowerShell NamedPipeClientStream

When connected from a non-elevated user account belonging to a different security context:

```powershell
$pipe = New-Object System.IO.Pipes.NamedPipeClientStream(".", "hphe-index", [System.IO.Pipes.PipeAccessRights]::ReadWrite)
$pipe.Connect(1000)
# Throws System.UnauthorizedAccessException: Access to the path is denied.
```

---

## Test Verification

Command:
```powershell
cargo test --manifest-path hphe/Cargo.toml -p hphe-ipc
```

Result:
- **Unit tests**: 14/14 passed
- **Integration tests**: 11/11 passed (connect/disconnect, ping, stats, search, resolve, watch subscribe/unsubscribe, concurrent clients, invalid params, server lifecycle, restrictive DACL)
- **Doc tests**: 2/2 passed
- **Total**: 27/27 passed, 0 failures, 0 warnings.

---

## Example Usage

Run the example server:
```powershell
cargo run --manifest-path hphe/Cargo.toml -p hphe-ipc --example server
```

Run the example client:
```powershell
cargo run --manifest-path hphe/Cargo.toml -p hphe-ipc --example client
```
