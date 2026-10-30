//! Pixiu Shell desktop boundary: platform credentials stay native; local hosts stay in SQLite.

mod ai;
mod askpass_bridge;
mod auth_store;
mod commands;
mod credentials;
mod dingtalk;
mod files;
mod hostkey;
mod migrate;
mod monitor;
mod platform;
mod preferences;
mod proxy;
mod screen_lock;
mod ssh;
mod storage;
mod terminal;
mod tunnel;

use anyhow::{Context, Result};
use platform::Platform;
use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};
use tauri::{Manager, State, ipc::Channel};
use terminal::{Event, Sessions};
use tokio::sync::Mutex;
use uuid::Uuid;

struct AppState {
    screen_lock: Arc<screen_lock::ScreenLock>,
    ai: ai::AiRuns,
    dingtalk: Arc<dingtalk::LoginFlow>,
    revision: AtomicU64,
    database: PathBuf,
    known_hosts: PathBuf,
    platform: Mutex<Platform>,
    sessions: Arc<Sessions>,
    transfer_cancels: Mutex<std::collections::HashMap<Uuid, Arc<AtomicBool>>>,
    // Monitoring polls a host every few seconds, so it keeps the SSH session alive.
    monitor_sessions: Mutex<std::collections::HashMap<Uuid, ssh2::Session>>,
}

type CommandResult<T> = std::result::Result<T, String>;
fn error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[tauri::command]
async fn local_hosts(state: State<'_, AppState>) -> CommandResult<Vec<storage::LocalHost>> {
    let path = state.database.to_path_buf();
    tokio::task::spawn_blocking(move || storage::list(&storage::open(&path)?))
        .await
        .map_err(error)?
        .map_err(error)
}

#[tauri::command]
async fn save_host(
    state: State<'_, AppState>,
    mut host: storage::LocalHost,
    password: Option<String>,
    clear_password: Option<bool>,
    proxy_password: Option<String>,
    clear_proxy_password: Option<bool>,
) -> CommandResult<storage::LocalHost> {
    let path = state.database.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<storage::LocalHost> {
        host.validate()?;
        let db = storage::open(&path)?;
        let existing = storage::list(&db)?
            .into_iter()
            .find(|item| item.id == host.id && host.id.is_some());
        host.has_password = existing.as_ref().is_some_and(|item| item.has_password);
        let id = *host.id.get_or_insert_with(Uuid::new_v4);
        let password = password.map(zeroize::Zeroizing::new);
        let update = password.as_ref().is_some_and(|value| !value.is_empty())
            || clear_password == Some(true);
        let old = if update { credentials::read(id)? } else { None };
        let old_proxy = proxy::password(id)?;
        let proxy_password = proxy_password.map(zeroize::Zeroizing::new);
        let proxy_update = clear_proxy_password == Some(true)
            || proxy_password
                .as_ref()
                .is_some_and(|value| !value.is_empty());
        let saved = (|| -> Result<storage::LocalHost> {
            if clear_password == Some(true) {
                credentials::delete(id)?;
                host.has_password = false;
            } else if let Some(password) = password.as_ref().filter(|value| !value.is_empty()) {
                credentials::write(id, password)?;
                host.has_password = true;
            }
            if clear_proxy_password == Some(true) {
                proxy::set_password(id, None)?;
            } else if let Some(value) = proxy_password.as_ref().filter(|value| !value.is_empty()) {
                proxy::set_password(id, Some(value))?;
            }
            if let Some(config) = &mut host.proxy {
                config.has_password = clear_proxy_password != Some(true)
                    && (proxy_password
                        .as_ref()
                        .is_some_and(|value| !value.is_empty())
                        || old_proxy.is_some());
            }
            let host = storage::save(&db, host)?;
            // Pooled SFTP sessions were authenticated with the old settings.
            files::forget(id);
            Ok(host)
        })();
        match saved {
            Ok(host) => Ok(host),
            Err(error) => {
                if proxy_update {
                    proxy::set_password(id, old_proxy.as_deref().map(String::as_str))?;
                }
                if update {
                    match old {
                        Some(old) => credentials::write(id, &old)?,
                        None => credentials::delete(id)?,
                    }
                }
                Err(error)
            }
        }
    })
    .await
    .map_err(error)?
    .map_err(error)
}


