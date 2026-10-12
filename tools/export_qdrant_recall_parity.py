#!/usr/bin/env python3
# [T-081] Export Qdrant -> hphe-vec + recall parity reel (gate P4 reel)
# Mission: exporter vecteurs reels Qdrant, importer dans VecIndex usearch,
# mesurer overlap@10 vs Qdrant search (cible >= 0.95).
# READ-ONLY sur Qdrant (aucune ecriture, aucune collection modifiee).
# Usage: python3 tools/export_qdrant_recall_parity.py [--collections name1,name2] [--sample 5000] [--queries 100] [--k 10]
import json, os, sys, time, urllib.request, urllib.parse, hashlib, argparse

QDRANT_URL = os.environ.get("QDRANT_URL", "http://localhost:6333")
API_KEY = os.environ.get("QDRANT_API_KEY", "")

def http(method, path, body=None):
    url = QDRANT_URL.rstrip("/") + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
        headers={"api-key": API_KEY, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.load(r)

def stable_key(point_id):
    # cle 64-bit stable a partir de l'id du point (string ou int)
    if isinstance(point_id, int):
        return point_id & 0xFFFFFFFFFFFFFFFF
    h = hashlib.sha256(str(point_id).encode()).digest()
    return int.from_bytes(h[:8], "big")

def list_collections():
    r = http("GET", "/collections")
    return [c["name"] for c in r["result"]["collections"]]

def collection_info(name):
    r = http("GET", f"/collections/{name}")
    res = r["result"]
    vec = res["config"]["params"]["vectors"]
    if isinstance(vec, dict) and "size" in vec:
        dim, dist, named = vec["size"], vec.get("distance"), None
    elif isinstance(vec, dict):
        # named vector: take 'dense'
        d = vec.get("dense") or list(vec.values())[0]
        dim, dist, named = d["size"], d.get("distance"), "dense"
    else:
        dim, dist, named = None, None, None
    return {"points": res.get("points_count", 0), "dim": dim, "dist": dist,
            "named": named, "status": res.get("status")}

def scroll_all(name, limit=5000, with_vector=True):
    """Scroll pagine — exporte tous les points (ou echantillon)."""
    out = []
    offset = None
    while True:
        body = {"limit": limit, "with_vector": with_vector, "with_payload": False}
        if offset is not None:
            body["offset"] = offset
        r = http("POST", f"/collections/{name}/points/scroll", body)
        pts = r["result"]["points"]
        out.extend(pts)
        offset = r["result"].get("next_page_offset")
        if not offset or not pts:
            break
    return out

def qdrant_search(name, qvec, k, named=None, only_ids=None):
    body = {"limit": k, "with_payload": False}
    body["vector"] = {"name": named, "vector": qvec} if named else qvec
    if only_ids:
        body["filter"] = {"must": [{"has_id": list(only_ids)}]}
    r = http("POST", f"/collections/{name}/points/search", body)
    return [(stable_key(h["id"]), h["score"]) for h in r["result"]]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--collections", default="", help="noms separes par virgule (defaut: auto)")
    ap.add_argument("--sample", type=int, default=5000, help="taille echantillon min export")
    ap.add_argument("--queries", type=int, default=100, help="nb requetes recall")
    ap.add_argument("--k", type=int, default=10, help="k pour overlap@k")
    ap.add_argument("--out", default="p4_real_results.json", help="fichier resultats JSON")
    ap.add_argument("--ef", type=int, default=256, help="ef_search usearch (defaut 256)")
    ap.add_argument("--reuse-corpus", action="store_true",
                    help="reutiliser corpus_<name>.json existant au lieu de re-scroller Qdrant")
    args = ap.parse_args()

    # Normaliser le chemin de sortie (chemins MSYS /c/ -> C:/)
    out_path = args.out
    if out_path.startswith("/c/"):
        out_path = "C:/" + out_path[3:]
    out_path = os.path.abspath(out_path)

    # --- 1. Choisir les collections ---
    if args.collections:
        names = [c.strip() for c in args.collections.split(",") if c.strip()]
    else:
        names = list_collections()
        info = {n: collection_info(n) for n in names}
        # garder les collections non vides avec dim connue
        names = [n for n in names if info[n]["points"] > 0 and info[n]["dim"]]

    print(f"[T-081] Collections candidates: {names}")
    all_results = []

    for name in names:
        info = collection_info(name)
        if info["points"] == 0 or not info["dim"]:
            print(f"  skip {name}: points={info['points']} dim={info['dim']}")
            continue
        dim = info["dim"]
        print(f"\n=== {name} === points={info['points']} dim={dim} dist={info['dist']} named={info['named']}")

        # --- 2. Export scroll (ou reuse corpus_<name>.json) ---
        corpus_file = f"corpus_{name}.json"
        t0 = time.time()
        if args.reuse_corpus and os.path.exists(corpus_file):
            with open(corpus_file) as f:
                cached = json.load(f)
            ids = [e["key"] for e in cached["vectors"]]
            vecs = [e["vec"] for e in cached["vectors"]]
            pts = cached["vectors"]
            oid_file = f"origids_{name}.json"
            if os.path.exists(oid_file):
                with open(oid_file) as f:
                    key2orig = {int(k): v for k, v in json.load(f).items()}
            else:
                # scroll leger (ids seuls, pas de vecteurs) pour reconstruire le mapping
                light = scroll_all(name, with_vector=False)
                key2orig = {stable_key(p["id"]): p["id"] for p in light}
                with open(oid_file, "w") as f:
                    json.dump({str(k): o for k, o in key2orig.items()}, f)
            export_s = time.time() - t0
            print(f"  reuse corpus {corpus_file}: {len(pts)} vecteurs")
        else:
            pts = scroll_all(name, with_vector=True)
            export_s = time.time() - t0
            if not pts:
                print("  vide, skip")
                continue
            # echantillon
            pts = pts[:max(args.sample, args.queries)]
            ids, vecs, orig_ids = [], [], []
            for p in pts:
                v = p["vector"]
                if isinstance(v, dict):
                    v = v.get(info["named"]) or v.get("dense") or list(v.values())[0]
                k = stable_key(p["id"])
                ids.append(k); vecs.append(v); orig_ids.append(p["id"])
            key2orig = dict(zip(ids, orig_ids))
            print(f"  exporte {len(pts)} vecteurs en {export_s:.2f}s")
            # On garde les ids Qdrant d'origine pour les lookups de scores filtres
            with open(f"origids_{name}.json", "w") as f:
                json.dump({str(k): o for k, o in key2orig.items()}, f)

        # --- 3. Import dans VecIndex usearch (via binaire hphe-vec recall_real) ---
        # On ecrit le corpus + queries dans un fichier JSON que le binaire Rust consomme.
        corpus_file = f"corpus_{name}.json"
        with open(corpus_file, "w") as f:
            json.dump({"dim": dim, "vectors": [{"key": i, "vec": v} for i, v in zip(ids, vecs)]}, f)

        # queries = vecteurs du corpus (les N premiers)
        nq = min(args.queries, len(vecs))
        qvecs = vecs[:nq]
        qkeys = ids[:nq]
        queries_file = f"queries_{name}.json"
        with open(queries_file, "w") as f:
            json.dump({"k": args.k, "queries": qvecs}, f)

        # Qdrant ground truth pour chaque query (parallele pour compenser latence ~2s/req)
        # Si l'export est un sous-ensemble de la collection (sample < total),
        # la verite terrain DOIT etre restreinte aux memes ids via has_id —
        # sinon Qdrant retourne des voisins absents de l'index usearch.
        sampled = len(pts) < info["points"]
        gt_only_ids = [key2orig[k] for k in ids if k in key2orig] if sampled else None
        if sampled:
            print(f"  sous-ensemble {len(pts)}/{info['points']} — ground truth filtree has_id")
        from concurrent.futures import ThreadPoolExecutor
        t0 = time.time()
        with ThreadPoolExecutor(max_workers=8) as ex:
            qdrant_topk = list(ex.map(
                lambda qv: qdrant_search(name, qv, args.k, named=info["named"],
                                         only_ids=gt_only_ids),
                qvecs))
        qdrant_s = time.time() - t0

        # --- 4. usearch knn via binaire Rust ---
        # hphe-vec recall_real --corpus <file> --queries <file> -> topk json
        t0 = time.time()
        use_out = subprocess_run(corpus_file, queries_file, dim, args.ef)
        usearch_s = time.time() - t0

        # --- 5. overlap@k ---
        #  - strict : intersection des ids top-k (Qdrant vs usearch)
        #  - tolere : score-aware — un hit usearch compte si son score Qdrant
        #    est >= score du k-ieme voisin Qdrant (ex aequo toleres, eps 1e-6).
        #    Scores des hits usearch recuperes via search filtre has_id
        #    (1 appel/query, O(k)) au lieu du fetch exhaustif O(N).
        overlap_sum, total = 0, 0
        tol_sum = 0
        for i, (qt, us) in enumerate(zip(qdrant_topk, use_out)):
            q_keys = [k for k, _s in qt]
            us_set = set(us[:args.k])
            overlap_sum += len(us_set & set(q_keys))
            total += len(qt)
            if not qt or not us:
                continue
            kth_score = qt[-1][1] - 1e-6
            us_orig = [key2orig.get(kk) for kk in us[:args.k]]
            us_orig = [o for o in us_orig if o is not None]
            if not us_orig:
                continue
            scored = qdrant_search(name, qvecs[i], len(us_orig),
                                   named=info["named"], only_ids=us_orig)
            tol_sum += sum(1 for _k, sc in scored if sc >= kth_score)
        recall = overlap_sum / max(total, 1)
        recall_tol = tol_sum / max(total, 1)

        result = {
            "collection": name, "points_total": info["points"],
            "exported": len(pts), "dim": dim, "queries": nq, "k": args.k,
            "overlap": recall, "overlap_tolere": recall_tol, "target": 0.95,
            "pass": recall_tol >= 0.95,
            "export_s": round(export_s, 3), "qdrant_search_s": round(qdrant_s, 3),
            "usearch_knn_s": round(usearch_s, 3),
        }
        all_results.append(result)
        print(f"  overlap@{args.k}: {recall:.4f} (tolere: {recall_tol:.4f})  {'PASS' if recall_tol >= 0.95 else 'FAIL'}")
        print(f"  latence: export={export_s:.2f}s qdrant_search={qdrant_s:.2f}s usearch={usearch_s:.2f}s")

    # --- 6. rapport ---
    with open(out_path, "w") as f:
        json.dump({"task": "T-081", "results": all_results}, f, indent=2)
    print(f"\n[T-081] Resultats ecrits dans {out_path}")
    print(f"Gate P4 reel: {'PASS' if all(r['pass'] for r in all_results) and all_results else 'FAIL/N-A'}")

def subprocess_run(corpus_file, queries_file, dim, ef=256):
    """Lance le binaire hphe-vec recall_real et retourne le topk par requete."""
    import subprocess, json as _j
    # chemin binaire release
    exe = os.path.join(os.path.dirname(__file__), "..", "hphe", "target", "release",
                       "hphe-vec.exe")
    if not os.path.exists(exe):
        exe = exe.replace(".exe", "")
    if not os.path.exists(exe):
        raise FileNotFoundError(f"binaire hphe-vec introuvable: {exe} — lancer cargo build --release -p hphe-vec")
    r = subprocess.run([exe, "recall_real", "--corpus", corpus_file,
                        "--queries", queries_file, "--ef", str(ef)], capture_output=True, text=True)
    if r.returncode != 0:
        print("  stderr:", r.stderr)
        raise RuntimeError("hphe-vec recall_real a echoue")
    return _j.loads(r.stdout)["topk"]

if __name__ == "__main__":
    main()
