//! Orchestrateur unifié — absorbé depuis `orchestrator-server` (Node).
//!
//! Même schéma, même fichier : `orchestrator.db` (rusqlite bundled).
//! Porte : tasks, agents, prompt_templates, provider_prefs, model_health,
//! worktrees, task_events, dispatch (spawn argv sans shell, shim .cmd).

use once_cell::sync::Lazy;
use rusqlite::{params, Connection};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

use crate::models::available_models;
use crate::orch_db_path;

static DB: Lazy<Mutex<Option<Connection>>> = Lazy::new(|| Mutex::new(None));

fn with_db<T>(f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
    let mut guard = DB.lock().map_err(|_| "db lock")?;
    if guard.is_none() {
        let path = orch_db_path();
        let conn = Connection::open(&path)
            .map_err(|e| format!("open {}: {}", path.display(), e))?;
        conn.pragma_update(None, "busy_timeout", 5000)
            .map_err(|e| e.to_string())?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| e.to_string())?;
        seed_templates(&conn)?;
        *guard = Some(conn);
    }
    f(guard.as_ref().unwrap())
}

fn now_iso() -> String {
    // ISO-8601 UTC sans chrono
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days = secs / 86400;
    let rem = secs % 86400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (y, mo, d) = civil_from_days(days as i64);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, mo, d, h, m, s)
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// task_id tolérant : accepte `"42"` (string) ou `42` (nombre).
fn arg_task_id(args: &Value) -> Result<String, String> {
    match &args["task_id"] {
        Value::String(s) if !s.is_empty() => Ok(s.clone()),
        Value::Number(n) => Ok(n.to_string()),
        _ => args["id"]
            .as_str()
            .map(String::from)
            .or_else(|| args["id"].as_i64().map(|n| n.to_string()))
            .ok_or_else(|| "task_id requis".to_string()),
    }
}

fn log_event(conn: &Connection, task_id: &str, event: &str, detail: &str) {
    let _ = conn.execute(
        "INSERT INTO task_events (task_id, event, detail, ts) VALUES (?,?,?,?)",
        params![task_id, event, detail, now_iso()],
    );
}

fn row_to_task(stmt: &mut rusqlite::Statement) -> Result<Vec<Value>, String> {
    let rows = stmt
        .query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "title": r.get::<_, String>(1)?,
                "description": r.get::<_, Option<String>>(2)?,
                "priority": r.get::<_, Option<String>>(3)?,
                "status": r.get::<_, Option<String>>(4)?,
                "due_date": r.get::<_, Option<String>>(5)?,
                "created_at": r.get::<_, Option<String>>(6)?,
                "dependencies": r.get::<_, Option<String>>(7)?,
                "assigned_to": r.get::<_, Option<i64>>(8)?,
                "result": r.get::<_, Option<String>>(9)?,
                "task_type": r.get::<_, Option<String>>(10)?,
                "model": r.get::<_, Option<String>>(11)?,
                "provider": r.get::<_, Option<String>>(12)?,
                "dispatcher": r.get::<_, Option<String>>(13)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

const TASK_COLS: &str =
    "id, title, description, priority, status, due_date, created_at, dependencies, \
     assigned_to, result, task_type, model, provider, dispatcher";

// ===================== Agents =====================

fn row_to_agent(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, i64>(0)?,
        "agent_name": r.get::<_, String>(1)?,
        "agent_type": r.get::<_, Option<String>>(2)?,
        "config": r.get::<_, Option<String>>(3)?,
        "active": r.get::<_, i64>(4)?,
    }))
}

fn find_agent(conn: &Connection, name_or_id: &str) -> Option<Value> {
    conn.query_row(
        "SELECT id, agent_name, agent_type, config, active FROM agents WHERE id = ?1 OR agent_name = ?1",
        params![name_or_id],
        row_to_agent,
    )
    .ok()
}

fn agent_cfg(agent: &Value) -> Value {
    agent["config"]
        .as_str()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_else(|| json!({}))
}

fn agent_priority(agent: &Value) -> i64 {
    agent_cfg(agent)["priority"].as_i64().unwrap_or(100)
}

fn pick_agent_by_skill(conn: &Connection, task_type: &str) -> Option<Value> {
    let mut stmt = conn
        .prepare("SELECT id, agent_name, agent_type, config, active FROM agents WHERE active = 1")
        .ok()?;
    let agents: Vec<Value> = stmt
        .query_map([], row_to_agent)
        .ok()?
        .filter_map(|r| r.ok())
        .collect();
    let has_skill = |a: &Value, s: &str| {
        agent_cfg(a)["skills"]
            .as_array()
            .map(|arr| arr.iter().any(|x| x.as_str() == Some(s)))
            .unwrap_or(false)
    };
    let mut by_prio = |a: &&Value, b: &&Value| {
        agent_priority(a)
            .cmp(&agent_priority(b))
            .then(a["id"].as_i64().cmp(&b["id"].as_i64()))
    };
    // 1. skill exact
    if let Some(a) = agents
        .iter()
        .filter(|a| has_skill(a, task_type))
        .min_by(&mut by_prio)
    {
        return Some(a.clone());
    }
    // 2. wildcard
    agents
        .iter()
        .filter(|a| has_skill(a, "*"))
        .min_by(&mut by_prio)
        .cloned()
}

pub fn tool_list_agents(_args: &Value) -> Result<Value, String> {
    with_db(|conn| {
        let mut stmt = conn
            .prepare("SELECT id, agent_name, agent_type, config, active FROM agents")
            .map_err(|e| e.to_string())?;
        let agents: Vec<Value> = stmt
            .query_map([], row_to_agent)
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(json!(agents))
    })
}

