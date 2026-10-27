use anyhow::{Context, Result, ensure};
use std::io::Write;
use std::time::Duration;
use uuid::Uuid;
use zeroize::Zeroizing;

/// The window answers a prompt on human time, so the helper has to wait far
/// longer than any network round trip would.
const REPLY_TIMEOUT: Duration = Duration::from_secs(300);

fn entry(id: Uuid) -> Result<keyring::Entry> {
    keyring::Entry::new(crate::auth_store::SSH_SERVICE, &id.to_string())
        .context("无法访问系统凭据库")
}

fn ai_entry() -> Result<keyring::Entry> {
    keyring::Entry::new(crate::auth_store::AI_SERVICE, crate::auth_store::AI_ACCOUNT)
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
    // OpenSSH may split the question into several argv words.
    let prompt = std::env::args().skip(1).collect::<Vec<_>>().join(" ");
    if std::env::var("SSH_ASKPASS_PROMPT").as_deref() == Ok("confirm") || prompt.contains("yes/no")
    {
        let answer = if confirm_host_key(&prompt) {
            "yes\n"
        } else {
            "no\n"
        };
        std::io::stdout().write_all(answer.as_bytes())?;
        return Ok(());
    }
    let normalized = prompt.to_ascii_lowercase();
    ensure!(
        normalized.contains("password") || normalized.contains("passphrase"),
        "不支持的 SSH 认证提示"
    );
    let id = Uuid::parse_str(&std::env::var("PIXIU_SHELL_CREDENTIAL_ID")?)?;
    let password = read(id)?.context("此主机未保存密码")?;
    std::io::stdout().write_all(password.as_bytes())?;
    std::io::stdout().write_all(b"\n")?;
    Ok(())
}

/// The helper is another process with no window of its own, so it dials back to
/// the loopback bridge and lets the app ask. There is no second path: a prompt
/// that cannot be shown must not be guessed at, so the answer becomes "no".
fn confirm_host_key(prompt: &str) -> bool {
    match ask_window(prompt) {
        Some(accepted) => accepted,
        None => {
            // OpenSSH only reads the helper's stdout, so anything written here
            // lands in the terminal and explains the refusal.
            eprintln!("pixiu-shell: 无法显示指纹确认窗口，已拒绝连接该主机");
            false
        }
    }
}

fn ask_window(prompt: &str) -> Option<bool> {
    use std::io::{BufRead, BufReader};
    let address = std::env::var(crate::askpass_bridge::ADDR_ENV).ok()?;
    let token = std::env::var(crate::askpass_bridge::TOKEN_ENV).ok()?;
    let stream = std::net::TcpStream::connect(address).ok()?;
    // The reply takes as long as the prompt does, plus the walk to the console.
    stream.set_read_timeout(Some(REPLY_TIMEOUT)).ok()?;
    let payload = serde_json::json!({ "token": token, "prompt": prompt });
    let mut writer = stream.try_clone().ok()?;
    writer.write_all(payload.to_string().as_bytes()).ok()?;
    writer.write_all(b"\n").ok()?;
    let mut reply = String::new();
    BufReader::new(stream).read_line(&mut reply).ok()?;
    Some(reply.trim().eq_ignore_ascii_case("yes"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires PIXIU_SHELL_APP_EXECUTABLE pointing to a built desktop binary"]
    fn real_askpass_helper_uses_keychain_without_argv_secrets() -> Result<()> {
        let id = Uuid::new_v4();
        let executable = std::env::var("PIXIU_SHELL_APP_EXECUTABLE")?;
        write(id, "pixiu-fixture-secret")?;
        let result = std::process::Command::new(executable)
            .env("PIXIU_SHELL_ASKPASS", "1")
            .env("PIXIU_SHELL_CREDENTIAL_ID", id.to_string())
            .arg("fixture@localhost's password:")
            .output();
        delete(id)?;
        let output = result?;
        ensure!(output.status.success(), "askpass helper failed");
        assert_eq!(output.stdout, b"pixiu-fixture-secret\n");
        assert!(output.stderr.is_empty());
        Ok(())
    }
}
