use crate::{
    AppState, CommandResult, Target, error, files, monitor, platform, preferences, storage,
};
use anyhow::{Context, Result, ensure};
use calamine::{Reader, open_workbook_auto};
use rust_xlsxwriter::{Format, Workbook};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};
use tauri::{Manager, State, ipc::Channel};
use uuid::Uuid;
use zeroize::Zeroizing;

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
pub(crate) async fn ai_key_configured() -> CommandResult<bool> {
    tokio::task::spawn_blocking(crate::credentials::ai_key_configured)
        .await
        .map_err(error)?
        .map_err(error)
}

#[tauri::command]
pub(crate) async fn ai_key_save(api_key: String, clear: Option<bool>) -> CommandResult<()> {
    tokio::task::spawn_blocking(move || {
        if clear == Some(true) {
            crate::credentials::delete_ai_key()
        } else {
            crate::credentials::save_ai_key(&api_key)
        }
    })
    .await
    .map_err(error)?
    .map_err(error)
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
pub(crate) async fn group_move(
    state: State<'_, AppState>,
    source: String,
    target: String,
) -> CommandResult<()> {
    let path = state.database.to_path_buf();
    tokio::task::spawn_blocking(move || {
        storage::move_group(&storage::open(&path)?, &source, &target)
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

#[derive(Clone, Default)]
struct OpenSshHost {
    hostname: String,
    user: String,
    port: Option<u16>,
    identity_file: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BatchImportDocument {
    hosts: Vec<BatchImportHost>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct BatchImportHost {
    #[serde(default)]
    name: String,
    #[serde(default)]
    ip: String,
    #[serde(default)]
    ssh_user: String,
    #[serde(default)]
    ssh_port: Option<serde_yaml::Value>,
    #[serde(default)]
    ssh_password: String,
    #[serde(default)]
    group: String,
}

impl BatchImportHost {
    fn port(&self, row: usize) -> Result<u16> {
        let Some(value) = &self.ssh_port else {
            return Ok(22);
        };
        let value = match value {
            serde_yaml::Value::Number(value) => value.to_string(),
            serde_yaml::Value::String(value) => value.trim().to_string(),
            _ => anyhow::bail!("第 {row} 条记录的 SSH 端口必须是 1 到 65535 的整数"),
        };
        value
            .parse::<u16>()
            .ok()
            .filter(|port| *port > 0)
            .context(format!("第 {row} 条记录的 SSH 端口必须是 1 到 65535 的整数"))
    }

    fn local_host(&self, row: usize) -> Result<storage::LocalHost> {
        let host = storage::LocalHost {
            id: Some(Uuid::new_v4()),
            name: self.name.trim().into(),
            address: self.ip.trim().into(),
            port: self.port(row)?,
            username: self.ssh_user.trim().into(),
            group: self.group.trim().into(),
            identity_file: String::new(),
            note: "从批量导入创建".into(),
            tags: vec!["批量导入".into()],
            tunnels: vec![],
            has_password: !self.ssh_password.is_empty(),
            proxy: None,
        };
        host.validate()
            .with_context(|| format!("第 {row} 条记录无效"))?;
        Ok(host)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BatchImportPreview {
    path: String,
    valid: Vec<BatchImportPreviewRow>,
    skipped: Vec<BatchImportSkippedRow>,
    invalid: Vec<BatchImportInvalidRow>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchImportPreviewRow {
    row: usize,
    name: String,
    address: String,
    username: String,
    port: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchImportSkippedRow {
    row: usize,
    name: String,
    address: String,
    reason: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchImportInvalidRow {
    row: usize,
    name: String,
    address: String,
    reason: String,
}

struct PreparedBatchImport {
    preview: BatchImportPreview,
    hosts: Vec<BatchImportHost>,
}

fn excel_value(value: Option<&calamine::Data>) -> String {
    value
        .map(ToString::to_string)
        .unwrap_or_default()
        .trim()
        .into()
}

fn batch_import_column(header: &str) -> Option<&'static str> {
    match header.trim().to_ascii_lowercase().as_str() {
        "主机名称" => Some("name"),
        "ip 地址" => Some("ip"),
        "ssh 用户" => Some("ssh_user"),
        "ssh 密码" => Some("ssh_password"),
        "ssh 端口" => Some("ssh_port"),
        "分组" => Some("group"),
        _ => None,
    }
}

fn import_excel(path: &Path) -> Result<Vec<BatchImportHost>> {
    let mut workbook = open_workbook_auto(path).context("无法读取 Excel 文件")?;
    let range = workbook
        .worksheet_range_at(0)
        .context("Excel 中没有工作表")??;
    let mut columns = HashMap::new();
    let Some(header) = range.rows().next() else {
        anyhow::bail!("Excel 模板缺少表头");
    };
    for (index, value) in header.iter().enumerate() {
        if let Some(key) = batch_import_column(&excel_value(Some(value))) {
            columns.insert(key, index);
        }
    }
    for required in ["name", "ip", "ssh_user", "ssh_password", "ssh_port", "group"] {
        ensure!(columns.contains_key(required), "Excel 缺少 {required} 列");
    }
    let value = |row: &[calamine::Data], key: &str| {
        excel_value(row.get(*columns.get(key).expect("validated column")))
    };
    let mut hosts = Vec::new();
    for row in range.rows().skip(1) {
        if row.iter().all(|cell| excel_value(Some(cell)).is_empty()) {
            continue;
        }
        let port = value(row, "ssh_port");
        hosts.push(BatchImportHost {
            name: value(row, "name"),
            ip: value(row, "ip"),
            ssh_user: value(row, "ssh_user"),
            ssh_port: (!port.is_empty()).then_some(serde_yaml::Value::String(port)),
            ssh_password: value(row, "ssh_password"),
            group: value(row, "group"),
        });
    }
    Ok(hosts)
}

fn import_batch_file(path: &Path) -> Result<Vec<BatchImportHost>> {
    let metadata = std::fs::metadata(path).context("无法读取导入文件")?;
    ensure!(
        metadata.len() <= 10 * 1024 * 1024,
        "导入文件不能超过 10 MiB"
    );
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "xlsx" | "xls" => import_excel(path),
        "yaml" | "yml" => {
            let source = std::fs::read_to_string(path).context("无法读取 YAML 文件")?;
            Ok(serde_yaml::from_str::<BatchImportDocument>(&source)
                .context("YAML 格式无效")?
                .hosts)
        }
        _ => anyhow::bail!("仅支持 .xlsx、.xls、.yaml 或 .yml 文件"),
    }
}

fn prepare_batch_import(path: &Path, database: &Path) -> Result<PreparedBatchImport> {
    let hosts = import_batch_file(path)?;
    ensure!(!hosts.is_empty(), "导入文件中没有主机记录");
    ensure!(hosts.len() <= 200, "一次最多导入 200 台主机");

    let existing_addresses: std::collections::HashSet<_> = storage::list(&storage::open(database)?)?
        .into_iter()
        .map(|host| host.address.trim().to_ascii_lowercase())
        .collect();
    let mut addresses = std::collections::HashSet::new();
    let mut valid = Vec::new();
    let mut preview = BatchImportPreview {
        path: path.to_string_lossy().into_owned(),
        valid: Vec::new(),
        skipped: Vec::new(),
        invalid: Vec::new(),
    };

    for (index, input) in hosts.into_iter().enumerate() {
        let row = index + 2;
        let host = match input.local_host(row) {
            Ok(host) => host,
            Err(error) => {
                preview.invalid.push(BatchImportInvalidRow {
                    row,
                    name: input.name.trim().into(),
                    address: input.ip.trim().into(),
                    reason: error.to_string(),
                });
                continue;
            }
        };
        let address_key = host.address.to_ascii_lowercase();
        let reason = if existing_addresses.contains(&address_key) {
            Some("主机列表中 IP 已存在")
        } else if !addresses.insert(address_key) {
            Some("文件内 IP 重复")
        } else {
            None
        };
        if let Some(reason) = reason {
            preview.skipped.push(BatchImportSkippedRow {
                row,
                name: host.name,
                address: host.address,
                reason: reason.into(),
            });
            continue;
        }
        preview.valid.push(BatchImportPreviewRow {
            row,
            name: host.name,
            address: host.address,
            username: host.username,
            port: host.port,
        });
        valid.push(input);
    }
    Ok(PreparedBatchImport {
        preview,
        hosts: valid,
    })
}

fn save_batch_hosts(
    path: &Path,
    mut hosts: Vec<BatchImportHost>,
) -> Result<usize> {
    ensure!(!hosts.is_empty(), "导入文件中没有主机记录");
    ensure!(hosts.len() <= 200, "一次最多导入 200 台主机");
    let prepared: Vec<_> = hosts
        .iter()
        .enumerate()
        .map(|(index, host)| host.local_host(index + 2))
        .collect::<Result<_>>()?;
    let db = storage::open(path)?;
    let mut saved = Vec::new();
    let result = (|| -> Result<()> {
        for (host, input) in prepared.into_iter().zip(hosts.iter_mut()) {
            let id = host.id.context("导入主机缺少 ID")?;
            let password = Zeroizing::new(std::mem::take(&mut input.ssh_password));
            if !password.is_empty() {
                crate::credentials::write(id, &password)?;
            }
            if let Err(error) = storage::save(&db, host) {
                if !password.is_empty() {
                    let _ = crate::credentials::delete(id);
                }
                return Err(error);
            }
            saved.push(id);
        }
        Ok(())
    })();
    if let Err(error) = result {
        for id in saved {
            let _ = crate::credentials::delete(id);
            let _ = db.execute("DELETE FROM local_hosts WHERE id=?1", [id.to_string()]);
        }
        return Err(error);
    }
    Ok(hosts.len())
}

fn write_batch_import_template(path: &Path) -> Result<()> {
    let mut workbook = Workbook::new();
    let worksheet = workbook.add_worksheet();
    worksheet.set_name("Hosts")?;
    let header = Format::new().set_bold();
    for (column, name) in ["主机名称", "IP 地址", "SSH 用户", "SSH 密码", "SSH 端口", "分组"]
        .iter()
        .enumerate()
    {
        worksheet.write_string_with_format(0, column as u16, *name, &header)?;
    }
    for (row, values) in [
        ["web-server-01", "10.20.30.40", "root", "", "22", "生产环境"],
        [
            "web-server-02",
            "10.20.30.41",
            "root",
            "",
            "22",
            "预发布",
        ],
    ]
    .iter()
    .enumerate()
    {
        for (column, value) in values.iter().enumerate() {
            worksheet.write_string((row + 1) as u32, column as u16, *value)?;
        }
    }
    for column in 0..6 {
        worksheet.set_column_width(column, 22)?;
    }
    workbook.save(path).context("无法生成 Excel 模板")
}

fn write_yaml_batch_import_template(path: &Path) -> Result<()> {
    std::fs::write(
        path,
        r#"hosts:
  - name: web-server-01
    ip: 10.20.30.40
    ssh_user: root
    ssh_password: ""
    ssh_port: 22
    group: 生产环境

  - name: web-server-02
    ip: 10.20.30.41
    ssh_user: root
    ssh_password: ""
    ssh_port: 22
    group: 预发布
"#,
    )
    .context("无法写入 YAML 模板")
}

fn ssh_value(value: &str) -> String {
    value.trim().trim_matches(['"', '\'']).to_string()
}

fn resolve_identity(value: &str, config: &Path) -> String {
    let value = ssh_value(value);
    if value == "~" || value.starts_with("~/") {
        if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
            let home = PathBuf::from(home);
            return home
                .join(value.trim_start_matches("~/"))
                .to_string_lossy()
                .into_owned();
        }
    }
    let path = PathBuf::from(&value);
    if path.is_relative() {
        config
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(path)
            .to_string_lossy()
            .into_owned()
    } else {
        value
    }
}

fn import_openssh_config(path: &Path, db: &std::path::Path) -> Result<usize> {
    let source = std::fs::read_to_string(path).context("无法读取 OpenSSH 配置文件")?;
    ensure!(source.len() <= 1024 * 1024, "OpenSSH 配置文件超过 1 MiB");
    let mut defaults = OpenSshHost::default();
    let mut hosts: HashMap<String, OpenSshHost> = HashMap::new();
    let mut names: Vec<String> = Vec::new();
    let mut current: Vec<String> = Vec::new();
    for raw in source.lines() {
        let line = raw.split_once('#').map_or(raw, |(value, _)| value).trim();
        if line.is_empty() {
            continue;
        }
        let Some((key, value)) = line.split_once(char::is_whitespace) else {
            continue;
        };
        let key = key.to_ascii_lowercase();
        let value = value.trim();
        if key == "host" {
            current = value
                .split_whitespace()
                .filter(|name| !name.contains(['*', '?', '!']))
                .map(str::to_string)
                .collect();
            for name in &current {
                if !hosts.contains_key(name) {
                    hosts.insert(name.clone(), defaults.clone());
                    names.push(name.clone());
                }
            }
            continue;
        }
        let apply = |host: &mut OpenSshHost| match key.as_str() {
            "hostname" if host.hostname.is_empty() => host.hostname = ssh_value(value),
            "user" if host.user.is_empty() => host.user = ssh_value(value),
            "port" if host.port.is_none() => {
                host.port = value.parse().ok().filter(|port: &u16| *port > 0)
            }
            "identityfile" if host.identity_file.is_empty() => {
                host.identity_file = resolve_identity(value, path)
            }
            _ => {}
        };
        if current.is_empty() {
            apply(&mut defaults);
        } else {
            for name in &current {
                if let Some(host) = hosts.get_mut(name) {
                    apply(host);
                }
            }
        }
    }
    let connection = storage::open(db)?;
    let mut saved = 0;
    for name in names {
        let host = hosts.remove(&name).context("导入主机不存在")?;
        let address = if host.hostname.is_empty() {
            name.clone()
        } else {
            host.hostname
        };
        if address.contains('%') || address.starts_with('-') {
            continue;
        }
        storage::save(
            &connection,
            storage::LocalHost {
                id: None,
                name,
                address,
                port: host.port.unwrap_or(22),
                username: if host.user.is_empty() {
                    "root".into()
                } else {
                    host.user
                },
                group: "OpenSSH 导入".into(),
                identity_file: host.identity_file,
                note: "从 OpenSSH config 导入".into(),
                tags: vec!["OpenSSH".into()],
                tunnels: vec![],
                has_password: false,
                proxy: None,
            },
        )?;
        saved += 1;
    }
    Ok(saved)
}

#[tauri::command]
pub(crate) async fn openssh_config_import(state: State<'_, AppState>) -> CommandResult<Value> {
    let picked = tokio::task::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("导入 OpenSSH config")
            .pick_file()
    })
    .await
    .map_err(error)?;
    let Some(path) = picked else {
        return Ok(json!({"cancelled": true, "count": 0}));
    };
    let database = state.database.to_path_buf();
    let count = tokio::task::spawn_blocking(move || import_openssh_config(&path, &database))
        .await
        .map_err(error)?
        .map_err(error)?;
    Ok(json!({"cancelled": false, "count": count}))
}

#[tauri::command]
pub(crate) async fn batch_hosts_preview(
    state: State<'_, AppState>,
    path: Option<String>,
) -> CommandResult<Option<BatchImportPreview>> {
    let picked = match path {
        Some(value) => Some(PathBuf::from(value)),
        None => tokio::task::spawn_blocking(|| {
            rfd::FileDialog::new()
                .set_title("批量导入主机")
                .add_filter("主机导入文件", &["xlsx", "xls", "yaml", "yml"])
                .pick_file()
        })
        .await
        .map_err(error)?,
    };
    let Some(path) = picked else {
        return Ok(None);
    };
    let database = state.database.to_path_buf();
    tokio::task::spawn_blocking(move || prepare_batch_import(&path, &database).map(|value| value.preview))
        .await
        .map_err(error)?
        .map(Some)
        .map_err(error)
}

#[tauri::command]
pub(crate) async fn batch_hosts_import(
    state: State<'_, AppState>,
    path: String,
) -> CommandResult<Value> {
    let database = state.database.to_path_buf();
    let count = tokio::task::spawn_blocking(move || {
        let prepared = prepare_batch_import(Path::new(&path), &database)?;
        save_batch_hosts(&database, prepared.hosts)
    })
    .await
    .map_err(error)?
    .map_err(error)?;
    Ok(json!({"cancelled": false, "count": count}))
}

#[tauri::command]
pub(crate) async fn batch_hosts_template_save(format: String) -> CommandResult<Value> {
    let (file_name, filter_name, extension) = match format.as_str() {
        "excel" => ("主机批量导入模板.xlsx", "Excel 工作簿", "xlsx"),
        "yaml" => ("主机批量导入模板.yaml", "YAML 文件", "yaml"),
        _ => return Err("不支持的模板格式".into()),
    };
    let saved = tokio::task::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title("保存主机导入模板")
            .set_file_name(file_name)
            .add_filter(filter_name, &[extension])
            .save_file()
    })
    .await
    .map_err(error)?;
    let Some(path) = saved else {
        return Ok(json!({"cancelled": true}));
    };
    tokio::task::spawn_blocking(move || match format.as_str() {
        "excel" => write_batch_import_template(&path),
        "yaml" => write_yaml_batch_import_template(&path),
        _ => unreachable!("template format is validated before saving"),
    })
    .await
    .map_err(error)?
    .map_err(error)?;
    Ok(json!({"cancelled": false}))
}

#[tauri::command]
pub(crate) async fn identity_file_pick() -> CommandResult<Option<String>> {
    tokio::task::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("选择 SSH 私钥")
            .pick_file()
            .map(|path| path.to_string_lossy().into_owned())
    })
    .await
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
    .title("Pixiu Shell · 钉钉扫码登录")
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
                files::with_sftp(&local_host(&database, id)?, &known, |sftp| {
                    Ok(serde_json::to_value(files::list(sftp, &path)?)?)
                })
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
                files::with_sftp(&local_host(&database, id)?, &known, |sftp| {
                    files::upload(sftp, &remote, &source)
                })
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
                files::with_sftp(&local_host(&database, id)?, &known, |sftp| {
                    files::download(sftp, &path)
                })
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

async fn register_transfer(
    state: &AppState,
    id: uuid::Uuid,
) -> Result<std::sync::Arc<std::sync::atomic::AtomicBool>> {
    let mut transfers = state.transfer_cancels.lock().await;
    ensure!(!transfers.contains_key(&id), "传输任务已存在");
    let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    transfers.insert(id, std::sync::Arc::clone(&cancelled));
    Ok(cancelled)
}

async fn finish_transfer(state: &AppState, id: uuid::Uuid) {
    state.transfer_cancels.lock().await.remove(&id);
}

#[tauri::command]
pub(crate) async fn file_transfer_cancel(
    state: State<'_, AppState>,
    id: uuid::Uuid,
) -> CommandResult<()> {
    if let Some(cancelled) = state.transfer_cancels.lock().await.get(&id) {
        cancelled.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn file_upload_progress(
    state: State<'_, AppState>,
    target: Target,
    directory: String,
    id: uuid::Uuid,
    channel: Channel<Value>,
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
    let Target::Local { id: host } = target else {
        return Err("此传输模式仅适用于离线 SFTP 主机".into());
    };
    let cancelled = register_transfer(&state, id).await.map_err(error)?;
    let database = state.database.to_path_buf();
    let known = state.known_hosts.to_path_buf();
    let event_channel = channel.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<()> {
        files::with_sftp(&local_host(&database, host)?, &known, |sftp| {
            files::upload_with_progress(sftp, &remote, &source, &cancelled, |transferred, total| {
                event_channel.send(
                    json!({"eventType":"progress","payload":{"transferred":transferred,"total":total}}),
                )?;
                Ok(())
            })
        })
    })
    .await
    .map_err(error)?;
    finish_transfer(&state, id).await;
    result.map_err(error)?;
    channel
        .send(json!({"eventType":"completed"}))
        .map_err(error)?;
    Ok(json!({"cancelled":false}))
}

#[tauri::command]
pub(crate) async fn file_download_progress(
    state: State<'_, AppState>,
    target: Target,
    path: String,
    id: uuid::Uuid,
    channel: Channel<Value>,
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
    let Target::Local { id: host } = target else {
        return Err("此传输模式仅适用于离线 SFTP 主机".into());
    };
    let cancelled = register_transfer(&state, id).await.map_err(error)?;
    let database = state.database.to_path_buf();
    let known = state.known_hosts.to_path_buf();
    let event_channel = channel.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<()> {
        files::with_sftp(&local_host(&database, host)?, &known, |sftp| {
            files::download_to_with_progress(sftp, &path, &destination, &cancelled, |transferred, total| {
                event_channel.send(json!({"eventType":"progress","payload":{"transferred":transferred,"total":total}}))?;
                Ok(())
            })
        })
    }).await.map_err(error)?;
    finish_transfer(&state, id).await;
    result.map_err(error)?;
    channel
        .send(json!({"eventType":"completed"}))
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
                files::with_sftp(&local_host(&database, id)?, &known, |sftp| {
                    files::delete(sftp, &path)
                })
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
pub(crate) async fn file_home(
    state: State<'_, AppState>,
    target: Target,
) -> CommandResult<String> {
    match target {
        Target::Local { .. } => with_local_sftp(&state, target, files::home).await,
        Target::Platform { .. } => Ok("/".into()),
        Target::Shell => Err("本机 Shell 请使用系统文件管理器".into()),
    }
}

fn local_sftp_target(target: &Target) -> CommandResult<uuid::Uuid> {
    match target {
        Target::Local { id } => Ok(*id),
        Target::Shell => Err("本机 Shell 请使用系统文件管理器".into()),
        Target::Platform { .. } => Err("平台主机暂不支持该文件操作".into()),
    }
}

async fn with_local_sftp<T: Send + 'static>(
    state: &State<'_, AppState>,
    target: Target,
    operation: impl Fn(&ssh2::Sftp) -> Result<T> + Send + 'static,
) -> CommandResult<T> {
    let id = local_sftp_target(&target)?;
    let database = state.database.to_path_buf();
    let known = state.known_hosts.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<T> {
        files::with_sftp(&local_host(&database, id)?, &known, |sftp| operation(sftp))
    })
    .await
    .map_err(error)?
    .map_err(error)
}

#[tauri::command]
pub(crate) async fn file_mkdir(
    state: State<'_, AppState>,
    target: Target,
    directory: String,
    name: String,
) -> CommandResult<()> {
    let path = files::join_name(&directory, &name).map_err(error)?;
    with_local_sftp(&state, target, move |sftp| files::mkdir(sftp, &path)).await
}

#[tauri::command]
pub(crate) async fn file_rename(
    state: State<'_, AppState>,
    target: Target,
    path: String,
    name: String,
) -> CommandResult<()> {
    files::validate_path(&path).map_err(error)?;
    let parent = path
        .rsplit_once('/')
        .map(|(directory, _)| if directory.is_empty() { "/" } else { directory })
        .unwrap_or("/");
    let to = files::join_name(parent, &name).map_err(error)?;
    with_local_sftp(&state, target, move |sftp| files::rename(sftp, &path, &to)).await
}

#[tauri::command]
pub(crate) async fn file_chmod(
    state: State<'_, AppState>,
    target: Target,
    path: String,
    mode: String,
) -> CommandResult<()> {
    files::validate_path(&path).map_err(error)?;
    let mode = files::parse_mode(&mode).map_err(error)?;
    with_local_sftp(&state, target, move |sftp| files::chmod(sftp, &path, mode)).await
}

#[tauri::command]
pub(crate) async fn file_read(
    state: State<'_, AppState>,
    target: Target,
    path: String,
) -> CommandResult<String> {
    files::validate_path(&path).map_err(error)?;
    with_local_sftp(&state, target, move |sftp| files::read_text(sftp, &path)).await
}

#[tauri::command]
pub(crate) async fn file_write(
    state: State<'_, AppState>,
    target: Target,
    path: String,
    content: String,
) -> CommandResult<()> {
    files::validate_path(&path).map_err(error)?;
    with_local_sftp(&state, target, move |sftp| {
        files::write_bytes(sftp, &path, content.as_bytes())
    })
    .await
}

#[tauri::command]
pub(crate) async fn file_close(target: Target) -> CommandResult<()> {
    if let Target::Local { id } = target {
        files::forget(id);
    }
    Ok(())
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
        Ok(json!({"status":"success","message":"SSH / SFTP 连通正常"}))
    })
    .await
    .map_err(error)?
    .map_err(error)
}

