//! Binary entrypoint for hphe-mcp.exe (unified non-elevated MCP server)

use clap::Parser;
use hphe_ipc::client::ClientBuilder;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

use hphe_mcp::{AccessPolicy, McpServer};

#[derive(Parser, Debug)]
#[command(
    name = "hphe-mcp",
    about = "Unified MCP stdio server client of hphe-index named pipe (Hephaistos Engine)",
    version
)]
struct Args {
    /// Pipe name to connect to
    #[arg(long, default_value = r"\\.\pipe\hphe-index", env = "HPHE_PIPE_NAME")]
    pipe_name: String,

    /// Connection timeout in milliseconds
    #[arg(long, default_value_t = 3000)]
    connect_timeout_ms: u64,

    /// Request timeout in milliseconds
    #[arg(long, default_value_t = 10000)]
    request_timeout_ms: u64,

    /// Active agent profile for .mcp-access policy
    #[arg(long, env = "EVERYTHING_MCP_AGENT")]
    profile: Option<String>,

    /// Log level (error, warn, info, debug, trace)
    #[arg(long, default_value = "info", env = "RUST_LOG")]
    log_level: String,

    /// Run a single tool non-interactively (CLI mode for scripts/scheduled tasks).
    /// Example: hphe-mcp --tool hephaistos_update --args "{\"root\":\".\",\"force\":true}"
    #[arg(long)]
    tool: Option<String>,

    /// JSON arguments for --tool
    #[arg(long, default_value = "{}")]
    args: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();

    // Critical: MCP stdio communicates over stdout, so logs MUST go to stderr!
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(&args.log_level));

    tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr))
        .init();

    tracing::info!(
        pipe_name = %args.pipe_name,
        profile = ?args.profile,
        "Starting hphe-mcp unified stdio server"
    );

    let client = ClientBuilder::new()
        .pipe_name(&args.pipe_name)
        .connect_timeout_ms(args.connect_timeout_ms)
        .request_timeout_ms(args.request_timeout_ms)
        .build();

    let mut policy = AccessPolicy::load();
    if let Some(prof) = args.profile {
        policy.profile = prof;
    }

    // CLI mode: run one tool and print its JSON result on stdout.
    if let Some(tool) = args.tool {
        let tool_args: serde_json::Value =
            serde_json::from_str(&args.args).unwrap_or_else(|_| serde_json::json!({}));
        let result = hphe_mcp::tools::execute_tool(&tool, &tool_args, &client, &policy).await;
        match result {
            Ok(v) => {
                println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
                return Ok(());
            }
            Err(e) => {
                eprintln!("tool error: {}", e);
                std::process::exit(1);
            }
        }
    }

    let server = McpServer::new(client, policy);
    server.run_stdio().await?;

    Ok(())
}
