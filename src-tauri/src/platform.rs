use anyhow::{Context, Result, anyhow, bail, ensure};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use url::Url;
use uuid::Uuid;
use zeroize::Zeroizing;

// Tokens never cross the IPC boundary or enter SQLite.
#[derive(Deserialize, Serialize)]
struct StoredAuth {
    refresh_token: String,
}
#[derive(Debug)]
struct AuthExpired;
impl std::fmt::Display for AuthExpired {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("平台登录已失效，请重新登录")
    }
}
impl std::error::Error for AuthExpired {}

pub(crate) struct Platform {
    store: Arc<dyn crate::auth_store::AuthStore>,
    client: Client,
    base: Option<Url>,
    token: Option<String>,
    refresh_token: Option<String>,
    expires: Option<Instant>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum Request {
    Login {
        username: String,
        password: String,
    },
    Qrcode,
    QrcodeStatus {
        id: Uuid,
    },
    Dingtalk {
        #[serde(rename = "authCode")]
        auth_code: Option<String>,
        #[serde(rename = "loginTicket")]
        login_ticket: Option<String>,
        #[serde(rename = "companyId")]
        company_id: Option<Uuid>,
    },
    Hosts,
    HostOptions {
        id: Uuid,
    },
    Resource {
        path: String,
        method: String,
        body: Option<Value>,
    },
    Me,
}

pub(crate) fn normalize_base(value: &str) -> Result<Url> {
    let mut url = Url::parse(value.trim()).context("平台地址必须包含 https://")?;
    ensure!(
        url.has_host()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "平台地址不能包含账号、查询参数或片段"
    );
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    ensure!(
        url.scheme() == "https" || (url.scheme() == "http" && loopback),
        "请使用 HTTPS；仅本机开发允许 HTTP"
    );
    let path = format!("{}/", url.path().trim_end_matches('/'));
    url.set_path(&path);
    Ok(url)
}

fn validate_resource_path(path: &str) -> Result<()> {
    let route = path.split('?').next().unwrap_or("");
    ensure!(
        !path.contains(['#', '\\'])
            && !route.contains('%')
            && !route
                .split('/')
                .any(|part| part == ".." || part == "." || part.is_empty()),
        "资源路径无效"
    );
    ensure!(
        [
            "assets/hosts",
            "assets/nodes",
            "assets/credentials",
            "assets/proxies",
            "assets/host-scripts",
            "assets/host-script-playbooks",
            "assets/host-script-runs",
            "assets/commands/jobs",
            "assets/command-approvals",
            "tags"
        ]
        .iter()
        .any(|prefix| route == *prefix
            || route
                .strip_prefix(prefix)
                .is_some_and(|rest| rest.starts_with('/'))),
        "资源接口未授权"
    );
    Ok(())
}

impl Platform {
    pub fn new() -> Result<Self> {
        Ok(Self {
            store: Arc::new(crate::auth_store::KeychainStore),
            client: Client::builder()
                .user_agent(concat!("PixiuShell/", env!("CARGO_PKG_VERSION")))
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(30))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            base: None,
            token: None,
            refresh_token: None,
            expires: None,
        })
    }

    pub fn configure(&mut self, base: Url) {
        self.clear();
        self.base = Some(base);
    }

