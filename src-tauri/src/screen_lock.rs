use crate::{AppState, CommandResult, error};
use anyhow::{Context, Result, anyhow, ensure};
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use rand_core::OsRng;
use rusqlite::OptionalExtension;
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tauri::State;
use zeroize::Zeroizing;
const ACCOUNT: &str = "__tshell_screen_lock";
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LockStatus {
    pub configured: bool,
    pub locked: bool,
}
#[derive(Default)]
struct Attempts {
    count: u32,
    retry_at: Option<Instant>,
}
pub(crate) struct ScreenLock {
    database: PathBuf,
    configured: AtomicBool,
    locked: AtomicBool,
    attempts: Mutex<Attempts>,
    store: Arc<dyn crate::auth_store::AuthStore>,
}
impl ScreenLock {
    pub fn new(database: &Path) -> Result<Self> {
        let db = crate::storage::open(database)?;
        let read = |key: &str| -> Result<bool> {
            Ok(db
                .query_row("SELECT value FROM settings WHERE key=?1", [key], |row| {
                    row.get::<_, String>(0)
                })
                .optional()?
                .as_deref()
                == Some("true"))
        };
        let configured = read("lock_configured")?;
        Ok(Self {
            database: database.to_path_buf(),
            configured: AtomicBool::new(configured),
            locked: AtomicBool::new(configured && read("screen_locked")?),
            attempts: Mutex::new(Attempts::default()),
            store: Arc::new(crate::auth_store::KeychainStore),
        })
    }
    pub fn status(&self) -> LockStatus {
        LockStatus {
            configured: self.configured.load(Ordering::SeqCst),
            locked: self.locked.load(Ordering::SeqCst),
        }
    }
    pub fn ensure_unlocked(&self) -> Result<()> {
        ensure!(!self.status().locked, "应用已锁定，请先解锁");
        Ok(())
    }
    pub fn command_allowed(&self, name: &str) -> bool {
        !self.status().locked
            || matches!(
                name,
                "lock_status"
                    | "screen_unlock"
                    | "preferences_load"
                    | "workspace_restore"
                    | "ai_cancel"
                    | "terminal_close"
                    | "dingtalk_close"
                    | "system_shell_info"
            )
    }
    fn persist(&self, key: &str, value: bool) -> Result<()> {
        crate::storage::open(&self.database)?.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[key,if value{"true"}else{"false"}])?;
        Ok(())
    }
    pub fn lock(&self) -> Result<LockStatus> {
        ensure!(self.status().configured, "请先在安全设置中设置锁屏密码");
        self.persist("screen_locked", true)?;
        self.locked.store(true, Ordering::SeqCst);
        Ok(self.status())
    }
    fn verify(&self, password: &str) -> Result<()> {
        let mut attempts = self
            .attempts
            .lock()
            .map_err(|_| anyhow!("锁屏状态不可用"))?;
        if let Some(at) = attempts.retry_at {
            ensure!(Instant::now() >= at, "请稍后再试");
        }
        let hash = self
            .store
            .read(ACCOUNT)?
            .context("锁屏凭据不可用，请检查系统凭据库")?;
        let parsed = PasswordHash::new(&hash).map_err(|_| anyhow!("锁屏凭据格式无效"))?;
        if Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_err()
        {
            attempts.count += 1;
            attempts.retry_at =
                Some(Instant::now() + Duration::from_secs(u64::from(attempts.count.min(30))));
            return Err(anyhow!("解锁密码错误"));
        }
        attempts.count = 0;
        attempts.retry_at = None;
        Ok(())
    }
    pub fn unlock(&self, password: &str) -> Result<LockStatus> {
        self.verify(password)?;
        self.persist("screen_locked", false)?;
        self.locked.store(false, Ordering::SeqCst);
        Ok(self.status())
    }
    pub fn configure(&self, current: &str, next: &str) -> Result<LockStatus> {
        self.ensure_unlocked()?;
        if self.status().configured {
            self.verify(current)?;
        }
        ensure!(
            next.is_empty() || (next.chars().count() >= 6 && next.len() <= 512),
            "锁屏密码至少 6 个字符，最长 512 字节"
        );
        if next.is_empty() {
            self.store.delete(ACCOUNT)?;
            self.persist("lock_configured", false)?;
            self.configured.store(false, Ordering::SeqCst);
        } else {
            let salt = SaltString::generate(&mut OsRng);
            let hash = Argon2::default()
                .hash_password(next.as_bytes(), &salt)
                .map_err(|_| anyhow!("生成锁屏凭据失败"))?
                .to_string();
            self.store.write(ACCOUNT, &hash)?;
            self.persist("lock_configured", true)?;
            self.configured.store(true, Ordering::SeqCst);
        }
        Ok(self.status())
    }
}
// Geometry updates carry no keystrokes and must continue while the screen is hidden.
pub(crate) fn resize_only(command: &str, payload: &serde_json::Value) -> bool {
    command == "terminal_input"
        && payload["input"]["type"] == "resize"
        && payload["input"].get("data").is_none()
        && ["cols", "rows"].iter().all(|key| {
            payload["input"][key]
                .as_u64()
                .is_some_and(|size| (1..=65535).contains(&size))
        })
}
#[tauri::command]
pub(crate) fn lock_status(state: State<'_, AppState>) -> LockStatus {
    state.screen_lock.status()
}
#[tauri::command]
pub(crate) async fn screen_lock(state: State<'_, AppState>) -> CommandResult<LockStatus> {
    let gate = Arc::clone(&state.screen_lock);
    let status = tokio::task::spawn_blocking(move || gate.lock())
        .await
        .map_err(error)?
        .map_err(error)?;
    state.ai.cancel_all();
    Ok(status)
}
#[tauri::command]
pub(crate) async fn screen_unlock(
    state: State<'_, AppState>,
    password: String,
) -> CommandResult<LockStatus> {
    let gate = Arc::clone(&state.screen_lock);
    let password = Zeroizing::new(password);
    tokio::task::spawn_blocking(move || gate.unlock(&password))
        .await
        .map_err(error)?
        .map_err(error)
}
#[tauri::command]
pub(crate) async fn lock_configure(
    state: State<'_, AppState>,
    current_password: String,
    new_password: String,
) -> CommandResult<LockStatus> {
    let gate = Arc::clone(&state.screen_lock);
    let current = Zeroizing::new(current_password);
    let next = Zeroizing::new(new_password);
    tokio::task::spawn_blocking(move || gate.configure(&current, &next))
        .await
        .map_err(error)?
        .map_err(error)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lock_survives_recreation_and_denies_native_operations_until_password_verified() -> Result<()>
    {
        let dir = tempfile::tempdir()?;
        let db = dir.path().join("lock.db");
        let store = Arc::new(crate::auth_store::MemoryStore::default());
        let mut gate = ScreenLock::new(&db)?;
        gate.store = store.clone();
        gate.configure("", "test-password")?;
        gate.lock()?;
        for command in [
            "terminal_open",
            "terminal_input",
            "platform_request",
            "local_hosts",
            "save_host",
            "lock_configure",
        ] {
            assert!(!gate.command_allowed(command));
        }
        assert!(gate.command_allowed("screen_unlock"));
        assert!(resize_only(
            "terminal_input",
            &serde_json::json!({"input":{"type":"resize","cols":80,"rows":24}})
        ));
        assert!(!resize_only(
            "terminal_input",
            &serde_json::json!({"input":{"type":"input","data":"whoami\r"}})
        ));
        assert!(!resize_only(
            "terminal_input",
            &serde_json::json!({"input":{"type":"resize","cols":80,"rows":24,"data":"injected"}})
        ));

        drop(gate);
        let mut restored = ScreenLock::new(&db)?;
        restored.store = store;
        assert!(restored.status().locked);
        assert!(restored.unlock("incorrect").is_err());
        assert!(restored.status().locked);
        assert!(restored.unlock("test-password").is_err());
        std::thread::sleep(Duration::from_millis(1100));
        restored.unlock("test-password")?;
        assert!(restored.command_allowed("terminal_input"));
        let raw = crate::storage::open(&db)?.query_row(
            "SELECT group_concat(value) FROM settings",
            [],
            |row| row.get::<_, String>(0),
        )?;
        assert!(!raw.contains("test-password"));
        Ok(())
    }
}
