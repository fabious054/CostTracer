//! Silent scan for existing AWS configuration: `~/.aws/credentials`, `~/.aws/config`, and the
//! standard environment variables. Read-only; never mutates anything on disk.

use std::path::PathBuf;

use crate::model::DetectedConfig;

fn aws_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".aws"))
}

fn env_has_credentials() -> bool {
    std::env::var_os("AWS_ACCESS_KEY_ID").is_some()
        && std::env::var_os("AWS_SECRET_ACCESS_KEY").is_some()
}

/// Section headers in an ini file: `[name]` in `credentials`, `[profile name]` / `[default]` in `config`.
fn parse_profiles(contents: &str) -> Vec<String> {
    contents
        .lines()
        .map(str::trim)
        .filter_map(|line| line.strip_prefix('[').and_then(|l| l.strip_suffix(']')))
        .map(|section| section.strip_prefix("profile ").unwrap_or(section).trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// `region = ...` inside the `[default]` section of the config file.
fn default_region_from_config(contents: &str) -> Option<String> {
    let mut in_default = false;
    for raw in contents.lines() {
        let line = raw.trim();
        if let Some(section) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            let name = section.strip_prefix("profile ").unwrap_or(section).trim();
            in_default = name == "default";
            continue;
        }
        if in_default {
            if let Some((key, value)) = line.split_once('=') {
                if key.trim() == "region" {
                    let v = value.trim().to_string();
                    if !v.is_empty() {
                        return Some(v);
                    }
                }
            }
        }
    }
    None
}

pub fn detect() -> DetectedConfig {
    let dir = aws_dir();
    let credentials_path = dir.as_ref().map(|d| d.join("credentials"));
    let config_path = dir.as_ref().map(|d| d.join("config"));

    let credentials_contents = credentials_path
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok());
    let config_contents = config_path
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok());

    let mut profiles: Vec<String> = Vec::new();
    for source in [&credentials_contents, &config_contents].into_iter().flatten() {
        for name in parse_profiles(source) {
            if !profiles.contains(&name) {
                profiles.push(name);
            }
        }
    }

    let default_region = config_contents
        .as_deref()
        .and_then(default_region_from_config)
        .or_else(|| std::env::var("AWS_REGION").ok().filter(|s| !s.is_empty()))
        .or_else(|| std::env::var("AWS_DEFAULT_REGION").ok().filter(|s| !s.is_empty()));

    DetectedConfig {
        has_env_credentials: env_has_credentials(),
        has_shared_credentials_file: credentials_contents.is_some(),
        has_config_file: config_contents.is_some(),
        profiles,
        default_region,
    }
}