    pub fn clear(&mut self) {
        self.token = None;
        self.refresh_token = None;
        self.expires = None;
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        token: Option<&str>,
    ) -> Result<Value> {
        let base = self.base.as_ref().context("请先配置运维平台地址")?;
        let mut request = self.client.request(method, base.join(path)?);
        if path.ends_with("/connectivity-test") {
            request = request.timeout(Duration::from_secs(65));
        }
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        // Do not include reqwest errors containing full URLs in frontend messages.
        let response = request
            .send()
            .await
            .map_err(|_| anyhow!("无法连接运维平台，请检查地址、网络及 TLS 证书"))?;
        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(AuthExpired.into());
        }
        let mut envelope: Value = response.json().await.context("平台响应不是有效 JSON")?;
        ensure!(
            status.is_success() && envelope["code"] == 200,
            "{}",
            envelope["msg"].as_str().unwrap_or("平台请求被拒绝")
        );
        envelope
            .as_object_mut()
            .and_then(|object| object.remove("data"))
            .context("平台响应缺少 data")
    }

    async fn accept_login(&mut self, mut login: Value) -> Result<Value> {
        let object = login.as_object_mut().context("登录响应格式错误")?;
        let token = object
            .remove("token")
            .and_then(|value| {
                if let Value::String(token) = value {
                    Some(token)
                } else {
                    None
                }
            })
            .filter(|v| !v.is_empty())
            .context("登录响应缺少 token")?;
        let refresh = object
            .remove("refresh_token")
            .or_else(|| object.remove("refreshToken"))
            .and_then(|value| {
                if let Value::String(token) = value {
                    Some(token)
                } else {
                    None
                }
            });
        let seconds = object
            .remove("expires_in")
            .or_else(|| object.remove("expiresIn"))
            .and_then(|v| v.as_u64())
            .unwrap_or(3600)
            .min(86400);
        let user = object.remove("user").context("登录响应缺少 user")?;
        if let Some(base) = &self.base {
            let stored = StoredAuth {
                refresh_token: refresh
                    .as_ref()
                    .context("平台未返回可恢复的登录凭据")?
                    .to_owned(),
            };
            let value = Zeroizing::new(serde_json::to_string(&stored)?);
            let account = base.to_string();
            let store = Arc::clone(&self.store);
            tokio::task::spawn_blocking(move || store.write(&account, &value)).await??;
        }
        self.token = Some(token);
        self.refresh_token = refresh;
        self.expires = Some(Instant::now() + Duration::from_secs(seconds.saturating_sub(60)));
        Ok(user)
    }

    async fn refresh(&mut self) -> Result<()> {
        ensure!(self.token.is_some(), "请先登录运维平台");
        if self
            .expires
            .is_some_and(|expires| Instant::now() >= expires)
        {
            let refresh = self
                .refresh_token
                .as_deref()
                .context("会话已过期，请重新登录")?;
            let body = json!({"refresh_token": refresh, "sessionKind": "pixiu-shell"});
            let result = self
                .request(Method::POST, "api/v1/auth/refresh", Some(&body), None)
                .await;
            match result {
                Ok(login) => {
                    self.accept_login(login).await?;
                }
                Err(error) => {
                    if error.downcast_ref::<AuthExpired>().is_some() {
                        self.forget_auth().await?;
                    }
                    return Err(error);
                }
            }
        }
        Ok(())
    }

    pub async fn forget_auth(&mut self) -> Result<()> {
        if let Some(base) = &self.base {
            let account = base.to_string();
            let store = Arc::clone(&self.store);
            tokio::task::spawn_blocking(move || store.delete(&account)).await??;
        }
        self.clear();
        Ok(())
    }
    pub async fn restore_identity(&mut self) -> Result<Value> {
        if self.token.is_none() {
            let Some(base) = &self.base else {
                return Ok(Value::Null);
            };
            let account = base.to_string();
            let store = Arc::clone(&self.store);
            let Some(value) = tokio::task::spawn_blocking(move || store.read(&account)).await??
            else {
                return Ok(Value::Null);
            };
            let stored: StoredAuth =
                serde_json::from_str(&value).context("保存的登录凭据无法读取")?;
            self.token = Some(String::new());
            self.refresh_token = Some(stored.refresh_token);
            self.expires = Some(Instant::now());
        }
        match self.execute(Request::Me).await {
            Ok(user) => Ok(user),
            Err(error) if error.downcast_ref::<AuthExpired>().is_some() => {
                self.forget_auth().await?;
                Ok(Value::Null)
            }
            Err(error) => Err(error.context("暂时无法恢复登录，凭据已保留，可稍后重试")),
        }
    }
    pub async fn logout(&mut self) -> Result<()> {
        let result = if self.token.is_some() {
            self.request(
                Method::POST,
                "api/v1/auth/logout",
                None,
                self.token.as_deref(),
            )
            .await
            .map(|_| ())
        } else {
            Ok(())
        };
        self.forget_auth().await?;
        result
    }

    pub async fn websocket_request(
        &mut self,
        host: Uuid,
        account: Option<Uuid>,
        access_path: Option<Uuid>,
    ) -> Result<tokio_tungstenite::tungstenite::http::Request<()>> {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        self.refresh().await?;
        let mut url = self
            .base
            .as_ref()
            .context("尚未配置平台")?
            .join(&format!("api/v1/assets/hosts/{host}/ssh/ws"))?;
        let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
        url.set_scheme(scheme)
            .map_err(|_| anyhow!("WebSocket 地址无效"))?;
        if let Some(id) = account {
            url.query_pairs_mut()
                .append_pair("accountId", &id.to_string());
        }
        if let Some(id) = access_path {
            url.query_pairs_mut()
                .append_pair("accessPathId", &id.to_string());
        }
        let mut request = url.as_str().into_client_request()?;
        let token = self.token.as_deref().context("请重新登录")?;
        request
            .headers_mut()
            .insert("Authorization", format!("Bearer {token}").parse()?);
        Ok(request)
    }

    pub async fn rdp_websocket_request(
        &mut self,
        host: Uuid,
        account: Option<Uuid>,
        access_path: Option<Uuid>,
    ) -> Result<tokio_tungstenite::tungstenite::http::Request<()>> {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        self.refresh().await?;
        let mut url = self
            .base
            .as_ref()
            .context("尚未配置平台")?
            .join(&format!("api/v1/assets/hosts/{host}/rdp/ws"))?;
        let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
        url.set_scheme(scheme)
            .map_err(|_| anyhow!("WebSocket 地址无效"))?;
        if let Some(id) = account {
            url.query_pairs_mut()
                .append_pair("accountId", &id.to_string());
        }
        if let Some(id) = access_path {
            url.query_pairs_mut()
                .append_pair("accessPathId", &id.to_string());
        }
        let mut request = url.as_str().into_client_request()?;
        let token = self.token.as_deref().context("请重新登录")?;
        request
            .headers_mut()
            .insert("Authorization", format!("Bearer {token}").parse()?);
        request
            .headers_mut()
            .insert("Sec-WebSocket-Protocol", "guacamole".parse()?);
        Ok(request)
    }

    pub(crate) async fn agent_client(&mut self) -> Result<crate::ai::AgentClient> {
        self.refresh().await?;
        // An independent native request owns credentials while streaming/cancelling;
        // the platform mutex stays available to SSH, login and file operations.
        Ok(crate::ai::AgentClient::new(
            self.client.clone(),
            self.base.as_ref().context("未配置平台")?.clone(),
            self.token.as_deref().context("请先登录平台")?.to_owned(),
        ))
    }

    pub async fn file_request(
        &mut self,
        host: Uuid,
        account: Option<Uuid>,
        access: Option<Uuid>,
        operation: &str,
        path: &str,
        bytes: Option<Vec<u8>>,
    ) -> Result<reqwest::Response> {
        crate::files::validate_path(path)?;
        self.refresh().await?;
        let (method, endpoint, path_key) = match operation {
            "list" => (Method::GET, "list", "path"),
            "upload" => (Method::POST, "upload-content", "remotePath"),
            "download" => (Method::GET, "download-content", "remotePath"),
            "delete" => (Method::DELETE, "delete-content", "remotePath"),
            _ => bail!("未知文件操作"),
        };
        let mut url = self
            .base
            .as_ref()
            .context("未配置平台")?
            .join(&format!("api/v1/assets/hosts/{host}/files/{endpoint}"))?;
        url.query_pairs_mut().append_pair(path_key, path);
        if let Some(account) = account {
            url.query_pairs_mut()
                .append_pair("accountId", &account.to_string());
        }
        if let Some(access) = access {
            url.query_pairs_mut()
                .append_pair("accessPathId", &access.to_string());
        }
        let mut request = self
            .client
            .request(method, url)
            .bearer_auth(self.token.as_deref().context("未登录")?)
            .timeout(Duration::from_secs(300));
        if let Some(bytes) = bytes {
            request = request
                .header("Content-Type", "application/octet-stream")
                .body(bytes);
        }
        let response = request
            .send()
            .await
            .map_err(|_| anyhow!("文件操作请求失败，请检查网络"))?;
        if !response.status().is_success() {
            let body: Value = response.json().await.unwrap_or(Value::Null);
            bail!(
                "{}",
                body["msg"]
                    .as_str()
                    .unwrap_or("平台拒绝文件操作，请检查文件权限")
            );
        }
        Ok(response)
    }

    pub async fn execute(&mut self, request: Request) -> Result<Value> {
        match request {
            Request::Login { username, password } => {
                let body =
                    json!({"username": username, "password": password, "sessionKind": "pixiu-shell"});
                let login = self
                    .request(Method::POST, "api/v1/auth/login", Some(&body), None)
                    .await?;
                self.accept_login(login).await
            }
            Request::Qrcode => {
                self.request(Method::GET, "api/v1/auth/dingtalk-qrcode", None, None)
                    .await
            }
            Request::QrcodeStatus { id } => {
                self.request(
                    Method::GET,
                    &format!("api/v1/auth/dingtalk-qrcode-status/{id}"),
                    None,
                    None,
                )
                .await
            }
            Request::Dingtalk {
                auth_code,
                login_ticket,
                company_id,
            } => {
                let body = json!({"auth_code": auth_code, "loginTicket": login_ticket, "companyId": company_id, "sessionKind": "pixiu-shell"});
                let mut result = self
                    .request(
                        Method::POST,
                        "api/v1/auth/dingtalk-login",
                        Some(&body),
                        None,
                    )
                    .await?;
                if let Some(login) = result
                    .as_object_mut()
                    .and_then(|value| value.remove("login"))
                {
                    result["user"] = self.accept_login(login).await?;
                }
                Ok(result)
            }
            Request::Hosts => {
                self.refresh().await?;
                let mut hosts = Vec::new();
                for page in 1..=1000 {
                    let path = format!(
                        "api/v1/assets/hosts?page={page}&pageSize=100&bastionEnabled=true&accessOperation=connect"
                    );
                    let mut result = self
                        .request(Method::GET, &path, None, self.token.as_deref())
                        .await?;
                    let mut data: Vec<Value> = serde_json::from_value(result["data"].take())
                        .context("主机列表格式错误")?;
                    let empty = data.is_empty();
                    hosts.append(&mut data);
                    let total = result["total"].as_u64().context("主机分页响应缺少 total")?;
                    if empty || hosts.len() as u64 >= total {
                        return Ok(Value::Array(hosts));
                    }
                }
                bail!("主机数量超过客户端单次加载上限")
            }
            Request::HostOptions { id } => {
                self.refresh().await?;
                let account_path = format!("api/v1/assets/hosts/{id}/accounts");
                let access_path = format!("api/v1/assets/hosts/{id}/access-paths");
                let (accounts, paths) = tokio::try_join!(
                    self.request(Method::GET, &account_path, None, self.token.as_deref()),
                    self.request(Method::GET, &access_path, None, self.token.as_deref())
                )?;
                Ok(json!({"accounts":accounts,"paths":paths}))
            }
            Request::Resource { path, method, body } => {
                validate_resource_path(&path)?;
                let method = match method.as_str() {
                    "GET" => Method::GET,
                    "POST" => Method::POST,
                    "PUT" => Method::PUT,
                    "DELETE" => Method::DELETE,
                    _ => bail!("不支持的资源操作"),
                };
                self.refresh().await?;
                self.request(
                    method,
                    &format!("api/v1/{path}"),
                    body.as_ref(),
                    self.token.as_deref(),
                )
                .await
            }
            Request::Me => {
                self.refresh().await?;
                self.request(Method::GET, "api/v1/me", None, self.token.as_deref())
                    .await
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn platform_contract_uses_pixiu_shell_session_and_connect_filter() -> Result<()> {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        let address = listener.local_addr()?;
        let server = std::thread::spawn(move || -> Result<Vec<String>> {
            let responses = [
                json!({"token":"native-only-token","refresh_token":"native-only-refresh","expires_in":3600,"user":{"username":"tester"}}),
                json!({"data":[{"id":"one"}],"total":2}),
                json!({"data":[{"id":"two"}],"total":2}),
                Value::Null,
            ];
            let mut requests = Vec::new();
            for data in responses {
                let (mut stream, _) = listener.accept()?;
                stream.set_read_timeout(Some(Duration::from_secs(5)))?;
                let mut bytes = Vec::new();
                let mut buffer = [0_u8; 4096];
                loop {
                    let count = stream.read(&mut buffer)?;
                    ensure!(count > 0, "unexpected EOF");
                    bytes.extend_from_slice(&buffer[..count]);
                    if let Some(end) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]);
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|length| length.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if bytes.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                requests.push(String::from_utf8(bytes)?);
                let body = json!({"code":200,"msg":"ok","data":data}).to_string();
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )?;
            }
            Ok(requests)
        });
        let mut client = Platform::new()?;
        client.store = Arc::new(crate::auth_store::MemoryStore::default());
        client.configure(normalize_base(&format!("http://{address}"))?);
        let user = client
            .execute(Request::Login {
                username: "tester".into(),
                password: "test-password".into(),
            })
            .await?;
        assert_eq!(user, json!({"username":"tester"}));
        let hosts = client.execute(Request::Hosts).await?;
        assert_eq!(hosts.as_array().map(Vec::len), Some(2));
        let ws = client.websocket_request(Uuid::new_v4(), None, None).await?;
        assert_eq!(ws.headers()["Authorization"], "Bearer native-only-token");
        assert!(!ws.uri().to_string().contains("native-only-token"));
        client.logout().await?;
        assert!(client.execute(Request::Hosts).await.is_err());
        let requests = server
            .join()
            .map_err(|_| anyhow!("test server panicked"))??;
        assert!(requests[0].contains("\"sessionKind\":\"pixiu-shell\""));
        assert!(
            requests[1].contains("accessOperation=connect")
                && requests[1].contains("bastionEnabled=true")
        );
        assert!(requests[2].contains("page=2"));
        assert!(requests[3].contains("/api/v1/auth/logout"));
        Ok(())
    }

    #[test]
    fn resource_routes_cannot_escape_platform_api() {
        for path in [
            "assets/hosts",
            "assets/nodes/tree",
            "assets/host-scripts?page=2",
            "assets/hosts?search=%E6%B5%8B%E8%AF%95&pageSize=10",
            "tags/resource/host/id",
        ] {
            assert!(validate_resource_path(path).is_ok());
        }
        for path in [
            "https://evil.test",
            "//evil.test",
            "assets/hosts/../../auth/login",
            "assets/hosts/%2e%2e",
            "auth/login",
            "assets/hostsevil",
        ] {
            assert!(validate_resource_path(path).is_err());
        }
    }
    #[test]
    fn validates_platform_origin() -> Result<()> {
        for base in [
            "http://ops.example.com",
            "https://user:secret@ops.example.com",
            "file:///tmp",
            "https://ops.example.com?token=secret",
        ] {
            assert!(normalize_base(base).is_err());
        }
        assert_eq!(
            normalize_base("https://ops.example.com/gateway")?.as_str(),
            "https://ops.example.com/gateway/"
        );
        assert!(normalize_base("http://127.0.0.1:8080").is_ok());
        Ok(())
    }

    #[tokio::test]
    async fn login_secrets_stay_native() -> Result<()> {
        let mut platform = Platform::new()?;
        let user = platform.accept_login(json!({"token":"secret","refresh_token":"refresh-secret","expires_in":3600,"user":{"username":"ops"}})).await?;
        assert_eq!(user, json!({"username":"ops"}));
        assert!(platform.token.is_some());
        platform.clear();
        assert!(platform.token.is_none() && platform.refresh_token.is_none());
        Ok(())
    }
}

