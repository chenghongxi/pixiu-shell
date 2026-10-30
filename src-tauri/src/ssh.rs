use crate::hostkey;
use crate::storage::LocalHost;
use anyhow::{Context, Result, bail, ensure};
use ssh2::{MethodType, Session};
use std::collections::VecDeque;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Advertised to remote shells; matches the TERM the previous OpenSSH
/// invocation set, so prompt detection and colors keep working unchanged.
pub(crate) const TERM: &str = "xterm-256color";

/// Algorithm preferences, fastest first. libssh2 silently skips anything the
/// crypto backend or the server does not offer, so this never narrows what a
/// connection can negotiate — it only reorders it: curve25519 replaces slow
/// modular exponentiation during the handshake, chacha20 is much faster than
/// AES on CPUs without AES-NI, and ed25519 host keys avoid RSA signing cost.
const PREFERRED_KEX: &str = "curve25519-sha256,curve25519-sha256@libssh.org,diffie-hellman-group16-sha512,diffie-hellman-group-exchange-sha256,diffie-hellman-group14-sha256";
const PREFERRED_HOST_KEY: &str =
    "ssh-ed25519,ecdsa-sha2-nistp256,ecdsa-sha2-nistp384,rsa-sha2-512,rsa-sha2-256,ssh-rsa";
const PREFERRED_CIPHER: &str = "chacha20-poly1305@openssh.com,aes128-gcm@openssh.com,aes256-gcm@openssh.com,aes128-ctr,aes256-ctr,aes192-ctr";
const PREFERRED_MAC: &str = "hmac-sha2-256-etm@openssh.com,hmac-sha2-512-etm@openssh.com,hmac-sha2-256,hmac-sha2-512,hmac-sha1";

fn prefer(session: &Session, method: MethodType, algorithms: &str) {
    if let Err(error) = session.method_pref(method, algorithms) {
        eprintln!("[pixiu-shell] 无法设置 SSH 算法偏好：{error}");
    }
}

/// Sleep between non-blocking polls. libssh2 has no thread-safe blocking
/// read, so every session drives its channels from its own poll loop.
pub(crate) const POLL: Duration = Duration::from_millis(5);

/// Writes as much of `queue` as `sink` accepts right now. Returns true when
/// the sink failed and the caller must give up on it.
pub(crate) fn drain(queue: &mut VecDeque<u8>, sink: &mut dyn Write) -> bool {
    while !queue.is_empty() {
        let (front, back) = queue.as_slices();
        let chunk = if front.is_empty() { back } else { front };
        match sink.write(chunk) {
            Ok(0) => return false,
            Ok(count) => {
                queue.drain(..count);
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => return false,
            Err(_) => return true,
        }
    }
    false
}

/// Reports connection progress. The terminal turns these into visible stages,
/// so a slow host shows where it is instead of a blank screen.
fn report(stage: Option<&dyn Fn(&str)>, message: &str) {
    if let Some(stage) = stage {
        stage(message);
    }
}

/// libssh2's from-file API uses C `fopen`, which on Windows cannot open
/// Unicode paths such as `D:\奈哥虚拟机密钥\id_rsa`. Read the PEM with Rust
/// and copy it to an ASCII temp file before handing it to libssh2.
fn authenticate_with_key(
    session: &Session,
    host: &LocalHost,
    passphrase: Option<&str>,
) -> Result<()> {
    let path = Path::new(&host.identity_file);
    ensure!(
        path.is_file(),
        "指定的私钥文件不存在（请填写绝对路径）"
    );
    let private = read_identity(path)?;
    if let Some(reason) = unsupported_identity(&private) {
        bail!("{reason}");
    }
    let public = sibling_public_key(path);
    // Stage through an ASCII temp path so libssh2's fopen can read Xshell
    // keys stored under Chinese folders.
    let staged = stage_identity(&private, public.as_deref())?;
    let mut result = session.userauth_pubkey_file(
        &host.username,
        staged.public.as_ref().map(|file| file.path()),
        staged.private.path(),
        passphrase,
    );
    if result.is_err() && staged.public.is_some() {
        result = session.userauth_pubkey_file(
            &host.username,
            None,
            staged.private.path(),
            passphrase,
        );
    }
    result.map_err(|error| key_auth_error(&host.username, error))
}

fn read_identity(path: &Path) -> Result<String> {
    let mut bytes =
        std::fs::read(path).with_context(|| format!("无法读取私钥文件 {}", path.display()))?;
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        bytes.drain(..3);
    }
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        bail!("私钥是 UTF-16 编码，请在 Xshell 中重新导出为 OpenSSH 文本格式");
    }
    String::from_utf8(bytes).context("私钥文件不是 UTF-8 文本，Xshell 请导出为 OpenSSH 格式")
}

