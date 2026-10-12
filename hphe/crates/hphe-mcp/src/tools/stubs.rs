//! Memory tools stubs (agentmemory rusqlite integration out of scope for T-092)

use serde_json::{json, Value};

pub fn tool_memory_stub(name: &str, _args: &Value) -> Result<Value, String> {
    Ok(json!({
        "tool": name,
        "status": "stub_v1",
        "note": "Unified SQLite memory store tool V1 stub (agentmemory rusqlite integration ready for P5).",
        "result": null
    }))
}
