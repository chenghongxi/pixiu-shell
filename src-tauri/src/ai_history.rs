use crate::{AppState, CommandResult, error, storage};
use anyhow::{Result, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;
use uuid::Uuid;

const RETENTION_KEY: &str = "ai_history_retention_days";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Conversation {
    id: Uuid,
    target: Option<Value>,
    host_name: String,
    title: String,
    messages: Value,
    updated_at: i64,
}

fn retention(db: &Connection) -> Result<u32> {
    let value: Option<String> = db
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            [RETENTION_KEY],
            |row| row.get(0),
        )
        .optional()?;
    Ok(value
        .and_then(|v| v.parse::<u32>().ok())
        .filter(|v| (1..=365).contains(v))
        .unwrap_or(30))
}

fn cleanup(db: &Connection) -> Result<()> {
    let days = retention(db)?;
    db.execute(
        "DELETE FROM ai_conversations WHERE updated_at < unixepoch() - ?1 * 86400",
        [days],
    )?;
    Ok(())
}

fn validate(item: &Conversation) -> Result<()> {
    ensure!(
        !item.title.trim().is_empty() && item.title.len() <= 512,
        "会话标题无效"
    );
    ensure!(item.host_name.len() <= 512, "主机名称过长");
    ensure!(item.messages.is_array(), "会话内容无效");
    ensure!(
        serde_json::to_vec(&item.messages)?.len() <= 4 * 1024 * 1024,
        "会话内容超过 4 MB"
    );
    ensure!(
        item.target.as_ref().is_none_or(Value::is_object),
        "会话主机无效"
    );
    Ok(())
}

#[tauri::command]
pub(crate) async fn ai_history_list(
    state: State<'_, AppState>,
) -> CommandResult<(u32, Vec<Conversation>)> {
    let path = state.database.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<_> {
        let db = storage::open(&path)?;
        cleanup(&db)?;
        let days = retention(&db)?;
        let mut stmt = db.prepare("SELECT id,target,host_name,title,messages,updated_at FROM ai_conversations ORDER BY updated_at DESC, id")?;
        let rows = stmt.query_map([], |row| Ok((
            row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?,
            row.get::<_, String>(2)?, row.get::<_, String>(3)?,
            row.get::<_, String>(4)?, row.get::<_, i64>(5)?,
        )))?;
        let mut items = Vec::new();
        for row in rows {
            let (id, target, host_name, title, messages, updated_at) = row?;
            items.push(Conversation {
                id: Uuid::parse_str(&id)?,
                target: target.map(|v| serde_json::from_str(&v)).transpose()?,
                host_name, title, messages: serde_json::from_str(&messages)?, updated_at,
            });
        }
        Ok((days, items))
    }).await.map_err(error)?.map_err(error)
}

#[tauri::command]
pub(crate) async fn ai_history_create(
    state: State<'_, AppState>,
    item: Conversation,
) -> CommandResult<()> {
    validate(&item).map_err(error)?;
    let path = state.database.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let db = storage::open(&path)?;
        cleanup(&db)?;
        db.execute("INSERT INTO ai_conversations(id,target,host_name,title,messages,updated_at) VALUES(?1,?2,?3,?4,?5,unixepoch())",
            params![item.id.to_string(), item.target.map(|v| v.to_string()), item.host_name, item.title, item.messages.to_string()])?;
        Ok(())
    }).await.map_err(error)?.map_err(error)
}

#[tauri::command]
pub(crate) async fn ai_history_update(
    state: State<'_, AppState>,
    item: Conversation,
) -> CommandResult<bool> {
    validate(&item).map_err(error)?;
    let path = state.database.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<bool> {
        let db = storage::open(&path)?;
        Ok(db.execute(
            "UPDATE ai_conversations SET title=?1,messages=?2,updated_at=unixepoch() WHERE id=?3",
            params![item.title, item.messages.to_string(), item.id.to_string()],
        )? > 0)
    })
    .await
    .map_err(error)?
    .map_err(error)
}

#[tauri::command]
pub(crate) async fn ai_history_delete(state: State<'_, AppState>, id: Uuid) -> CommandResult<()> {
    let path = state.database.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let db = storage::open(&path)?;
        db.execute("DELETE FROM ai_conversations WHERE id=?1", [id.to_string()])?;
        Ok(())
    })
    .await
    .map_err(error)?
    .map_err(error)
}

#[tauri::command]
pub(crate) async fn ai_history_retention(
    state: State<'_, AppState>,
    days: u32,
) -> CommandResult<()> {
    if !(1..=365).contains(&days) {
        return Err("保留期限须为 1 至 365 天".into());
    }
    let path = state.database.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let mut db = storage::open(&path)?;
        let tx = db.transaction()?;
        tx.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![RETENTION_KEY, days.to_string()])?;
        cleanup(&tx)?;
        tx.commit()?;
        Ok(())
    }).await.map_err(error)?.map_err(error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expiry_uses_last_update_and_selected_retention() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let db = storage::open(&dir.path().join("history.db"))?;
        db.execute(
            "INSERT INTO ai_conversations VALUES('old',NULL,'','old','[]',unixepoch()-31*86400)",
            [],
        )?;
        db.execute(
            "INSERT INTO ai_conversations VALUES('new',NULL,'','new','[]',unixepoch()-8*86400)",
            [],
        )?;
        cleanup(&db)?;
        assert_eq!(
            db.query_row("SELECT count(*) FROM ai_conversations", [], |r| r
                .get::<_, i64>(0))?,
            1
        );
        db.execute(
            "INSERT INTO settings(key,value) VALUES(?1,'7')",
            [RETENTION_KEY],
        )?;
        cleanup(&db)?;
        assert_eq!(
            db.query_row("SELECT count(*) FROM ai_conversations", [], |r| r
                .get::<_, i64>(0))?,
            0
        );
        Ok(())
    }

    #[test]
    fn validation_limits_message_size() -> Result<()> {
        let item = Conversation {
            id: Uuid::new_v4(),
            target: None,
            host_name: String::new(),
            title: "test".into(),
            messages: serde_json::json!(["x".repeat(4 * 1024 * 1024)]),
            updated_at: 0,
        };
        assert!(validate(&item).is_err());
        Ok(())
    }
}
