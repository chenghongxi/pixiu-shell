//! Host-key verification inside the application window.
//!
//! Terminal, files, monitoring and tunnels each reach the host-key check from a
//! different call stack, so the prompt lives in a process-wide gateway instead
//! of an argument threaded through every layer. The askpass helper runs as a
//! separate process without Tauri, so it reaches the same prompt through the
//! socket served by `askpass_bridge`.

use anyhow::{Context, Result, anyhow};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use serde::Serialize;
use sha2::{Digest, Sha256};
use ssh2::{CheckResult, HostKeyType, KnownHostFileKind, Session};
use std::{
    collections::{HashMap, HashSet},
    io::ErrorKind,
    path::Path,
    sync::{LazyLock, Mutex, MutexGuard, OnceLock, mpsc},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

/// The window opens a prompt on the first event and drops it on the second. The
/// second also fires when a connection gave up waiting, so no prompt outlives
/// its connection.
const PROMPT_EVENT: &str = "host-key-verify";
const RESOLVED_EVENT: &str = "host-key-resolved";

/// An unanswered prompt must never hold a connection thread forever. Two
/// minutes is enough to walk over to a console; past that the user has moved on.
const TIMEOUT: Duration = Duration::from_secs(120);

/// Every key this app records is tagged, so it can be told apart from one the
/// user keeps in OpenSSH's own file.
const MARKER: &str = "PIXIU_SHELL";

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Kind {
    /// First contact: nothing is stored for this host yet.
    New,
    /// A key we trusted now answers differently.
    Changed,
    /// OpenSSH asked in its own words (system engine, askpass) and the text
    /// could not be parsed into the fields above.
    Prompt,
}

/// What the user decided: nothing, only this connection, or this plus disk.
#[derive(Clone, Copy)]
pub(crate) enum Answer {
    Reject,
    /// Trust the key until the session ends; `known_hosts` stays untouched.
    Once,
    /// Trust it and remember it.
    Remember,
}

/// One question for the window, serialized straight onto the prompt event.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Request {
    id: String,
    kind: Kind,
    address: String,
    port: u16,
    key_type: String,
    fingerprint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    stored: Option<String>,
    /// Raw issuer text, only set for [`Kind::Prompt`].
    #[serde(skip_serializing_if = "Option::is_none")]
    prompt: Option<String>,
    /// OpenSSH always writes the key it accepted, so a system-engine prompt
    /// cannot offer "this session only" and must say so.
    supports_once: bool,
}

impl Request {
    /// ssh2 reported the exact key it saw, so every field has a value.
    pub(crate) fn new(address: &str, port: u16, key_type: &str, fingerprint: String) -> Self {
        Self {
            id: String::new(),
            kind: Kind::New,
            address: address.to_string(),
            port,
            key_type: key_type.to_string(),
            fingerprint,
            stored: None,
            prompt: None,
            supports_once: true,
        }
    }

    /// The key we trusted is gone and another one answers: show what was stored.
    pub(crate) fn changed(mut self, stored: Option<String>) -> Self {
        self.kind = Kind::Changed;
        self.stored = stored;
        self
    }

    /// Nobody could parse the issuer text, so it is shown verbatim. OpenSSH
    /// stores whatever it is told yes to, hence no "once" either.
    pub(crate) fn raw(prompt: &str) -> Self {
        Self {
            kind: Kind::Prompt,
            prompt: Some(prompt.to_string()),
            supports_once: false,
            ..Self::new("", 22, "", String::new())
        }
    }
}

#[derive(Clone, Serialize)]
struct Resolved {
    id: String,
}

#[derive(Default)]
struct Gateway {
    handle: OnceLock<AppHandle>,
    pending: Mutex<HashMap<String, mpsc::Sender<Answer>>>,
}

static GATEWAY: OnceLock<Gateway> = OnceLock::new();

/// Keys accepted during this run, as `"<known_hosts host> <fingerprint>"`.
///
/// "Once" must leave `known_hosts` alone, but it must not ask twice either. One
/// user action opens several sessions against the same host — the shell plus
/// the tunnels, the file browser, the monitor probes — and every one of them
/// would otherwise raise its own prompt for the very key just accepted. The
/// cache dies with the process, so a fresh launch still asks.
static SESSION_TRUST: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