struct StagedIdentity {
    private: tempfile::NamedTempFile,
    public: Option<tempfile::NamedTempFile>,
}

fn fopen_temp_dir() -> PathBuf {
    let tmp = std::env::temp_dir();
    if tmp.to_string_lossy().chars().all(|c| c.is_ascii()) {
        tmp
    } else if cfg!(windows) && Path::new(r"C:\Windows\Temp").is_dir() {
        PathBuf::from(r"C:\Windows\Temp")
    } else {
        tmp
    }
}

fn stage_identity(private: &str, public: Option<&str>) -> Result<StagedIdentity> {
    let dir = fopen_temp_dir();
    let mut private_file = tempfile::Builder::new()
        .prefix("pixiu-id-")
        .suffix(".pem")
        .tempfile_in(&dir)
        .context("无法创建临时私钥文件")?;
    private_file.write_all(private.as_bytes())?;
    private_file.flush()?;
    let public_file = public
        .map(|public| -> Result<_> {
            let mut file = tempfile::Builder::new()
                .prefix("pixiu-id-")
                .suffix(".pub")
                .tempfile_in(&dir)
                .context("无法创建临时公钥文件")?;
            file.write_all(public.as_bytes())?;
            file.flush()?;
            Ok(file)
        })
        .transpose()?;
    Ok(StagedIdentity {
        private: private_file,
        public: public_file,
    })
}

fn sibling_public_key(private: &Path) -> Option<String> {
    let name = private.file_name()?.to_str()?;
    let text = std::fs::read_to_string(private.with_file_name(format!("{name}.pub"))).ok()?;
    let trimmed = text.trim();
    let kind = trimmed.split_whitespace().next().unwrap_or("");
    matches!(
        kind,
        "ssh-rsa"
            | "ssh-ed25519"
            | "ssh-dss"
            | "ecdsa-sha2-nistp256"
            | "ecdsa-sha2-nistp384"
            | "ecdsa-sha2-nistp521"
    )
    .then(|| trimmed.to_string())
}

fn unsupported_identity(pem: &str) -> Option<String> {
    if pem.contains("PuTTY-User-Key-File") {
        return Some(
            "这是 PuTTY/Xshell 的 ppk 私钥，pixiu-shell 需要 OpenSSH 格式。请在 Xshell「用户密钥管理器」中导出为 OpenSSH。"
                .into(),
        );
    }
    if pem.contains("BEGIN SSH2") {
        return Some("这是 SSH2 格式私钥，请在 Xshell 中导出为 OpenSSH 格式后再连接。".into());
    }
    if !pem.contains("BEGIN") || !pem.contains("PRIVATE KEY") {
        return Some(
            "无法识别私钥格式。Xshell 导出时请选择 OpenSSH，文件应以 -----BEGIN 开头。".into(),
        );
    }
    None
}

fn key_auth_error(username: &str, error: ssh2::Error) -> anyhow::Error {
    let detail = error.to_string();
    let lower = detail.to_ascii_lowercase();
    if lower.contains("passphrase") {
        anyhow::anyhow!("SSH 私钥认证失败：私钥口令不正确")
    } else if lower.contains("username/publickey") || lower.contains("authentication failed") {
        anyhow::anyhow!(
            "SSH 私钥认证失败：服务器拒绝了用户 {username} 的公钥，请确认用户名与 Xshell 中一致，且 authorized_keys 包含对应公钥"
        )
    } else if lower.contains("unable to extract") || lower.contains("unrecognized") {
        anyhow::anyhow!(
            "SSH 私钥认证失败：无法解析私钥，Xshell 请导出为 OpenSSH（PEM）格式。{detail}"
        )
    } else {
        anyhow::anyhow!("SSH 私钥认证失败：{detail}")
    }
}

