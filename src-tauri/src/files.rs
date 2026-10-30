use crate::ssh::connect_session;
use crate::storage::LocalHost;
use anyhow::{Context, Result, bail, ensure};
use serde::Serialize;
use ssh2::{FileStat, OpenFlags, OpenType, Sftp};
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

fn normalize_remote_path(path: &str) -> Result<String> {
    let mut home = path.replace('\\', "/");
    if !home.starts_with('/') {
        home.insert(0, '/');
    }
    while home.len() > 1 && home.ends_with('/') {
        home.pop();
    }
    validate_path(&home)?;
    Ok(home)
}

/// SFTP starts in the login directory, which is the account home.
pub(crate) fn home(sftp: &Sftp) -> Result<String> {
    let resolved = sftp
        .realpath(Path::new("."))
        .context("无法解析用户家目录")?;
    normalize_remote_path(&resolved.to_string_lossy())
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
            Err(explain(error))
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
    result.map_err(explain)
}

fn sftp_reason(error: &anyhow::Error) -> Option<&'static str> {
    for cause in error.chain() {
        let Some(ssh) = cause.downcast_ref::<ssh2::Error>() else {
            continue;
        };
        match ssh.code() {
            ssh2::ErrorCode::SFTP(2) | ssh2::ErrorCode::SFTP(10) => {
                return Some("文件或目录不存在");
            }
            ssh2::ErrorCode::SFTP(3) => return Some("权限不足"),
            ssh2::ErrorCode::SFTP(4) => continue,
            ssh2::ErrorCode::SFTP(5) => return Some("服务器返回了无效消息"),
            ssh2::ErrorCode::SFTP(6) | ssh2::ErrorCode::SFTP(7) => {
                return Some("SFTP 连接已断开");
            }
            ssh2::ErrorCode::SFTP(8) => return Some("服务器不支持该操作"),
            ssh2::ErrorCode::SFTP(9) => return Some("文件句柄无效"),
            ssh2::ErrorCode::SFTP(11) => return Some("目标已存在"),
            ssh2::ErrorCode::SFTP(12) => return Some("文件系统只读"),
            ssh2::ErrorCode::SFTP(13) => return Some("存储介质不可用"),
            ssh2::ErrorCode::SFTP(_) => return Some("SFTP 操作失败"),
            ssh2::ErrorCode::Session(_) => {
                let message = ssh.message().to_ascii_lowercase();
                if message.contains("permission") {
                    return Some("权限不足");
                }
                if message == "failure" || message == "failed" || message.is_empty() {
                    continue;
                }
            }
        }
    }
    None
}

fn explain(error: anyhow::Error) -> anyhow::Error {
    let top = error.to_string();
    let prefix = top.split_once(": ").map(|(head, _)| head.trim()).unwrap_or("");
    let chinese = prefix.chars().any(|ch| ('\u{4e00}'..='\u{9fff}').contains(&ch));
    if let Some(reason) = sftp_reason(&error) {
        if chinese {
            anyhow::anyhow!("{prefix}：{reason}")
        } else {
            anyhow::anyhow!("{reason}")
        }
    } else if chinese {
        let tail = top
            .split_once(": ")
            .map(|(_, rest)| rest.trim())
            .unwrap_or("");
        let lower = tail.to_ascii_lowercase();
        if tail.is_empty()
            || matches!(
                lower.as_str(),
                "failure" | "failed" | "error" | "ssh_fx_failure"
            )
        {
            anyhow::anyhow!("{prefix}")
        } else {
            error
        }
    } else {
        error
    }
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
            kind: entry_kind(sftp, &path, &stat),
            size: stat.size.unwrap_or(0),
            permissions: format!("{:o}", stat.perm.unwrap_or(0) & 0o7777),
            modified_at: stat.mtime.map(|value| value.to_string()),
        });
    }
    Ok(items)
}