fn trusted_this_run(hostname: &str, fingerprint: &str) -> bool {
    SESSION_TRUST
        .lock()
        .map(|trusted| trusted.contains(&format!("{hostname} {fingerprint}")))
        .unwrap_or(false)
}

/// Kept in memory only; the file is written when the user picks "remember".
fn trust_this_run(hostname: &str, fingerprint: &str) {
    if let Ok(mut trusted) = SESSION_TRUST.lock() {
        trusted.insert(format!("{hostname} {fingerprint}"));
    }
}

fn lock_pending() -> Result<MutexGuard<'static, HashMap<String, mpsc::Sender<Answer>>>> {
    GATEWAY
        .get_or_init(Gateway::default)
        .pending
        .lock()
        .map_err(|_| anyhow!("主机指纹待确认队列不可用"))
}

fn remove_pending(id: &str) {
    if let Ok(mut pending) = lock_pending() {
        pending.remove(id);
    }
}

/// Wired up once at startup: a handshake can only ask the user something after
/// the window exists.
pub(crate) fn attach(handle: AppHandle) {
    let _ = GATEWAY.get_or_init(Gateway::default).handle.set(handle);
}

/// Checks the server key against the trusted ones and asks the window whenever
/// it is unknown or has changed. Either case ends the same way: trust the key
/// for this session, remember it, or drop the connection.
pub(crate) fn verify(
    session: &Session,
    known_hosts: &Path,
    address: &str,
    port: u16,
    key: &[u8],
    raw_key_type: HostKeyType,
) -> Result<()> {
    let mut known = session.known_hosts()?;
    if known_hosts.exists() {
        known.read_file(known_hosts, KnownHostFileKind::OpenSSH)?;
    }
    let hostname = hostname(address, port);
    let fingerprint = fingerprint(key);
    let result = known.check_port(address, port, key);
    // A key accepted earlier in this run is still accepted. Without this the
    // tunnels, the file browser and the monitor each ask again, because "once"
    // deliberately never touches the file.
    let trusted = trusted_this_run(&hostname, &fingerprint);
    let request = match result {
        CheckResult::Match => None,
        CheckResult::NotFound | CheckResult::Mismatch if trusted => None,
        CheckResult::NotFound => Some(Request::new(
            address,
            port,
            key_type(raw_key_type),
            fingerprint.clone(),
        )),
        CheckResult::Mismatch => Some(
            Request::new(address, port, key_type(raw_key_type), fingerprint.clone())
                .changed(stored_fingerprint(known_hosts, &hostname)),
        ),
        CheckResult::Failure => return Err(anyhow!("无法核验 SSH 主机指纹")),
    };
    let Some(request) = request else {
        return Ok(());
    };
    let changed = matches!(request.kind, Kind::Changed);
    match confirm(request)? {
        Answer::Reject => Err(anyhow!(if changed {
            "已拒绝指纹发生变化的主机"
        } else {
            "已取消主机指纹确认"
        })),
        // Either answer trusts the key for the rest of the run. "Once" only
        // keeps it off the disk, so the next launch still asks.
        answer => {
            trust_this_run(&hostname, &fingerprint);
            if matches!(answer, Answer::Remember) {
                if changed {
                    // The collection still holds the rejected key, so the file
                    // is cleaned before a fresh one is built from it. libssh2
                    // can add to a collection but only remove from a file.
                    forget(known_hosts, &hostname)?;
                    known = session.known_hosts()?;
                    if known_hosts.exists() {
                        known.read_file(known_hosts, KnownHostFileKind::OpenSSH)?;
                    }
                }
                known.add(&hostname, key, MARKER, raw_key_type.into())?;
                known.write_file(known_hosts, KnownHostFileKind::OpenSSH)?;
            }
            Ok(())
        }
    }
}

