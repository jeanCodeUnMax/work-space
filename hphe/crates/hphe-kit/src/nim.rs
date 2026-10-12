//! NIM router — absorbé depuis `nim-router-mcp` (Python).
//!
//! Le mapping domaine → modèle(s) vit dans `registre-modeles.json`,
//! embarqué au build (même fichier que le routeur Python historique).
//! Outils : domaines, modèles live, chat routé par domaine (+fallbacks),
//! embeddings (domaine `rag_embedding`, 2048D pour hphe-vec).

use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::time::Duration;

use crate::{nim_base, nim_key};

static REGISTRY: Lazy<Value> = Lazy::new(|| {
    serde_json::from_str(include_str!("registre-modeles.json"))
        .unwrap_or_else(|_| json!({"domains": {}}))
});

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .unwrap_or_default()
}

fn require_key(account: u8) -> Result<String, String> {
    nim_key(account).ok_or_else(|| {
        "NVIDIA_API_KEY absente de l'environnement (compte NIM requis)".to_string()
    })
}

fn domain_entry(domain: &str) -> Result<Value, String> {
    let entry = &REGISTRY["domains"][domain];
    if entry.is_null() {
        let avail: Vec<&str> = REGISTRY["domains"]
            .as_object()
            .map(|o| o.keys().map(String::as_str).collect())
            .unwrap_or_default();
        return Err(format!(
            "domaine '{}' inconnu — disponibles: {}",
            domain,
            avail.join(", ")
        ));
    }
    Ok(entry.clone())
}

/// Chain: primary then fallbacks (deduped).
fn model_chain(domain: &str) -> Result<Vec<String>, String> {
    let e = domain_entry(domain)?;
    let mut chain = Vec::new();
    if let Some(p) = e["primary"].as_str() {
        chain.push(p.to_string());
    }
    if let Some(fb) = e["fallback"].as_array() {
        for f in fb {
            if let Some(s) = f.as_str() {
                if !chain.iter().any(|c| c == s) {
                    chain.push(s.to_string());
                }
            }
        }
    }
    if chain.is_empty() {
        return Err(format!("domaine '{}' sans modèle", domain));
    }
    Ok(chain)
}

pub fn tool_nim_domains() -> Result<Value, String> {
    let mut out = serde_json::Map::new();
    if let Some(domains) = REGISTRY["domains"].as_object() {
        for (name, d) in domains {
            out.insert(
                name.clone(),
                json!({
                    "primary": d["primary"],
                    "fallbacks": d["fallback"],
                    "usage": d["usage"],
                }),
            );
        }
    }
    Ok(json!({"domains": out, "count": out.len(), "backend": "hphe-kit (rust)"}))
}

pub async fn tool_nim_models() -> Result<Value, String> {
    let key = require_key(1)?;
    let resp = client()
        .get(format!("{}/models", nim_base()))
        .bearer_auth(&key)
        .send()
        .await
        .map_err(|e| format!("NIM /models: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("NIM /models HTTP {}", resp.status()));
    }
    let data: Value = resp.json().await.map_err(|e| e.to_string())?;
    let ids: Vec<&str> = data["data"]
        .as_array()
        .map(|a| a.iter().filter_map(|m| m["id"].as_str()).collect())
        .unwrap_or_default();
    Ok(json!({"count": ids.len(), "models": ids}))
}

async fn chat_once(
    model: &str,
    messages: &Value,
    temperature: f64,
    max_tokens: u64,
    account: u8,
) -> Result<Value, String> {
    let key = require_key(account)?;
    let body = json!({
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    });
    let resp = client()
        .post(format!("{}/chat/completions", nim_base()))
        .bearer_auth(&key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("{}: {}", model, e))?;
    let status = resp.status();
    let data: Value = resp.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "{} HTTP {}: {}",
            model,
            status,
            data["message"].as_str().unwrap_or("erreur")
        ));
    }
    Ok(data)
}

pub async fn tool_nim_chat(args: &Value) -> Result<Value, String> {
    let domain = args["domain"].as_str().ok_or("domain requis")?;
    let prompt = args["prompt"].as_str().ok_or("prompt requis")?;
    let system = args["system"].as_str();
    let temperature = args["temperature"].as_f64().unwrap_or(0.6);
    let max_tokens = args["max_tokens"].as_u64().unwrap_or(2048);

    let mut messages = Vec::new();
    if let Some(s) = system {
        messages.push(json!({"role": "system", "content": s}));
    }
    messages.push(json!({"role": "user", "content": prompt}));
    let messages = json!(messages);

    let chain = model_chain(domain)?;
    let mut last_err = String::new();
    let mut tried = Vec::new();
    for model in &chain {
        match chat_once(model, &messages, temperature, max_tokens, 1).await {
            Ok(data) => {
                let content = data["choices"][0]["message"]["content"].clone();
                return Ok(json!({
                    "domain": domain,
                    "model_used": model,
                    "content": content,
                    "usage": data["usage"],
                    "tried": tried,
                }));
            }
            Err(e) => {
                tried.push(json!({"model": model, "error": e}));
                last_err = e;
            }
        }
    }
    Err(format!("tous les modèles ont échoué: {}", last_err))
}