fn entry_kind(sftp: &Sftp, path: &Path, stat: &FileStat) -> &'static str {
    if stat.is_dir() {
        return "directory";
    }
    if stat.file_type().is_symlink() {
        if sftp.stat(path).map(|target| target.is_dir()).unwrap_or(false) {
            return "directory";
        }
        return "symlink";
    }
    "file"
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
pub(crate) fn join_name(directory: &str, name: &str) -> Result<String> {
    ensure!(
        !name.is_empty()
            && name.len() <= 255
            && name != "."
            && name != ".."
            && !name.contains(['/', '\\', '\0', '\n', '\r']),
        "目录或文件名无效"
    );
    let path = if directory == "/" {
        format!("/{name}")
    } else {
        format!("{}/{name}", directory.trim_end_matches('/'))
    };
    validate_path(&path)?;
    Ok(path)
}

pub(crate) fn parse_mode(value: &str) -> Result<u32> {
    let mode = u32::from_str_radix(value.trim(), 8).context("权限请使用八进制，例如 755")?;
    ensure!(mode <= 0o7777, "权限无效");
    Ok(mode)
}

pub(crate) fn mkdir(sftp: &Sftp, remote: &str) -> Result<()> {
    validate_path(remote)?;
    sftp.mkdir(Path::new(remote), 0o755)
        .context("无法创建目录，路径可能已存在")
}

pub(crate) fn rename(sftp: &Sftp, from: &str, to: &str) -> Result<()> {
    validate_path(from)?;
    validate_path(to)?;
    ensure!(from != to, "新名称与原名称相同");
    sftp.rename(Path::new(from), Path::new(to), None)
        .context("无法重命名；目标路径可能已存在")
}

pub(crate) fn chmod(sftp: &Sftp, remote: &str, mode: u32) -> Result<()> {
    validate_path(remote)?;
    ensure!(mode <= 0o7777, "权限无效");
    let current = sftp.stat(Path::new(remote)).context("无法读取文件属性")?;
    let file_type = current.perm.unwrap_or(0) & !0o7777;
    sftp.setstat(
        Path::new(remote),
        FileStat {
            size: None,
            uid: None,
            gid: None,
            perm: Some(file_type | (mode & 0o7777)),
            atime: None,
            mtime: None,
        },
    )
    .context("无法修改权限")
}

const EDIT_MAX: u64 = 512 * 1024;

pub(crate) fn read_text(sftp: &Sftp, remote: &str) -> Result<String> {
    validate_path(remote)?;
    let path = Path::new(remote);
    if let Some(reason) = unreadable_reason(sftp, path) {
        bail!("{reason}");
    }
    let file = match sftp.open(path) {
        Ok(file) => file,
        Err(err) => {
            if let Some(reason) = unreadable_reason(sftp, path) {
                bail!("{reason}");
            }
            return Err(anyhow::Error::new(err).context("无法打开远程文件"));
        }
    };
    let mut data = Vec::new();
    file.take(EDIT_MAX + 1).read_to_end(&mut data)?;
    ensure!(
        data.len() as u64 <= EDIT_MAX,
        "文件超过 512 KiB，请下载后编辑"
    );
    ensure!(!data.contains(&0), "该文件不是文本，无法在线编辑");
    String::from_utf8(data).context("该文件不是 UTF-8 文本，无法在线编辑")
}

fn unreadable_reason(sftp: &Sftp, path: &Path) -> Option<String> {
    if let Ok(target) = sftp.readlink(path) {
        let target = target.to_string_lossy();
        if !target.is_empty() {
            return Some(format!("这是符号链接，指向 {target}，无法在线编辑"));
        }
        return Some("这是符号链接，无法在线编辑".into());
    }
    if let Ok(meta) = sftp.lstat(path).or_else(|_| sftp.stat(path)) {
        if meta.is_dir() {
            return Some("这是目录，无法在线编辑".into());
        }
        if !meta.file_type().is_file() {
            return Some("该文件不是普通文件，无法在线编辑".into());
        }
    }
    None
}

