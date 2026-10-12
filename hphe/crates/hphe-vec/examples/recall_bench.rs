//! Recall/latency gate benchmark for `hphe-vec` (P4).
//!
//! Builds a synthetic corpus of clustered 384-D vectors + noise, then
//! measures `knn` (HNSW approx) against `exact_knn` (brute-force ground
//! truth) — the `recall@10` gate target is >= 0.95.
//!
//! Usage:
//!   cargo run --release --example recall_bench -- [n] [queries] [dim]

use hphe_vec::{VecIndex, VecIndexConfig};
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use std::time::Instant;

fn synth_vector(rng: &mut StdRng, dim: usize, center: &[f32], noise: f32) -> Vec<f32> {
    (0..dim)
        .map(|i| center[i] + (rng.gen::<f32>() - 0.5) * noise)
        .collect()
}

fn main() {
    let n: usize = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(50_000);
    let n_queries: usize = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(200);
    let dim: usize = std::env::args().nth(3).and_then(|s| s.parse().ok()).unwrap_or(384);
    let k = 10usize;
    let n_clusters = 64usize;
    let noise = 0.2f32;

    let mut rng = StdRng::seed_from_u64(0x4850_4845); // "HPHE"

    // Cluster centers on the unit-ish sphere.
    let centers: Vec<Vec<f32>> = (0..n_clusters)
        .map(|_| {
            let mut v: Vec<f32> = (0..dim).map(|_| rng.gen::<f32>() - 0.5).collect();
            let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
            v.iter_mut().for_each(|x| *x /= norm);
            v
        })
        .collect();

    let cfg = VecIndexConfig::recall_tuned(dim, n + n_clusters);
    let idx = VecIndex::create(&cfg, None::<&str>).expect("create index");

    let t0 = Instant::now();
    for i in 0..n {
        let c = &centers[i % n_clusters];
        idx.upsert_vector(i as u64, &synth_vector(&mut rng, dim, c, noise))
            .expect("upsert");
    }
    let build = t0.elapsed();

    let mut hits_sum = 0usize;
    let mut total = 0usize;
    let mut lat_sum = std::time::Duration::ZERO;
    for _ in 0..n_queries {
        let c = &centers[rng.gen_range(0..n_clusters)];
        let q = synth_vector(&mut rng, dim, c, noise * 0.5);
        let t = Instant::now();
        let approx = idx.knn(&q, k).expect("knn");
        lat_sum += t.elapsed();
        let exact = idx.exact_knn(&q, k).expect("exact");
        let exact_keys: std::collections::HashSet<u64> =
            exact.iter().map(|h| h.key).collect();
        hits_sum += approx.iter().filter(|h| exact_keys.contains(&h.key)).count();
        total += exact.len();
    }

    let recall = hits_sum as f64 / total.max(1) as f64;
    let avg_lat = lat_sum / n_queries.max(1) as u32;

    println!("=== hphe-vec recall gate (P4) ===");
    println!("vectors:     {n} x {dim}D ({n_clusters} clusters, noise {noise})");
    println!("build:       {:.3}s ({:.0} vec/s)", build.as_secs_f64(), n as f64 / build.as_secs_f64());
    println!("queries:     {n_queries} @k={k}");
    println!("recall@{k}:    {:.4}  (target >= 0.95) {}", recall, if recall >= 0.95 { "PASS" } else { "FAIL" });
    println!("avg knn lat: {:.1} us", avg_lat.as_secs_f64() * 1e6);
}