pub async fn tool_nim_chat_model(args: &Value) -> Result<Value, String> {
    let model = args["model"].as_str().ok_or("model requis")?;
    let prompt = args["prompt"].as_str().ok_or("prompt requis")?;
    let system = args["system"].as_str();
    let temperature = args["temperature"].as_f64().unwrap_or(0.6);
    let max_tokens = args["max_tokens"].as_u64().unwrap_or(2048);
    let account = args["account"].as_u64().unwrap_or(1) as u8;

    let mut messages = Vec::new();
    if let Some(s) = system {
        messages.push(json!({"role": "system", "content": s}));
    }
    messages.push(json!({"role": "user", "content": prompt}));

    let data = chat_once(model, &json!(messages), temperature, max_tokens, account).await?;
    Ok(json!({
        "model_used": model,
        "content": data["choices"][0]["message"]["content"],
        "usage": data["usage"],
    }))
}

/// Embeddings — domaine `rag_embedding` (primary = nemotron-3-embed-1b, 2048D).
/// Utilisé par l'ingestion hphe-vec et les requêtes vec_search.
pub async fn embed_texts(texts: &[String], input_type: &str) -> Result<Vec<Vec<f32>>, String> {
    embed_texts_domain(texts, "rag_embedding", input_type, 1).await
}

pub async fn embed_texts_domain(
    texts: &[String],
    domain: &str,
    input_type: &str,
    account: u8,
) -> Result<Vec<Vec<f32>>, String> {
    let chain = model_chain(domain)?;
    let key = require_key(account)?;
    let mut last_err = String::new();
    for model in &chain {
        let body = json!({
            "model": model,
            "input": texts,
            "input_type": input_type,
            "encoding_format": "float",
        });
        match client()
            .post(format!("{}/embeddings", nim_base()))
            .bearer_auth(&key)
            .json(&body)
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status();
                match resp.json::<Value>().await {
                    Ok(data) if status.is_success() => {
                        let mut out = Vec::with_capacity(texts.len());
                        let mut items: Vec<&Value> = data["data"]
                            .as_array()
                            .map(|a| a.iter().collect())
                            .unwrap_or_default();
                        items.sort_by_key(|it| it["index"].as_u64().unwrap_or(0));
                        for it in items {
                            let v: Vec<f32> = it["embedding"]
                                .as_array()
                                .map(|a| {
                                    a.iter()
                                        .filter_map(|x| x.as_f64().map(|f| f as f32))
                                        .collect()
                                })
                                .unwrap_or_default();
                            out.push(v);
                        }
                        if out.len() != texts.len() {
                            return Err(format!(
                                "embeddings incomplets: {} attendus, {} reçus",
                                texts.len(),
                                out.len()
                            ));
                        }
                        return Ok(out);
                    }
                    Ok(data) => {
                        last_err = format!(
                            "{} HTTP {}: {}",
                            model,
                            status,
                            data["message"].as_str().unwrap_or("erreur")
                        );
                    }
                    Err(e) => last_err = format!("{}: {}", model, e),
                }
            }
            Err(e) => last_err = format!("{}: {}", model, e),
        }
    }
    Err(last_err)
}

pub async fn tool_nim_embed(args: &Value) -> Result<Value, String> {
    let texts: Vec<String> = match args["texts"].as_array() {
        Some(a) => a
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect(),
        None => args["text"]
            .as_str()
            .map(|s| vec![s.to_string()])
            .ok_or("texts[] ou text requis")?,
    };
    let domain = args["domain"].as_str().unwrap_or("rag_embedding");
    let input_type = args["input_type"].as_str().unwrap_or("query");
    let vectors = embed_texts_domain(&texts, domain, input_type, 1).await?;
    let dim = vectors.first().map(|v| v.len()).unwrap_or(0);
    Ok(json!({
        "domain": domain,
        "count": vectors.len(),
        "dim": dim,
        "embeddings": vectors,
    }))
}
