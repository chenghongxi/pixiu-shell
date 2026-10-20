use anyhow::{Context, Result, anyhow, bail, ensure};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::ipc::Channel;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{Message, http::Request};
use uuid::Uuid;

use crate::storage::LocalHost;

#[derive(Debug, Serialize)]
#[serde(tag = "type", content = "data", rename_all = "camelCase")]
pub(crate) enum Event {
    Output(Vec<u8>),
    Rdp(String),
    Status(String),
    #[serde(rename = "command_guard")]
    CommandGuard {
        blocked: bool,
        action: String,
        #[serde(rename = "riskLevel")]
        #[serde(skip_serializing_if = "Option::is_none")]
        risk_level: Option<String>,
        #[serde(rename = "matchedRule")]
        #[serde(skip_serializing_if = "Option::is_none")]
        matched_rule: Option<String>,
        message: String,
        command: String,
    },
    Error(String),
    Closed,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum Input {
    Input {
        data: String,
        #[serde(default)]
        command: Option<String>,
    },
    Resize {
        cols: u16,
        rows: u16,
    },
}

struct LocalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
}

fn terminate_child(child: &mut dyn portable_pty::Child) -> Result<()> {
    if child.try_wait().context("无法读取终端进程状态")?.is_some() {
        return Ok(());
    }
    if let Err(error) = child.kill() {
        // Process exit can race with TerminateProcess on Windows.
        if child.try_wait().context("无法读取终端进程状态")?.is_none() {
            return Err(error).context("无法结束终端进程");
        }
        return Ok(());
    }
    // portable-pty's Windows Child::kill can discard OS errors, while its
    // clone_killer misreports success. Verify the original process has exited.
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if child.try_wait().context("无法读取终端进程状态")?.is_some() {
            return Ok(());
        }
        ensure!(Instant::now() < deadline, "终端进程未结束，请重试关闭");
        std::thread::sleep(Duration::from_millis(10));
    }
}

impl LocalSession {
    fn terminate(&self) -> Result<()> {
        let mut child = self.child.lock().map_err(|_| anyhow!("终端进程锁不可用"))?;
        terminate_child(child.as_mut())
    }
}

enum Session {
    Local(LocalSession),
    Platform(mpsc::Sender<Message>),
}

const IDLE_TIMEOUT: Duration = Duration::from_secs(600);
struct SessionEntry {
    is_system_shell: bool,
    platform_host: Option<Uuid>,
    transport: Session,
    last_input: Instant,
    events: Channel<Event>,
}
#[derive(Default)]
pub(crate) struct Sessions {
    entries: Mutex<HashMap<Uuid, SessionEntry>>,
}

pub(crate) fn system_shell() -> (std::path::PathBuf, &'static str) {
    if cfg!(windows) {
        return (
            std::env::var_os("COMSPEC")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| "cmd.exe".into()),
            "cmd",
        );
    }
    if let Some(path) = std::env::var_os("SHELL")
        .map(std::path::PathBuf::from)
        .filter(|path| path.is_file())
    {
        match path.file_name().and_then(|value| value.to_str()) {
            Some("bash") => return (path, "bash"),
            Some("zsh") => return (path, "zsh"),
            _ => {}
        }
    }
    if cfg!(target_os = "macos") {
        (std::path::PathBuf::from("/bin/zsh"), "zsh")
    } else {
        (std::path::PathBuf::from("/bin/bash"), "bash")
    }
}

impl Sessions {
    pub fn platform_host(&self, id: Uuid) -> Result<Uuid> {
        self.entries
            .lock()
            .map_err(|_| anyhow!("终端状态锁不可用"))?
            .get(&id)
            .and_then(|entry| entry.platform_host)
            .context("AI 仅支持已连接的平台 SSH 会话")
    }

