//! Access policy implementation (.mcp-access and EVERYTHING_MCP_ROOTS allowlist)

use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use regex::Regex;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum PolicyError {
    #[error("path outside allowed roots: {0}")]
    OutsideRoots(String),
    #[error("agent '{agent}': {op} denied by .mcp-access: {path}")]
    AccessDenied {
        agent: String,
        op: &'static str,
        path: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleAction {
    Allow,
    Read,
    Write,
    DenyWrite,
    Deny,
}

#[derive(Debug, Clone)]
pub struct Rule {
    pub action: RuleAction,
    pub pattern: String,
    pub regex: Regex,
}

#[derive(Debug, Clone)]
pub struct AccessPolicy {
    pub allowed_roots: Vec<PathBuf>,
    pub access_file: PathBuf,
    pub profile: String,
    pub profiles_rules: HashMap<String, Vec<Rule>>,
}

impl Default for AccessPolicy {
    fn default() -> Self {
        Self::load()
    }
}

impl AccessPolicy {
    pub fn load() -> Self {
        let roots_raw = env::var("EVERYTHING_MCP_ROOTS").unwrap_or_default();
        let allowed_roots: Vec<PathBuf> = roots_raw
            .split(';')
            .filter(|s| !s.trim().is_empty())
            .map(|s| PathBuf::from(s.trim()))
            .collect();

        let access_file = env::var("EVERYTHING_MCP_ACCESS_FILE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(".mcp-access"));

        let profile = env::var("EVERYTHING_MCP_AGENT")
            .unwrap_or_else(|_| "default".to_string());
        let profile = if profile.trim().is_empty() {
            "default".to_string()
        } else {
            profile.trim().to_string()
        };

        let mut policy = Self {
            allowed_roots,
            access_file: access_file.clone(),
            profile,
            profiles_rules: HashMap::new(),
        };

        policy.parse_access_file(&access_file);
        policy
    }

    fn parse_access_file(&mut self, path: &Path) {
        let content = match fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => return,
        };

        let mut current_profile = None;

        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }

            if line.starts_with('[') && line.ends_with(']') {
                let inner = &line[1..line.len() - 1].trim();
                let prof = if let Some(stripped) = inner.strip_prefix("profile:") {
                    stripped.trim()
                } else {
                    inner
                };
                current_profile = Some(prof.to_string());
                self.profiles_rules.entry(prof.to_string()).or_default();
                continue;
            }

            if let Some(prof) = &current_profile {
                if let Some((action_str, pat_str)) = line.split_once(':') {
                    let action = match action_str.trim().to_lowercase().as_str() {
                        "allow" => RuleAction::Allow,
                        "read" => RuleAction::Read,
                        "write" => RuleAction::Write,
                        "deny-write" => RuleAction::DenyWrite,
                        "deny" => RuleAction::Deny,
                        _ => continue,
                    };
                    let pat_norm = pat_str.trim().replace('\\', "/").to_lowercase();
                    if let Ok(re) = glob_to_regex(&pat_norm) {
                        self.profiles_rules
                            .entry(prof.clone())
                            .or_default()
                            .push(Rule {
                                action,
                                pattern: pat_norm,
                                regex: re,
                            });
                    }
                }
            }
        }
    }

    pub fn check_allowed(&self, path: &Path, write: bool) -> Result<PathBuf, PolicyError> {
        let abs = match fs::canonicalize(path) {
            Ok(p) => p,
            Err(_) => {
                if path.is_absolute() {
                    path.to_path_buf()
                } else if let Ok(cwd) = env::current_dir() {
                    cwd.join(path)
                } else {
                    path.to_path_buf()
                }
            }
        };

        let abs_str = abs.to_string_lossy();
        let clean_path = strip_unc_prefix(&abs_str);

        // 1. Allowed roots check
        if !self.allowed_roots.is_empty() {
            let path_norm = clean_path.replace('\\', "/").to_lowercase();
            let mut inside = false;
            for r in &self.allowed_roots {
                let r_norm = r.to_string_lossy().replace('\\', "/").to_lowercase();
                if path_norm == r_norm || path_norm.starts_with(&format!("{}/", r_norm.trim_end_matches('/'))) {
                    inside = true;
                    break;
                }
            }
            if !inside {
                return Err(PolicyError::OutsideRoots(clean_path.to_string()));
            }
        }

        // 2. .mcp-access check
        if !self.is_path_allowed(&clean_path, write) {
            return Err(PolicyError::AccessDenied {
                agent: self.profile.clone(),
                op: if write { "write" } else { "read" },
                path: clean_path.to_string(),
            });
        }

        Ok(PathBuf::from(clean_path))
    }

    pub fn is_path_allowed(&self, path_str: &str, write: bool) -> bool {
        let rules = self
            .profiles_rules
            .get(&self.profile)
            .or_else(|| self.profiles_rules.get("default"));

        let rules = match rules {
            Some(r) if !r.is_empty() => r,
            _ => return true, // No rules = unrestricted
        };

        let np = path_str.replace('\\', "/").to_lowercase();
        let mut grant = false;

        for rule in rules {
            if rule.regex.is_match(&np) {
                match rule.action {
                    RuleAction::Deny => grant = false,
                    RuleAction::DenyWrite => {
                        if write {
                            grant = false;
                        }
                    }
                    RuleAction::Read => {
                        if !write {
                            grant = true;
                        }
                    }
                    RuleAction::Write | RuleAction::Allow => {
                        grant = true;
                    }
                }
            }
        }

        grant
    }

    pub fn filter_paths(&self, paths: &[String]) -> Vec<String> {
        paths
            .iter()
            .filter(|p| self.is_path_allowed(p, false))
            .cloned()
            .collect()
    }
}

pub fn strip_unc_prefix(p: &str) -> &str {
    if let Some(stripped) = p.strip_prefix(r"\\?\") {
        stripped
    } else {
        p
    }
}

/// Convert a glob pattern like `**/*.pem` or `c:/foo/**` to a Regex
fn glob_to_regex(pat: &str) -> Result<Regex, regex::Error> {
    let mut re = String::with_capacity(pat.len() * 2 + 10);
    re.push('^');

    let chars: Vec<char> = pat.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '*' {
            if i + 1 < chars.len() && chars[i + 1] == '*' {
                // **
                re.push_str(".*");
                i += 2;
                if i < chars.len() && chars[i] == '/' {
                    // **/ matches / or empty prefix
                    i += 1;
                }
            } else {
                // * matches any character except /
                re.push_str("[^/]*");
                i += 1;
            }
        } else if chars[i] == '?' {
            re.push_str("[^/]");
            i += 1;
        } else {
            let c = chars[i];
            if ".+^$()[]{}|\\".contains(c) {
                re.push('\\');
            }
            re.push(c);
            i += 1;
        }
    }

    re.push('$');
    Regex::new(&re)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_glob_matching() {
        let re1 = glob_to_regex("**").unwrap();
        assert!(re1.is_match("c:/anything/test.txt"));

        let re2 = glob_to_regex("**/*.pem").unwrap();
        assert!(re2.is_match("c:/path/secret.pem"));
        assert!(!re2.is_match("c:/path/secret.txt"));

        let re3 = glob_to_regex("c:/program files/servers/**").unwrap();
        assert!(re3.is_match("c:/program files/servers/everything-mcp/file.rs"));
    }
}
