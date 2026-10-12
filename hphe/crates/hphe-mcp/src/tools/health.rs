//! Health check tool verifying daemon pipe connectivity

use std::time::{SystemTime, UNIX_EPOCH};

use hphe_ipc::client::Client;
use serde_json::{json, Value};

use crate::protocol::SERVER_VERSION;

pub async fn tool_health(client: &Client) -> Result<Value, String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);

    let pipe_name = client.config().full_pipe_name();

    let (connected, daemon_info, daemon_err) = match client.ping().await {
        Ok(ping) => (
            true,
            Some(json!({
                "version": ping.version,
                "uptime_ms": ping.uptime_ms,
                "timestamp": ping.timestamp
            })),
            None,
        ),
        Err(e) => (false, None, Some(e.to_string())),
    };

    Ok(json!({
        "status": if connected { "healthy" } else { "degraded" },
        "server": "hphe-mcp",
        "version": SERVER_VERSION,
        "pipe_name": pipe_name,
        "pipe_connected": connected,
        "daemon_ping": daemon_info,
        "daemon_error": daemon_err,
        "timestamp": now
    }))
}
