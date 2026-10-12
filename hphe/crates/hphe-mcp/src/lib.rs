//! hphe-mcp - Unified MCP stdio server client of hphe-index named pipe

pub mod categories;
pub mod diff;
pub mod policy;
pub mod protocol;
pub mod server;
pub mod tools;

pub use policy::AccessPolicy;
pub use protocol::{JsonRpcRequest, JsonRpcResponse, ToolDefinition, ToolResult};
pub use server::McpServer;