#[tauri::command]
async fn duplicate_host(
    state: State<'_, AppState>,
    id: Uuid,
    name: String,
) -> CommandResult<storage::LocalHost> {
    let path = state.database.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<storage::LocalHost> {
        let db = storage::open(&path)?;
        let mut host = storage::list(&db)?
            .into_iter()
            .find(|item| item.id == Some(id))
            .context("主机不存在")?;
        let password = credentials::read(id)?;
        let proxy_password = proxy::password(id)?;
        host.name = name;
        host.validate()?;
        let new_id = Uuid::new_v4();
        host.id = Some(new_id);
        host.has_password = password
            .as_ref()
            .is_some_and(|value| !value.is_empty());
        if let Some(config) = &mut host.proxy {
            config.has_password = proxy_password
                .as_ref()
                .is_some_and(|value| !value.is_empty());
        }
        let saved = (|| -> Result<storage::LocalHost> {
            if let Some(password) = password.as_ref().filter(|value| !value.is_empty()) {
                credentials::write(new_id, password)?;
            }
            if host
                .proxy
                .as_ref()
                .is_some_and(|config| config.has_password)
            {
                if let Some(value) = proxy_password.as_ref().filter(|value| !value.is_empty()) {
                    proxy::set_password(new_id, Some(value.as_str()))?;
                }
            }
            storage::save(&db, host)
        })();
        match saved {
            Ok(host) => Ok(host),
            Err(error) => {
                let _ = credentials::delete(new_id);
                let _ = proxy::set_password(new_id, None);
                Err(error)
            }
        }
    })
    .await
    .map_err(error)?
    .map_err(error)
}

#[tauri::command]
async fn delete_host(state: State<'_, AppState>, id: Uuid) -> CommandResult<()> {
    let path = state.database.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let db = storage::open(&path)?;
        if storage::list(&db)?
            .iter()
            .any(|host| host.id == Some(id) && host.has_password)
        {
            credentials::delete(id)?;
        }
        proxy::set_password(id, None)?;
        db.execute("DELETE FROM local_hosts WHERE id=?1", [id.to_string()])?;
        files::forget(id);
        Ok(())
    })
    .await
    .map_err(error)?
    .map_err(error)
}

#[tauri::command]
async fn platform_address(state: State<'_, AppState>) -> CommandResult<String> {
    let path = state.database.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<String> {
        Ok(storage::open(&path)?
            .query_row(
                "SELECT value FROM settings WHERE key='platform_url'",
                [],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or_default())
    })
    .await
    .map_err(error)?
    .map_err(error)
}