pub fn tool_register_agent(args: &Value) -> Result<Value, String> {
    let name = args["agent_name"].as_str().ok_or("agent_name requis")?;
    let atype = args["agent_type"].as_str().unwrap_or("cli");
    let config = args["config"].as_str().unwrap_or("{}");
    with_db(|conn| {
        if let Some(existing) = find_agent(conn, name) {
            conn.execute(
                "UPDATE agents SET agent_type=?, config=?, active=1 WHERE id=?",
                params![atype, config, existing["id"].as_i64().unwrap_or(0)],
            )
            .map_err(|e| e.to_string())?;
            return Ok(json!({"id": existing["id"], "agent_name": name, "updated": true}));
        }
        conn.execute(
            "INSERT INTO agents (agent_name, agent_type, config, active) VALUES (?,?,?,1)",
            params![name, atype, config],
        )
        .map_err(|e| e.to_string())?;
        Ok(json!({"id": conn.last_insert_rowid(), "agent_name": name, "created": true}))
    })
}

pub fn tool_update_agent(args: &Value) -> Result<Value, String> {
    let name = args["agent_name"].as_str().ok_or("agent_name requis")?;
    with_db(|conn| {
        let Some(agent) = find_agent(conn, name) else {
            return Err(format!("agent '{}' introuvable", name));
        };
        if let Some(c) = args["config"].as_str() {
            conn.execute(
                "UPDATE agents SET config=? WHERE id=?",
                params![c, agent["id"].as_i64().unwrap_or(0)],
            )
            .map_err(|e| e.to_string())?;
        }
        if let Some(t) = args["agent_type"].as_str() {
            conn.execute(
                "UPDATE agents SET agent_type=? WHERE id=?",
                params![t, agent["id"].as_i64().unwrap_or(0)],
            )
            .map_err(|e| e.to_string())?;
        }
        if let Some(a) = args["active"].as_i64() {
            conn.execute(
                "UPDATE agents SET active=? WHERE id=?",
                params![a, agent["id"].as_i64().unwrap_or(0)],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(json!({"updated": true, "agent_name": name}))
    })
}

// ===================== Tasks =====================

pub fn tool_create_task(args: &Value) -> Result<Value, String> {
    let title = args["title"].as_str().ok_or("title requis")?;
    let desc = args["description"].as_str().unwrap_or("");
    let priority = args["priority"].as_str().unwrap_or("medium");
    let deps = args["dependencies"]
        .as_array()
        .map(|a| serde_json::to_string(a).unwrap_or_else(|_| "[]".into()))
        .unwrap_or_else(|| "[]".into());
    let session = args["session"].as_str().unwrap_or("");
    let assigned: Option<i64> = args["assigned_to"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .or_else(|| args["assigned_to"].as_i64());
    with_db(|conn| {
        // assignation par nom possible
        let assigned = match (assigned, args["assigned_to"].as_str()) {
            (None, Some(name)) => find_agent(conn, name)
                .and_then(|a| a["id"].as_i64()),
            (id, _) => id,
        };
        conn.execute(
            "INSERT INTO tasks_todo (title, description, priority, status, created_at, dependencies, assigned_to, dispatcher) \
             VALUES (?,?,?,?,?,?,?,?)",
            params![title, desc, priority, "pending", now_iso(), deps, assigned, session],
        )
        .map_err(|e| e.to_string())?;
        let id = conn.last_insert_rowid();
        log_event(conn, &id.to_string(), "created", &format!("session={}", session));
        Ok(json!({"id": id, "title": title, "status": "pending", "assigned_to": assigned}))
    })
}

pub fn tool_update_task(args: &Value) -> Result<Value, String> {
    let task_id = arg_task_id(args)?;
    let id_num: i64 = task_id.parse().map_err(|_| "task_id numérique requis")?;
    with_db(|conn| {
        if let Some(s) = args["status"].as_str() {
            conn.execute(
                "UPDATE tasks_todo SET status=? WHERE id=?",
                params![s, id_num],
            )
            .map_err(|e| e.to_string())?;
            log_event(conn, &task_id, "status", s);
        }
        if let Some(d) = args["description"].as_str() {
            conn.execute(
                "UPDATE tasks_todo SET description=? WHERE id=?",
                params![d, id_num],
            )
            .map_err(|e| e.to_string())?;
        }
        if let Some(r) = args["result"].as_str() {
            conn.execute(
                "UPDATE tasks_todo SET result=? WHERE id=?",
                params![r, id_num],
            )
            .map_err(|e| e.to_string())?;
        }
        if let Some(deps) = args["dependencies"].as_array() {
            conn.execute(
                "UPDATE tasks_todo SET dependencies=? WHERE id=?",
                params![serde_json::to_string(deps).unwrap_or_default(), id_num],
            )
            .map_err(|e| e.to_string())?;
        }
        if let Some(a) = args["assigned_to"].as_str() {
            let aid = a.parse::<i64>().ok().or_else(|| {
                find_agent(conn, a).and_then(|ag| ag["id"].as_i64())
            });
            conn.execute(
                "UPDATE tasks_todo SET assigned_to=? WHERE id=?",
                params![aid, id_num],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(json!({"updated": true, "task_id": id_num}))
    })
}

pub fn tool_list_tasks(args: &Value) -> Result<Value, String> {
    with_db(|conn| {
        let mut sql = format!("SELECT {} FROM tasks_todo WHERE 1=1", TASK_COLS);
        if let Some(s) = args["status"].as_str() {
            sql += &format!(" AND status = '{}'", s.replace('\'', "''"));
        }
        if let Some(a) = args["assigned_to"].as_str() {
            if let Ok(n) = a.parse::<i64>() {
                sql += &format!(" AND assigned_to = {}", n);
            }
        }
        sql += " ORDER BY id DESC LIMIT 500";
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        Ok(json!(row_to_task(&mut stmt)?))
    })
}

pub fn tool_get_next_task(args: &Value) -> Result<Value, String> {
    with_db(|conn| {
        let agent_id = args["agent_id"].as_str().unwrap_or("");
        let aid: Option<i64> = agent_id
            .parse()
            .ok()
            .or_else(|| find_agent(conn, agent_id).and_then(|a| a["id"].as_i64()));
        let sql = format!("SELECT {} FROM tasks_todo WHERE status='pending' ORDER BY id", TASK_COLS);
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let tasks = row_to_task(&mut stmt)?;
        'outer: for t in tasks {
            // assignation : tâche libre ou assignée à cet agent
            if let Some(a) = t["assigned_to"].as_i64() {
                if Some(a) != aid {
                    continue;
                }
            }
            // dépendances : toutes les tâches listées doivent être completed
            let deps: Vec<Value> = serde_json::from_str(
                t["dependencies"].as_str().unwrap_or("[]"),
            )
            .unwrap_or_default();
            for d in deps {
                let dep_id = d.as_i64().or_else(|| d.as_str().and_then(|s| s.parse().ok()));
                if let Some(di) = dep_id {
                    let st: String = conn
                        .query_row(
                            "SELECT status FROM tasks_todo WHERE id=?",
                            params![di],
                            |r| r.get(0),
                        )
                        .unwrap_or_else(|_| "pending".into());
                    if st != "completed" {
                        continue 'outer;
                    }
                }
            }
            return Ok(json!({"found": true, "task": t}));
        }
        Ok(json!({"found": false}))
    })
}

pub fn tool_delete_task(args: &Value) -> Result<Value, String> {
    let task_id = arg_task_id(args)?;
    with_db(|conn| {
        let n = conn
            .execute("DELETE FROM tasks_todo WHERE id=? OR CAST(id AS TEXT)=?",
                     params![task_id.parse::<i64>().unwrap_or(-1), task_id])
            .map_err(|e| e.to_string())?;
        Ok(json!({"deleted": n > 0, "task_id": task_id}))
    })
}

// ===================== Prompt templates =====================

fn default_templates() -> Vec<(&'static str, &'static str, &'static str, &'static str)> {
    vec![
        ("code", "Coder", "Implementation propre et minimale (single-line, exec-safe)",
         "Tu es l'agent codeur. TACHE : {{task}}. CONTEXTE : {{context}}. FICHIERS : {{files}}. MODELE : {{model}}.\nSECURITE ABSOLUE: 1. Injections: utilise exclusivement spawn/argv, JAMAIS exec/execSync/cmd. 2. Anti-Backdoor: Aucun code obfusque, dynamique (eval) ou caractere furtif. Le code doit etre 100% lisible.\nCLEAN GARDEN: Privilegie la modif aux creations. Resume dans update_task status=completed."),
        ("debug", "Debugger", "Diagnostiquer et corriger un bug",
         "Tu es l'agent de debogage. TACHE : {{task}}. SYMPTOMES : {{context}}. FICHIERS : {{files}}. MODELE : {{model}}.\nSECURITE ABSOLUE: 1. Injections: utilise exclusivement spawn/argv, JAMAIS exec/execSync/cmd. 2. Anti-Backdoor: Aucun code obfusque, dynamique (eval) ou caractere furtif.\nIdentifie la root cause, corrige proprement, update_task status=completed."),
        ("review", "Reviewer", "Revue qualite/securite (single-line, exec-safe)",
         "Tu es le reviewer qualite/securite. TACHE : {{task}}. CONTEXTE : {{context}}. FICHIERS : {{files}}. MODELE : {{model}}.\nSECURITE ABSOLUE: 1. Injections: utilise exclusivement spawn/argv, JAMAIS exec/execSync/cmd. 2. Anti-Backdoor: Aucun code obfusque, dynamique (eval) ou caractere furtif.\nFais un audit sans concession, update_task status=completed."),
        ("docs", "Documentation", "Redaction/mise a jour doc (single-line, exec-safe)",
         "Tu es le redacteur technique. TACHE : {{task}}. CONTEXTE : {{context}}. FICHIERS : {{files}}. MODELE : {{model}}.\nCLEAN GARDEN: Privilegie la modification aux creations. Rends la doc claire. update_task status=completed."),
        ("test", "Tester", "Ecriture ou execution de tests",
         "Tu es l'ingenieur QA. TACHE : {{task}}. CONTEXTE : {{context}}. FICHIERS : {{files}}. MODELE : {{model}}.\nSECURITE ABSOLUE: 1. Injections: utilise exclusivement spawn/argv, JAMAIS exec/execSync/cmd. 2. Anti-Backdoor: Aucun code obfusque, dynamique (eval) ou caractere furtif.\nEcris/execute les tests, update_task status=completed."),
        ("explore", "Explorer", "Exploration/analyse de codebase (lecture seule)",
         "Tu es l'agent explorateur. TACHE : {{task}}. CONTEXTE : {{context}}. FICHIERS : {{files}}. MODELE : {{model}}.\nFais un rapport d'analyse precis. Read-only (pas de modif) sauf consigne. update_task status=completed."),
    ]
}

fn seed_templates(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("INSERT OR IGNORE INTO prompt_templates (role, name, template, description) VALUES (?,?,?,?)")
        .map_err(|e| e.to_string())?;
    for (role, name, tpl, desc) in default_templates() {
        stmt.execute(params![role, name, tpl, desc])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn tool_list_prompt_templates(_args: &Value) -> Result<Value, String> {
    with_db(|conn| {
        let mut stmt = conn
            .prepare("SELECT role, name, template, description, updated_at FROM prompt_templates")
            .map_err(|e| e.to_string())?;
        let rows: Vec<Value> = stmt
            .query_map([], |r| {
                Ok(json!({
                    "role": r.get::<_, String>(0)?,
                    "name": r.get::<_, Option<String>>(1)?,
                    "template": r.get::<_, Option<String>>(2)?,
                    "description": r.get::<_, Option<String>>(3)?,
                    "updated_at": r.get::<_, Option<String>>(4)?,
                }))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(json!(rows))
    })
}

pub fn tool_set_prompt_template(args: &Value) -> Result<Value, String> {
    let role = args["role"].as_str().ok_or("role requis")?;
    let name = args["name"].as_str().unwrap_or(role);
    let template = args["template"].as_str().ok_or("template requis")?;
    let desc = args["description"].as_str().unwrap_or("");
    with_db(|conn| {
        conn.execute(
            "INSERT INTO prompt_templates (role, name, template, description, updated_at) VALUES (?,?,?,?,?) \
             ON CONFLICT(role) DO UPDATE SET name=excluded.name, template=excluded.template, description=excluded.description, updated_at=excluded.updated_at",
            params![role, name, template, desc, now_iso()],
        )
        .map_err(|e| e.to_string())?;
        Ok(json!({"role": role, "saved": true}))
    })
}

fn render_template(conn: &Connection, role: &str, vars: &Map<String, Value>) -> (String, &'static str) {
    let custom: Option<String> = conn
        .query_row(
            "SELECT template FROM prompt_templates WHERE role=?",
            params![role],
            |r| r.get(0),
        )
        .ok();
    let tpl = custom
        .clone()
        .or_else(|| {
            default_templates()
                .into_iter()
                .find(|(r, _, _, _)| r == &role)
                .map(|(_, _, t, _)| t.to_string())
        })
        .unwrap_or_else(|| "TÂCHE : {{task}}\nCONTEXTE : {{context}}\nFICHIERS : {{files}}".into());
    let get = |k: &str| vars.get(k).and_then(|v| v.as_str()).unwrap_or("");
    let rendered = tpl
        .replace("{{task}}", &get("task").to_string())
        .replace("{{context}}", &if get("context").is_empty() { "(non précisé)".to_string() } else { get("context").to_string() })
        .replace("{{files}}", &if get("files").is_empty() { "(non précisés)".to_string() } else { get("files").to_string() })
        .replace("{{model}}", &get("model").to_string())
        .replace("{{provider}}", &get("provider").to_string());
    (rendered, if custom.is_some() { "custom" } else { "builtin" })
}

// ===================== pickModel (router unifié) =====================

fn recently_failed(model: &str, health: &Map<String, Value>) -> bool {
    let Some(h) = health.get(&model.to_lowercase()) else { return false };
    if h["ok"].as_i64().unwrap_or(1) == 1 {
        return false;
    }
    let Some(at) = h["at"].as_str() else { return false };
    // "YYYY-MM-DD HH:MM:SS" (UTC) -> epoch approx
    let Ok(at_ms) = parse_sql_time(at) else { return false };
    now_ms() - at_ms < 30 * 60 * 1000
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn parse_sql_time(s: &str) -> Result<u64, ()> {
    // "YYYY-MM-DD HH:MM:SS" ou ISO
    let s = s.replace('T', " ").replace('Z', "");
    let parts: Vec<&str> = s.split([' ', '-', ':']).collect();
    if parts.len() < 6 {
        return Err(());
    }
    let n: Vec<u64> = parts.iter().filter_map(|p| p.parse().ok()).collect();
    if n.len() < 6 {
        return Err(());
    }
    let days = days_from_civil(n[0] as i64, n[1] as u32, n[2] as u32);
    Ok((days as u64) * 86400_000 + n[3] * 3600_000 + n[4] * 60_000 + n[5] * 1000)
}

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Le coeur du routage — port direct de pickModel() du serveur Node.
pub fn pick_model(
    conn: &Connection,
    agent_cfg: &Value,
    available: &[Value],
    force_provider: Option<&str>,
    force_model: Option<&str>,
) -> Option<Value> {
    if let Some(m) = force_model {
        return Some(json!({"provider": force_provider.unwrap_or("forced"), "model": m}));
    }
    // provider_prefs : ordre UI + désactivés
    let mut ui_order: Vec<String> = Vec::new();
    let mut disabled: Vec<String> = Vec::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT provider, enabled, position FROM provider_prefs \
         ORDER BY CASE WHEN position IS NULL THEN 1 ELSE 0 END, position",
    ) {
        if let Ok(rows) = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
            ))
        }) {
            for r in rows.flatten() {
                if r.1 == 1 {
                    ui_order.push(r.0);
                } else {
                    disabled.push(r.0);
                }
            }
        }
    }
    let base: Vec<String> = match force_provider {
        Some(p) => vec![p.to_string()],
        None => agent_cfg["providers"]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .filter(|v: &Vec<String>| !v.is_empty())
            .unwrap_or_else(|| {
                vec![
                    "nvidia-nim".into(),
                    "nvidia-nim2".into(),
                    "ollama-cloud".into(),
                    "openrouter-free".into(),
                ]
            }),
    };
    let mut pref_providers: Vec<String> = base
        .into_iter()
        .filter(|p| !disabled.contains(p))
        .collect();
    pref_providers.sort_by_key(|p| {
        ui_order
            .iter()
            .position(|u| u == p)
            .map(|i| i as i64)
            .unwrap_or(0)
    });

    // santé live
    let mut health: Map<String, Value> = Map::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT model, available, latency_ms, checked_at FROM model_health \
         WHERE id IN (SELECT MAX(id) FROM model_health GROUP BY provider, model)",
    ) {
        if let Ok(rows) = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, Option<i64>>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        }) {
            for r in rows.flatten() {
                health.insert(
                    r.0.to_lowercase(),
                    json!({"ok": r.1, "lat": r.2.unwrap_or(999999), "at": r.3.unwrap_or_default()}),
                );
            }
        }
    }
    // in-flight
    let mut in_flight: Vec<String> = Vec::new();
    if let Ok(mut stmt) =
        conn.prepare("SELECT DISTINCT model FROM tasks_todo WHERE status='in_progress' AND model IS NOT NULL")
    {
        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
            in_flight = rows.flatten().map(|m| m.to_lowercase()).collect();
        }
    }
    let pref_models: Vec<String> = agent_cfg["model_prefs"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();

    for prov in &pref_providers {
        let candidates: Vec<Value> = available
            .iter()
            .filter(|m| m["provider"].as_str() == Some(prov.as_str()))
            .cloned()
            .collect();
        if candidates.is_empty() {
            continue;
        }
        let healthy: Vec<Value> = candidates
            .iter()
            .filter(|c| !recently_failed(c["model"].as_str().unwrap_or(""), &health))
            .cloned()
            .collect();
        let free: Vec<Value> = healthy
            .iter()
            .filter(|c| {
                !in_flight.contains(&c["model"].as_str().unwrap_or("").to_lowercase())
            })
            .cloned()
            .collect();
        let mut pool = if !free.is_empty() {
            free
        } else if !healthy.is_empty() {
            healthy
        } else {
            candidates
        };
        pool.sort_by_key(|c| {
            health
                .get(&c["model"].as_str().unwrap_or("").to_lowercase())
                .and_then(|h| h["lat"].as_i64())
                .unwrap_or(999999)
        });
        if !pref_models.is_empty() {
            if let Some(hit) = pool.iter().find(|c| {
                pref_models.iter().any(|p| {
                    c["model"]
                        .as_str()
                        .unwrap_or("")
                        .to_lowercase()
                        .contains(&p.to_lowercase())
                })
            }) {
                return Some(hit.clone());
            }
        }
        return pool.first().cloned();
    }
    None
}

// ===================== Dispatch + spawn =====================

/// Tokenizer identique au JS (quotes + re-fusion `--opt=` valeur).
fn tokenize_args(s: &str) -> Vec<String> {
    let re = regex::Regex::new(r#""([^"]*)"|([^\s"]+)"#).unwrap();
    let mut out: Vec<String> = Vec::new();
    for cap in re.captures_iter(s) {
        out.push(
            cap.get(1)
                .or_else(|| cap.get(2))
                .map(|m| m.as_str().to_string())
                .unwrap_or_default(),
        );
    }
    let eq_re = regex::Regex::new(r#"^--?[^\s=]+=$"#).unwrap();
    let mut merged: Vec<String> = Vec::new();
    for t in out {
        if let Some(last) = merged.last_mut() {
            if eq_re.is_match(last) {
                *last = format!("{}{}", last, t);
                continue;
            }
        }
        merged.push(t);
    }
    merged
}

struct SpawnPlan {
    file: String,
    argv: Vec<String>,
    cwd: PathBuf,
    stdout_file: Option<PathBuf>,
}

fn template_to_spawn_plan(tpl: &str, vars: &Map<String, Value>) -> Option<SpawnPlan> {
    let sub = |v: &str| -> String {
        v.replace("{model}", vars.get("{model}").and_then(|x| x.as_str()).unwrap_or(""))
            .replace("{provider}", vars.get("{provider}").and_then(|x| x.as_str()).unwrap_or(""))
            .replace("{provider_arg}", vars.get("{provider_arg}").and_then(|x| x.as_str()).unwrap_or(""))
            .replace("{workspace}", vars.get("{workspace}").and_then(|x| x.as_str()).unwrap_or(""))
            .replace("{message}", vars.get("{message}").and_then(|x| x.as_str()).unwrap_or(""))
    };
    let mut s = tpl.to_string();
    let mut cwd = PathBuf::from(
        vars.get("{workspace}")
            .and_then(|x| x.as_str())
            .unwrap_or("."),
    );
    // `cd /d "X" && ...`
    let cd_re = regex::Regex::new(r#"(?i)^\s*cd\s+/d\s+("[^"]*"|\S+)\s*&&\s*"#).unwrap();
    if let Some(cap) = cd_re.captures(&s.clone()) {
        let raw = cap.get(1).unwrap().as_str().trim_matches('"');
        cwd = PathBuf::from(sub(raw));
        s = s[cap.get(0).unwrap().end()..].to_string();
    }
    // `< NUL` en fin -> stdin ignore
    let nul_re = regex::Regex::new(r"(?i)<\s*NUL\s*$").unwrap();
    s = nul_re.replace(&s, "").to_string();
    // `> file 2>&1` en fin -> stdout redirect
    let out_re = regex::Regex::new(r#"(?i)>\s*("[^"]*"|\S+)\s*(?:2>&1)?\s*$"#).unwrap();
    let mut stdout_file = None;
    if let Some(cap) = out_re.captures(&s.clone()) {
        let raw = cap.get(1).unwrap().as_str().trim_matches('"');
        stdout_file = Some(PathBuf::from(sub(raw)));
        s = s[..cap.get(0).unwrap().start()].to_string();
    }
    let tokens: Vec<String> = tokenize_args(&s).into_iter().map(|t| sub(&t)).collect();
    if tokens.is_empty() {
        return None;
    }
    Some(SpawnPlan {
        file: tokens[0].clone(),
        argv: tokens[1..].to_vec(),
        cwd,
        stdout_file,
    })
}

/// Node >= 20.12 refuse spawn(.cmd/.bat) sans shell — on extrait la cible
/// réelle depuis la ligne `%*` du shim (vrai exe ou script node).
fn resolve_cmd_shim(file: &str) -> Option<(String, Vec<String>)> {
    if !file.to_lowercase().ends_with(".cmd") && !file.to_lowercase().ends_with(".bat") {
        return None;
    }
    let path = Path::new(file);
    let content = std::fs::read_to_string(path).ok()?;
    let line = content.lines().filter(|l| l.contains("%*")).last()?;
    let re = regex::Regex::new(r#""([^"]+)""#).unwrap();
    let quoted: Vec<String> = re
        .captures_iter(line)
        .map(|c| c[1].to_string())
        .collect();
    let last = quoted.last()?.replace("%~dp0", "").replace("%dp0%", "");
    let dir = path.parent()?;
    let target = dir.join(&last).canonicalize().unwrap_or_else(|_| dir.join(&last));
    let target_str = target.to_string_lossy().to_string();
    if target_str.to_lowercase().ends_with(".exe") {
        Some((target_str, vec![]))
    } else {
        // script node -> node.exe <script>
        let node = std::env::var("HPHE_NODE").unwrap_or_else(|_| "node".into());
        Some((node, vec![target_str]))
    }
}

fn run_spawn_plan(plan: &SpawnPlan) -> Result<u32, String> {
    let out: Stdio = match &plan.stdout_file {
        Some(f) => {
            let path = if f.is_absolute() {
                f.clone()
            } else {
                plan.cwd.join(f)
            };
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .map_err(|e| format!("log redirect impossible: {}", e))?;
            Stdio::from(file)
        }
        None => Stdio::null(),
    };
    let (file, argv) = match resolve_cmd_shim(&plan.file) {
        Some((f, prefix)) => {
            let mut a = prefix;
            a.extend(plan.argv.clone());
            (f, a)
        }
        None => (plan.file.clone(), plan.argv.clone()),
    };
    let mut cmd = Command::new(&file);
    cmd.args(&argv)
        .current_dir(&plan.cwd)
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW | DETACHED_PROCESS
        cmd.creation_flags(0x08000000 | 0x00000008);
    }
    cmd.spawn()
        .map(|c| c.id())
        .map_err(|e| format!("spawn {}: {}", file, e))
}

fn cli_provider_mapping() -> Map<String, Value> {
    serde_json::from_value(json!({
        "nvidia-nim":      {"kilo": "nvidia"},
        "nvidia-nim2":     {"kilo": "nvidia2", "hermes": "custom"},
        "kilo-free":       {"kilo": "kilo"},
        "openrouter-free": {"kilo": "kilo", "hermes": "openrouter"},
        "hermes-free":     {"kilo": "kilo", "hermes": "nous"},
        "ollama":          {"kilo": "ollama-local"},
        "ollama-cloud":    {"kilo": "ollama", "hermes": "ollama-cloud"},
        "mistral-vibe":    {},
        "antigravity-subscription": {},
        "devin-subscription": {},
    }))
    .unwrap_or_default()
}

fn cli_model_name(agent_name: &str, provider: &str, model: &str) -> String {
    let map = cli_provider_mapping();
    let name = agent_name.to_lowercase();
    let family = if name.contains("kilo") {
        "kilo"
    } else if name.contains("hermes") {
        "hermes"
    } else {
        ""
    };
    if let Some(cli) = map.get(provider).and_then(|p| p.get(family)).and_then(|v| v.as_str()) {
        match family {
            "kilo" => format!("{}/{}", cli, model),
            _ => model.to_string(),
        }
    } else {
        model.to_string()
    }
}

#[allow(clippy::too_many_arguments)]
fn notify_agent(
    conn: &Connection,
    task_id: i64,
    title: &str,
    assigned_to: Option<i64>,
    model: &str,
    provider: &str,
    workspace: Option<&str>,
    full_prompt: Option<&str>,
) -> Result<Value, String> {
    let Some(aid) = assigned_to else {
        return Ok(json!({"notified": false, "reason": "no_agent"}));
    };
    let Some(agent) = find_agent(conn, &aid.to_string()) else {
        return Ok(json!({"notified": false, "reason": "agent_unknown"}));
    };
    let agent_name = agent["agent_name"].as_str().unwrap_or("").to_string();
    let cfg = agent_cfg(&agent);
    let command_tpl = cfg["command"].as_str().unwrap_or("").to_string();
    if command_tpl.is_empty() {
        return Ok(json!({"notified": false, "reason": "no_command_template", "agent": agent_name}));
    }
    let safe_title = title.replace('"', "\\\"");
    let default_msg = format!(
        "Tu as une nouvelle tâche en attente dans l'orchestrateur. Tâche #{} : \"{}\". Utilise tes outils MCP pour la lire en détail et la traiter.",
        task_id, safe_title
    );
    let ws_rule = workspace
        .map(|w| {
            format!(
                " WORKSPACE={}. REGLE ABSOLUE : tout fichier à écrire (livrable, log, rapport) DOIT utiliser un chemin absolu sous {} — jamais de chemin relatif.",
                w, w
            )
        })
        .unwrap_or_default();
    let full = cfg["full_prompt"].as_bool().unwrap_or(false);
    let raw = format!("{}{}", if full { full_prompt.unwrap_or(&default_msg) } else { &default_msg }, ws_rule);
    let message = raw
        .replace('\n', " ")
        .replace('\r', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace('"', "'");
    let cli_model = cli_model_name(&agent_name, provider, model);
    let cli_provider = cli_provider_mapping()
        .get(provider)
        .and_then(|p| {
            p.get(if agent_name.to_lowercase().contains("kilo") {
                "kilo"
            } else {
                "hermes"
            })
        })
        .and_then(|v| v.as_str())
        .unwrap_or(provider)
        .to_string();

    let mut vars = Map::new();
    vars.insert("{model}".into(), json!(cli_model));
    vars.insert("{provider}".into(), json!(cli_provider));
    vars.insert("{provider_arg}".into(), json!(cli_provider));
    vars.insert("{workspace}".into(), json!(workspace.unwrap_or("")));
    vars.insert("{message}".into(), json!(message));
    let Some(plan) = template_to_spawn_plan(&command_tpl, &vars) else {
        return Ok(json!({"notified": false, "reason": "empty_plan", "agent": agent_name}));
    };
    match run_spawn_plan(&plan) {
        Ok(pid) => {
            log_event(conn, &task_id.to_string(), "dispatched",
                      &format!("agent={} pid={} model={}", agent_name, pid, cli_model));
            Ok(json!({"notified": true, "agent": agent_name, "pid": pid, "model": cli_model, "provider": cli_provider}))
        }
        Err(e) => {
            log_event(conn, &task_id.to_string(), "dispatch_error", &e);
            Ok(json!({"notified": false, "reason": e, "agent": agent_name}))
        }
    }
}

// ===================== Worktrees =====================

fn create_worktree(conn: &Connection, base_repo: &str, task_id: i64) -> Result<Value, String> {
    let wt_path = format!("{}/.kilo/worktrees/task-{}", base_repo, task_id).replace('\\', "/");
    let branch = format!("agent/task-{}", task_id);
    let out = Command::new("git")
        .args(["-C", base_repo, "worktree", "add", &wt_path, "-b", &branch])
        .output()
        .map_err(|e| format!("git worktree add: {}", e))?;
    if !out.status.success() {
        return Err(format!(
            "git worktree add: {}",
            String::from_utf8_lossy(&out.stderr).chars().take(300).collect::<String>()
        ));
    }
    conn.execute(
        "INSERT INTO worktrees (task_id, path, branch, base, status, created_at) VALUES (?,?,?,?,'active',?)",
        params![task_id.to_string(), wt_path, branch, base_repo, now_iso()],
    )
    .map_err(|e| e.to_string())?;
    Ok(json!({"path": wt_path, "branch": branch}))
}

fn remove_worktree(conn: &Connection, row: &Value) -> Value {
    let base = row["base"].as_str().unwrap_or("");
    let path = row["path"].as_str().unwrap_or("");
    let branch = row["branch"].as_str().unwrap_or("");
    let out = Command::new("git")
        .args(["-C", base, "worktree", "remove", "--force", path])
        .output();
    match out {
        Err(e) => json!({"removed": false, "error": format!("worktree remove: {}", e)}),
        Ok(o) if !o.status.success() => json!({
            "removed": false,
            "error": format!("worktree remove: {}", String::from_utf8_lossy(&o.stderr).chars().take(300).collect::<String>()),
        }),
        Ok(_) => {
            let _ = Command::new("git")
                .args(["-C", base, "branch", "-D", branch])
                .output();
            let _ = conn.execute(
                "UPDATE worktrees SET status='removed' WHERE id=?",
                params![row["id"].as_i64().unwrap_or(0)],
            );
            json!({"removed": true, "branch_deleted": true})
        }
    }
}

pub fn tool_list_worktrees(args: &Value) -> Result<Value, String> {
    let status = args["status"].as_str().unwrap_or("active");
    with_db(|conn| {
        let sql = if status == "all" {
            "SELECT id, task_id, path, branch, base, status, created_at FROM worktrees ORDER BY id DESC".to_string()
        } else {
            format!(
                "SELECT id, task_id, path, branch, base, status, created_at FROM worktrees WHERE status='{}' ORDER BY id DESC",
                status.replace('\'', "''")
            )
        };
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows: Vec<Value> = stmt
            .query_map([], |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?,
                    "task_id": r.get::<_, String>(1)?,
                    "path": r.get::<_, String>(2)?,
                    "branch": r.get::<_, String>(3)?,
                    "base": r.get::<_, String>(4)?,
                    "status": r.get::<_, String>(5)?,
                    "created_at": r.get::<_, Option<String>>(6)?,
                }))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(json!(rows))
    })
}

pub fn tool_worktree_cleanup(args: &Value) -> Result<Value, String> {
    with_db(|conn| {
        let mut results = Vec::new();
        if args["all"].as_bool().unwrap_or(false) {
            let mut stmt = conn
                .prepare("SELECT id, task_id, path, branch, base, status FROM worktrees WHERE status='active'")
                .map_err(|e| e.to_string())?;
            let rows: Vec<Value> = stmt
                .query_map([], |r| {
                    Ok(json!({
                        "id": r.get::<_, i64>(0)?, "task_id": r.get::<_, String>(1)?,
                        "path": r.get::<_, String>(2)?, "branch": r.get::<_, String>(3)?,
                        "base": r.get::<_, String>(4)?,
                    }))
                })
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();
            for row in rows {
                results.push(json!({"task_id": row["task_id"], "result": remove_worktree(conn, &row)}));
            }
        } else {
            let tid = arg_task_id(args).map_err(|_| "task_id ou all=true requis".to_string())?;
            let row: Option<Value> = conn
                .query_row(
                    "SELECT id, task_id, path, branch, base FROM worktrees WHERE task_id=? AND status='active'",
                    params![tid],
                    |r| {
                        Ok(json!({
                            "id": r.get::<_, i64>(0)?, "task_id": r.get::<_, String>(1)?,
                            "path": r.get::<_, String>(2)?, "branch": r.get::<_, String>(3)?,
                            "base": r.get::<_, String>(4)?,
                        }))
                    },
                )
                .ok();
            match row {
                Some(r) => results.push(json!({"task_id": tid, "result": remove_worktree(conn, &r)})),
                None => return Ok(json!({"results": [], "note": "aucun worktree actif"})),
            }
        }
        Ok(json!({"results": results}))
    })
}

// ===================== dispatch_task =====================

pub async fn tool_dispatch_task(args: &Value) -> Result<Value, String> {
    let title = args["title"].as_str().ok_or("title requis")?;
    let task_type = args["task_type"].as_str().unwrap_or("code");
    let context = args["context"].as_str().unwrap_or("");
    let files = args["files"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>().join(", "))
        .unwrap_or_default();
    let priority = args["priority"].as_str().unwrap_or("medium");
    let session = args["session"].as_str().unwrap_or("");
    let workspace = args["workspace"].as_str();
    let worktree = args["worktree"].as_bool().unwrap_or(false);
    let force_agent = args["agent_name"].as_str();
    let force_provider = args["provider"].as_str();
    let force_model = args["model"].as_str();

    let available = available_models(false).await;

    with_db(|conn| {
        // 1. Agent
        let agent = match force_agent {
            Some(name) => find_agent(conn, name),
            None => pick_agent_by_skill(conn, task_type),
        };
        let Some(agent) = agent else {
            return Err(format!("aucun agent actif pour task_type '{}'", task_type));
        };
        let agent_name = agent["agent_name"].as_str().unwrap_or("").to_string();
        let acfg = agent_cfg(&agent);

        // 2. Modèle (router unifié)
        let picked = pick_model(conn, &acfg, &available, force_provider, force_model);
        let (model, provider) = picked
            .as_ref()
            .map(|p| {
                (
                    p["model"].as_str().unwrap_or("").to_string(),
                    p["provider"].as_str().unwrap_or("").to_string(),
                )
            })
            .unwrap_or_default();

        // 3. Tâche
        let mut vars = Map::new();
        vars.insert("task".into(), json!(title));
        vars.insert("context".into(), json!(context));
        vars.insert("files".into(), json!(files));
        vars.insert("model".into(), json!(model));
        vars.insert("provider".into(), json!(provider));
        let (prompt, tpl_used) = render_template(conn, task_type, &vars);

        conn.execute(
            "INSERT INTO tasks_todo (title, description, priority, status, created_at, dependencies, assigned_to, task_type, model, provider, dispatcher) \
             VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            params![
                title, context, priority, "pending", now_iso(), "[]",
                agent["id"].as_i64().unwrap_or(0), task_type, model, provider, session
            ],
        )
        .map_err(|e| e.to_string())?;
        let task_id = conn.last_insert_rowid();

        // 4. Worktree isolé optionnel
        let mut ws = workspace.map(String::from);
        let mut wt_info = Value::Null;
        if worktree {
            let base = workspace.unwrap_or(".").to_string();
            match create_worktree(conn, &base, task_id) {
                Ok(w) => {
                    ws = Some(w["path"].as_str().unwrap_or(&base).to_string());
                    wt_info = w;
                }
                Err(e) => {
                    log_event(conn, &task_id.to_string(), "worktree_error", &e);
                    wt_info = json!({"error": e});
                }
            }
        }

        // 5. Notify (spawn CLI)
        let notify = notify_agent(
            conn, task_id, title, agent["id"].as_i64(), &model, &provider,
            ws.as_deref(), Some(&prompt),
        )?;

        conn.execute(
            "UPDATE tasks_todo SET status='in_progress' WHERE id=?",
            params![task_id],
        )
        .map_err(|e| e.to_string())?;
        log_event(conn, &task_id.to_string(), "assigned",
                  &format!("agent={} model={} provider={} template={}", agent_name, model, provider, tpl_used));

        Ok(json!({
            "task_id": task_id,
            "agent": agent_name,
            "model": model,
            "provider": provider,
            "template_used": tpl_used,
            "workspace": ws,
            "worktree": wt_info,
            "notify": notify,
        }))
    })
}

pub fn tool_suggest_agent(args: &Value) -> Result<Value, String> {
    let task_type = args["task_type"].as_str().ok_or("task_type requis")?;
    with_db(|conn| {
        match pick_agent_by_skill(conn, task_type) {
            Some(a) => Ok(json!({
                "found": true,
                "agent_name": a["agent_name"],
                "id": a["id"],
                "skills": agent_cfg(&a)["skills"],
            })),
            None => Ok(json!({"found": false, "task_type": task_type})),
        }
    })
}

/// Enregistre un probe de santé modèle (remplace la tâche model-discovery).
pub fn record_model_health(
    conn: &Connection,
    supplier: &str,
    provider: &str,
    model: &str,
    available: bool,
    latency_ms: i64,
) {
    let _ = conn.execute(
        "INSERT INTO model_health (supplier, provider, model, available, latency_ms, checked_at) VALUES (?,?,?,?,?,?)",
        params![supplier, provider, model, available as i64, latency_ms, now_iso().replace('T', " ").trim_end_matches('Z').to_string()],
    );
}
