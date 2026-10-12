//! MCP Server handling JSON-RPC 2.0 stdio protocol loop and method dispatch

use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tracing::{debug, error, info};
use serde_json::{json, Value};

use hphe_ipc::client::Client;

use crate::policy::AccessPolicy;
use crate::protocol::{
    JsonRpcRequest, JsonRpcResponse, ToolResult, CODE_INVALID_PARAMS, CODE_METHOD_NOT_FOUND,
    CODE_PARSE_ERROR, MCP_PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION,
};
use crate::tools::{execute_tool, get_tool_definitions};

#[derive(Clone)]
pub struct McpServer {
    pub client: Arc<Client>,
    pub policy: Arc<AccessPolicy>,
}

impl McpServer {
    pub fn new(client: Client, policy: AccessPolicy) -> Self {
        Self {
            client: Arc::new(client),
            policy: Arc::new(policy),
        }
    }

    pub async fn handle_message(&self, req: JsonRpcRequest) -> Option<JsonRpcResponse> {
        let method = req.method.as_str();
        let id = req.id.clone();

        match method {
            "initialize" => {
                let proto_ver = req
                    .params
                    .as_ref()
                    .and_then(|p| p.get("protocolVersion"))
                    .and_then(|v| v.as_str())
                    .unwrap_or(MCP_PROTOCOL_VERSION);

                Some(JsonRpcResponse::success(
                    id,
                    json!({
                        "protocolVersion": proto_ver,
                        "capabilities": {
                            "tools": { "listChanged": false }
                        },
                        "serverInfo": {
                            "name": SERVER_NAME,
                            "version": SERVER_VERSION
                        },
                        "instructions": "Unified Hephaistos Engine MCP server (hphe-mcp). Ultra-fast NTFS search client to \\\\.\\pipe\\hphe-index with integrated filesystem tools."
                    }),
                ))
            }
            "ping" => Some(JsonRpcResponse::success(id, json!({}))),
            "tools/list" => {
                let tools = get_tool_definitions();
                Some(JsonRpcResponse::success(id, json!({ "tools": tools })))
            }
            "resources/list" => Some(JsonRpcResponse::success(id, json!({ "resources": [] }))),
            "prompts/list" => Some(JsonRpcResponse::success(id, json!({ "prompts": [] }))),
            "tools/call" => {
                let params = match req.params {
                    Some(Value::Object(map)) => Value::Object(map),
                    _ => {
                        return Some(JsonRpcResponse::error(
                            id,
                            CODE_INVALID_PARAMS,
                            "tools/call params must be an object",
                        ));
                    }
                };
                let tool_name = match params.get("name").and_then(|v| v.as_str()) {
                    Some(name) if !name.is_empty() => name,
                    _ => {
                        return Some(JsonRpcResponse::error(
                            id,
                            CODE_INVALID_PARAMS,
                            "Missing tool name parameter in tools/call",
                        ));
                    }
                };
                let empty_args = json!({});
                let arguments = params.get("arguments").unwrap_or(&empty_args);

                let res = execute_tool(tool_name, arguments, &self.client, &self.policy).await;
                match res {
                    Ok(val) => {
                        let tool_result = ToolResult::ok_value(val);
                        Some(JsonRpcResponse::success(
                            id,
                            serde_json::to_value(tool_result).unwrap_or(Value::Null),
                        ))
                    }
                    Err(err_msg) => {
                        if err_msg.starts_with("unknown tool") {
                            Some(JsonRpcResponse::error(id, CODE_INVALID_PARAMS, err_msg))
                        } else {
                            let tool_result = ToolResult::error(err_msg);
                            Some(JsonRpcResponse::success(
                                id,
                                serde_json::to_value(tool_result).unwrap_or(Value::Null),
                            ))
                        }
                    }
                }
            }
            "shutdown" => Some(JsonRpcResponse::success(id, Value::Null)),
            "exit" => {
                std::process::exit(0);
            }
            notif if notif.starts_with("notifications/") => None,
            _ => {
                if id.is_some() {
                    Some(JsonRpcResponse::error(
                        id,
                        CODE_METHOD_NOT_FOUND,
                        format!("method not found: {}", method),
                    ))
                } else {
                    None
                }
            }
        }
    }

    pub async fn run_stdio(&self) -> std::io::Result<()> {
        let stdin = tokio::io::stdin();
        let mut stdout = tokio::io::stdout();
        let mut reader = BufReader::new(stdin).lines();

        info!("hphe-mcp listening on stdio");

        while let Ok(Some(line)) = reader.next_line().await {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }

            debug!("Received MCP message: {}", line);

            let req: JsonRpcRequest = match serde_json::from_str(line) {
                Ok(r) => r,
                Err(e) => {
                    error!("JSON parse error: {}", e);
                    let resp = JsonRpcResponse::error(None, CODE_PARSE_ERROR, format!("Parse error: {}", e));
                    let serialized = serde_json::to_string(&resp)?;
                    stdout.write_all(serialized.as_bytes()).await?;
                    stdout.write_all(b"\n").await?;
                    stdout.flush().await?;
                    continue;
                }
            };

            if let Some(resp) = self.handle_message(req).await {
                let serialized = serde_json::to_string(&resp)?;
                stdout.write_all(serialized.as_bytes()).await?;
                stdout.write_all(b"\n").await?;
                stdout.flush().await?;
            }
        }

        Ok(())
    }
}
