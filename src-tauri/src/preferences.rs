use anyhow::{Result, ensure};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub(crate) const TERMINAL_THEME: &str = "pixiu-shell";
// The window is transparent; lower values blend the whole surface into the desktop.
pub(crate) const MIN_WINDOW_OPACITY: u8 = 20;
// Stored in preferences written by the previous TShell-branded build.
const LEGACY_TERMINAL_THEME: &str = "tshell";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiGateway {
    pub id: Uuid,
    pub name: String,
    pub base_url: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UserShortcut {
    pub id: Uuid,
    pub name: String,
    pub binding: String,
    pub kind: String,
    pub text: String,
}

// Unknown keys are ignored: a stored blob written by a newer build must not
// keep the desktop client from starting.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Preferences {
    pub shortcuts: std::collections::BTreeMap<String, String>,
    pub upload_command: String,
    pub download_command: String,
    pub ai_panel_width: u16,
    pub sidebar_hidden: bool,
    pub theme: String,
    pub terminal_theme: String,
    pub font_size: u16,
    pub scrollback: u32,
    #[serde(alias = "panelOpacity")]
    pub window_opacity: u8,
    pub group_by: String,
    pub mode: String,
    /// Escape hatch: fall back to the system OpenSSH client for every host.
    pub ssh_engine: String,
    pub platform_address: String,
    pub ai_name: String,
    pub ai_base_url: String,
    pub ai_model: String,
    pub ai_gateways: Vec<AiGateway>,
    pub active_ai_gateway_id: Option<Uuid>,
    pub user_shortcuts: Vec<UserShortcut>,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            shortcuts: std::collections::BTreeMap::new(),
            upload_command: "cl-u".into(),
            download_command: "cl-d".into(),
            ai_panel_width: 400,
            sidebar_hidden: false,
            theme: "dark".into(),
            terminal_theme: TERMINAL_THEME.into(),
            font_size: 13,
            scrollback: 10000,
            window_opacity: 100,
            group_by: "group".into(),
            mode: "local".into(),
            ssh_engine: "builtin".into(),
            platform_address: String::new(),
            ai_name: String::new(),
            ai_base_url: String::new(),
            ai_model: String::new(),
            ai_gateways: Vec::new(),
            active_ai_gateway_id: None,
            user_shortcuts: Vec::new(),
        }
    }
}
impl Preferences {
    /// True when every local host should connect through the system ssh client.
    pub fn system_engine(&self) -> bool {
        self.ssh_engine == "system"
    }

    pub fn validate(&self) -> Result<()> {
        for (key, value) in &self.shortcuts {
            ensure!(
                [
                    "search",
                    "newShell",
                    "splitRight",
                    "splitDown",
                    "closeTab",
                    "nextTab",
                    "previousTab",
                    "settings",
                    "lock",
                    "zoomIn",
                    "zoomOut",
                    "zoomReset",
                    "fullscreen"
                ]
                .contains(&key.as_str())
                    && value.len() <= 64
                    && !value.chars().any(char::is_control),
                "快捷键配置无效"
            );
        }

        for name in [&self.upload_command, &self.download_command] {
            ensure!(
                !name.is_empty()
                    && name.len() <= 32
                    && name.starts_with(|c: char| c.is_ascii_alphabetic())
                    && name
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || "_-".contains(c)),
                "传输命令名须为字母开头的 1–32 位字母、数字、下划线或连字符"
            );
        }
        ensure!(
            self.upload_command != self.download_command,
            "上传和下载命令不能同名"
        );