#[tauri::command]
pub(crate) async fn host_metrics_probe(
    state: State<'_, AppState>,
    host_id: Uuid,
) -> CommandResult<monitor::HostMetrics> {
    let database = state.database.to_path_buf();
    let known = state.known_hosts.to_path_buf();
    let cached = state.monitor_sessions.lock().await.remove(&host_id);
    let (metrics, session) = tokio::task::spawn_blocking(
        move || -> Result<(monitor::HostMetrics, ssh2::Session)> {
            let hosts = storage::list(&storage::open(&database)?)?;
            let host = hosts
                .into_iter()
                .find(|host| host.id == Some(host_id))
                .context("主机不存在或已删除")?;
            let probe = monitor::probe(cached, &host, &known)?;
            Ok((probe.metrics, probe.session))
        },
    )
    .await
    .map_err(error)?
    .map_err(error)?;
    state.monitor_sessions.lock().await.insert(host_id, session);
    Ok(metrics)
}

#[tauri::command]
pub(crate) async fn host_metrics_stop(
    state: State<'_, AppState>,
    host_id: Uuid,
) -> CommandResult<()> {
    state.monitor_sessions.lock().await.remove(&host_id);
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_yaml_batch_import_records() -> Result<()> {
        let document: BatchImportDocument = serde_yaml::from_str(
            r#"hosts:
  - name: app-prod
    ip: 10.20.30.40
    ssh_user: deploy
    ssh_port: 2222
    ssh_password: secret
    group: production"#,
        )?;
        assert_eq!(document.hosts.len(), 1);
        let host = document.hosts[0].local_host(2)?;
        assert_eq!(host.name, "app-prod");
        assert_eq!(host.address, "10.20.30.40");
        assert_eq!(host.port, 2222);
        assert_eq!(host.group, "production");
        assert!(host.has_password);
        Ok(())
    }

    #[test]
    fn defaults_batch_import_port_to_ssh_default() -> Result<()> {
        let host = BatchImportHost {
            name: "app-dev".into(),
            ip: "10.20.30.40".into(),
            ssh_user: "ops".into(),
            ..Default::default()
        }
        .local_host(2)?;
        assert_eq!(host.port, 22);
        assert!(!host.has_password);
        Ok(())
    }

    #[test]
    fn writes_an_importable_excel_template() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("hosts.xlsx");
        write_batch_import_template(&path)?;
        let hosts = import_excel(&path)?;
        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[0].name, "web-server-01");
        assert_eq!(hosts[1].group, "预发布");
        Ok(())
    }

    #[test]
    fn writes_an_importable_yaml_template() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("hosts.yaml");
        write_yaml_batch_import_template(&path)?;
        let hosts = import_batch_file(&path)?;
        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[0].name, "web-server-01");
        assert_eq!(hosts[1].group, "预发布");
        Ok(())
    }

    #[test]
    fn rejects_legacy_yaml_batch_import_fields() {
        let result = serde_yaml::from_str::<BatchImportDocument>(
            r#"hosts:
  - Host: app-prod
    HostName: 10.20.30.40
    User: deploy"#,
        );
        assert!(result.is_err());
    }
}

#[tauri::command]
pub(crate) fn system_shell_info() -> Value {
    let (_, name) = crate::terminal::system_shell();
    json!({"name":name})
}
