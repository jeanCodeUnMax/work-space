//! hphe-rest — passerelle REST de la structure unifiée.
//!
//! Expose TOUS les outils hphe-mcp en HTTP/JSON — c'est l'interface "REST"
//! demandée pour les briques absorbées (orchestrator, nim, memory, ingest).
//!
//! Endpoints :
//!   GET  /health                    -> statut serveur + pipe daemon
//!   GET  /tools                     -> inventaire des outils exposés
//!   POST /tools/{name}              -> exécute un outil, body = arguments JSON
//!   POST /call                      -> {"name": "...", "arguments": {...}}

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Json;
use axum::routing::{get, post};
use axum::Router;
use clap::Parser;
use serde_json::{json, Value};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

use hphe_ipc::client::ClientBuilder;
use hphe_mcp::{tools, AccessPolicy};

/// Ingestion automatisée : racines surveillées, re-ingest incrémental
/// périodique. `HPHE_INGEST_ROOTS` = liste séparée par ';' ; la racine du
/// workspace (parent de `.agent`) est utilisée par défaut via `--ingest-root`.
const DEFAULT_INGEST_INTERVAL_S: u64 = 900; // 15 min

#[derive(Parser, Debug)]
#[command(name = "hphe-rest", about = "REST gateway over the unified hphe-mcp toolset")]
struct Args {
    /// Named pipe of the hphe-indexd daemon
    #[arg(long, default_value = r"\\.\pipe\hphe-index", env = "HPHE_PIPE_NAME")]
    pipe_name: String,

    /// Listen address
    #[arg(long, default_value = "127.0.0.1:8792", env = "HPHE_REST_ADDR")]
    addr: String,

    /// Agent profile for .mcp-access policy
    #[arg(long, env = "EVERYTHING_MCP_AGENT")]
    profile: Option<String>,

    /// Racine(s) à ingérer périodiquement (';' séparé). Défaut :
    /// `HPHE_INGEST_ROOTS`, sinon aucune boucle.
    #[arg(long, env = "HPHE_INGEST_ROOTS")]
    ingest_roots: Option<String>,

    /// Dossiers parents scannés pour marqueur `.agent/` (';' séparé) —
    /// tout workspace inité est découvert et ingéré automatiquement.
    #[arg(long, env = "HPHE_INGEST_SCAN")]
    ingest_scan: Option<String>,

    /// Intervalle d'ingestion en secondes (défaut 900 = 15 min)
    #[arg(long, default_value_t = DEFAULT_INGEST_INTERVAL_S, env = "HPHE_INGEST_INTERVAL_S")]
    ingest_interval_s: u64,

    #[arg(long, default_value = "info", env = "RUST_LOG")]
    log_level: String,
}

struct AppState {
    client: hphe_ipc::client::Client,
    policy: AccessPolicy,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(&args.log_level));
    tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr))
        .init();

    let client = ClientBuilder::new().pipe_name(&args.pipe_name).build();
    let mut policy = AccessPolicy::load();
    if let Some(p) = args.profile {
        policy.profile = p;
    }
    let state = Arc::new(AppState { client, policy });

    let app = Router::new()
        .route("/health", get(health))
        .route("/tools", get(list_tools))
        .route("/tools/{name}", post(call_tool))
        .route("/call", post(call_generic))
        .with_state(state);

    // Boucle d'ingestion automatisée — remplace la tâche planifiée
    // ingest-workspace.ps1. Racines résolues À CHAQUE cycle :
    //   1) HPHE_INGEST_ROOTS (liste explicite ';')
    //   2) registre persistant <data>/ingest-roots.txt (toute racine passée
    //      à content_ingest/hephaistos_update y est inscrite)
    //   3) HPHE_INGEST_SCAN : parents scannés pour marqueur `.agent/`
    //      (un workspace inité est découvert et ingéré tout seul)
    if args.ingest_roots.is_some() || args.ingest_scan.is_some() {
        let interval = std::time::Duration::from_secs(args.ingest_interval_s.max(30));
        let env_roots: Vec<std::path::PathBuf> = args
            .ingest_roots
            .unwrap_or_default()
            .split(';')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(std::path::PathBuf::from)
            .collect();
        let scan_dirs: Vec<std::path::PathBuf> = args
            .ingest_scan
            .unwrap_or_default()
            .split(';')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(std::path::PathBuf::from)
            .collect();
        tokio::spawn(async move {
            loop {
                let mut roots: Vec<std::path::PathBuf> = env_roots.clone();
                roots.extend(hphe_kit::ingest::read_ingest_registry());
                for parent in &scan_dirs {
                    roots.extend(hphe_kit::ingest::scan_agent_workspaces(parent));
                }
                roots.sort();
                roots.dedup();
                for root in &roots {
                    if !root.exists() {
                        continue;
                    }
                    let tag = root
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("workspace")
                        .to_string();
                    let args = serde_json::json!({"root": root, "project_tag": tag});
                    match tools::execute_tool("content_ingest", &args, &hphe_ipc::client::ClientBuilder::new().build(), &AccessPolicy::load()).await {
                        Ok(v) => tracing::info!(root = %root.display(), result = %v, "auto-ingest done"),
                        Err(e) => tracing::warn!(root = %root.display(), error = %e, "auto-ingest failed"),
                    }
                }
                tokio::time::sleep(interval).await;
            }
        });
    }

    let addr: SocketAddr = args.addr.parse()?;
    tracing::info!(%addr, "hphe-rest listening");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health(State(st): State<Arc<AppState>>) -> Json<Value> {
    let res = tools::execute_tool("hphe_health", &json!({}), &st.client, &st.policy).await;
    match res {
        Ok(v) => Json(v),
        Err(e) => Json(json!({"status": "error", "error": e})),
    }
}

async fn list_tools() -> Json<Value> {
    let defs = tools::get_tool_definitions();
    let names: Vec<Value> = defs
        .iter()
        .map(|t| json!({"name": t.name, "description": t.description}))
        .collect();
    Json(json!({"count": names.len(), "tools": names}))
}

async fn call_tool(
    State(st): State<Arc<AppState>>,
    Path(name): Path<String>,
    body: Option<Json<Value>>,
) -> (StatusCode, Json<Value>) {
    let args = body.map(|b| b.0).unwrap_or_else(|| json!({}));
    run_tool(&st, &name, args).await
}

async fn call_generic(
    State(st): State<Arc<AppState>>,
    body: Json<Value>,
) -> (StatusCode, Json<Value>) {
    let name = body["name"].as_str().unwrap_or("").to_string();
    let args = body["arguments"].clone();
    run_tool(&st, &name, args).await
}

async fn run_tool(
    st: &Arc<AppState>,
    name: &str,
    args: Value,
) -> (StatusCode, Json<Value>) {
    if !tools::get_tool_definitions().iter().any(|t| t.name == name) {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": format!("unknown tool {}", name)})),
        );
    }
    match tools::execute_tool(name, &args, &st.client, &st.policy).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": e, "tool": name})),
        ),
    }
}
