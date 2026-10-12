"""Mesure simulée de la latence événement USN -> ingest (T-071).

Reproduit le chemin réel du mode --watch de beacon_ingest.py : un
`_DebounceTrigger` reçoit des événements (via le faux client pipe) et
déclenche `ingest_once` après le debounce. On mesure le délai entre
l'arrivée de l'événement et l'appel effectif d'ingest.

Le RAGPipeline réel n'est pas sollicité : `ingest_once` est remplacé par un
stub instantané, ce qui isole la **latence du mécanisme watch+debounce** (le
composant livré par T-071), pas celle du pipeline d'indexation.

Sortie : JSON imprimé sur stdout + écriture dans latency-results.json.
"""

import argparse
import asyncio
import json
import statistics
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / ".agent" / "rag"))
sys.path.insert(0, str(REPO_ROOT))

import beacon_ingest as bi  # noqa: E402

LOG = Path(r"C:\Users\x\.beacon\endpoint\logs\runtime.jsonl")


class TimingIngest:
    """Stub d'ingest_once qui horodate chaque appel."""

    def __init__(self):
        self.times = []

    async def __call__(self, log_path, limit=20, dry_run=False, reset=False):
        self.times.append(time.perf_counter())


async def measure_single(debounce: float) -> float:
    """Un seul événement -> latence événement→ingest."""
    ingest = TimingIngest()
    orig = bi.ingest_once
    bi.ingest_once = ingest
    try:
        args = argparse.Namespace(
            watch=True, watch_interval=30.0, debounce=debounce,
            dry_run=False, limit=20, reset=False,
            log_path=str(LOG), once=False,
        )
        trigger = bi._DebounceTrigger(debounce, LOG, args)
        t0 = time.perf_counter()
        trigger.on_event({"path": str(LOG), "name": "runtime.jsonl"})
        # Attend que l'ingest ait été appelé.
        while not ingest.times:
            await asyncio.sleep(0.001)
        return (ingest.times[0] - t0) * 1000.0  # ms
    finally:
        bi.ingest_once = orig


async def measure_burst(debounce: float, n_events: int, spacing: float) -> dict:
    """Rafale de n_events espacés de `spacing`s -> latence + nb d'ingests."""
    ingest = TimingIngest()
    orig = bi.ingest_once
    bi.ingest_once = ingest
    try:
        args = argparse.Namespace(
            watch=True, watch_interval=30.0, debounce=debounce,
            dry_run=False, limit=20, reset=False,
            log_path=str(LOG), once=False,
        )
        trigger = bi._DebounceTrigger(debounce, LOG, args)
        t0 = time.perf_counter()
        for _ in range(n_events):
            trigger.on_event({"path": str(LOG), "name": "runtime.jsonl"})
            await asyncio.sleep(spacing)
        # Le debounce regroupe la rafale en UN seul ingest : on attend 1 appel.
        target = 1
        while len(ingest.times) < target:
            await asyncio.sleep(0.001)
        total = (ingest.times[-1] - t0) * 1000.0
        return {
            "events": n_events,
            "spacing_s": spacing,
            "ingests": len(ingest.times),
            "coalesced": len(ingest.times) == 1,
            "latence_dernier_evenement_ms": (
                (ingest.times[-1] - (t0 + (n_events - 1) * spacing)) * 1000.0
            ),
            "latence_premier_evenement_ms": total,
        }
    finally:
        bi.ingest_once = orig


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--samples", type=int, default=20)
    ap.add_argument("--debounce", type=float, default=2.0,
                    help="debounce de production (défaut 2.0s)")
    args = ap.parse_args()

    # 1) Latence d'un événement isolé avec le debounce de production.
    single_latencies = []
    for _ in range(args.samples):
        single_latencies.append(await measure_single(args.debounce))

    # 2) Latence avec un debounce court (pour isoler l'overhead du mécanisme,
    #    sans le délai de debounce lui-même).
    overhead_latencies = []
    for _ in range(args.samples):
        overhead_latencies.append(await measure_single(0.0))

    # 3) Rafole d'événements : vérifie le regroupement.
    burst = await measure_burst(debounce=0.05, n_events=10, spacing=0.005)

    def stats(xs):
        return {
            "min_ms": round(min(xs), 3),
            "median_ms": round(statistics.median(xs), 3),
            "mean_ms": round(statistics.fmean(xs), 3),
            "max_ms": round(max(xs), 3),
        }

    results = {
        "debounce_production_s": args.debounce,
        "samples": args.samples,
        "evenement_isole_avec_debounce": stats(single_latencies),
        "overhead_mecanisme_debounce_0s": stats(overhead_latencies),
        "rafale_10_evenements_5ms": burst,
        "note": (
            "ingest_once est un stub instantané : on mesure la latence du "
            "mécanisme watch+debounce, pas celle du pipeline d'indexation."
        ),
    }

    out = Path(__file__).resolve().parent / "latency-results.json"
    out.write_text(json.dumps(results, indent=2, ensure_ascii=False),
                   encoding="utf-8")
    print(json.dumps(results, indent=2, ensure_ascii=False))
    print(f"\nÉcrit : {out}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
