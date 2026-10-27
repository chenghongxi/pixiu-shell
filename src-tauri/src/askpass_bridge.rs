//! Bridge between OpenSSH's askpass helper and the in-app prompt.
//!
//! A password-authenticated connection runs the system `ssh`, which answers
//! host-key questions through `SSH_ASKPASS`. That helper is a separate process
//! with no access to Tauri, so it dials a short-lived loopback listener owned by
//! this process and waits for the window's verdict.

use crate::hostkey::{Answer, Request, confirm};
use anyhow::{Context, Result};
use serde::Deserialize;
use std::{
    io::{BufRead, BufReader, ErrorKind, Write},
    net::{TcpListener, TcpStream},
    time::{Duration, Instant},
};
use uuid::Uuid;

/// Handed to the ssh child so its helper can find the listener.
pub(crate) const ADDR_ENV: &str = "PIXIU_SHELL_ASKPASS_ADDR";
pub(crate) const TOKEN_ENV: &str = "PIXIU_SHELL_ASKPASS_TOKEN";

/// One authentication has to finish inside this window. A slow MFA login can
/// sit in front of the prompt for a while, so the listener waits much longer
/// than the prompt itself does.
const LIFETIME: Duration = Duration::from_secs(600);
const IDLE_POLL: Duration = Duration::from_millis(200);
const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Deserialize)]
struct Ask {
    token: String,
    prompt: String,
}

/// Starts the listener and returns what the child process needs to reach it.
pub(crate) fn start() -> Result<(String, String)> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).context("无法启动指纹确认通道")?;
    listener
        .set_nonblocking(true)
        .context("无法启动指纹确认通道")?;
    let address = listener
        .local_addr()
        .context("无法启动指纹确认通道")?
        .to_string();
    let token = Uuid::new_v4().to_string();
    let shared = token.clone();
    std::thread::spawn(move || serve(listener, &shared));
    Ok((address, token))
}

fn serve(listener: TcpListener, token: &str) {
    let deadline = Instant::now() + LIFETIME;
    while Instant::now() < deadline {
        match listener.accept() {
            // One connection asks about the host key exactly once; a second
            // question would be a password prompt, which never comes here.
            Ok((stream, _)) => {
                if handle(stream, token) {
                    return;
                }
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                std::thread::sleep(IDLE_POLL);
            }
            // The listener is gone: nothing left to answer.
            Err(_) => return,
        }
    }
}

/// Answers one helper and reports whether it was a genuine request.
fn handle(mut stream: TcpStream, token: &str) -> bool {
    let _ = stream.set_read_timeout(Some(EXCHANGE_TIMEOUT));
    let _ = stream.set_write_timeout(Some(EXCHANGE_TIMEOUT));
    let Ok(cloned) = stream.try_clone() else {
        return false;
    };
    let mut line = String::new();
    if BufReader::new(cloned).read_line(&mut line).is_err() {
        return false;
    }
    let Ok(ask) = serde_json::from_str::<Ask>(&line) else {
        return false;
    };
    // Any local process can reach the port, so the token is the only thing
    // separating a real helper from a random one.
    if ask.token != token {
        return false;
    }
    let accepted = matches!(
        confirm(request_from(&ask.prompt)),
        Ok(Answer::Once | Answer::Remember)
    );
    let _ = stream.write_all(if accepted { b"yes\n" } else { b"no\n" });
    let _ = stream.flush();
    true
}

/// OpenSSH asks in its own words, so the fields the prompt shows are rebuilt
/// from the text; whatever cannot be parsed falls back to the raw wording.
fn request_from(prompt: &str) -> Request {
    let fingerprint = extract_fingerprint(prompt);
    if fingerprint.is_empty() {
        return Request::raw(prompt);
    }
    let (address, port) = extract_host(prompt);
    let request = Request::new(&address, port, &extract_key_type(prompt), fingerprint);
    // OpenSSH only says the key changed, never what it used to be.
    if prompt.to_ascii_lowercase().contains("changed") {
        request.changed(None)
    } else {
        request
    }
}

fn extract_fingerprint(text: &str) -> String {
    let Some(start) = text.find("SHA256:") else {
        return String::new();
    };
    let rest = &text[start + "SHA256:".len()..];
    let end = rest
        .find(|value: char| !(value.is_ascii_alphanumeric() || matches!(value, '+' | '/' | '=')))
        .unwrap_or(rest.len());
    if end == 0 {
        String::new()
    } else {
        format!("SHA256:{}", &rest[..end])
    }
}

fn extract_host(text: &str) -> (String, u16) {
    let Some(start) = text.find("host '") else {
        return (String::new(), 22);
    };
    let rest = &text[start + "host '".len()..];
    let Some(end) = rest.find('\'') else {
        return (String::new(), 22);
    };
    let target = rest[..end].split_whitespace().next().unwrap_or_default();
    if let Some(inner) = target.strip_prefix('[')
        && let Some((address, port)) = inner.split_once("]:")
    {
        return (address.to_string(), port.parse().unwrap_or(22));
    }
    (target.trim_matches(['[', ']']).to_string(), 22)
}

fn extract_key_type(text: &str) -> String {
    let upper = text.to_ascii_uppercase();
    for (needle, name) in [
        ("ED25519 KEY", "ssh-ed25519"),
        ("ECDSA KEY", "ecdsa"),
        ("RSA KEY", "ssh-rsa"),
        ("DSA KEY", "ssh-dss"),
    ] {
        if upper.contains(needle) {
            return name.to_string();
        }
    }
    String::new()
}
