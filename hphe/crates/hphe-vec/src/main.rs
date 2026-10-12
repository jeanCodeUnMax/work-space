use hphe_vec::{VecIndex, VecIndexConfig};
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 4 && args[1] == "recall_real" {
        // recall_real --corpus <file> --queries <file> [--ef N]
        let corpus = std::env::args().nth(3).unwrap_or_default();
        let queries = std::env::args().nth(5).unwrap_or_default();
        let ef = std::env::args().position(|a| a == "--ef")
            .and_then(|i| std::env::args().nth(i + 1))
            .and_then(|s| s.parse::<usize>().ok());
        recall_real(&corpus, &queries, ef);
    } else if args.len() >= 4 && args[1] == "import" {
        // import --corpus <file> --dir <outdir> [--file index.usearch]
        // Construit un VecIndex depuis un export corpus_*.json et le persiste
        // sur disque (T-082 : migration Qdrant -> usearch).
        let corpus = std::env::args().nth(3).unwrap_or_default();
        let dir = std::env::args().nth(5).unwrap_or_else(|| ".".into());
        let file = std::env::args().position(|a| a == "--file")
            .and_then(|i| std::env::args().nth(i + 1))
            .unwrap_or_else(|| "index.usearch".into());
        import(&corpus, &dir, &file);
    } else {
        println!("hphe-vec: recall_real --corpus <f> --queries <f> [--ef N] | import --corpus <f> --dir <d> [--file f]");
    }
}

fn import(corpus_path: &str, dir: &str, file: &str) {
    let corpus: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(corpus_path).expect("corpus file"),
    )
    .expect("corpus json");
    let dim = corpus["dim"].as_u64().unwrap() as usize;
    let vecs = corpus["vectors"].as_array().unwrap();
    let n = vecs.len();

    std::fs::create_dir_all(dir).expect("create out dir");
    let cfg = VecIndexConfig::recall_tuned(dim, n + 1024);
    let idx = VecIndex::create(&cfg, Some(dir)).expect("create index");

    let t0 = Instant::now();
    for v in vecs {
        let key = v["key"].as_u64().unwrap();
        let vec: Vec<f32> = v["vec"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_f64().unwrap() as f32)
            .collect();
        idx.upsert_vector(key, &vec).expect("upsert");
    }
    let build_s = t0.elapsed().as_secs_f64();

    idx.save(file).expect("save index");
    let out = serde_json::json!({"imported": n, "dim": dim, "build_s": build_s,
        "dir": dir, "file": file});
    println!("{}", serde_json::to_string(&out).unwrap());
}

fn recall_real(corpus_path: &str, queries_path: &str, ef: Option<usize>) {
    // corpus JSON: {"dim":N,"vectors":[{"key":K,"vec":[...]}]}
    let corpus: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(corpus_path).expect("corpus file"),
    )
    .expect("corpus json");
    let dim = corpus["dim"].as_u64().unwrap() as usize;
    let vecs = corpus["vectors"].as_array().unwrap();
    let n = vecs.len();

    let cfg = VecIndexConfig::recall_tuned(dim, n + 1024);
    let idx = VecIndex::create(&cfg, None::<&str>).expect("create index");

    let t0 = Instant::now();
    for v in vecs {
        let key = v["key"].as_u64().unwrap();
        let vec: Vec<f32> = v["vec"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_f64().unwrap() as f32)
            .collect();
        idx.upsert_vector(key, &vec).expect("upsert");
    }
    let build_s = t0.elapsed().as_secs_f64();

    // Optionally boost ef_search for higher recall at search time.
    if let Some(ef) = ef {
        idx.set_expansion_search(ef);
    }

    let q: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(queries_path).expect("queries file"),
    )
    .expect("queries json");
    let k = q["k"].as_u64().unwrap() as usize;
    let queries = q["queries"].as_array().unwrap();

    let mut topk = Vec::new();
    let t1 = Instant::now();
    for qv in queries {
        let vec: Vec<f32> = qv
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_f64().unwrap() as f32)
            .collect();
        let hits = idx.knn(&vec, k).expect("knn");
        topk.push(hits.iter().map(|h| h.key).collect::<Vec<u64>>());
    }
    let knn_s = t1.elapsed().as_secs_f64();

    let out = serde_json::json!({"topk": topk, "build_s": build_s, "knn_s": knn_s});
    println!("{}", serde_json::to_string(&out).unwrap());
}