#[cfg(test)]
mod persistence_tests {
    use super::*;
    use crate::auth_store::{AuthStore, MemoryStore};
    use std::io::{Read, Write};
    fn server(
        responses: Vec<(u16, Value)>,
    ) -> Result<(Url, std::thread::JoinHandle<Result<Vec<String>>>)> {
        let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        listener.set_nonblocking(true)?;
        let base = normalize_base(&format!("http://{}", listener.local_addr()?))?;
        let worker = std::thread::spawn(move || -> Result<Vec<String>> {
            let mut requests = vec![];
            for (status, data) in responses {
                let until = Instant::now() + Duration::from_secs(5);
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            ensure!(Instant::now() < until, "missing expected request");
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(error) => return Err(error.into()),
                    }
                };
                stream.set_read_timeout(Some(Duration::from_secs(5)))?;
                let mut bytes = vec![];
                let mut buffer = [0; 4096];
                loop {
                    let count = stream.read(&mut buffer)?;
                    ensure!(count > 0, "unexpected EOF");
                    bytes.extend_from_slice(&buffer[..count]);
                    if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]);
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|value| value.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if bytes.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                requests.push(String::from_utf8(bytes)?);
                let body = json!({"code":status,"data":data,"msg":"fixture"}).to_string();
                write!(
                    stream,
                    "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )?;
            }
            Ok(requests)
        });
        Ok((base, worker))
    }
    fn login(token: &str, refresh: &str) -> Value {
        json!({"token":token,"refresh_token":refresh,"expires_in":3600,"user":{"username":"ops"}})
    }
    #[tokio::test]
    async fn reopening_restores_from_origin_scoped_refresh_credential_and_logout_removes_it()
    -> Result<()> {
        let (base, worker) = server(vec![
            (200, login("renewed-access", "renewed-refresh")),
            (200, json!({"username":"ops"})),
        ])?;
        let store = Arc::new(MemoryStore::default());
        let mut first = Platform::new()?;
        first.store = store.clone();
        first.configure(base.clone());
        first
            .accept_login(login("original-access", "original-refresh"))
            .await?;
        let saved = store.read(base.as_str())?.context("saved auth")?;
        assert!(!saved.contains("original-access"));
        drop(first);
        let mut other = Platform::new()?;
        other.store = store.clone();
        other.configure(base.join("other-platform/")?);
        assert!(other.restore_identity().await?.is_null());
        let mut reopened = Platform::new()?;
        reopened.store = store.clone();
        reopened.configure(base.clone());
        assert_eq!(reopened.restore_identity().await?["username"], "ops");
        let requests = worker.join().map_err(|_| anyhow!("fixture failed"))??;
        assert!(requests[0].starts_with("POST /api/v1/auth/refresh"));
        assert!(requests[0].contains("\"sessionKind\":\"pixiu-shell\""));
        assert!(
            requests[1]
                .to_ascii_lowercase()
                .contains("authorization: bearer renewed-access")
        );
        assert!(
            store
                .read(base.as_str())?
                .context("renewed credential")?
                .contains("renewed-refresh")
        );
        reopened.forget_auth().await?;
        assert!(store.read(base.as_str())?.is_none());
        assert!(reopened.restore_identity().await?.is_null());
        Ok(())
    }
    #[tokio::test]
    async fn transient_restore_failure_keeps_credentials_but_rejected_refresh_removes_them()
    -> Result<()> {
        let (base, worker) = server(vec![(503, Value::Null), (401, Value::Null)])?;
        let store = Arc::new(MemoryStore::default());
        let mut first = Platform::new()?;
        first.store = store.clone();
        first.configure(base.clone());
        first.accept_login(login("access", "refresh")).await?;
        drop(first);
        let mut client = Platform::new()?;
        client.store = store.clone();
        client.configure(base.clone());
        assert!(client.restore_identity().await.is_err());
        assert!(store.read(base.as_str())?.is_some());
        assert!(client.restore_identity().await?.is_null());
        assert!(store.read(base.as_str())?.is_none());
        worker.join().map_err(|_| anyhow!("fixture failed"))??;
        Ok(())
    }
}
