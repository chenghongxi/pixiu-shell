use crate::{AppState, CommandResult, error, storage};
use anyhow::{Result, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::State;
use uuid::Uuid;

const MAX_HISTORY_ENTRIES: usize = 1000;
const DEFAULT_LIST_LIMIT: usize = 200;
const MAX_LIST_LIMIT: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommandHistoryEntry {
    pub id: Uuid,
    pub scope: String,
    pub host_name: String,
    pub host_address: String,
    pub command: String,
    pub use_count: i64,
    pub last_used_at: i64,
}

fn validate_record(scope: &str, host_name: &str, host_address: &str, command: &str) -> Result<String> {
    let scope = scope.trim();
    ensure!(!scope.is_empty() && scope.len() <= 256, "命令历史作用域无效");
    ensure!(host_name.len() <= 512, "主机名称过长");
    ensure!(host_address.len() <= 512, "主机地址过长");
    let command = command.trim();
    ensure!(
        !command.is_empty() && command.len() <= 4000,
        "命令不能为空且不能超过 4000 字符"
    );
    ensure!(
        !command.chars().any(char::is_control),
        "历史命令不能包含控制字符"
    );
    Ok(command.to_string())
}

pub(crate) fn record_entry(
    db: &Connection,
    scope: &str,
    host_name: &str,
    host_address: &str,
    command: &str,
) -> Result<()> {
    let command = validate_record(scope, host_name, host_address, command)?;
    let scope = scope.trim();
    let id = Uuid::new_v4().to_string();
    db.execute(
        "INSERT INTO command_history(id, scope, host_name, host_address, command, use_count, last_used_at)
         VALUES(?1, ?2, ?3, ?4, ?5, 1, unixepoch())
         ON CONFLICT(scope, command) DO UPDATE SET
           host_name = excluded.host_name,
           host_address = excluded.host_address,
           use_count = command_history.use_count + 1,
           last_used_at = unixepoch()",
        params![id, scope, host_name, host_address, command],
    )?;
    db.execute(
        "DELETE FROM command_history WHERE id NOT IN (
            SELECT id FROM command_history ORDER BY last_used_at DESC, rowid DESC LIMIT ?1
        )",
        [MAX_HISTORY_ENTRIES as i64],
    )?;
    Ok(())
}

pub(crate) fn list_entries(
    db: &Connection,
    scope: Option<&str>,
    query: Option<&str>,
    limit: Option<u32>,
) -> Result<Vec<CommandHistoryEntry>> {
    let limit = limit
        .map(|value| (value as usize).clamp(1, MAX_LIST_LIMIT))
        .unwrap_or(DEFAULT_LIST_LIMIT);
    let needle = query
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_lowercase);
    let scope = scope.map(str::trim).filter(|value| !value.is_empty());

    let mut items = Vec::new();
    if let Some(scope) = scope {
        let mut stmt = db.prepare(
            "SELECT id, scope, host_name, host_address, command, use_count, last_used_at
             FROM command_history
             WHERE scope = ?1
             ORDER BY last_used_at DESC, rowid DESC",
        )?;
        let rows = stmt.query_map([scope], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
            ))
        })?;
        for row in rows {
            let (id, scope, host_name, host_address, command, use_count, last_used_at) = row?;
            if let Some(ref filter) = needle
                && !command.to_lowercase().contains(filter)
            {
                continue;
            }
            items.push(CommandHistoryEntry {
                id: Uuid::parse_str(&id)?,
                scope,
                host_name,
                host_address,
                command,
                use_count,
                last_used_at,
            });
            if items.len() >= limit {
                break;
            }
        }
        return Ok(items);
    }

    let mut stmt = db.prepare(
        "SELECT id, scope, host_name, host_address, command, use_count, last_used_at
         FROM command_history
         ORDER BY last_used_at DESC, rowid DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, i64>(5)?,
            row.get::<_, i64>(6)?,
        ))
    })?;
    let mut seen: HashMap<String, usize> = HashMap::new();
    for row in rows {
        let (id, scope, host_name, host_address, command, use_count, last_used_at) = row?;
        if let Some(ref filter) = needle
            && !command.to_lowercase().contains(filter)
            && !host_name.to_lowercase().contains(filter)
            && !host_address.to_lowercase().contains(filter)
        {
            continue;
        }
        if let Some(&index) = seen.get(&command) {
            items[index].use_count += use_count;
            continue;
        }
        seen.insert(command.clone(), items.len());
        items.push(CommandHistoryEntry {
            id: Uuid::parse_str(&id)?,
            scope,
            host_name,
            host_address,
            command,
            use_count,
            last_used_at,
        });
    }
    items.truncate(limit);
    Ok(items)
}

