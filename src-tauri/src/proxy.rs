use anyhow::{Context, Result, bail, ensure};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    net::{Shutdown, TcpStream, ToSocketAddrs},
    sync::mpsc,
    time::Duration,
};
use uuid::Uuid;

/// Upper bound for one dial attempt: long enough for a slow WAN link, short
/// enough that a dead address never freezes the whole connection.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Proxy {
    pub kind: String,
    pub address: String,
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub has_password: bool,
}
impl Proxy {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            ["socks5", "http"].contains(&self.kind.as_str()),
            "代理协议无效"
        );
        ensure!(
            self.port > 0
                && !self.address.is_empty()
                && self.address.len() <= 253
                && self
                    .address
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || ".-:_".contains(c)),
            "代理地址或端口无效"
        );
        ensure!(
            self.username.len() <= 255 && !self.username.contains(['\r', '\n', '\0', ':']),
            "代理用户名无效"
        );
        Ok(())
    }
}
fn entry(id: Uuid) -> Result<keyring::Entry> {
    Ok(keyring::Entry::new(
        crate::auth_store::PROXY_SERVICE,
        &id.to_string(),
    )?)
}
pub(crate) fn password(id: Uuid) -> Result<Option<zeroize::Zeroizing<String>>> {
    match entry(id)?.get_password() {
        Ok(value) => Ok(Some(zeroize::Zeroizing::new(value))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.into()),
    }
}
pub(crate) fn set_password(id: Uuid, value: Option<&str>) -> Result<()> {
    if let Some(value) = value {
        ensure!(
            value.len() <= 255 && !value.contains(['\r', '\n', '\0']),
            "代理密码无效"
        );
        entry(id)?.set_password(value)?;
    } else {
        match entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}
pub(crate) fn connect(
    host: &str,
    port: u16,
    proxy: Option<&Proxy>,
    id: Option<Uuid>,
) -> Result<TcpStream> {
    connect_with_password(host, port, proxy, id, None)
}
pub(crate) fn connect_with_password(
    host: &str,
    port: u16,
    proxy: Option<&Proxy>,
    id: Option<Uuid>,
    supplied_password: Option<&str>,
) -> Result<TcpStream> {
    let (address, endpoint_port) = proxy
        .map(|p| (p.address.as_str(), p.port))
        .unwrap_or((host, port));
    let mut socket = dial(address, endpoint_port)?;
    // Interactive SSH sends single keystrokes; Nagle would delay each of them.
    socket.set_nodelay(true)?;
    socket.set_read_timeout(Some(Duration::from_secs(30)))?;
    socket.set_write_timeout(Some(Duration::from_secs(30)))?;
    if let Some(proxy) = proxy {
        proxy.validate()?;
        if let Some(secret) = supplied_password {
            ensure!(
                secret.len() <= 255 && !secret.contains(['\r', '\n', '\0']),
                "代理密码无效"
            );
        }
        let secret = if proxy.has_password && supplied_password.is_none() {
            password(id.context("代理凭据缺少主机 ID")?)?
        } else {
            None
        };
        ensure!(
            !proxy.has_password || supplied_password.is_some() || secret.is_some(),
            "代理密码不可用，请重新保存"
        );
        handshake(
            &mut socket,
            host,
            port,
            proxy,
            supplied_password.or_else(|| secret.as_deref().map(String::as_str)),
        )?;
    }
    Ok(socket)
}
/// Dials every resolved address at once and keeps the first one that answers.
/// Dialing in order makes a host with an unreachable AAAA record — IPv6 is
/// resolved first — block for a full timeout before IPv4 is even attempted.
fn dial(host: &str, port: u16) -> Result<TcpStream> {
    let addresses: Vec<_> = (host, port)
        .to_socket_addrs()
        .with_context(|| format!("无法解析地址 {host}:{port}"))?
        .collect();
    let Some(first) = addresses.first().copied() else {
        bail!("地址 {host}:{port} 没有解析结果");
    };
    if addresses.len() == 1 {
        return TcpStream::connect_timeout(&first, CONNECT_TIMEOUT)
            .with_context(|| format!("无法连接 {host}:{port}"));
    }
    let (sender, receiver) = mpsc::channel();
    for address in addresses {
        let sender = sender.clone();
        std::thread::spawn(move || {
            let _ = sender.send(TcpStream::connect_timeout(&address, CONNECT_TIMEOUT));
        });
    }
    drop(sender);
    let mut failure = None;
    // Losers report errors immediately, so keep waiting for a winner until
    // every attempt has answered or the shared timeout elapses.
    while let Ok(attempt) = receiver.recv_timeout(CONNECT_TIMEOUT) {
        match attempt {
            Ok(socket) => return Ok(socket),
            Err(error) => failure = Some(error),
        }
    }
    match failure {
        Some(error) => {
            Err(anyhow::Error::new(error)).with_context(|| format!("无法连接 {host}:{port}"))
        }
        None => bail!("连接 {host}:{port} 超时"),
    }
}

fn handshake(
    socket: &mut TcpStream,
    host: &str,
    port: u16,
    proxy: &Proxy,
    password: Option<&str>,
) -> Result<()> {
    if proxy.kind == "socks5" {
        socket.write_all(if password.is_some() {
            &[5, 2, 0, 2]
        } else {
            &[5, 1, 0]
        })?;
        let mut response = [0; 2];
        socket.read_exact(&mut response)?;
        ensure!(response[0] == 5, "SOCKS5 代理响应无效");
        match response[1] {
            0 => {}
            2 => {
                let password = password.context("代理需要用户名密码")?;
                let mut auth = vec![1, proxy.username.len() as u8];
                auth.extend_from_slice(proxy.username.as_bytes());
                auth.push(password.len() as u8);
                auth.extend_from_slice(password.as_bytes());
                socket.write_all(&auth)?;
                socket.read_exact(&mut response)?;
                ensure!(response == [1, 0], "代理认证失败");
            }
            _ => bail!("代理不支持此认证方式"),
        }
        ensure!(host.len() <= 255, "目标主机名过长");
        let mut request = vec![5, 1, 0, 3, host.len() as u8];
        request.extend_from_slice(host.as_bytes());
        request.extend_from_slice(&port.to_be_bytes());
        socket.write_all(&request)?;
        let mut header = [0; 4];
        socket.read_exact(&mut header)?;
        ensure!(header[0] == 5 && header[1] == 0, "SOCKS5 代理拒绝目标连接");
        let length = match header[3] {
            1 => 4,
            4 => 16,
            3 => {
                let mut length = [0];
                socket.read_exact(&mut length)?;
                usize::from(length[0])
            }
            _ => bail!("SOCKS5 地址类型无效"),
        };
        socket.read_exact(&mut vec![0; length + 2])?;
    } else {
        let endpoint = if host.contains(':') {
            format!("[{host}]:{port}")
        } else {
            format!("{host}:{port}")
        };
        let auth = password
            .map(|password| {
                format!(
                    "Proxy-Authorization: Basic {}\r\n",
                    base64::engine::general_purpose::STANDARD
                        .encode(format!("{}:{password}", proxy.username))
                )
            })
            .unwrap_or_default();
        socket.write_all(
            format!("CONNECT {endpoint} HTTP/1.1\r\nHost: {endpoint}\r\n{auth}\r\n").as_bytes(),
        )?;
        let mut headers = Vec::new();
        let mut byte = [0];
        while !headers.ends_with(b"\r\n\r\n") {
            ensure!(headers.len() < 16384, "代理响应过长");
            socket.read_exact(&mut byte)?;
            headers.push(byte[0]);
        }
        ensure!(
            String::from_utf8_lossy(&headers)
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1))
                == Some("200"),
            "HTTP 代理拒绝目标连接"
        );
    }
    Ok(())
}
pub(crate) fn helper() -> Result<()> {
    let proxy: Proxy = serde_json::from_str(&std::env::var("PIXIU_SHELL_PROXY_CONFIG")?)?;
    let host = std::env::var("PIXIU_SHELL_PROXY_TARGET")?;
    let port = std::env::var("PIXIU_SHELL_PROXY_PORT")?.parse()?;
    let id = Uuid::parse_str(&std::env::var("PIXIU_SHELL_PROXY_ID")?)?;
    let mut socket = connect(&host, port, Some(&proxy), Some(id))?;
    socket.set_read_timeout(None)?;
    socket.set_write_timeout(None)?;
    let mut upload = socket.try_clone()?;
    std::thread::spawn(move || {
        let _ = std::io::copy(&mut std::io::stdin(), &mut upload);
        let _ = upload.shutdown(Shutdown::Write);
    });
    std::io::copy(&mut socket, &mut std::io::stdout())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn socks5_negotiates_remote_dns_and_preserves_payload() -> Result<()> {
        let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        let port = listener.local_addr()?.port();
        let server = std::thread::spawn(move || -> Result<()> {
            let (mut stream, _) = listener.accept()?;
            stream.set_read_timeout(Some(Duration::from_secs(2)))?;
            let mut greeting = [0; 3];
            stream.read_exact(&mut greeting)?;
            assert_eq!(greeting, [5, 1, 0]);
            stream.write_all(&[5, 0])?;
            let mut header = [0; 5];
            stream.read_exact(&mut header)?;
            assert_eq!(&header[..4], &[5, 1, 0, 3]);
            let mut target = vec![0; usize::from(header[4]) + 2];
            stream.read_exact(&mut target)?;
            assert_eq!(&target[..target.len() - 2], b"internal.example");
            assert_eq!(&target[target.len() - 2..], &22_u16.to_be_bytes());
            stream.write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 22])?;
            stream.write_all(b"SSH-2.0-fixture\r\n")?;
            Ok(())
        });
        let proxy = Proxy {
            kind: "socks5".into(),
            address: "127.0.0.1".into(),
            port,
            username: String::new(),
            has_password: false,
        };
        let mut stream = connect("internal.example", 22, Some(&proxy), None)?;
        let mut result = [0; 17];
        stream.read_exact(&mut result)?;
        assert_eq!(&result, b"SSH-2.0-fixture\r\n");
        server
            .join()
            .map_err(|_| anyhow::anyhow!("proxy fixture failed"))??;
        Ok(())
    }
    #[test]
    fn http_connect_auth_and_rejection_are_handled() -> Result<()> {
        for status in [
            "200 Connection established",
            "407 Proxy Authentication Required",
        ] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
            let port = listener.local_addr()?.port();
            let server = std::thread::spawn(move || -> Result<()> {
                let (mut stream, _) = listener.accept()?;
                let mut bytes = Vec::new();
                let mut byte = [0];
                while !bytes.ends_with(b"\r\n\r\n") {
                    stream.read_exact(&mut byte)?;
                    bytes.push(byte[0]);
                }
                let request = String::from_utf8(bytes)?;
                assert!(request.starts_with("CONNECT internal.example:2222 HTTP/1.1"));
                assert!(request.contains("Proxy-Authorization: Basic dXNlcjpwYXNz"));
                stream.write_all(format!("HTTP/1.1 {status}\r\n\r\n").as_bytes())?;
                Ok(())
            });
            let proxy = Proxy {
                kind: "http".into(),
                address: "127.0.0.1".into(),
                port,
                username: "user".into(),
                has_password: true,
            };
            let mut stream = TcpStream::connect(("127.0.0.1", port))?;
            assert_eq!(
                handshake(&mut stream, "internal.example", 2222, &proxy, Some("pass")).is_ok(),
                status.starts_with("200")
            );
            server
                .join()
                .map_err(|_| anyhow::anyhow!("proxy fixture failed"))??;
        }
        Ok(())
    }
}

