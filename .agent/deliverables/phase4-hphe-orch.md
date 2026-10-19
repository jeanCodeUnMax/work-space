.agent/deliverables/phase4-hphe-orch.md
```markdown
# hphe-orch crate

## Cargo.toml
```toml
[package]
name = "hphe-orch"
version = "0.1.0"
edition = "2021"

[dependencies]
hphe-kit = { path = "../hphe-kit" }
serde_json = { version = "1.0" }
clap = { version = "4.0", features = ["derive"] }
```

## src/main.rs
```rust
use clap::{Parser, Subcommand, ValueEnum};
use hphe_kit::orch::{self, Error as OrchError};
use serde_json::json;
use std::process::exit;

/// Hephaistos Orchestrator CLI
#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// Output JSON instead of human‑readable text
    #[arg(long)]
    json: bool,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Dispatch a new task
    Dispatch {
        /// Task payload in JSON
        #[arg(long)]
        payload: String,
    },
    /// List known agents
    List,
    /// Update an agent's configuration
    Update {
        /// Agent ID
        id: String,
        /// New configuration in JSON
        #[arg(long)]
        config: String,
    },
    /// Manage agents (register / deregister)
    Agents {
        /// Sub‑action: register or deregister
        #[arg(value_enum)]
        action: AgentAction,
        /// Agent ID
        id: String,
    },
    /// Apply discipline rules
    Discipline {
        /// Agent ID
        id: String,
        /// Rule to apply
        rule: String,
    },
    /// Health check of the orchestrator
    Health,
}

#[derive(ValueEnum, Clone, Debug)]
enum AgentAction {
    Register,
    Deregister,
}

fn main() {
    let args = Args::parse();
    if let Err(code) = run(args) {
        exit(code);
    }
}

fn run(args: Args) -> Result<(), i32> {
    match args.command {
        Commands::Dispatch { payload } => {
            let task: serde_json::Value = serde_json::from_str(&payload)
                .map_err(|_| 1)?; // validation error
            match orch::dispatch_task(task) {
                Ok(_) => output_success(args.json, "Task dispatched"),
                Err(OrchError::Validation) => Err(1),
                Err(OrchError::System) => Err(2),
            }
        }
        Commands::List => {
            match orch::list_agents() {
                Ok(agents) => output_success(args.json, format!("{:?}", agents)),
                Err(OrchError::Validation) => Err(1),
                Err(OrchError::System) => Err(2),
            }
        }
        Commands::Update { id, config } => {
            let cfg: serde_json::Value = serde_json::from_str(&config)
                .map_err(|_| 1)?;
            match orch::update_agent(&id, cfg) {
                Ok(_) => output_success(args.json, "Agent updated"),
                Err(OrchError::Validation) => Err(1),
                Err(OrchError::System) => Err(2),
            }
        }
        Commands::Agents { action, id } => {
            let res = match action {
                AgentAction::Register => orch::register_agent(&id),
                AgentAction::Deregister => orch::deregister_agent(&id),
            };
            match res {
                Ok(_) => output_success(args.json, format!("Agent {:?}ed", action)),
                Err(OrchError::Validation) => Err(1),
                Err(OrchError::System) => Err(2),
            }
        }
        Commands::Discipline { id, rule } => {
            match orch::apply_discipline(&id, &rule) {
                Ok(_) => output_success(args.json, "Discipline applied"),
                Err(OrchError::Validation) => Err(1),
                Err(OrchError::System) => Err(2),
            }
        }
        Commands::Health => {
            match orch::health_check() {
                Ok(status) => output_success(args.json, format!("Health: {}", status)),
                Err(OrchError::Validation) => Err(1),
                Err(OrchError::System) => Err(2),
            }
        }
    }
}

fn output_success(json: bool, message: String) -> Result<(), i32> {
    if json {
        let out = json!({ "status": "success", "message": message });
        println!("{}", out.to_string());
    } else {
        println!("{}", message);
    }
    Ok(())
}
```
```