        ensure!(
            (280..=1000).contains(&self.ai_panel_width),
            "AI 面板宽度应在 280–1000 像素之间"
        );
        ensure!(
            ["dark", "light", "system"].contains(&self.theme.as_str()),
            "主题无效"
        );
        ensure!(
            [
                TERMINAL_THEME,
                "windterm",
                "catppuccin",
                "dracula",
                "nord",
                "solarized",
                "paper"
            ]
            .contains(&self.terminal_theme.as_str()),
            "终端配色无效"
        );
        ensure!(
            (10..=24).contains(&self.font_size) && (1000..=100000).contains(&self.scrollback),
            "终端字号或历史行数超出范围"
        );
        ensure!(
            (MIN_WINDOW_OPACITY..=100).contains(&self.window_opacity),
            "界面透明度应在 20–100 之间"
        );
        ensure!(
            ["group", "tag"].contains(&self.group_by.as_str()),
            "分组方式无效"
        );
        ensure!(
            ["local", "platform"].contains(&self.mode.as_str()),
            "工作模式无效"
        );
        ensure!(
            ["builtin", "system"].contains(&self.ssh_engine.as_str()),
            "SSH 引擎无效"
        );
        if !self.platform_address.is_empty() {
            crate::platform::normalize_base(&self.platform_address)?;
        }
        ensure!(
            self.ai_name.len() <= 256
                && !self.ai_name.chars().any(char::is_control)
                && self.ai_base_url.len() <= 2048
                && self.ai_model.len() <= 256,
            "AI 配置过长"
        );
        if !self.ai_base_url.is_empty() {
            let url = url::Url::parse(&self.ai_base_url)?;
            ensure!(
                matches!(url.scheme(), "https" | "http") && url.host().is_some(),
                "AI 网关地址无效"
            );
        }
        ensure!(self.ai_gateways.len() <= 100, "AI 网关数量过多");
        let mut ids = std::collections::HashSet::new();
        for gateway in &self.ai_gateways {
            ensure!(
                ids.insert(gateway.id)
                    && gateway.name.len() <= 256
                    && !gateway.name.chars().any(char::is_control)
                    && gateway.base_url.len() <= 2048
                    && gateway.model.len() <= 256,
                "AI 网关配置无效"
            );
            let url = url::Url::parse(&gateway.base_url)?;
            ensure!(
                matches!(url.scheme(), "https" | "http") && url.host().is_some(),
                "AI 网关地址无效"
            );
        }
        ensure!(
            self.active_ai_gateway_id.is_none_or(|id| ids.contains(&id)),
            "当前 AI 网关不存在"
        );
        ensure!(self.user_shortcuts.len() <= 30, "用户按键最多 30 条");
        let mut shortcut_ids = std::collections::BTreeSet::new();
        let mut shortcut_bindings = std::collections::BTreeSet::new();
        for item in &self.user_shortcuts {
            ensure!(
                shortcut_ids.insert(item.id)
                    && !item.name.trim().is_empty()
                    && item.name.chars().count() <= 40
                    && !item.name.chars().any(char::is_control),
                "用户按键名称无效"
            );
            ensure!(
                !item.binding.is_empty()
                    && item.binding.len() <= 64
                    && !item.binding.chars().any(char::is_control)
                    && shortcut_bindings.insert(item.binding.clone())
                    && !self.shortcuts.values().any(|value| value == &item.binding),
                "用户按键快捷键无效"
            );
            ensure!(
                item.kind == "send" || item.kind == "sendEnter",
                "用户按键类型无效"
            );
            ensure!(
                !item.text.is_empty()
                    && item.text.chars().count() <= 2000
                    && !item.text.chars().any(char::is_control),
                "用户按键字符串无效"
            );
        }
        Ok(())
    }
}
pub(crate) fn load(db: &Connection) -> Result<Preferences> {
    let json: Option<String> = db
        .query_row(
            "SELECT value FROM settings WHERE key='preferences'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let mut prefs = match json {
        Some(json) => serde_json::from_str(&json)?,
        None => Preferences::default(),
    };
    prefs.platform_address = db
        .query_row(
            "SELECT value FROM settings WHERE key='platform_url'",
            [],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(prefs.platform_address);
    if prefs.terminal_theme == LEGACY_TERMINAL_THEME {
        prefs.terminal_theme = TERMINAL_THEME.into();
    }
    if prefs.ai_gateways.is_empty() && !prefs.ai_base_url.is_empty() {
        prefs.ai_gateways.push(AiGateway {
            id: Uuid::nil(),
            name: prefs.ai_name.clone(),
            base_url: prefs.ai_base_url.clone(),
            model: prefs.ai_model.clone(),
        });
        prefs.active_ai_gateway_id = Some(Uuid::nil());
    }
    prefs.validate()?;
    Ok(prefs)
}
pub(crate) fn save(db: &mut Connection, prefs: &Preferences) -> Result<()> {
    prefs.validate()?;
    let tx = db.transaction()?;
    tx.execute("INSERT INTO settings(key,value) VALUES('preferences',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [serde_json::to_string(prefs)?])?;
    tx.execute("INSERT INTO settings(key,value) VALUES('platform_url',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [&prefs.platform_address])?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settings_survive_reopening() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("data.db");
        let prefs = Preferences {
            theme: "light".into(),
            terminal_theme: "dracula".into(),
            font_size: 16,
            ai_panel_width: 620,
            platform_address: "https://ops.example.com".into(),
            ..Preferences::default()
        };
        save(&mut crate::storage::open(&path)?, &prefs)?;
        let restored = load(&crate::storage::open(&path)?)?;
        assert_eq!(restored.theme, "light");
        assert_eq!(restored.font_size, 16);
        assert_eq!(restored.ai_panel_width, 620);
        assert_eq!(restored.platform_address, "https://ops.example.com");
        Ok(())
    }
    #[test]
    fn window_opacity_stays_within_readable_range() {
        let mut prefs = Preferences::default();
        assert_eq!(prefs.window_opacity, 100);
        prefs.window_opacity = MIN_WINDOW_OPACITY;
        assert!(prefs.validate().is_ok());
        prefs.window_opacity = MIN_WINDOW_OPACITY - 1;
        assert!(prefs.validate().is_err());
        prefs.window_opacity = 101;
        assert!(prefs.validate().is_err());
    }
    #[test]
    fn stored_preferences_tolerate_legacy_and_unknown_keys() {
        let stored = r#"{
            "theme": "dark",
            "panelOpacity": 45,
            "someFieldFromANewerBuild": true
        }"#;
        let prefs: Preferences = serde_json::from_str(stored).unwrap();
        assert_eq!(prefs.window_opacity, 45);
        assert_eq!(prefs.font_size, Preferences::default().font_size);
    }
}
