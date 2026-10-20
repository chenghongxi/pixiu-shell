use crate::{AppState, CommandResult, Target, error, files, platform, preferences, storage};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::path::PathBuf;
use tauri::{Manager, State};

#[tauri::command]
pub(crate) async fn preferences_load(
    state: State<'_, AppState>,
) -> CommandResult<preferences::Preferences> {
    let path = state.database.to_path_buf();
    tokio::task::spawn_blocking(move || preferences::load(&storage::open(&path)?))
        .await
        .map_err(error)?
        .map_err(error)
}
#[tauri::command]
pub(crate) async fn preferences_save(
    state: State<'_, AppState>,
    preferences: preferences::Preferences,
) -> CommandResult<()> {
    preferences.validate().map_err(error)?;
    let mut client = state.platform.lock().await;
    let path = state.database.to_path_buf();
    let address = preferences.platform_address.to_string();
    if preferences.mode == "local" {
        state.ai.cancel_all();
    }
    let changed = tokio::task::spawn_blocking(move || -> Result<bool> {
        let mut db = storage::open(&path)?;
        let changed = preferences::load(&db)?.platform_address != preferences.platform_address;
        preferences::save(&mut db, &preferences)?;
        Ok(changed)
    })
    .await
    .map_err(error)?
    .map_err(error)?;
    if changed {
        state.ai.cancel_all();
        state.sessions.close_platform().map_err(error)?;
        client.forget_auth().await.map_err(error)?;
        if address.is_empty() {
            client.clear();
        } else {
            client.configure(platform::normalize_base(&address).map_err(error)?);
        }
    }
    Ok(())
}
#[tauri::command]
pub(crate) async fn workspace_restore(state: State<'_, AppState>) -> CommandResult<Value> {
    // Reloading the webview cannot orphan SSH processes or forwarding ports.
    state
        .revision
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    state.ai.cancel_all();
    state.sessions.close_all().map_err(error)?;
    if state.screen_lock.status().locked {
        return Ok(Value::Null);
    }
    let database = state.database.to_path_buf();
    let mode = tokio::task::spawn_blocking(move || -> Result<String> {
        Ok(preferences::load(&storage::open(&database)?)?.mode)
    })
    .await
    .map_err(error)?
    .map_err(error)?;
    if mode == "local" {
        return Ok(Value::Null);
    }
    state
        .platform
        .lock()
        .await
        .restore_identity()
        .await
        .map_err(error)
}
#[tauri::command]
pub(crate) async fn groups_list(state: State<'_, AppState>) -> CommandResult<Vec<String>> {
    let path = state.database.to_path_buf();
    tokio::task::spawn_blocking(move || storage::groups(&storage::open(&path)?))
        .await
        .map_err(error)?
        .map_err(error)
}
#[tauri::command]
pub(crate) async fn group_save(
    state: State<'_, AppState>,
    previous: Option<String>,
    name: String,
) -> CommandResult<()> {
    let path = state.database.to_path_buf();
    tokio::task::spawn_blocking(move || {
        storage::save_group(&storage::open(&path)?, previous.as_deref(), name.trim())
    })
    .await
    .map_err(error)?
    .map_err(error)
}
#[tauri::command]
pub(crate) async fn group_delete(state: State<'_, AppState>, name: String) -> CommandResult<()> {
    let path = state.database.to_path_buf();
    tokio::task::spawn_blocking(move || storage::delete_group(&storage::open(&path)?, &name))
        .await
        .map_err(error)?
        .map_err(error)
}
#[tauri::command]
pub(crate) async fn dingtalk_open(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<Value> {
    close_dingtalk_windows(&app, None).map_err(error)?;
    let qr = state
        .platform
        .lock()
        .await
        .execute(platform::Request::Qrcode)
        .await
        .map_err(error)?;
    let url = state.dingtalk.begin(&qr).map_err(error)?;
    let id =
        uuid::Uuid::parse_str(qr["qrcodeId"].as_str().ok_or("二维码 ID 无效")?).map_err(error)?;
    let flow = std::sync::Arc::clone(&state.dingtalk);
    let window = tauri::WebviewWindowBuilder::new(
        &app,
        format!("dingtalk-login-{id}"),
        tauri::WebviewUrl::External(url),
    )
    .title("TSHELL · 钉钉扫码登录")
    .inner_size(520.0, 680.0)
    .center()
    .on_navigation(move |url| flow.navigate(id, url))
    .build()
    .map_err(error)?;
    let flow = std::sync::Arc::clone(&state.dingtalk);
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            flow.closed(id);
        }
    });
    Ok(qr)
}
#[tauri::command]
pub(crate) async fn dingtalk_close(
    app: tauri::AppHandle,
    id: Option<uuid::Uuid>,
) -> CommandResult<()> {
    close_dingtalk_windows(&app, id).map_err(error)
}
fn close_dingtalk_windows(app: &tauri::AppHandle, id: Option<uuid::Uuid>) -> Result<()> {
    let exact = id.map(|id| format!("dingtalk-login-{id}"));
    for (label, window) in app.webview_windows() {
        if exact.as_ref().map_or_else(
            || label.starts_with("dingtalk-login"),
            |expected| &label == expected,
        ) {
            window.close()?;
        }
    }
    Ok(())
}
#[tauri::command]
pub(crate) async fn dingtalk_status(
    state: State<'_, AppState>,
    id: uuid::Uuid,
) -> CommandResult<Value> {
    if let Some(status) = state.dingtalk.status(id).map_err(error)? {
        return Ok(status);
    }
    // Retain polling for authorizations completed outside the native popup.
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        state
            .platform
            .lock()
            .await
            .execute(platform::Request::QrcodeStatus { id })
            .await
    })
    .await;
    if let Some(status) = state.dingtalk.status(id).map_err(error)? {
        return Ok(status);
    }
    result
        .map_err(|_| "查询扫码状态超时，请检查网络".to_string())?
        .map_err(error)
}
fn local_host(database: &std::path::Path, id: uuid::Uuid) -> Result<storage::LocalHost> {
    storage::list(&storage::open(database)?)?
        .into_iter()
        .find(|host| host.id == Some(id))
        .context("本地主机不存在")
}
async fn envelope(response: reqwest::Response) -> Result<Value> {
    let mut body: Value = response.json().await?;
    ensure!(
        body["code"] == 200,
        "{}",
        body["msg"].as_str().unwrap_or("平台文件操作失败")
    );
    Ok(body["data"].take())
}
#[tauri::command]
pub(crate) async fn file_list(
    state: State<'_, AppState>,
    target: Target,
    path: String,
) -> CommandResult<Value> {
    files::validate_path(&path).map_err(error)?;
    match target {
        Target::Shell => Err("本机 Shell 请使用系统文件管理器".into()),
        Target::Local { id } => {
            let database = state.database.to_path_buf();
            let known = state.known_hosts.to_path_buf();
            tokio::task::spawn_blocking(move || -> Result<Value> {
                let sftp = files::connect(&local_host(&database, id)?, &known)?;
                Ok(serde_json::to_value(files::list(&sftp, &path)?)?)
            })
            .await
            .map_err(error)?
            .map_err(error)
        }
        Target::Platform {
            id,
            account_id,
            access_path_id,
            ..
        } => {
            let mut platform = state.platform.lock().await;
            envelope(
                platform
                    .file_request(id, account_id, access_path_id, "list", &path, None)
                    .await
                    .map_err(error)?,
            )
            .await
            .map_err(error)
        }
    }
}
#[tauri::command]
pub(crate) async fn file_upload(
    state: State<'_, AppState>,
    target: Target,
    directory: String,
) -> CommandResult<Value> {
    files::validate_path(&directory).map_err(error)?;
    let picked = tokio::task::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("上传文件到远程主机")
            .pick_file()
    })
    .await
    .map_err(error)?;
    let Some(source) = picked else {
        return Ok(json!({"cancelled":true}));
    };
    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("本地文件名无效")?;
    let remote = format!("{}/{}", directory.trim_end_matches('/'), name);
    files::validate_path(&remote).map_err(error)?;
    let database = state.database.to_path_buf();
    let known = state.known_hosts.to_path_buf();
    match target {
        Target::Shell => return Err("本机 Shell 请使用系统文件管理器".into()),
        Target::Local { id } => {
            tokio::task::spawn_blocking(move || -> Result<()> {
                let sftp = files::connect(&local_host(&database, id)?, &known)?;
                files::upload(&sftp, &remote, &source)
            })
            .await
            .map_err(error)?
            .map_err(error)?;
        }
        Target::Platform {
            id,
            account_id,
            access_path_id,
            ..
        } => {
            let confirmation = format!("上传到 {remote}？平台接口可能覆盖同名文件。");
            let confirmed = tokio::task::spawn_blocking(move || {
                rfd::MessageDialog::new()
                    .set_title("确认上传")
                    .set_description(confirmation)
                    .set_buttons(rfd::MessageButtons::YesNo)
                    .show()
                    == rfd::MessageDialogResult::Yes
            })
            .await
            .map_err(error)?;
            if !confirmed {
                return Ok(json!({"cancelled":true}));
            }
            let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>> {
                ensure!(
                    std::fs::metadata(&source)?.len() <= files::MAX_TRANSFER,
                    "单文件上限为 64 MiB"
                );
                Ok(std::fs::read(source)?)
            })
            .await
            .map_err(error)?
            .map_err(error)?;
            let mut platform = state.platform.lock().await;
            envelope(
                platform
                    .file_request(
                        id,
                        account_id,
                        access_path_id,
                        "upload",
                        &remote,
                        Some(bytes),
                    )
                    .await
                    .map_err(error)?,
            )
            .await
            .map_err(error)?;
        }
    }
    Ok(json!({"cancelled":false}))
}
#[tauri::command]
pub(crate) async fn file_download(
    state: State<'_, AppState>,
    target: Target,
    path: String,
) -> CommandResult<Value> {
    files::validate_path(&path).map_err(error)?;
    let name = PathBuf::from(&path)
        .file_name()
        .context("文件名无效")
        .map_err(error)?
        .to_string_lossy()
        .into_owned();
    let picked = tokio::task::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title("保存下载文件")
            .set_file_name(name)
            .save_file()
    })
    .await
    .map_err(error)?;
    let Some(destination) = picked else {
        return Ok(json!({"cancelled":true}));
    };
    let bytes = match target {
        Target::Shell => return Err("本机 Shell 请使用系统文件管理器".into()),
        Target::Local { id } => {
            let database = state.database.to_path_buf();
            let known = state.known_hosts.to_path_buf();
            tokio::task::spawn_blocking(move || -> Result<Vec<u8>> {
                let sftp = files::connect(&local_host(&database, id)?, &known)?;
                files::download(&sftp, &path)
            })
            .await
            .map_err(error)?
            .map_err(error)?
        }
        Target::Platform {
            id,
            account_id,
            access_path_id,
            ..
        } => {
            let mut platform = state.platform.lock().await;
            let mut response = platform
                .file_request(id, account_id, access_path_id, "download", &path, None)
                .await
                .map_err(error)?;
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(error)? {
                if bytes.len() as u64 + chunk.len() as u64 > files::MAX_TRANSFER {
                    return Err("单文件上限为 64 MiB".into());
                }
                bytes.extend_from_slice(&chunk);
            }
            bytes
        }
    };
    tokio::task::spawn_blocking(move || files::write_download(&destination, &bytes))
        .await
        .map_err(error)?
        .map_err(error)?;
    Ok(json!({"cancelled":false}))
}
#[tauri::command]
pub(crate) async fn file_delete(
    state: State<'_, AppState>,
    target: Target,
    path: String,
) -> CommandResult<()> {
    files::validate_path(&path).map_err(error)?;
    match target {
        Target::Shell => Err("本机 Shell 请使用系统文件管理器".into()),
        Target::Local { id } => {
            let database = state.database.to_path_buf();
            let known = state.known_hosts.to_path_buf();
            tokio::task::spawn_blocking(move || -> Result<()> {
                let sftp = files::connect(&local_host(&database, id)?, &known)?;
                files::delete(&sftp, &path)
            })
            .await
            .map_err(error)?
            .map_err(error)
        }
        Target::Platform {
            id,
            account_id,
            access_path_id,
            ..
        } => {
            let mut platform = state.platform.lock().await;
            envelope(
                platform
                    .file_request(id, account_id, access_path_id, "delete", &path, None)
                    .await
                    .map_err(error)?,
            )
            .await
            .map_err(error)?;
            Ok(())
        }
    }
}

#[tauri::command]
pub(crate) async fn local_connectivity_test(
    state: State<'_, AppState>,
    mut host: crate::storage::LocalHost,
    password: Option<String>,
    proxy_password: Option<String>,
) -> CommandResult<Value> {
    let known = state.known_hosts.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<Value> {
        if host.name.trim().is_empty() {
            host.name = "连接检测".into();
        }
        let password = password.map(zeroize::Zeroizing::new);
        let proxy_password = proxy_password.map(zeroize::Zeroizing::new);
        let _sftp = files::connect_with_credentials(
            &host,
            &known,
            password.as_deref().map(String::as_str),
            proxy_password.as_deref().map(String::as_str),
        )?;
        Ok(json!({"status":"success","message":"SSH 认证与 SFTP 通道检测通过"}))
    })
    .await
    .map_err(error)?
    .map_err(error)
}

#[tauri::command]
pub(crate) async fn platform_restore(state: State<'_, AppState>) -> CommandResult<Value> {
    state
        .platform
        .lock()
        .await
        .restore_identity()
        .await
        .map_err(error)
}

#[tauri::command]
pub(crate) fn system_shell_info() -> Value {
    let (_, name) = crate::terminal::system_shell();
    json!({"name":name})
}
