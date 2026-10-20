use anyhow::{Context, Result, ensure};
use uuid::Uuid;
use zeroize::Zeroizing;

fn entry(id: Uuid) -> Result<keyring::Entry> {
    keyring::Entry::new("com.chenlian.tshell.ssh", &id.to_string()).context("无法访问系统凭据库")
}

fn ai_entry() -> Result<keyring::Entry> {
    keyring::Entry::new("com.chenlian.tshell.ai", "openai-compatible-api-key")
        .context("无法访问 AI 系统凭据")
}

pub(crate) fn ai_key_configured() -> Result<bool> {
    match ai_entry()?.get_password() {
        Ok(value) => Ok(!value.is_empty()),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(error) => Err(error).context("无法读取 AI 系统凭据"),
    }
}

pub(crate) fn read_ai_key() -> Result<Zeroizing<String>> {
    match ai_entry()?.get_password() {
        Ok(value) if !value.is_empty() => Ok(Zeroizing::new(value)),
        Ok(_) | Err(keyring::Error::NoEntry) => anyhow::bail!("请先在设置 > AI 中配置 API Key"),
        Err(error) => Err(error).context("无法读取 AI 系统凭据"),
    }
}

pub(crate) fn save_ai_key(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty() && value.len() <= 8192 && !value.contains(['\0', '\n', '\r']),
        "AI API Key 不能为空、过长或含换行符"
    );
    ai_entry()?
        .set_password(value)
        .context("保存 AI API Key 失败")
}

pub(crate) fn delete_ai_key() -> Result<()> {
    match ai_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error).context("删除 AI API Key 失败"),
    }
}
pub(crate) fn read(id: Uuid) -> Result<Option<Zeroizing<String>>> {
    match entry(id)?.get_password() {
        Ok(password) => Ok(Some(Zeroizing::new(password))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error).context("无法读取主机密码，请检查系统凭据库权限"),
    }
}
pub(crate) fn write(id: Uuid, password: &str) -> Result<()> {
    ensure!(
        !password.is_empty() && password.len() <= 4096 && !password.contains(['\0', '\n', '\r']),
        "密码不能为空、过长或含换行符"
    );
    entry(id)?
        .set_password(password)
        .context("保存主机密码失败")
}
pub(crate) fn delete(id: Uuid) -> Result<()> {
    match entry(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error).context("删除系统凭据失败"),
    }
}

// Invoked only by OpenSSH as a helper; passwords never appear in argv or environment.
pub fn askpass() -> Result<()> {
    use std::io::Write;
    let prompt = std::env::args().nth(1).unwrap_or_default();
    if std::env::var("SSH_ASKPASS_PROMPT").as_deref() == Ok("confirm") || prompt.contains("yes/no")
    {
        let accepted = rfd::MessageDialog::new()
            .set_title("Pixiu Shell · 验证 SSH 主机指纹")
            .set_description(&prompt)
            .set_buttons(rfd::MessageButtons::YesNo)
            .show()
            == rfd::MessageDialogResult::Yes;
        std::io::stdout().write_all(if accepted { b"yes\n" } else { b"no\n" })?;
        return Ok(());
    }
    let normalized = prompt.to_ascii_lowercase();
    ensure!(
        normalized.contains("password") || normalized.contains("passphrase"),
        "不支持的 SSH 认证提示"
    );
    let id = Uuid::parse_str(&std::env::var("TSHELL_CREDENTIAL_ID")?)?;
    let password = read(id)?.context("此主机未保存密码")?;
    std::io::stdout().write_all(password.as_bytes())?;
    std::io::stdout().write_all(b"\n")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires TSHELL_APP_EXECUTABLE pointing to a built desktop binary"]
    fn real_askpass_helper_uses_keychain_without_argv_secrets() -> Result<()> {
        let id = Uuid::new_v4();
        let executable = std::env::var("TSHELL_APP_EXECUTABLE")?;
        write(id, "tshell-fixture-secret")?;
        let result = std::process::Command::new(executable)
            .env("TSHELL_ASKPASS", "1")
            .env("TSHELL_CREDENTIAL_ID", id.to_string())
            .arg("fixture@localhost's password:")
            .output();
        delete(id)?;
        let output = result?;
        ensure!(output.status.success(), "askpass helper failed");
        assert_eq!(output.stdout, b"tshell-fixture-secret\n");
        assert!(output.stderr.is_empty());
        Ok(())
    }
}