#[tauri::command]
async fn configure_platform(state: State<'_, AppState>, address: String) -> CommandResult<()> {
    let base = platform::normalize_base(&address).map_err(error)?;
    let mut platform = state.platform.lock().await;
    state.ai.cancel_all();
    state.sessions.close_platform().map_err(error)?;
    platform.forget_auth().await.map_err(error)?;
    platform.configure(base);
    let path = state.database.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<()> { storage::open(&path)?.execute("INSERT INTO settings(key,value) VALUES ('platform_url',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [address])?; Ok(()) }).await.map_err(error)?.map_err(error)
}

#[tauri::command]
async fn platform_request(
    state: State<'_, AppState>,
    request: platform::Request,
) -> CommandResult<Value> {
    state
        .platform
        .lock()
        .await
        .execute(request)
        .await
        .map_err(error)
}

#[tauri::command]
async fn logout(state: State<'_, AppState>) -> CommandResult<()> {
    let mut platform = state.platform.lock().await;
    state.ai.cancel_all();
    state.sessions.close_platform().map_err(error)?;
    platform.logout().await.map_err(error)
}

#[derive(Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub(crate) enum Target {
    Shell,
    Local {
        id: Uuid,
    },
    Platform {
        id: Uuid,
        #[serde(rename = "accountId")]
        account_id: Option<Uuid>,
        #[serde(rename = "accessPathId")]
        access_path_id: Option<Uuid>,
        #[serde(default)]
        protocol: RemoteProtocol,
    },
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum RemoteProtocol {
    #[default]
    Ssh,
    Rdp,
}

#[tauri::command]
async fn terminal_open(
    state: State<'_, AppState>,
    target: Target,
    channel: Channel<Event>,
    cols: u16,
    rows: u16,
) -> CommandResult<Uuid> {
    let revision = state.revision.load(Ordering::SeqCst);
    let session_id = Uuid::new_v4();
    match target {
        Target::Shell => {
            let sessions = Arc::clone(&state.sessions);
            tokio::task::spawn_blocking(move || {
                sessions.open_system(session_id, channel, cols, rows)
            })
            .await
            .map_err(error)?
            .map_err(error)?;
        }
        Target::Local { id } => {
            let database = state.database.to_path_buf();
            let known_hosts = state.known_hosts.to_path_buf();
            let sessions = Arc::clone(&state.sessions);
            tokio::task::spawn_blocking(move || -> Result<()> {
                let connection = storage::open(&database)?;
                let host = storage::list(&connection)?
                    .into_iter()
                    .find(|host| host.id == Some(id))
                    .context("本地主机不存在或已删除")?;
                let system_engine = preferences::load(&connection)?.system_engine();
                sessions.open_local(
                    session_id,
                    host,
                    &known_hosts,
                    system_engine,
                    channel,
                    cols,
                    rows,
                )
            })
            .await
            .map_err(error)?
            .map_err(error)?;
        }
        Target::Platform {
            id,
            account_id,
            access_path_id,
            protocol,
        } => {
            // Hold the platform lock until registration; logout cannot race a pending open.
            let mut platform = state.platform.lock().await;
            let is_rdp = protocol == RemoteProtocol::Rdp;
            let request = if is_rdp {
                platform
                    .rdp_websocket_request(id, account_id, access_path_id)
                    .await
            } else {
                platform
                    .websocket_request(id, account_id, access_path_id)
                    .await
            }
            .map_err(error)?;
            state
                .sessions
                .open_platform(session_id, id, request, channel, (cols, rows), is_rdp)
                .await
                .map_err(error)?;
        }
    }
    if revision != state.revision.load(Ordering::SeqCst) {
        state.sessions.close(session_id).map_err(error)?;
        return Err("页面已刷新，连接已取消".into());
    }
    Ok(session_id)
}

#[tauri::command]
async fn terminal_input(
    state: State<'_, AppState>,
    id: Uuid,
    input: terminal::Input,
) -> CommandResult<()> {
    let sessions = Arc::clone(&state.sessions);
    tokio::task::spawn_blocking(move || sessions.send(id, input))
        .await
        .map_err(error)?
        .map_err(error)
}

#[tauri::command]
async fn rdp_input(state: State<'_, AppState>, id: Uuid, data: String) -> CommandResult<()> {
    let sessions = Arc::clone(&state.sessions);
    tokio::task::spawn_blocking(move || sessions.send_rdp(id, data))
        .await
        .map_err(error)?
        .map_err(error)
}

#[tauri::command]
async fn terminal_close(state: State<'_, AppState>, id: Uuid) -> CommandResult<()> {
    state.ai.cancel_terminal(id);
    let sessions = Arc::clone(&state.sessions);
    tokio::task::spawn_blocking(move || sessions.close(id))
        .await
        .map_err(error)?
        .map_err(error)
}

/// Start the desktop application.
///
/// # Errors
/// Returns an error if application initialization or the native runtime fails.
pub fn run() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(|app| {
        use tauri::menu::{Menu, PredefinedMenuItem as Item, Submenu};
        // Keep native editing shortcuts, but leave Cmd+W to the configurable tab action.
        Menu::with_items(
            app,
            &[
                &Submenu::with_items(
                    app,
                    "Pixiu Shell",
                    true,
                    &[
                        &Item::about(app, None, None)?,
                        &Item::separator(app)?,
                        &Item::hide(app, None)?,
                        &Item::hide_others(app, None)?,
                        &Item::show_all(app, None)?,
                        &Item::separator(app)?,
                        &Item::quit(app, None)?,
                    ],
                )?,
                &Submenu::with_items(
                    app,
                    "编辑",
                    true,
                    &[
                        &Item::undo(app, None)?,
                        &Item::redo(app, None)?,
                        &Item::separator(app)?,
                        &Item::cut(app, None)?,
                        &Item::copy(app, None)?,
                        &Item::paste(app, None)?,
                        &Item::select_all(app, None)?,
                    ],
                )?,
                &Submenu::with_items(
                    app,
                    "窗口",
                    true,
                    &[&Item::minimize(app, None)?, &Item::maximize(app, None)?],
                )?,
            ],
        )
    });
    let app = builder.setup(|app| {
            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                window.set_decorations(false)?;
            }
            let directory = app.path().app_data_dir()?;
            std::fs::create_dir_all(&directory)?;
            let database = directory.join("pixiu-shell.sqlite3");
            let known_hosts = directory.join("known_hosts");
            // Must run before the screen lock is constructed: a configured lock
            // whose hash is still under the legacy service can never be opened.
            if let Err(error) = migrate::run(&directory, &database, &known_hosts) {
                eprintln!("[pixiu-shell] 旧版本数据迁移未完成：{error}");
            }
            let prefs = preferences::load(&storage::open(&database)?)?;
            let mut platform = Platform::new()?;
            if !prefs.platform_address.is_empty() {
                platform.configure(platform::normalize_base(&prefs.platform_address)?);
            }
            let sessions = Arc::new(Sessions::default());
            let screen_lock = Arc::new(screen_lock::ScreenLock::new(&database)?);
            app.manage(AppState {
                screen_lock,
                ai: ai::AiRuns::default(),
                dingtalk: Arc::new(dingtalk::LoginFlow::default()),
                revision: AtomicU64::new(0),
                database,
                known_hosts,
                platform: Mutex::new(platform),
                sessions,
                transfer_cancels: Mutex::new(std::collections::HashMap::new()),
                monitor_sessions: Mutex::new(std::collections::HashMap::new()),
            });
            // Connections can ask the user to verify a fingerprint, and they
            // must be able to do it before the first window is even rendered.
            hostkey::attach(app.handle().clone());
            Ok(())
        })
        .invoke_handler(|invoke| {
            let state = invoke.message.state_ref().get::<AppState>();
            let resize_only = matches!(invoke.message.payload(), tauri::ipc::InvokeBody::Json(payload) if screen_lock::resize_only(invoke.message.command(),payload));
            if !state.screen_lock.command_allowed(invoke.message.command()) && !resize_only {
                invoke.resolver.reject("应用已锁定，请先解锁");
                return true;
            }
            let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
                screen_lock::lock_status,
                screen_lock::screen_lock,
                screen_lock::screen_unlock,
                screen_lock::lock_configure,
                ai::ai_chat,
                ai::ai_cancel,
                commands::preferences_load,
                commands::preferences_save,
                commands::ai_key_configured,
                commands::ai_key_save,
                commands::groups_list,
                commands::group_save,
                commands::group_move,
                commands::group_delete,
                commands::openssh_config_import,
                commands::batch_hosts_preview,
                commands::batch_hosts_import,
                commands::batch_hosts_template_save,
                commands::identity_file_pick,
                commands::dingtalk_open,
                commands::dingtalk_close,
                commands::dingtalk_status,
                commands::workspace_restore,
                commands::platform_restore,
                commands::system_shell_info,
                commands::local_connectivity_test,
                commands::file_list,
                commands::file_home,
                commands::file_upload,
                commands::file_download,
                commands::file_transfer_cancel,
                commands::file_upload_progress,
                commands::file_download_progress,
                commands::file_delete,
                commands::file_mkdir,
                commands::file_rename,
                commands::file_chmod,
                commands::file_read,
                commands::file_write,
                commands::file_close,
                commands::host_metrics_probe,
                commands::host_metrics_stop,
                local_hosts,
                save_host,
                duplicate_host,
                delete_host,
                platform_address,
                configure_platform,
                platform_request,
                logout,
                terminal_open,
                terminal_input,
                rdp_input,
                terminal_close,
                hostkey::host_key_answer
            ];
            handler(invoke)
        })
        .build(tauri::generate_context!())?;
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let state = handle.state::<AppState>();
            let _ = state.sessions.close_all();
        }
    });
    Ok(())
}

/// OpenSSH password helper. Secrets are written only to the calling SSH process pipe.
/// # Errors
/// Returns an error if the credential is unavailable or the prompt is unsupported.
pub fn askpass() -> std::result::Result<(), Box<dyn std::error::Error>> {
    credentials::askpass().map_err(Into::into)
}

/// Bridge OpenSSH stdio to a configured HTTP CONNECT or SOCKS5 proxy.
/// # Errors
/// Returns an error if the stored proxy cannot establish the connection.
pub fn proxy_helper() -> std::result::Result<(), Box<dyn std::error::Error>> {
    proxy::helper().map_err(Into::into)
}
