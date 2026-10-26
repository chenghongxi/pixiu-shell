//! Host port forwards implemented on the builtin ssh2 transport.
//!
//! libssh2 sessions are not safe to use from several threads at once, so one
//! session and one poll loop drive every forward configured on a host.

use crate::ssh;
use crate::storage::{LocalHost, Tunnel};
use anyhow::{Context, Result, bail, ensure};
use ssh2::{Channel, Listener, Session};
use std::collections::VecDeque;
use std::io::{ErrorKind, Read, Write};
use std::net::{IpAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::Duration;

/// A SOCKS5 client that finished negotiating and is waiting for its channel.
type Request = (TcpStream, String, u16);

const CHUNK: usize = 16384;
/// Backpressure bound per direction; reads pause while a buffer is full.
const BUFFER_LIMIT: usize = 512 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// Guards the tunnel worker threads; dropping it stops every forward.
pub(crate) struct TunnelSet {
    stop: Arc<AtomicBool>,
}

impl Drop for TunnelSet {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

pub(crate) fn spawn(host: &LocalHost, known_hosts: &Path) -> Result<TunnelSet> {
    let stop = Arc::new(AtomicBool::new(false));
    if host.tunnels.is_empty() {
        return Ok(TunnelSet { stop });
    }
    let worker_stop = Arc::clone(&stop);
    let host = host.clone();
    let known_hosts = known_hosts.to_path_buf();
    std::thread::spawn(move || {
        // One session drives every forward. Giving each tunnel its own session
        // used to cost N extra TCP + handshake + authentication round trips
        // against the same host.
        if let Err(error) = run(worker_stop, &host, &known_hosts) {
            warn(&format!("隧道已退出：{error}"));
        }
    });
    Ok(TunnelSet { stop })
}

fn warn(message: &str) {
    eprintln!("[pixiu-shell] {message}");
}

fn run(stop: Arc<AtomicBool>, host: &LocalHost, known_hosts: &Path) -> Result<()> {
    let session = ssh::connect_session(host, known_hosts, None, None, None)?;
    session.set_blocking(false);
    let mut forwards = host
        .tunnels
        .iter()
        .map(|tunnel| Forward::open(&session, tunnel))
        .collect::<Result<Vec<_>>>()?;
    serve(stop, |pairs| {
        for forward in &mut forwards {
            forward.accept(&session, pairs)?;
        }
        Ok(())
    })
}

/// One configured port forward. Every variant is polled from the single
/// session thread, which is why they can share one SSH connection.
enum Forward {
    Local {
        listener: TcpListener,
        target_host: String,
        target_port: u16,
    },
    Remote {
        listener: Listener,
        target_host: String,
        target_port: u16,
    },
    Dynamic {
        listener: TcpListener,
        sender: mpsc::Sender<Request>,
        requests: mpsc::Receiver<Request>,
    },
}

impl Forward {
    fn open(session: &Session, tunnel: &Tunnel) -> Result<Self> {
        let target_host = tunnel.target_host.clone();
        let target_port = tunnel.target_port;
        match tunnel.kind.as_str() {
            "local" => Ok(Self::Local {
                listener: bind(tunnel.listen_port)?,
                target_host,
                target_port,
            }),
            "remote" => {
                // Match the OpenSSH `127.0.0.1:port` spelling: loopback only
                // on the server.
                let (listener, bound) = session
                    .channel_forward_listen(tunnel.listen_port, Some("127.0.0.1"), None)
                    .with_context(|| format!("无法请求远端监听端口 {}", tunnel.listen_port))?;
                if bound != tunnel.listen_port {
                    warn(&format!(
                        "远端实际监听端口为 {bound}（请求 {}）",
                        tunnel.listen_port
                    ));
                }
                Ok(Self::Remote {
                    listener,
                    target_host,
                    target_port,
                })
            }
            "dynamic" => {
                let (sender, requests) = mpsc::channel::<Request>();
                Ok(Self::Dynamic {
                    listener: bind(tunnel.listen_port)?,
                    sender,
                    requests,
                })
            }
            _ => bail!("隧道类型无效：{}", tunnel.kind),
        }
    }

    fn accept(&mut self, session: &Session, pairs: &mut Vec<Pair>) -> Result<()> {
        match self {
            Self::Local {
                listener,
                target_host,
                target_port,
            } => {
                while let Ok((stream, peer)) = listener.accept() {
                    let origin = Some(("127.0.0.1", peer.port()));
                    bridge(
                        pairs,
                        Ok(stream),
                        session
                            .channel_direct_tcpip(target_host, *target_port, origin)
                            .with_context(|| format!("转发到 {target_host}:{target_port} 失败")),
                    );
                }
            }
            Self::Remote {
                listener,
                target_host,
                target_port,
            } => {
                // WouldBlock is the ordinary "nothing pending" answer here,
                // and one accept per poll keeps a busy tunnel from starving.
                match listener.accept() {
                    Ok(channel) => bridge(
                        pairs,
                        connect_target(target_host, *target_port),
                        Ok(channel),
                    ),
                    Err(error) => {
                        let error = std::io::Error::from(error);
                        if error.kind() != ErrorKind::WouldBlock {
                            return Err(error).context("远端转发监听中断");
                        }
                    }
                }
            }
            Self::Dynamic {
                listener,
                sender,
                requests,
            } => {
                while let Ok((stream, _)) = listener.accept() {
                    let sender = sender.clone();
                    std::thread::spawn(move || {
                        if let Ok(Some(request)) = socks5_negotiate(stream) {
                            let _ = sender.send(request);
                        }
                    });
                }
                while let Ok((stream, target_host, target_port)) = requests.try_recv() {
                    bridge(
                        pairs,
                        Ok(stream),
                        session
                            .channel_direct_tcpip(&target_host, target_port, None)
                            .with_context(|| format!("转发到 {target_host}:{target_port} 失败")),
                    );
                }
            }
        }
        Ok(())
    }
}

fn bind(port: u16) -> Result<TcpListener> {
    let listener = TcpListener::bind(("127.0.0.1", port))
        .with_context(|| format!("无法监听本地端口 {port}"))?;
    listener.set_nonblocking(true)?;
    Ok(listener)
}

/// Runs a forward until it stops: accepts new connections, then moves data
/// for every live pair.
fn serve(
    stop: Arc<AtomicBool>,
    mut accept: impl FnMut(&mut Vec<Pair>) -> Result<()>,
) -> Result<()> {
    let mut pairs = Vec::new();
    loop {
        if stop.load(Ordering::Relaxed) {
            return Ok(());
        }
        accept(&mut pairs)?;
        // Idle forwards sleep; a busy one keeps its throughput instead of
        // being capped at one chunk per poll.
        if !pump(&mut pairs) {
            std::thread::sleep(ssh::POLL);
        }
    }
}

/// Bridges a TCP stream to an SSH channel. Either leg may fail independently;
/// a failure drops just that connection and is logged, never the whole forward.
fn bridge(pairs: &mut Vec<Pair>, stream: Result<TcpStream>, channel: Result<Channel>) {
    let pair = stream.and_then(|stream| channel.and_then(|channel| Pair::new(stream, channel)));
    match pair {
        Ok(pair) => pairs.push(pair),
        Err(error) => warn(&format!("隧道连接建立失败：{error}")),
    }
}

/// One forwarded connection: a local TCP stream bridged to an SSH channel.
/// Buffers decouple the two legs so a slow reader never stalls the poll loop.
struct Pair {
    stream: TcpStream,
    channel: Channel,
    upstream: VecDeque<u8>,
    downstream: VecDeque<u8>,
}

impl Pair {
    fn new(stream: TcpStream, channel: Channel) -> Result<Self> {
        stream.set_nonblocking(true)?;
        Ok(Self {
            stream,
            channel,
            upstream: VecDeque::new(),
            downstream: VecDeque::new(),
        })
    }
}

/// Returns true while at least one pair still has bytes in flight.
fn pump(pairs: &mut Vec<Pair>) -> bool {
    let mut busy = false;
    let mut index = 0;
    while index < pairs.len() {
        match step(&mut pairs[index]) {
            Step::Closed => {
                pairs.swap_remove(index);
            }
            Step::Busy => {
                busy = true;
                index += 1;
            }
            Step::Idle => index += 1,
        }
    }
    busy
}

enum Step {
    Idle,
    Busy,
    Closed,
}

/// Advances one pair by a bounded amount.
fn step(pair: &mut Pair) -> Step {
    let mut buffer = [0_u8; CHUNK];
    let mut closed = transfer(&mut pair.stream, &mut pair.upstream, &mut buffer);
    closed |= ssh::drain(&mut pair.upstream, &mut pair.channel);
    if closed {
        return Step::Closed;
    }
    closed = transfer(&mut pair.channel, &mut pair.downstream, &mut buffer);
    closed |= ssh::drain(&mut pair.downstream, &mut pair.stream);
    if closed {
        return Step::Closed;
    }
    // A non-empty queue means another pass can move it right away.
    if pair.upstream.is_empty() && pair.downstream.is_empty() {
        Step::Idle
    } else {
        Step::Busy
    }
}

/// Reads one chunk into `queue` while there is room. True means the source
/// ended and nothing is left to forward.
fn transfer(source: &mut dyn Read, queue: &mut VecDeque<u8>, buffer: &mut [u8]) -> bool {
    if queue.len() >= BUFFER_LIMIT {
        return false;
    }
    match source.read(buffer) {
        Ok(0) => queue.is_empty(),
        Ok(count) => {
            queue.extend(&buffer[..count]);
            false
        }
        Err(error) if error.kind() == ErrorKind::WouldBlock => false,
        Err(_) => true,
    }
}

fn connect_target(target_host: &str, target_port: u16) -> Result<TcpStream> {
    let mut stream = None;
    for address in (target_host, target_port).to_socket_addrs()? {
        if let Ok(candidate) = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT) {
            stream = Some(candidate);
            break;
        }
    }
    stream.context("无法连接隧道本地目标")
}

/// Minimal SOCKS5 server: CONNECT only, no authentication.
/// Successful negotiations hand the raw stream back for tunneling.
fn socks5_negotiate(mut stream: TcpStream) -> Result<Option<(TcpStream, String, u16)>> {
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    stream.set_write_timeout(Some(Duration::from_secs(30)))?;
    let mut header = [0_u8; 2];
    stream.read_exact(&mut header)?;
    ensure!(header[0] == 5, "SOCKS5 握手版本无效");
    let mut methods = vec![0_u8; header[1] as usize];
    stream.read_exact(&mut methods)?;
    if !methods.contains(&0) {
        let _ = stream.write_all(&[5, 0xFF]);
        return Ok(None);
    }
    stream.write_all(&[5, 0])?;
    let mut request = [0_u8; 4];
    stream.read_exact(&mut request)?;
    ensure!(
        request[0] == 5 && request[1] == 1,
        "SOCKS5 仅支持 CONNECT 命令"
    );
    let target_host = match request[3] {
        1 => IpAddr::from(read_exact::<4>(&mut stream)?).to_string(),
        3 => {
            let [length] = read_exact::<1>(&mut stream)?;
            let name = read_exact_vec(&mut stream, length as usize)?;
            String::from_utf8(name).map_err(|_| anyhow::anyhow!("SOCKS5 目标域名无效"))?
        }
        4 => IpAddr::from(read_exact::<16>(&mut stream)?).to_string(),
        _ => bail!("SOCKS5 地址类型无效"),
    };
    let port = u16::from_be_bytes(read_exact::<2>(&mut stream)?);
    // Success reply with a dummy bound address, mirroring common clients.
    stream.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0])?;
    Ok(Some((stream, target_host, port)))
}

