use anyhow::{Result, ensure};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

pub(crate) const TERMINAL_THEME: &str = "pixiu-shell";
// Stored in preferences written by the previous TShell-branded build.
const LEGACY_TERMINAL_THEME: &str = "tshell";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
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
    pub group_by: String,
    pub mode: String,
    pub platform_address: String,
    pub ai_base_url: String,
    pub ai_model: String,
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
            group_by: "group".into(),
            mode: "local".into(),
            platform_address: String::new(),
            ai_base_url: String::new(),
            ai_model: String::new(),
        }
    }
}
impl Preferences {
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
            ["group", "tag"].contains(&self.group_by.as_str()),
            "分组方式无效"
        );
        ensure!(
            ["local", "platform"].contains(&self.mode.as_str()),
            "工作模式无效"
        );
        if !self.platform_address.is_empty() {
            crate::platform::normalize_base(&self.platform_address)?;
        }
        ensure!(
            self.ai_base_url.len() <= 2048 && self.ai_model.len() <= 256,
            "AI 配置过长"
        );
        if !self.ai_base_url.is_empty() {
            let url = url::Url::parse(&self.ai_base_url)?;
            ensure!(
                matches!(url.scheme(), "https" | "http") && url.host().is_some(),
                "AI 网关地址无效"
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
}
