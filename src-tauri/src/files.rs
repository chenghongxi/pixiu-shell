use crate::ssh::connect_session;
use crate::storage::LocalHost;
use anyhow::{Context, Result, ensure};
use serde::Serialize;
use ssh2::Sftp;
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    sync::{LazyLock, Mutex},
};
use uuid::Uuid;

/// One SFTP read or write. libssh2 puts at most this many bytes in a single
/// packet, and each packet waits for its reply, so the chunk size — not the
/// bandwidth — decides throughput on a high-latency link.
const CHUNK: usize = 256 * 1024;

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
    connect_session(host, known_hosts, supplied_password, proxy_password, None)?
        .sftp()
        .context("服务器不支持 SFTP")
}

/// Idle SFTP connections per host. Two covers the usual "browse while a
/// transfer runs" pattern without keeping many server sessions open.
const POOL_LIMIT: usize = 2;
static POOL: LazyLock<Mutex<HashMap<Uuid, Vec<Sftp>>>> = LazyLock::new(Default::default);

/// Drops cached connections for a host, e.g. after its credentials changed.
pub(crate) fn forget(id: Uuid) {
    if let Ok(mut pool) = POOL.lock() {
        pool.remove(&id);
    }
}

fn checkout(id: Uuid) -> Option<Sftp> {
    POOL.lock().ok()?.get_mut(&id)?.pop()
}

fn checkin(id: Uuid, sftp: Sftp) {
    if let Ok(mut pool) = POOL.lock() {
        let idle = pool.entry(id).or_default();
        if idle.len() < POOL_LIMIT {
            idle.push(sftp);
        }
    }
}

/// Runs one operation on a pooled connection. Reusing a session turns "list a
/// directory" into a single round trip instead of a TCP connect, handshake,
/// authentication and SFTP subsystem start every time.
pub(crate) fn with_sftp<T>(
    host: &LocalHost,
    known_hosts: &Path,
    operation: impl Fn(&Sftp) -> Result<T>,
) -> Result<T> {
    let id = host.id.context("主机缺少 ID，无法复用 SFTP 连接")?;
    let Some(sftp) = checkout(id) else {
        return run_fresh(id, host, known_hosts, operation);
    };
    match operation(&sftp) {
        Ok(value) => {
            checkin(id, sftp);
            Ok(value)
        }
        // Servers quietly drop idle sessions. Retry once on a fresh
        // connection before blaming the operation itself.
        Err(error) if from_libssh2(&error) => run_fresh(id, host, known_hosts, operation),
        Err(error) => {
            checkin(id, sftp);
            Err(error)
        }
    }
}

fn run_fresh<T>(
    id: Uuid,
    host: &LocalHost,
    known_hosts: &Path,
    operation: impl Fn(&Sftp) -> Result<T>,
) -> Result<T> {
    let sftp = connect(host, known_hosts)?;
    let result = operation(&sftp);
    if result.is_ok() {
        checkin(id, sftp);
    }
    result
}

/// True when libssh2 produced the error. Only that can mean "the cached
/// connection died"; our own validation errors must not force a reconnect.
fn from_libssh2(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.downcast_ref::<ssh2::Error>().is_some())
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