pub(crate) fn delete_entry(db: &Connection, id: Uuid, all_scopes: bool) -> Result<()> {
    if all_scopes {
        let command: Option<String> = db
            .query_row(
                "SELECT command FROM command_history WHERE id = ?1",
                [id.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(command) = command {
            db.execute("DELETE FROM command_history WHERE command = ?1", [command])?;
            return Ok(());
        }
    }
    db.execute("DELETE FROM command_history WHERE id = ?1", [id.to_string()])?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn command_history_list(
    state: State<'_, AppState>,
    scope: Option<String>,
    query: Option<String>,
    limit: Option<u32>,
) -> CommandResult<Vec<CommandHistoryEntry>> {
    let path = state.database.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<_> {
        let db = storage::open(&path)?;
        list_entries(&db, scope.as_deref(), query.as_deref(), limit)
    })
    .await
    .map_err(error)?
    .map_err(error)
}

#[tauri::command]
pub(crate) async fn command_history_record(
    state: State<'_, AppState>,
    scope: String,
    host_name: String,
    host_address: String,
    command: String,
) -> CommandResult<()> {
    let path = state.database.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let db = storage::open(&path)?;
        record_entry(&db, &scope, &host_name, &host_address, &command)
    })
    .await
    .map_err(error)?
    .map_err(error)
}

#[tauri::command]
pub(crate) async fn command_history_delete(
    state: State<'_, AppState>,
    id: Uuid,
    all_scopes: Option<bool>,
) -> CommandResult<()> {
    let path = state.database.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let db = storage::open(&path)?;
        delete_entry(&db, id, all_scopes.unwrap_or(false))
    })
    .await
    .map_err(error)?
    .map_err(error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_deduplicates_and_merges_across_scopes() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let db = storage::open(&dir.path().join("command-history.db"))?;

        record_entry(&db, "local:1", "node-a", "10.0.0.1", "docker ps")?;
        record_entry(&db, "local:1", "node-a", "10.0.0.1", "docker ps")?;
        record_entry(&db, "local:2", "node-b", "10.0.0.2", "docker ps")?;
        record_entry(&db, "local:1", "node-a", "10.0.0.1", "systemctl status nginx")?;

        let host_one = list_entries(&db, Some("local:1"), None, None)?;
        assert_eq!(host_one.len(), 2);
        assert_eq!(host_one[0].command, "systemctl status nginx");
        assert_eq!(host_one[1].command, "docker ps");
        assert_eq!(host_one[1].use_count, 2);

        let all = list_entries(&db, None, Some("docker"), None)?;
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].command, "docker ps");
        assert_eq!(all[0].use_count, 3);

        delete_entry(&db, all[0].id, true)?;
        assert!(list_entries(&db, None, Some("docker"), None)?.is_empty());
        assert_eq!(list_entries(&db, None, None, None)?.len(), 1);
        Ok(())
    }

    #[test]
    fn rejects_empty_or_control_commands() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let db = storage::open(&dir.path().join("command-history-invalid.db"))?;
        assert!(record_entry(&db, "local:1", "node", "10.0.0.1", "   ").is_err());
        assert!(record_entry(&db, "local:1", "node", "10.0.0.1", "ls\nrm -rf /").is_err());
        assert!(record_entry(&db, "local:1", "node", "10.0.0.1", "ls\u{0003}").is_err());
        Ok(())
    }
}