fn read_exact<const N: usize>(stream: &mut TcpStream) -> Result<[u8; N]> {
    let mut buffer = [0_u8; N];
    stream.read_exact(&mut buffer)?;
    Ok(buffer)
}

fn read_exact_vec(stream: &mut TcpStream, length: usize) -> Result<Vec<u8>> {
    let mut buffer = vec![0_u8; length];
    stream.read_exact(&mut buffer)?;
    Ok(buffer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socks5_rejects_clients_without_no_auth() -> Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let address = listener.local_addr()?;
        let worker = std::thread::spawn(move || {
            let (stream, _) = listener.accept()?;
            socks5_negotiate(stream)
        });
        let mut client = TcpStream::connect(address)?;
        // Offer only username/password auth; the server must refuse.
        client.write_all(&[5, 1, 2])?;
        let mut reply = [0_u8; 2];
        client.read_exact(&mut reply)?;
        assert_eq!(reply, [5, 0xFF]);
        assert!(
            worker
                .join()
                .map_err(|_| anyhow::anyhow!("panicked"))??
                .is_none()
        );
        Ok(())
    }

    #[test]
    fn socks5_negotiates_connect_and_returns_target() -> Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let address = listener.local_addr()?;
        let worker = std::thread::spawn(move || {
            let (stream, _) = listener.accept()?;
            socks5_negotiate(stream)
        });
        let mut client = TcpStream::connect(address)?;
        client.write_all(&[5, 1, 0])?;
        let mut reply = [0_u8; 2];
        client.read_exact(&mut reply)?;
        assert_eq!(reply, [5, 0]);
        // CONNECT example.org:443 via a domain-name address.
        client.write_all(&[5, 1, 0, 3, 11])?;
        client.write_all(b"example.org")?;
        client.write_all(&443_u16.to_be_bytes())?;
        let mut status = [0_u8; 10];
        client.read_exact(&mut status)?;
        assert_eq!(&status[..2], &[5, 0]);
        let (stream, host, port) = worker
            .join()
            .map_err(|_| anyhow::anyhow!("panicked"))??
            .context("negotiated")?;
        assert_eq!(host, "example.org");
        assert_eq!(port, 443);
        drop(stream);
        Ok(())
    }

    #[test]
    fn drain_flushes_wrapped_queues_without_losing_bytes() -> Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let address = listener.local_addr()?;
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept()?;
            let mut received = vec![0_u8; 5];
            stream.read_exact(&mut received)?;
            Ok::<_, std::io::Error>(received)
        });
        let mut client = TcpStream::connect(address)?;
        let mut queue: VecDeque<u8> = [1, 2, 3].into_iter().collect();
        queue.extend([4, 5]);
        assert!(!ssh::drain(&mut queue, &mut client));
        assert!(queue.is_empty());
        assert_eq!(
            worker.join().map_err(|_| anyhow::anyhow!("panicked"))??,
            [1, 2, 3, 4, 5]
        );
        Ok(())
    }
}
