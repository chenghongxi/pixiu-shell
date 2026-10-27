use crate::hostkey;
use crate::storage::LocalHost;
use anyhow::{Context, Result, ensure};
use ssh2::{MethodType, Session};
use std::collections::VecDeque;
use std::io::{ErrorKind, Write};
use std::path::Path;
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
        session
            .userauth_pubkey_file(
                &host.username,
                None,
                Path::new(&host.identity_file),
                password,
            )
            .context("SSH 私钥认证失败")?;
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
