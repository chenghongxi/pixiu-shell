//! Native OAuth callback bridge. No remote window receives IPC permissions.
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use url::Url;
use uuid::Uuid;

#[derive(Default)]
pub(crate) struct LoginFlow {
    current: Mutex<Option<Attempt>>,
}
struct Attempt {
    id: Uuid,
    callback: Url,
    deadline: Instant,
    code: Option<String>,
    error: Option<String>,
    closed: bool,
}
impl LoginFlow {
    pub fn begin(&self, response: &Value) -> Result<Url> {
        let url = Url::parse(response["qrcodeUrl"].as_str().context("缺少钉钉授权 URL")?)?;
        ensure!(
            url.scheme() == "https" && url.host_str() == Some("login.dingtalk.com"),
            "平台返回了无效的钉钉授权地址"
        );
        let id = Uuid::parse_str(response["qrcodeId"].as_str().context("缺少二维码 ID")?)?;
        let state = url
            .query_pairs()
            .find_map(|(key, value)| (key == "state").then_some(value.into_owned()))
            .context("钉钉授权 URL 缺少 state")?;
        ensure!(state == id.to_string(), "钉钉授权 state 与二维码不匹配");
        let callback = url
            .query_pairs()
            .find_map(|(key, value)| (key == "redirect_uri").then_some(value.into_owned()))
            .context("缺少钉钉回调地址")?;
        let callback = Url::parse(&callback)?;
        ensure!(
            ["http", "https"].contains(&callback.scheme())
                && callback.has_host()
                && callback.username().is_empty()
                && callback.password().is_none(),
            "钉钉回调地址无效"
        );
        let ttl = response["expiresIn"].as_u64().unwrap_or(300).clamp(1, 600);
        *self
            .current
            .lock()
            .map_err(|_| anyhow::anyhow!("登录状态锁不可用"))? = Some(Attempt {
            id,
            callback,
            deadline: Instant::now() + Duration::from_secs(ttl),
            code: None,
            error: None,
            closed: false,
        });
        Ok(url)
    }
    /// Intercept the matching callback before loading an HTTP/intranet callback page.
    pub fn navigate(&self, id: Uuid, url: &Url) -> bool {
        let Ok(mut state) = self.current.lock() else {
            return false;
        };
        let Some(attempt) = state.as_mut().filter(|attempt| attempt.id == id) else {
            return false;
        };
        if callback_matches(&attempt.callback, url) {
            if Instant::now() >= attempt.deadline {
                attempt.error = Some("二维码已过期，请重新打开登录窗口".into());
                return false;
            }
            let state = url
                .query_pairs()
                .find_map(|(key, value)| (key == "state").then_some(value.into_owned()));
            if state.as_deref() != Some(id.to_string().as_str()) {
                attempt.error = Some("钉钉回调 state 不匹配，请重新登录".into());
                return false;
            }
            let code = url.query_pairs().find_map(|(key, value)| {
                (["code", "authCode", "auth_code", "loginTmpCode"].contains(&key.as_ref())
                    && !value.is_empty())
                .then_some(value.into_owned())
            });
            if let Some(code) = code {
                if attempt.code.is_none() {
                    attempt.code = Some(code);
                }
            } else {
                attempt.error = Some("钉钉未返回授权码，授权可能已取消，请重试".into());
            }
            return false;
        }
        url.scheme() == "https"
            && url
                .host_str()
                .is_some_and(|host| host == "dingtalk.com" || host.ends_with(".dingtalk.com"))
    }
    pub fn closed(&self, id: Uuid) {
        if let Ok(mut state) = self.current.lock()
            && let Some(attempt) = state.as_mut().filter(|value| value.id == id)
        {
            attempt.closed = true;
        }
    }
    pub fn status(&self, id: Uuid) -> Result<Option<Value>> {
        let state = self
            .current
            .lock()
            .map_err(|_| anyhow::anyhow!("登录状态锁不可用"))?;
        let attempt = state
            .as_ref()
            .filter(|value| value.id == id)
            .context("登录请求已取消或替换，请重新扫码")?;
        if let Some(code) = &attempt.code {
            return Ok(Some(json!({"status":"SUCCESS","authCode":code})));
        }
        if let Some(error) = &attempt.error {
            return Ok(Some(json!({"status":"ERROR","message":error})));
        }
        if Instant::now() >= attempt.deadline {
            return Ok(Some(json!({"status":"EXPIRED"})));
        }
        if attempt.closed {
            return Ok(Some(json!({"status":"CANCELLED"})));
        }
        Ok(None)
    }
}
fn callback_matches(expected: &Url, actual: &Url) -> bool {
    let scheme = actual.scheme() == expected.scheme()
        || (expected.scheme() == "http"
            && actual.scheme() == "https"
            && expected.port().is_none()
            && actual.port().is_none());
    scheme
        && expected.host_str() == actual.host_str()
        && expected.port() == actual.port()
        && expected.path() == actual.path()
}
#[cfg(test)]
mod tests {
    use super::*;
    fn response(id: Uuid) -> Value {
        let mut url = Url::parse("https://login.dingtalk.com/oauth2/auth").unwrap();
        url.query_pairs_mut()
            .append_pair("state", &id.to_string())
            .append_pair(
                "redirect_uri",
                "http://ops.example.com/api/v1/auth/dingtalk-callback",
            );
        json!({"qrcodeId":id,"qrcodeUrl":url,"expiresIn":300})
    }
    #[test]
    fn callback_does_not_depend_on_http_page_or_server_cache() -> Result<()> {
        let flow = LoginFlow::default();
        let id = Uuid::new_v4();
        flow.begin(&response(id))?;
        let callback = Url::parse(&format!(
            "https://ops.example.com/api/v1/auth/dingtalk-callback?state={id}&code=one-time-code"
        ))?;
        assert!(!flow.navigate(id, &callback));
        flow.closed(id);
        assert_eq!(
            flow.status(id)?.context("status")?["authCode"],
            "one-time-code"
        );
        Ok(())
    }
    #[test]
    fn mismatched_state_untrusted_origin_and_closed_window_are_explicit() -> Result<()> {
        let flow = LoginFlow::default();
        let id = Uuid::new_v4();
        flow.begin(&response(id))?;
        assert!(!flow.navigate(id, &Url::parse("https://evil.example.com/?code=bad")?));
        assert!(flow.status(id)?.is_none());
        assert!(!flow.navigate(
            id,
            &Url::parse("http://ops.example.com/api/v1/auth/dingtalk-callback?state=bad&code=bad")?
        ));
        assert_eq!(flow.status(id)?.context("status")?["status"], "ERROR");
        flow.begin(&response(id))?;
        flow.closed(id);
        assert_eq!(flow.status(id)?.context("status")?["status"], "CANCELLED");
        Ok(())
    }
}