/// Single entry point for every local SSH feature — terminal, SFTP and
/// monitoring probes must share the same proxy hops, host-key decisions and
/// credentials, otherwise they can disagree about which machine they reached.
pub(crate) fn connect_session(
    host: &LocalHost,
    known_hosts: &Path,
    supplied_password: Option<&str>,
    proxy_password: Option<&str>,
    stage: Option<&dyn Fn(&str)>,
) -> Result<Session> {
    host.validate()?;
    report(stage, &format!("正在连接 {}:{}", host.address, host.port));
    let socket = crate::proxy::connect_with_password(
        &host.address,
        host.port,
        host.proxy.as_ref(),
        host.id,
        proxy_password,
    )?;
    socket.set_read_timeout(Some(std::time::Duration::from_secs(30)))?;
    socket.set_write_timeout(Some(std::time::Duration::from_secs(30)))?;
    let mut session = Session::new()?;
    session.set_timeout(30000);
    // Preferences must be set before the handshake starts negotiating.
    for (method, algorithms) in [
        (MethodType::Kex, PREFERRED_KEX),
        (MethodType::HostKey, PREFERRED_HOST_KEY),
        (MethodType::CryptCs, PREFERRED_CIPHER),
        (MethodType::CryptSc, PREFERRED_CIPHER),
        (MethodType::MacCs, PREFERRED_MAC),
        (MethodType::MacSc, PREFERRED_MAC),
    ] {
        prefer(&session, method, algorithms);
    }
    session.set_tcp_stream(socket);
    report(stage, "正在进行 SSH 握手");
    session.handshake().context("SSH 握手失败")?;
    let (key, raw_key_type) = session.host_key().context("服务器没有主机公钥")?;
    report(stage, "正在校验主机指纹");
    hostkey::verify(
        &session,
        known_hosts,
        &host.address,
        host.port,
        key,
        raw_key_type,
    )
    .context("无法核验主机指纹")?;
    let stored_password = if host.has_password && supplied_password.is_none() {
        crate::credentials::read(host.id.context("主机缺少 ID")?)?
    } else {
        None
    };
    let password = supplied_password.or_else(|| stored_password.as_deref().map(String::as_str));
    report(stage, "正在进行 SSH 认证");
    if !host.identity_file.is_empty() {
        authenticate_with_key(&session, host, password)?;
    } else if let Some(password) = password {
        session
            .userauth_password(&host.username, password)
            .context("SSH 密码认证失败")?;
    } else {
        session
            .userauth_agent(&host.username)
            .context("SSH 需要保存主机密码、配置私钥或解锁 SSH Agent，请在主机配置中设置")?;
    }
    ensure!(session.authenticated(), "SSH 认证失败");
    Ok(session)
}

/// Opens an interactive shell on an authenticated session. Call while the
/// session is still blocking: these three round trips are part of connection
/// setup, and the caller switches the session afterwards.
pub(crate) fn open_shell(session: &Session, cols: u16, rows: u16) -> Result<ssh2::Channel> {
    let mut channel = session.channel_session().context("无法打开 SSH 通道")?;
    channel
        .request_pty(TERM, None, Some((cols.into(), rows.into(), 0, 0)))
        .context("服务器拒绝了 PTY 请求，请确认该账户允许交互式登录")?;
    channel.shell().context("无法启动远程 Shell")?;
    Ok(channel)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_ppk_and_ssh2_identities() {
        assert!(unsupported_identity("PuTTY-User-Key-File-2: ssh-rsa\n").is_some());
        assert!(unsupported_identity("---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----\n").is_some());
        assert!(unsupported_identity("-----BEGIN RSA PRIVATE KEY-----\nMIIE\n").is_none());
        assert!(unsupported_identity("-----BEGIN OPENSSH PRIVATE KEY-----\n").is_none());
        assert!(unsupported_identity("not a key").is_some());
    }

    #[test]
    fn reads_identity_from_unicode_path() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("奈哥虚拟机密钥");
        std::fs::create_dir(&folder).unwrap();
        let path = folder.join("id_rsa_2048");
        std::fs::write(
            &path,
            "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\n",
        )
        .unwrap();
        let pem = read_identity(&path).unwrap();
        assert!(pem.contains("BEGIN RSA PRIVATE KEY"));
        assert!(sibling_public_key(&path).is_none());
        std::fs::write(
            folder.join("id_rsa_2048.pub"),
            "ssh-rsa AAAAB3NzaC1yc2EAAAABIwAAAQEA comment\n",
        )
        .unwrap();
        assert!(sibling_public_key(&path).unwrap().starts_with("ssh-rsa "));
        let staged = stage_identity(&pem, sibling_public_key(&path).as_deref()).unwrap();
        let staged_path = staged.private.path().to_string_lossy();
        assert!(staged_path.chars().all(|c| c.is_ascii()), "{staged_path}");
    }
}