pub(crate) fn write_bytes(sftp: &Sftp, remote: &str, bytes: &[u8]) -> Result<()> {
    validate_path(remote)?;
    ensure!(bytes.len() as u64 <= EDIT_MAX, "文件超过 512 KiB，无法在线保存");
    let mut output = sftp
        .open_mode(
            Path::new(remote),
            OpenFlags::WRITE | OpenFlags::TRUNCATE,
            0o644,
            OpenType::File,
        )
        .context("无法写入远程文件")?;
    output.write_all(bytes)?;
    output.close()?;
    Ok(())
}

fn remove_entry(sftp: &Sftp, remote: &str, depth: u8) -> Result<()> {
    validate_path(remote)?;
    ensure!(remote != "/", "不能删除根目录");
    ensure!(depth < 32, "目录层级过深，已停止删除");
    let path = Path::new(remote);
    let stat = sftp
        .lstat(path)
        .or_else(|_| sftp.stat(path))
        .context("无法读取文件属性")?;
    if stat.file_type().is_symlink() || !stat.is_dir() {
        sftp.unlink(path).context("无法删除文件")?;
        return Ok(());
    }
    for (child, child_stat) in sftp
        .readdir(path)
        .context("无法读取目录内容")?
    {
        let name = child
            .file_name()
            .context("文件名无效")?
            .to_string_lossy()
            .into_owned();
        if name == "." || name == ".." {
            continue;
        }
        let child_path = child.to_string_lossy().into_owned();
        if child_stat.is_dir() && !child_stat.file_type().is_symlink() {
            remove_entry(sftp, &child_path, depth + 1)?;
        } else {
            sftp.unlink(&child)
                .or_else(|_| sftp.rmdir(&child))
                .context("无法删除文件")?;
        }
    }
    sftp.rmdir(path).context("无法删除文件夹")
}
pub(crate) fn delete(sftp: &Sftp, remote: &str) -> Result<()> {
    remove_entry(sftp, remote, 0)
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
    fn explains_sftp_failure_in_chinese() {
        let error = anyhow::Error::new(ssh2::Error::from_errno(ssh2::ErrorCode::SFTP(4)))
            .context("无法删除文件");
        let text = explain(error).to_string();
        assert!(text.starts_with("无法删除文件"), "{text}");
        assert!(!text.contains("权限不足"), "{text}");
        let bare = anyhow::Error::new(ssh2::Error::from_errno(ssh2::ErrorCode::SFTP(3)));
        assert_eq!(explain(bare).to_string(), "权限不足");
    }
    #[test]
    fn joins_and_rejects_unsafe_names() {
        assert_eq!(join_name("/tmp", "logs").unwrap(), "/tmp/logs");
        assert_eq!(join_name("/", "etc").unwrap(), "/etc");
        for name in ["", ".", "..", "a/b", "a\\b", "a\nb"] {
            assert!(join_name("/tmp", name).is_err(), "{name}");
        }
    }
    #[test]
    fn parses_chmod_octal() {
        assert_eq!(parse_mode("755").unwrap(), 0o755);
        assert_eq!(parse_mode("0644").unwrap(), 0o644);
        assert!(parse_mode("888").is_err());
        assert!(parse_mode("10000").is_err());
    }
    #[test]
    fn rejects_control_characters_and_relative_paths() {
        for path in ["../etc", "relative", "/tmp/a\nrm", "/tmp/a\0b"] {
            assert!(validate_path(path).is_err());
        }
        assert!(validate_path("/tmp/中文 文件.txt").is_ok());
    }
    #[test]
    fn normalizes_home_paths() {
        assert_eq!(normalize_remote_path("/home/xiaobai/").unwrap(), "/home/xiaobai");
        assert_eq!(normalize_remote_path("/").unwrap(), "/");
        assert_eq!(normalize_remote_path("home/xiaobai").unwrap(), "/home/xiaobai");
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