pub(crate) fn upload_with_progress(
    sftp: &Sftp,
    remote: &str,
    source: &Path,
    cancelled: &AtomicBool,
    mut progress: impl FnMut(u64, u64) -> Result<()>,
) -> Result<()> {
    validate_path(remote)?;
    let total = std::fs::metadata(source)?.len();
    let mut input = std::fs::File::open(source)?;
    let mut output = sftp
        .open_mode(
            Path::new(remote),
            ssh2::OpenFlags::WRITE | ssh2::OpenFlags::CREATE | ssh2::OpenFlags::EXCLUSIVE,
            0o600,
            ssh2::OpenType::File,
        )
        .context("无法新建远程文件，若文件已存在请先重命名或删除")?;
    let mut buffer = vec![0_u8; CHUNK];
    let mut transferred = 0_u64;
    progress(0, total)?;
    let result = (|| -> Result<()> {
        loop {
            ensure!(!cancelled.load(Ordering::SeqCst), "传输已取消");
            let count = input.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            output.write_all(&buffer[..count])?;
            transferred += count as u64;
            progress(transferred, total)?;
        }
        output.close()?;
        Ok(())
    })();
    if result.is_err() && cancelled.load(Ordering::SeqCst) {
        let _ = sftp.unlink(Path::new(remote));
    }
    result
}
pub(crate) fn download(sftp: &Sftp, remote: &str) -> Result<Vec<u8>> {
    validate_path(remote)?;
    let mut data = Vec::new();
    sftp.open(Path::new(remote))?.read_to_end(&mut data)?;
    Ok(data)
}

pub(crate) fn download_to_with_progress(
    sftp: &Sftp,
    remote: &str,
    destination: &Path,
    cancelled: &AtomicBool,
    mut progress: impl FnMut(u64, u64) -> Result<()>,
) -> Result<()> {
    validate_path(remote)?;
    let mut input = sftp.open(Path::new(remote))?;
    let total = input.stat()?.size.unwrap_or(0);
    let parent = destination.parent().context("保存路径无效")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    let mut buffer = vec![0_u8; CHUNK];
    let mut transferred = 0_u64;
    progress(0, total)?;
    loop {
        ensure!(!cancelled.load(Ordering::SeqCst), "传输已取消");
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        transferred += count as u64;
        temporary.write_all(&buffer[..count])?;
        progress(transferred, total)?;
    }
    temporary.as_file().sync_all()?;
    temporary.persist(destination).context("保存下载文件失败")?;
    Ok(())
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
    fn reconnect_only_after_libssh2_failures() {
        // A dead session must be retried on a fresh connection, but our own
        // validation errors must not trigger a needless reconnect.
        assert!(from_libssh2(&anyhow::Error::new(ssh2::Error::from_errno(
            ssh2::ErrorCode::SFTP(5)
        ))));
        assert!(!from_libssh2(&anyhow::Error::msg("请输入绝对远程路径")));
    }
    #[test]
    fn rejects_control_characters_and_relative_paths() {
        for path in ["../etc", "relative", "/tmp/a\nrm", "/tmp/a\0b"] {
            assert!(validate_path(path).is_err());
        }
        assert!(validate_path("/tmp/中文 文件.txt").is_ok());
    }
    #[test]
    #[ignore = "requires tests/ssh_fixture.py and PIXIU_SHELL_SSH_FIXTURE"]
    fn draft_connectivity_uses_ephemeral_password_and_rejects_bad_auth() -> Result<()> {
        let fixture: serde_json::Value =
            serde_json::from_slice(&std::fs::read(std::env::var("PIXIU_SHELL_SSH_FIXTURE")?)?)?;
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
        let sftp = connect_with_credentials(&host, known, Some("pixiu-fixture-password"), None)?;
        assert!(
            list(&sftp, "/")?
                .iter()
                .any(|entry| entry.name == "welcome.txt")
        );
        assert!(host.id.is_none());
        Ok(())
    }
    #[test]
    #[ignore = "requires tests/ssh_fixture.py and PIXIU_SHELL_SSH_FIXTURE"]
    fn real_sftp_key_and_password_roundtrip() -> Result<()> {
        let fixture: serde_json::Value =
            serde_json::from_slice(&std::fs::read(std::env::var("PIXIU_SHELL_SSH_FIXTURE")?)?)?;
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
        crate::credentials::write(id, "pixiu-fixture-password")?;
        host.identity_file.clear();
        host.has_password = true;
        let result = connect(&host, known).and_then(|sftp| download(&sftp, "/welcome.txt"));
        crate::credentials::delete(id)?;
        assert!(String::from_utf8(result?)?.contains("你好"));
        Ok(())
    }
}
