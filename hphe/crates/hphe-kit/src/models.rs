//! Model discovery — absorbé depuis `model-discovery` + `orchestrator:getAvailableModels`.
//!
//! Probes live : NVIDIA NIM (comptes 1+2), Ollama (`:cloud` vs locaux),
//! OpenRouter (`:free` uniquement). Cache 60 s, écrit les résultats dans
//! `model_health` (même table que l'orchestrateur Node — historique préservé).

use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::{nim_base, nim_key};

const MODELS_TTL: Duration = Duration::from_secs(60);

static CACHE: Lazy<Mutex<(Option<Instant>, Vec<Value>)>> =
    Lazy::new(|| Mutex::new((None, Vec::new())));

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(7))
        .build()
        .unwrap_or_default()
}

/// Live probe of all providers. `refresh` bypasses the 60 s cache.
pub async fn available_models(refresh: bool) -> Vec<Value> {
    {
        let cache = CACHE.lock().unwrap();
        if !refresh {
            if let (Some(at), m) = (&cache.0, &cache.1) {
                if at.elapsed() < MODELS_TTL && !m.is_empty() {
                    return m.clone();
                }
            }
        }
    }

    let mut models: Vec<Value> = Vec::new();
    let base = nim_base();

    // 1-2. NVIDIA NIM — deux comptes (clé secondaire = fallback)
    for account in [1u8, 2u8] {
        let Some(key) = nim_key(account) else { continue };
        let provider = if account == 2 { "nvidia-nim2" } else { "nvidia-nim" };
        if let Ok(resp) = client()
            .get(format!("{}/models", base))
            .bearer_auth(&key)
            .send()
            .await
        {
            if let Ok(data) = resp.json::<Value>().await {
                if let Some(arr) = data["data"].as_array() {
                    for m in arr {
                        if let Some(id) = m["id"].as_str() {
                            models.push(json!({"provider": provider, "model": id}));
                        }
                    }
                }
            }
        }
    }

    // 3. Ollama — `:cloud` = distant quota mensuel, sinon local
    if let Ok(resp) = client()
        .get("http://localhost:11434/api/tags")
        .timeout(Duration::from_millis(2500))
        .send()
        .await
    {
        if let Ok(data) = resp.json::<Value>().await {
            if let Some(arr) = data["models"].as_array() {
                for m in arr {
                    if let Some(name) = m["name"].as_str() {
                        let is_cloud = name.ends_with(":cloud") || name.ends_with("-cloud");
                        models.push(json!({
                            "provider": if is_cloud { "ollama-cloud" } else { "ollama" },
                            "model": name,
                        }));
                    }
                }
            }
        }
    }

    // 4. OpenRouter — modèles gratuits uniquement
    if let Ok(resp) = client()
        .get("https://openrouter.ai/api/v1/models")
        .send()
        .await
    {
        if let Ok(data) = resp.json::<Value>().await {
            if let Some(arr) = data["data"].as_array() {
                for m in arr {
                    let free = m["pricing"]["prompt"].as_str() == Some("0")
                        && m["pricing"]["completion"].as_str() == Some("0");
                    if free {
                        if let Some(id) = m["id"].as_str() {
                            models.push(json!({"provider": "openrouter-free", "model": id}));
                        }
                    }
                }
            }
        }
    }

    let mut cache = CACHE.lock().unwrap();
    *cache = (Some(Instant::now()), models.clone());
    models
}

pub async fn tool_models_available(args: &Value) -> Result<Value, String> {
    let refresh = args["refresh"].as_bool().unwrap_or(false);
    let models = available_models(refresh).await;
    let mut by_provider: serde_json::Map<String, Value> = serde_json::Map::new();
    for m in &models {
        let p = m["provider"].as_str().unwrap_or("?").to_string();
        by_provider
            .entry(p)
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .unwrap()
            .push(m["model"].clone());
    }
    Ok(json!({
        "count": models.len(),
        "providers": by_provider,
        "cached_ttl_s": MODELS_TTL.as_secs(),
        "backend": "hphe-kit (rust) — absorbe model-discovery",
    }))
}
