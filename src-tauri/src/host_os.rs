use anyhow::{Context, Result};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::{io::Read, path::Path};
use tauri::State;
use uuid::Uuid;

use crate::{AppState, CommandResult, error, storage::{self, LocalHost}};

#[derive(Serialize, Deserialize)]
struct Observation {
    address: String,
    port: u16,
    username: String,
    os: String,
}

fn parse_os(output: &str) -> Option<String> {
    let mut lines = output.lines();
    let uname = lines.next()?.trim();
    let system = uname.split_whitespace().next()?;
    if !["Linux", "Darwin", "FreeBSD", "OpenBSD", "NetBSD", "SunOS"].contains(&system) {
        return None;
    }
    let pretty = lines.find_map(|line| {
        let value = line.strip_prefix("PRETTY_NAME=")?.trim();
        if value.starts_with('"') {
            serde_json::from_str::<String>(value).ok()
        } else {
            Some(value.trim_matches('\'').to_owned())
        }
    });
    let name = pretty.filter(|value| !value.trim().is_empty()).unwrap_or_else(|| uname.to_owned());
    let clean: String = name.chars().filter(|ch| !ch.is_control()).take(160).collect();
    (!clean.trim().is_empty()).then_some(clean)
}

pub(crate) fn collect(host: &LocalHost, known_hosts: &Path, database: &Path) -> Result<()> {
    let session = crate::ssh::connect_session_silent(host, known_hosts)?;
    let mut channel = session.channel_session()?;
    channel.exec("uname -srm; cat /etc/os-release 2>/dev/null")?;
    let mut output = String::new();
    channel.by_ref().take(8192).read_to_string(&mut output)?;
    let os = parse_os(&output).context("远程主机未返回可识别的操作系统")?;
    let id = host.id.context("主机缺少 ID")?;
    let observation = Observation {
        address: host.address.clone(), port: host.port, username: host.username.clone(), os,
    };
    let db = storage::open(database)?;
    db.execute(
        "INSERT INTO settings(key,value) SELECT ?1,?2 WHERE EXISTS (SELECT 1 FROM local_hosts WHERE id=?3 AND address=?4 AND port=?5 AND username=?6) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![format!("host_os:{id}"), serde_json::to_string(&observation)?, id.to_string(), host.address, host.port, host.username],
    )?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn host_os_get(state: State<'_, AppState>, id: Uuid) -> CommandResult<Option<String>> {
    let database = state.database.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<Option<String>> {
        let db = storage::open(&database)?;
        let row: Option<(String, String, u16, String)> = db.query_row(
            "SELECT s.value,h.address,h.port,h.username FROM settings s JOIN local_hosts h ON h.id=?1 WHERE s.key=?2",
            params![id.to_string(), format!("host_os:{id}")],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).optional()?;
        Ok(row.and_then(|(value, address, port, username)| {
            let observation: Observation = serde_json::from_str(&value).ok()?;
            (observation.address == address && observation.port == port && observation.username == username)
                .then_some(observation.os)
        }))
    }).await.map_err(error)?.map_err(error)
}