    pub fn is_local_ssh(&self, id: Uuid) -> Result<bool> {
        let entries = self
            .entries
            .lock()
            .map_err(|_| anyhow!("终端状态锁不可用"))?;
        let entry = entries.get(&id).context("终端已关闭")?;
        Ok(!entry.is_system_shell && matches!(entry.transport, Session::Local(_)))
    }
    pub fn start_idle_monitor(self: &Arc<Self>) {
        let sessions = Arc::downgrade(self);
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_secs(1));
                let Some(sessions) = sessions.upgrade() else {
                    break;
                };
                sessions.expire_idle(Instant::now());
            }
        });
    }
    fn expire_idle(&self, now: Instant) {
        let Ok(mut entries) = self.entries.lock() else {
            return;
        };
        entries.retain(|_, entry| {
            if entry.is_system_shell {
                return true;
            }
            if now.saturating_duration_since(entry.last_input) < IDLE_TIMEOUT {
                return true;
            }
            let _ = entry
                .events
                .send(Event::Status("10 分钟无操作，SSH 连接已自动关闭".into()));
            if let Session::Local(local) = &mut entry.transport
                && let Err(error) = local.terminate()
            {
                let _ = entry
                    .events
                    .send(Event::Error(format!("关闭空闲 SSH 进程失败：{error}")));
            }
            false
        });
    }
    pub fn close(&self, id: Uuid) -> Result<()> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| anyhow!("终端状态锁不可用"))?;
        if let Some(entry) = entries.get(&id)
            && let Session::Local(session) = &entry.transport
        {
            session.terminate().with_context(|| {
                if entry.is_system_shell {
                    "无法关闭本机 Shell 进程"
                } else {
                    "无法关闭 SSH 进程"
                }
            })?;
        }
        entries.remove(&id);
        // Dropping the last sender stops the WebSocket worker.
        Ok(())
    }

    pub fn close_platform(&self) -> Result<()> {
        self.entries
            .lock()
            .map_err(|_| anyhow!("终端状态锁不可用"))?
            .retain(|_, value| matches!(value.transport, Session::Local(_)));
        Ok(())
    }

    pub fn close_all(&self) -> Result<()> {
        let entries = std::mem::take(
            &mut *self
                .entries
                .lock()
                .map_err(|_| anyhow!("终端状态锁不可用"))?,
        );
        let mut failure = None;
        for (_, entry) in entries {
            if let Session::Local(session) = entry.transport
                && let Err(error) = session.terminate()
            {
                failure = Some(error);
            }
        }
        match failure {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    pub fn send(&self, id: Uuid, input: Input) -> Result<()> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| anyhow!("终端状态锁不可用"))?;
        let entry = entries.get_mut(&id).context("终端已断开")?;
        match input {
            Input::Input { data, command } => {
                ensure!(data.len() <= 65536, "单次输入不能超过 64 KiB");
                match &mut entry.transport {
                    Session::Local(local) => {
                        local.writer.write_all(data.as_bytes())?;
                        local.writer.flush()?;
                    }
                    Session::Platform(sender) => sender
                        .try_send(Message::Text(
                            json!({"type":"input","data":data,"command":command})
                                .to_string()
                                .into(),
                        ))
                        .context("终端输入队列已满或连接已关闭")?,
                }
                if !data.is_empty() {
                    entry.last_input = Instant::now();
                }
            }
            Input::Resize { cols, rows } => {
                let size = size(cols, rows);
                match &mut entry.transport {
                    Session::Local(local) => local.master.resize(size)?,
                    Session::Platform(sender) => sender
                        .try_send(Message::Text(
                            json!({"type":"resize","cols":size.cols,"rows":size.rows})
                                .to_string()
                                .into(),
                        ))
                        .context("终端调整队列已满或连接已关闭")?,
                }
            }
        }
        Ok(())
    }

    pub fn send_rdp(&self, id: Uuid, data: String) -> Result<()> {
        ensure!(data.len() <= 65536, "单次 RDP 输入不能超过 64 KiB");
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| anyhow!("终端状态锁不可用"))?;
        let entry = entries.get_mut(&id).context("终端已断开")?;
        match &mut entry.transport {
            Session::Platform(sender) => sender
                .try_send(Message::Text(data.into()))
                .context("RDP 输入队列已满或连接已关闭")?,
            Session::Local(_) => bail!("当前会话不是 RDP"),
        }
        Ok(())
    }

    pub fn open_local(
        self: &Arc<Self>,
        id: Uuid,
        host: LocalHost,
        known_hosts: &Path,
        channel: Channel<Event>,
        cols: u16,
        rows: u16,
    ) -> Result<()> {
        host.validate()?;
        let mut command = CommandBuilder::new("ssh");
        // Use argv, never shell interpolation. Ignore arbitrary user SSH config commands.
        command.args([
            "-F",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
            "-tt",
            "-o",
            "StrictHostKeyChecking=ask",
            "-o",
            "ConnectTimeout=60",
            "-o",
            "ServerAliveInterval=30",
            "-o",
            "ServerAliveCountMax=3",
        ]);
        command.arg("-o");
        command.arg(format!("UserKnownHostsFile=\"{}\"", known_hosts.display()));
        if let Some(proxy) = &host.proxy {
            let executable = std::env::current_exe()?.to_string_lossy().into_owned();
            let quoted = if cfg!(windows) {
                format!("\"{executable}\"")
            } else {
                format!("'{}'", executable.replace('\'', "'\"'\"'"))
            };
            command.arg("-o");
            command.arg(format!("ProxyCommand={quoted} --tshell-proxy"));
            command.env("TSHELL_PROXY_CONFIG", serde_json::to_string(proxy)?);
            command.env(
                "TSHELL_PROXY_ID",
                host.id.context("主机缺少 ID")?.to_string(),
            );
            command.env("TSHELL_PROXY_TARGET", &host.address);
            command.env("TSHELL_PROXY_PORT", host.port.to_string());
        }
        command.arg("-p");
        command.arg(host.port.to_string());
        command.arg("-l");
        command.arg(host.username);
        if !host.identity_file.is_empty() {
            ensure!(
                Path::new(&host.identity_file).is_file(),
                "指定的私钥文件不存在（请填写绝对路径）"
            );
            command.arg("-i");
            command.arg(host.identity_file);
        }
        for tunnel in &host.tunnels {
            let (flag, value) = tunnel.arguments()?;
            command.arg(flag);
            command.arg(value);
        }
        if !host.tunnels.is_empty() {
            command.args(["-o", "ExitOnForwardFailure=yes"]);
        }
        if host.has_password {
            let id = host.id.context("主机缺少 ID")?;
            ensure!(
                crate::credentials::read(id)?.is_some(),
                "主机保存的密码不可用，请在配置页重新保存"
            );
            command.env("SSH_ASKPASS", std::env::current_exe()?);
            command.env("SSH_ASKPASS_REQUIRE", "force");
            command.env("TSHELL_ASKPASS", "1");
            command.env("TSHELL_CREDENTIAL_ID", id.to_string());
            command.env("DISPLAY", "tshell:0");
        }
        command.arg("--");
        command.arg(host.address);
        command.env("TERM", "xterm-256color");
        self.spawn_process(id, command, channel, (cols, rows), false)
    }
    pub fn open_system(
        self: &Arc<Self>,
        id: Uuid,
        channel: Channel<Event>,
        cols: u16,
        rows: u16,
    ) -> Result<()> {
        let (executable, _) = system_shell();
        let mut command = CommandBuilder::new(executable);
        if cfg!(windows) {
            command.args(["/Q", "/K", "chcp 65001>nul"]);
        } else {
            command.arg("-l");
        }
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        if let Some(directory) =
            std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        {
            command.cwd(directory);
        }
        self.spawn_process(id, command, channel, (cols, rows), true)
    }
    fn spawn_process(
        self: &Arc<Self>,
        id: Uuid,
        command: CommandBuilder,
        channel: Channel<Event>,
        dimensions: (u16, u16),
        is_system_shell: bool,
    ) -> Result<()> {
        let pair = portable_pty::native_pty_system().openpty(size(dimensions.0, dimensions.1))?;
        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| anyhow!("终端状态锁不可用"))?;
        let child = pair
            .slave
            .spawn_command(command)
            .context("无法启动终端进程，请检查系统 Shell 或 OpenSSH")?;
        drop(pair.slave);
        let child = Arc::new(Mutex::new(child));
        let local = LocalSession {
            master: pair.master,
            writer,
            child: Arc::clone(&child),
        };
        entries.insert(
            id,
            SessionEntry {
                is_system_shell,
                platform_host: None,
                transport: Session::Local(local),
                last_input: Instant::now(),
                events: channel.clone(),
            },
        );
        drop(entries);
        let sessions = Arc::clone(self);
        std::thread::spawn(move || {
            if is_system_shell {
                let _ = channel.send(Event::Status("local shell connected".into()));
            }
            let mut buffer = [0_u8; 16384];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        if channel
                            .send(Event::Output(buffer[..count].to_vec()))
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = channel.send(Event::Error(format!("SSH 输出中断：{error}")));
                        break;
                    }
                }
            }
            if let Err(error) = sessions.close(id) {
                let _ = channel.send(Event::Error(error.to_string()));
                return;
            }
            let waited = child
                .lock()
                .map_err(|_| anyhow!("终端进程锁不可用"))
                .and_then(|mut process| process.wait().map_err(Into::into));
            if let Err(error) = waited {
                let label = if is_system_shell {
                    "本机 Shell"
                } else {
                    "SSH"
                };
                let _ = channel.send(Event::Error(format!("{label} 进程退出异常：{error}")));
            }
            let _ = channel.send(Event::Closed);
        });
        Ok(())
    }

    pub async fn open_platform(
        self: &Arc<Self>,
        id: Uuid,
        host_id: Uuid,
        request: Request<()>,
        channel: Channel<Event>,
        dimensions: (u16, u16),
        is_rdp: bool,
    ) -> Result<()> {
        let (mut socket, _) = tokio::time::timeout(
            Duration::from_secs(60),
            tokio_tungstenite::connect_async(request),
        )
        .await
        .context("平台连接超时")?
        .map_err(|_| anyhow!("平台 SSH 通道建立失败，请检查权限及网络"))?;
        let size = size(dimensions.0, dimensions.1);
        if !is_rdp {
            socket
                .send(Message::Text(
                    json!({"type":"connect","cols":size.cols,"rows":size.rows})
                        .to_string()
                        .into(),
                ))
                .await?;
        }
        let (sender, mut receiver) = mpsc::channel(128);
        self.entries
            .lock()
            .map_err(|_| anyhow!("终端状态锁不可用"))?
            .insert(
                id,
                SessionEntry {
                    is_system_shell: false,
                    platform_host: None,
                    transport: Session::Platform(sender),
                    last_input: Instant::now(),
                    events: channel.clone(),
                },
            );
        let sessions = Arc::clone(self);
        tokio::spawn(async move {
            let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
            heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let result: Result<()> = async {
                loop {
                    tokio::select! {
                        _ = heartbeat.tick() => tokio::time::timeout(Duration::from_secs(15), socket.send(Message::Ping(Vec::new().into()))).await??,
                        message = receiver.recv() => match message {
                            Some(message) => tokio::time::timeout(Duration::from_secs(15), socket.send(message)).await??,
                            None => break,
                        },
                        message = socket.next() => match message {
                            Some(Ok(Message::Text(text))) => {
                                if is_rdp {
                                    channel.send(Event::Rdp(text.to_string()))?;
                                    continue;
                                }
                                let event = parse_frame(text.as_str());
                                if matches!(&event, Event::Status(message) if message == "ssh session connected")
                                    && let Ok(mut entries) = sessions.entries.lock()
                                    && let Some(entry) = entries.get_mut(&id)
                                { entry.last_input = Instant::now(); entry.platform_host = Some(host_id); }
                                channel.send(event)?;
                            },
                            Some(Ok(Message::Binary(bytes))) => channel.send(Event::Output(bytes.to_vec()))?,
                            Some(Ok(Message::Ping(bytes))) => socket.send(Message::Pong(bytes)).await?,
                            Some(Ok(Message::Close(_))) | None => break,
                            Some(Err(_)) => return Err(anyhow!("平台 SSH 通道中断")),
                            _ => {},
                        }
                    }
                }
                Ok(())
            }.await;
            if let Err(error) = result {
                let _ = channel.send(Event::Error(error.to_string()));
            }
            let _ = tokio::time::timeout(Duration::from_secs(2), socket.close(None)).await;
            if let Err(error) = sessions.close(id) {
                let _ = channel.send(Event::Error(error.to_string()));
            }
            let _ = channel.send(Event::Closed);
        });
        Ok(())
    }
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols: cols.clamp(2, 500),
        rows: rows.clamp(2, 300),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn parse_frame(text: &str) -> Event {
    if let Ok(frame) = serde_json::from_str::<Value>(text) {
        let message = frame["message"]
            .as_str()
            .or_else(|| frame["data"].as_str())
            .unwrap_or("");
        match frame["type"].as_str() {
            Some("output") => {
                return Event::Output(frame["data"].as_str().unwrap_or("").as_bytes().to_vec());
            }
            Some("error") => return Event::Error(message.to_owned()),
            Some("status") => return Event::Status(message.to_owned()),
            Some("command_guard") => {
                return Event::CommandGuard {
                    blocked: frame["blocked"].as_bool().unwrap_or(true),
                    action: frame["action"].as_str().unwrap_or("检查").to_string(),
                    risk_level: frame["riskLevel"]
                        .as_str()
                        .or_else(|| frame["risk_level"].as_str())
                        .map(ToString::to_string),
                    matched_rule: frame["matchedRule"]
                        .as_str()
                        .or_else(|| frame["matched_rule"].as_str())
                        .map(ToString::to_string),
                    message: message.to_string(),
                    command: frame["command"].as_str().unwrap_or("").to_string(),
                };
            }
            _ => {}
        }
    }
    Event::Output(text.as_bytes().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Clone)]
    struct ExitRaceChild {
        polls: usize,
        exited_at: usize,
        kill_fails: bool,
        kills: Arc<std::sync::atomic::AtomicUsize>,
    }
    impl portable_pty::ChildKiller for ExitRaceChild {
        fn kill(&mut self) -> std::io::Result<()> {
            self.kills.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if self.kill_fails {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "TerminateProcess failed",
                ))
            } else {
                self.exited_at = self.polls + 1;
                Ok(())
            }
        }
        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            Box::new(self.clone())
        }
    }
    impl portable_pty::Child for ExitRaceChild {
        fn try_wait(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> {
            self.polls += 1;
            Ok((self.polls >= self.exited_at).then(|| portable_pty::ExitStatus::with_exit_code(0)))
        }
        fn wait(&mut self) -> std::io::Result<portable_pty::ExitStatus> {
            Ok(portable_pty::ExitStatus::with_exit_code(0))
        }
        fn process_id(&self) -> Option<u32> {
            None
        }
        #[cfg(windows)]
        fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
            None
        }
    }

    #[test]
    fn closing_exited_and_racing_processes_is_idempotent_but_real_kill_failures_propagate() {
        for (exited_at, kill_fails, expected_kills, succeeds) in [
            (1, true, 0, true),
            (2, true, 1, true),
            (usize::MAX, true, 1, false),
            (usize::MAX, false, 1, true),
        ] {
            let kills = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let mut child = ExitRaceChild {
                polls: 0,
                exited_at,
                kill_fails,
                kills: Arc::clone(&kills),
            };
            assert_eq!(terminate_child(&mut child).is_ok(), succeeds);
            assert_eq!(
                kills.load(std::sync::atomic::Ordering::SeqCst),
                expected_kills
            );
        }
    }

    #[test]
    fn naturally_exited_local_shell_closes_without_ssh_error() -> Result<()> {
        let sessions = Arc::new(Sessions::default());
        let id = Uuid::new_v4();
        let (sender, receiver) = std::sync::mpsc::channel();
        let events = Channel::new(move |body| {
            let _ = sender.send(body.deserialize::<Value>()?);
            Ok(())
        });
        let mut command = CommandBuilder::new(if cfg!(windows) { "cmd.exe" } else { "/bin/sh" });
        command.args(if cfg!(windows) {
            vec!["/C", "echo exited"]
        } else {
            vec!["-c", "printf 'exited\\n'"]
        });
        sessions.spawn_process(id, command, events, (80, 24), true)?;
        loop {
            let event = receiver.recv_timeout(Duration::from_secs(8))?;
            assert_ne!(event["type"], "error", "{event}");
            if event["type"] == "closed" {
                break;
            }
        }
        sessions.close(id)?;
        sessions.close(id)?;
        Ok(())
    }

    #[test]
    fn real_system_shell_has_interactive_io_and_is_not_an_idle_ssh_session() -> Result<()> {
        let sessions = Arc::new(Sessions::default());
        let id = Uuid::new_v4();
        let (sender, receiver) = std::sync::mpsc::channel();
        let events = Channel::new(move |body| {
            let _ = sender.send(body.deserialize::<Value>()?);
            Ok(())
        });
        sessions.open_system(id, events, 80, 24)?;
        let result = (|| -> Result<()> {
            sessions.expire_idle(Instant::now() + Duration::from_secs(601));
            assert!(
                sessions
                    .entries
                    .lock()
                    .map_err(|_| anyhow!("lock"))?
                    .contains_key(&id)
            );
            let command = if cfg!(windows) {
                "echo TSHELL_SYSTEM^_SHELL_OK\r"
            } else {
                "printf '%s%s\\n' 'TSHELL_' 'SYSTEM_SHELL_OK'\r"
            };
            sessions.send(
                id,
                Input::Input {
                    data: command.into(),
                    command: None,
                },
            )?;
            let until = Instant::now() + Duration::from_secs(8);
            let mut output = String::new();
            while Instant::now() < until {
                let event = match receiver.recv_timeout(Duration::from_millis(500)) {
                    Ok(event) => event,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(error) => return Err(error.into()),
                };
                if event["type"] == "output" {
                    let bytes: Vec<u8> = serde_json::from_value(event["data"].to_owned())?;
                    output.push_str(&String::from_utf8_lossy(&bytes));
                    if output.contains("TSHELL_SYSTEM_SHELL_OK") {
                        return Ok(());
                    }
                }
            }
            Err(anyhow!("shell output was not received"))
        })();
        sessions.close(id)?;
        result
    }
    #[test]
    fn ai_rejects_unknown_and_unconfirmed_platform_sessions() -> Result<()> {
        let sessions = Sessions::default();
        let id = Uuid::new_v4();
        assert!(sessions.platform_host(id).is_err());
        let (sender, _receiver) = mpsc::channel(1);
        sessions
            .entries
            .lock()
            .map_err(|_| anyhow!("lock"))?
            .insert(
                id,
                SessionEntry {
                    is_system_shell: false,
                    platform_host: None,
                    transport: Session::Platform(sender),
                    last_input: Instant::now(),
                    events: Channel::new(|_| Ok(())),
                },
            );
        assert!(sessions.platform_host(id).is_err());
        let host = Uuid::new_v4();
        sessions
            .entries
            .lock()
            .map_err(|_| anyhow!("lock"))?
            .get_mut(&id)
            .context("session")?
            .platform_host = Some(host);
        assert_eq!(sessions.platform_host(id)?, host);
        sessions.close(id)?;
        assert!(sessions.platform_host(id).is_err());
        Ok(())
    }
    #[test]
    fn idle_deadline_ignores_resize_and_resets_on_input() -> Result<()> {
        let sessions = Sessions::default();
        let id = Uuid::new_v4();
        let now = Instant::now();
        let (sender, mut receiver) = mpsc::channel(8);
        sessions
            .entries
            .lock()
            .map_err(|_| anyhow!("lock"))?
            .insert(
                id,
                SessionEntry {
                    is_system_shell: false,
                    platform_host: None,
                    transport: Session::Platform(sender),
                    last_input: now - Duration::from_secs(599),
                    events: Channel::new(|_| Ok(())),
                },
            );
        sessions.send(
            id,
            Input::Resize {
                cols: 100,
                rows: 30,
            },
        )?;
        sessions.expire_idle(now);
        assert!(!receiver.is_closed());
        sessions.send(
            id,
            Input::Input {
                data: "ls\r".into(),
                command: None,
            },
        )?;
        sessions.expire_idle(now + Duration::from_secs(2));
        assert!(!receiver.is_closed());
        sessions.expire_idle(now + Duration::from_secs(601));
        assert!(receiver.is_closed());
        while receiver.try_recv().is_ok() {}
        Ok(())
    }
    #[test]
    fn decodes_platform_frames_without_losing_unicode() {
        match parse_frame(r#"{"type":"output","data":"你好\r\n"}"#) {
            Event::Output(bytes) => assert_eq!(bytes, "你好\r\n".as_bytes()),
            other => panic!("unexpected {other:?}"),
        }
        assert!(matches!(
            parse_frame(r#"{"type":"error","message":"禁止访问"}"#),
            Event::Error(_)
        ));
        assert!(matches!(
            parse_frame(r#"{"type":"command_guard","action":"block","message":"命令已阻断"}"#),
            Event::CommandGuard { .. }
        ));
    }
    #[test]
    #[ignore = "requires tests/ssh_fixture.py and TSHELL_SSH_FIXTURE"]
    fn real_ssh_pty_input_resize_and_local_forward() -> Result<()> {
        use std::net::{TcpListener, TcpStream};
        let fixture: Value =
            serde_json::from_slice(&std::fs::read(std::env::var("TSHELL_SSH_FIXTURE")?)?)?;
        let echo = TcpListener::bind("127.0.0.1:0")?;
        echo.set_nonblocking(true)?;
        let destination = echo.local_addr()?.port();
        let reserve = TcpListener::bind("127.0.0.1:0")?;
        let forwarded = reserve.local_addr()?.port();
        drop(reserve);
        let echo_worker = std::thread::spawn(move || -> Result<()> {
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            while std::time::Instant::now() < deadline {
                if let Ok((mut stream, _)) = echo.accept() {
                    stream.set_nonblocking(false)?;
                    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
                    let mut bytes = [0; 5];
                    stream.read_exact(&mut bytes)?;
                    stream.write_all(&bytes)?;
                    return Ok(());
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(anyhow!("forwarding destination was not reached"))
        });
        let host = LocalHost {
            id: Some(Uuid::new_v4()),
            name: "fixture".into(),
            address: "127.0.0.1".into(),
            port: fixture["port"].as_u64().context("port")? as u16,
            username: "fixture".into(),
            group: String::new(),
            identity_file: fixture["identity"].as_str().context("identity")?.into(),
            note: String::new(),
            tags: vec![],
            tunnels: vec![crate::storage::Tunnel {
                kind: "local".into(),
                listen_port: forwarded,
                target_host: "127.0.0.1".into(),
                target_port: destination,
            }],
            has_password: false,
            proxy: None,
        };
        let sessions = Arc::new(Sessions::default());
        let id = Uuid::new_v4();
        let (sender, receiver) = std::sync::mpsc::channel();
        let channel = Channel::new(move |body| {
            let _ = sender.send(body.deserialize::<Value>()?);
            Ok(())
        });
        sessions.open_local(
            id,
            host,
            Path::new(fixture["knownHosts"].as_str().context("knownHosts")?),
            channel,
            100,
            30,
        )?;
        let result = (|| -> Result<()> {
            let mut output = String::new();
            while !output.contains("fixture ready") {
                let event = receiver.recv_timeout(Duration::from_secs(10))?;
                if event["type"] == "output" {
                    let bytes: Vec<u8> = serde_json::from_value(event["data"].to_owned())?;
                    output.push_str(&String::from_utf8_lossy(&bytes));
                }
                ensure!(
                    event["type"] != "closed",
                    "SSH exited before shell was ready: {output}"
                );
            }
            let pty: Value = serde_json::from_slice(&std::fs::read(
                Path::new(fixture["directory"].as_str().context("directory")?).join("pty.json"),
            )?)?;
            assert_eq!(pty["term"], "xterm-256color");

            sessions.send(
                id,
                Input::Resize {
                    cols: 120,
                    rows: 40,
                },
            )?;
            sessions.send(
                id,
                Input::Input {
                    data: "tshell-input-test\r".into(),
                    command: None,
                },
            )?;
            let mut tunnel = TcpStream::connect(("127.0.0.1", forwarded))?;
            tunnel.set_read_timeout(Some(Duration::from_secs(5)))?;
            tunnel.write_all(b"hello")?;
            let mut echoed = [0; 5];
            tunnel
                .read_exact(&mut echoed)
                .context("forwarded echo response")?;
            assert_eq!(&echoed, b"hello");
            echo_worker
                .join()
                .map_err(|_| anyhow!("echo worker panicked"))??;
            Ok(())
        })();
        sessions.close(id)?;
        result
    }
}
