# Bench Report — P1 `hphe-index` (T-010 / task #314)

## Scope

`hphe-index` implements the SoA index for the Hephaistos engine:

- **SoA layout** — name blob (`\0`-separated UTF-8, u32 offsets), lowercase blob,
  `frn`/`parent_frn`/`size`/`created`/`modified`/`accessed` (u64), `flags` (u32
  packed `EntryFlags`), rows sorted by `name_lower`.
- **SIMD substring search** — `memchr::memmem` over the `name_lower` blob; hits
  are mapped back to rows via the monotonic `name_lower_offsets` frontier.
- **Path resolution** — `resolve_path(row)` climbs `parent_frn` chains through
  `frn_to_row`, with a `dir_cache` (`RwLock<HashMap<frn, path>>`) memoizing
  directory prefixes per segment.
- **Scanner** — `IndexScanner::scan(drive)` streams `MftReader` records into the
  builder; `IndexBuilder::from_synthetic(n)` produces a deterministic NTFS-like
  tree (root FRN 5, `C:` label) for non-elevated benchmarking.
- **CLI** — `hphe-index scan C: --stats --bench` (elevated) with automatic
  fallback to a 1M-entry synthetic index when elevation is missing;
  `hphe-index bench --count N --queries M`.

## Environment

| Item        | Value                                  |
|-------------|----------------------------------------|
| OS          | Windows 11, x86_64                     |
| Toolchain   | Rust stable, `--release` (opt-level 3) |
| Deps        | memchr 2.8, hashbrown 0.14, rayon 1.12 |
| Dataset     | Synthetic MFT (deterministic)          |

> Real-volume `scan C:` requires Administrator elevation; numbers below use the
> `bench` subcommand, which is the sanctioned no-elevation path.

## Results — 1,000,000 entries

| Metric                  | Value            | Spec target        | Status |
|-------------------------|------------------|--------------------|--------|
| Build wall time         | 1.307 s          | —                  | —      |
| Build time (internal)   | 400 ms           | —                  | —      |
| Memory per entry        | 123.9 B/entry    | —                  | —      |
| Index memory            | 118.12 MiB       | —                  | —      |
| **Projected @16M**      | **1.85 GiB**     | **< 2 GiB**        | **✓**  |
| Avg substring query     | 842.5 µs         | —                  | —      |
| Worst query             | 2 440 µs         | —                  | —      |
| Search throughput       | 1 187 M rows/s   | —                  | —      |
| Path resolution         | resolves + caches `C:\...` correctly | ✓ | — |

Memory footprint breakdown (measured, 1M rows):

- `name` blob + offsets: ~25 MB
- `name_lower` blob + offsets: ~21 MB
- numeric columns (7 × u64 + u32): ~60 MB
- `frn_to_row` HashMap: ~12 MB

The dual-name blob (original + lowercase) is the main RAM driver alongside the
numeric columns. At 123.9 B/entry the 16M-entry budget projects to 1.85 GiB,
inside the 2 GiB envelope.

## Correctness

`cargo test -p hphe-index --release`: **9/9 pass** — build+sort order, SIMD
substring search (case-insensitive), prefix + exact match, path resolution with
segment cache, stats consistency, synthetic generator shape.

## Commands

```powershell
# Real volume (Admin PowerShell required)
hphe-index.exe scan C: --stats --bench

# Non-elevated synthetic benchmark
hphe-index.exe bench --count 1000000 --queries 200
hphe-index.exe scan C: --synthetic 1000000 --stats
```