#[cfg(test)]
mod helper_tests {
    use super::*;
    #[test]
    #[ignore = "requires PIXIU_SHELL_APP_EXECUTABLE pointing to a built desktop binary"]
    fn native_proxy_helper_bridges_stdio_without_starting_gui() -> Result<()> {
        let executable = std::env::var("PIXIU_SHELL_APP_EXECUTABLE")?;
        let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        let port = listener.local_addr()?.port();
        let server = std::thread::spawn(move || -> Result<()> {
            let (mut stream, _) = listener.accept()?;
            stream.set_read_timeout(Some(Duration::from_secs(5)))?;
            let mut greeting = [0; 3];
            stream.read_exact(&mut greeting)?;
            stream.write_all(&[5, 0])?;
            let mut header = [0; 5];
            stream.read_exact(&mut header)?;
            stream.read_exact(&mut vec![0; usize::from(header[4]) + 2])?;
            stream.write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 22])?;
            stream.write_all(b"SSH-2.0-proxy-fixture\r\n")?;
            Ok(())
        });
        let proxy = Proxy {
            kind: "socks5".into(),
            address: "127.0.0.1".into(),
            port,
            username: String::new(),
            has_password: false,
        };
        let output = std::process::Command::new(executable)
            .arg("--pixiu-shell-proxy")
            .env("PIXIU_SHELL_PROXY_CONFIG", serde_json::to_string(&proxy)?)
            .env("PIXIU_SHELL_PROXY_ID", Uuid::new_v4().to_string())
            .env("PIXIU_SHELL_PROXY_TARGET", "internal.example")
            .env("PIXIU_SHELL_PROXY_PORT", "22")
            .env("PIXIU_SHELL_ASKPASS", "1")
            .output()?;
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.stdout, b"SSH-2.0-proxy-fixture\r\n");
        server
            .join()
            .map_err(|_| anyhow::anyhow!("proxy fixture failed"))??;
        Ok(())
    }
}
