use crate::storage::LocalHost;
use anyhow::{Context, Result, bail, ensure};
use base64::Engine;
use serde::Serialize;
use ssh2::{CheckResult, KnownHostFileKind, Session, Sftp};
use std::{
    io::{Read, Write},
    path::Path,
    time::Duration,
};

pub(crate) const MAX_TRANSFER: u64 = 64 * 1024 * 1024;
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileItem {
    name: String,
    path: String,
    kind: &'static str,
    size: u64,
    permissions: String,
    modified_at: Option<String>,
}
pub(crate) fn validate_path(path: &str) -> Result<()> {
    ensure!(
        path.starts_with('/') && !path.contains(['\0', '\n', '\r']) && path.len() <= 4096,
        "请输入绝对远程路径"
    );
    Ok(())
}
pub(crate) fn connect(host: &LocalHost, known_hosts: &Path) -> Result<Sftp> {
    connect_with_credentials(host, known_hosts, None, None)
}
pub(crate) fn connect_with_credentials(
    host: &LocalHost,
    known_hosts: &Path,
    supplied_password: Option<&str>,
    proxy_password: Option<&str>,
) -> Result<Sftp> {
    host.validate()?;
    let socket = crate::proxy::connect_with_password(
        &host.address,
        host.port,
        host.proxy.as_ref(),
        host.id,
        proxy_password,
    )?;
    socket.set_read_timeout(Some(Duration::from_secs(30)))?;
    socket.set_write_timeout(Some(Duration::from_secs(30)))?;
    let mut session = Session::new()?;
    session.set_timeout(30000);
    session.set_tcp_stream(socket);
    session.handshake().context("SSH 握手失败")?;
    let (key, key_type) = session.host_key().context("服务器没有主机公钥")?;
    let mut known = session.known_hosts()?;
    if known_hosts.exists() {
        known.read_file(known_hosts, KnownHostFileKind::OpenSSH)?;
    }
    match known.check_port(&host.address, host.port, key) {
        CheckResult::Match => {}
        CheckResult::NotFound => {
            let fingerprint = session
                .host_key_hash(ssh2::HashType::Sha256)
                .context("无法计算主机指纹")?;
            let fingerprint = base64::engine::general_purpose::STANDARD_NO_PAD.encode(fingerprint);
            let message = format!(
                "{}:{}\nSHA256:{}\n\n请通过可信渠道核对该指纹后确认。",
                host.address, host.port, fingerprint
            );
            ensure!(
                rfd::MessageDialog::new()
                    .set_title("TSHELL · 验证 SFTP 主机指纹")
                    .set_description(message)
                    .set_buttons(rfd::MessageButtons::YesNo)
                    .show()
                    == rfd::MessageDialogResult::Yes,
                "已取消主机指纹确认"
            );
            let hostname = if host.port == 22 {
                host.address.to_string()
            } else {
                format!("[{}]:{}", host.address, host.port)
            };
            known.add(&hostname, key, "TSHELL", key_type.into())?;
            known.write_file(known_hosts, KnownHostFileKind::OpenSSH)?;
        }
        CheckResult::Mismatch => bail!("SSH 主机指纹已改变，连接已拒绝。请先确认服务器身份。"),
        CheckResult::Failure => bail!("无法核验 SSH 主机指纹"),
    }
    let stored_password = if host.has_password && supplied_password.is_none() {
        crate::credentials::read(host.id.context("主机缺少 ID")?)?
    } else {
        None
    };
    let password = supplied_password.or_else(|| stored_password.as_deref().map(String::as_str));
    if !host.identity_file.is_empty() {
        session
            .userauth_pubkey_file(
                &host.username,
                None,
                Path::new(&host.identity_file),
                password,
            )
            .context("SFTP 私钥认证失败")?;
    } else if let Some(password) = password {
        session
            .userauth_password(&host.username, password)
            .context("SFTP 密码认证失败")?;
    } else {
        session
            .userauth_agent(&host.username)
            .context("SFTP 需要保存主机密码、配置私钥或解锁 SSH Agent，请在主机配置中设置")?;
    }
    ensure!(session.authenticated(), "SFTP 认证失败");
    session.sftp().context("服务器不支持 SFTP")
}
pub(crate) fn list(sftp: &Sftp, path: &str) -> Result<Vec<FileItem>> {
    validate_path(path)?;
    let mut items = Vec::new();
    for (path, stat) in sftp.readdir(Path::new(path))? {
        let name = path
            .file_name()
            .context("文件名无效")?
            .to_string_lossy()
            .into_owned();
        if name == "." || name == ".." {
            continue;
        }
        items.push(FileItem {
            name,
            path: path.to_string_lossy().into_owned(),
            kind: if stat.is_dir() {
                "directory"
            } else if stat.file_type().is_symlink() {
                "symlink"
            } else {
                "file"
            },
            size: stat.size.unwrap_or(0),
            permissions: format!("{:o}", stat.perm.unwrap_or(0) & 0o7777),
            modified_at: stat.mtime.map(|value| value.to_string()),
        });
    }
    Ok(items)
}
pub(crate) fn upload(sftp: &Sftp, remote: &str, source: &Path) -> Result<()> {
    validate_path(remote)?;
    ensure!(
        std::fs::metadata(source)?.len() <= MAX_TRANSFER,
        "单文件上限为 64 MiB"
    );
    let mut input = std::fs::File::open(source)?;
    // Exclusive create prevents an accidental overwrite or symlink replacement.
    let mut output = sftp
        .open_mode(
            Path::new(remote),
            ssh2::OpenFlags::WRITE | ssh2::OpenFlags::CREATE | ssh2::OpenFlags::EXCLUSIVE,
            0o600,
            ssh2::OpenType::File,
        )
        .context("无法新建远程文件，若文件已存在请先重命名或删除")?;
    std::io::copy(&mut input, &mut output)?;
    output.close()?;
    Ok(())
}
pub(crate) fn download(sftp: &Sftp, remote: &str) -> Result<Vec<u8>> {
    validate_path(remote)?;
    let mut data = Vec::new();
    sftp.open(Path::new(remote))?
        .take(MAX_TRANSFER + 1)
        .read_to_end(&mut data)?;
    ensure!(data.len() as u64 <= MAX_TRANSFER, "单文件上限为 64 MiB");
    Ok(data)
}
pub(crate) fn delete(sftp: &Sftp, remote: &str) -> Result<()> {
    validate_path(remote)?;
    ensure!(remote != "/", "不能删除根目录");
    sftp.unlink(Path::new(remote))
        .context("无法删除文件；文件夹不支持删除")
}
pub(crate) fn write_download(destination: &Path, bytes: &[u8]) -> Result<()> {
    let parent = destination.parent().context("保存路径无效")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    temporary.persist(destination).context("保存下载文件失败")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_control_characters_and_relative_paths() {
        for path in ["../etc", "relative", "/tmp/a\nrm", "/tmp/a\0b"] {
            assert!(validate_path(path).is_err());
        }
        assert!(validate_path("/tmp/中文 文件.txt").is_ok());
    }
    #[test]
    #[ignore = "requires tests/ssh_fixture.py and TSHELL_SSH_FIXTURE"]
    fn draft_connectivity_uses_ephemeral_password_and_rejects_bad_auth() -> Result<()> {
        let fixture: serde_json::Value =
            serde_json::from_slice(&std::fs::read(std::env::var("TSHELL_SSH_FIXTURE")?)?)?;
        let host = LocalHost {
            id: None,
            name: "unsaved draft".into(),
            address: "127.0.0.1".into(),
            port: fixture["port"].as_u64().context("port")? as u16,
            username: "fixture".into(),
            group: String::new(),
            identity_file: String::new(),
            note: String::new(),
            tags: vec![],
            tunnels: vec![],
            has_password: false,
            proxy: None,
        };
        let known = Path::new(fixture["knownHosts"].as_str().context("known hosts")?);
        assert!(connect_with_credentials(&host, known, Some("incorrect-password"), None).is_err());
        let sftp = connect_with_credentials(&host, known, Some("tshell-fixture-password"), None)?;
        assert!(
            list(&sftp, "/")?
                .iter()
                .any(|entry| entry.name == "welcome.txt")
        );
        assert!(host.id.is_none());
        Ok(())
    }
    #[test]
    #[ignore = "requires tests/ssh_fixture.py and TSHELL_SSH_FIXTURE"]
    fn real_sftp_key_and_password_roundtrip() -> Result<()> {
        let fixture: serde_json::Value =
            serde_json::from_slice(&std::fs::read(std::env::var("TSHELL_SSH_FIXTURE")?)?)?;
        let mut host = LocalHost {
            id: Some(uuid::Uuid::new_v4()),
            name: "fixture".into(),
            address: "127.0.0.1".into(),
            port: fixture["port"].as_u64().context("port")? as u16,
            username: "fixture".into(),
            group: String::new(),
            identity_file: fixture["identity"].as_str().context("identity")?.into(),
            note: String::new(),
            tags: vec![],
            tunnels: vec![],
            has_password: false,
            proxy: None,
        };
        let known = Path::new(fixture["knownHosts"].as_str().context("knownHosts")?);
        let sftp = connect(&host, known)?;
        assert!(
            list(&sftp, "/")?
                .iter()
                .any(|entry| entry.name == "welcome.txt")
        );
        let dir = tempfile::tempdir()?;
        let file = dir.path().join("upload.txt");
        std::fs::write(&file, "roundtrip 中文\n")?;
        upload(&sftp, "/roundtrip.txt", &file)?;
        assert!(
            upload(&sftp, "/roundtrip.txt", &file).is_err(),
            "must not overwrite existing files"
        );
        assert_eq!(
            download(&sftp, "/roundtrip.txt")?,
            "roundtrip 中文\n".as_bytes()
        );
        delete(&sftp, "/roundtrip.txt")?;
        assert!(
            !list(&sftp, "/")?
                .iter()
                .any(|entry| entry.name == "roundtrip.txt")
        );
        let id = host.id.context("id")?;
        crate::credentials::write(id, "tshell-fixture-password")?;
        host.identity_file.clear();
        host.has_password = true;
        let result = connect(&host, known).and_then(|sftp| download(&sftp, "/welcome.txt"));
        crate::credentials::delete(id)?;
        assert!(String::from_utf8(result?)?.contains("你好"));
        Ok(())
    }
}