/// Blocks the connecting thread until the user answers or the request gives up.
pub(crate) fn confirm(mut request: Request) -> Result<Answer> {
    let handle = GATEWAY
        .get_or_init(Gateway::default)
        .handle
        .get()
        .context("主机指纹确认窗口尚未就绪")?
        .clone();
    let (sender, receiver) = mpsc::channel();
    request.id = Uuid::new_v4().to_string();
    lock_pending()?.insert(request.id.clone(), sender);
    // A connection can start from the tray or a monitoring retry, so bring the
    // window forward: nobody can answer a prompt they cannot see.
    if let Some(window) = handle.get_webview_window("main")
        && !window.is_focused().unwrap_or(true)
    {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    if let Err(error) = handle.emit(PROMPT_EVENT, &request) {
        remove_pending(&request.id);
        return Err(error).context("无法显示主机指纹确认");
    }
    let answer = receiver.recv_timeout(TIMEOUT);
    remove_pending(&request.id);
    match answer {
        Ok(answer) => Ok(answer),
        // Nobody answered: the prompt would otherwise linger forever.
        Err(_) => {
            let _ = handle.emit(
                RESOLVED_EVENT,
                Resolved {
                    id: request.id.clone(),
                },
            );
            Ok(Answer::Reject)
        }
    }
}

/// The window's answer. Unknown ids are the normal case: the connection timed
/// out or was closed before the user clicked.
pub(crate) fn answer(id: &str, accepted: bool, remember: bool) {
    let sender = lock_pending()
        .ok()
        .and_then(|mut pending| pending.remove(id));
    if let Some(sender) = sender {
        let reply = match (accepted, remember) {
            (false, _) => Answer::Reject,
            (true, true) => Answer::Remember,
            (true, false) => Answer::Once,
        };
        let _ = sender.send(reply);
    }
}

/// OpenSSH brackets non-standard ports, so port 22 is stored bare.
fn hostname(address: &str, port: u16) -> String {
    if port == 22 {
        address.to_string()
    } else {
        format!("[{address}]:{port}")
    }
}

/// Same form OpenSSH prints, so the value can be compared with `ssh-keygen -l`.
fn fingerprint(key: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(key);
    format!("SHA256:{}", STANDARD_NO_PAD.encode(hasher.finalize()))
}

/// The key type name, so the prompt can say what kind of key it verified.
fn key_type(value: HostKeyType) -> &'static str {
    match value {
        HostKeyType::Rsa => "ssh-rsa",
        HostKeyType::Dss => "ssh-dss",
        HostKeyType::Ecdsa256 => "ecdsa-sha2-nistp256",
        HostKeyType::Ecdsa384 => "ecdsa-sha2-nistp384",
        HostKeyType::Ecdsa521 => "ecdsa-sha2-nistp521",
        HostKeyType::Ed25519 => "ssh-ed25519",
        HostKeyType::Unknown => "unknown",
    }
}

/// The fingerprint already trusted, so a change can show what it was.
/// Hashed entries cannot be read back, so those simply report nothing.
fn stored_fingerprint(known_hosts: &Path, hostname: &str) -> Option<String> {
    let content = std::fs::read_to_string(known_hosts).ok()?;
    content.lines().find_map(|line| {
        let mut fields = line.split_whitespace();
        if fields.next()? != hostname {
            return None;
        }
        fields.next()?;
        let key = STANDARD.decode(fields.next()?).ok()?;
        Some(fingerprint(&key))
    })
}

/// Drops every stored entry for one host. libssh2 can add to a collection but
/// only remove from a file, so the file is rewritten and read back afterwards.
fn forget(known_hosts: &Path, hostname: &str) -> Result<()> {
    let content = match std::fs::read_to_string(known_hosts) {
        Ok(content) => content,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error).context("无法读取 known_hosts"),
    };
    let kept: Vec<&str> = content
        .lines()
        .filter(|line| line.split_whitespace().next() != Some(hostname))
        .collect();
    let updated = if kept.is_empty() {
        String::new()
    } else {
        format!("{}\n", kept.join("\n"))
    };
    std::fs::write(known_hosts, updated).context("无法更新 known_hosts")
}

#[tauri::command]
pub(crate) fn host_key_answer(id: String, accept: bool, remember: bool) {
    answer(&id, accept, remember);
}
