use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::path::Path;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LocalHost {
    pub id: Option<Uuid>,
    pub name: String,
    pub address: String,
    pub port: u16,
    pub username: String,
    pub group: String,
    #[serde(default)]
    pub identity_id: Option<Uuid>,
    pub identity_file: String,
    pub note: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub tunnels: Vec<Tunnel>,
    #[serde(default)]
    pub has_password: bool,
    #[serde(default)]
    pub proxy: Option<crate::proxy::Proxy>,
}

/// A reusable SSH private-key reference. The private key remains at its
/// original filesystem path; Pixiu only stores metadata and the path.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SshIdentity {
    pub id: Uuid,
    pub name: String,
    pub path: String,
    pub key_type: String,
    #[serde(default)]
    pub algorithm: String,
    pub fingerprint: String,
    #[serde(default)]
    pub has_passphrase: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Tunnel {
    pub kind: String,
    pub listen_port: u16,
    pub target_host: String,
    pub target_port: u16,
}

impl LocalHost {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            !self.name.trim().is_empty() && self.name.len() <= 120,
            "主机名称不能为空，且不能超过 120 字节"
        );
        ensure!(
            !self.address.is_empty()
                && self.address.len() <= 253
                && !self.address.starts_with('-')
                && self
                    .address
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || ".-:_".contains(c)),
            "请输入有效的 IP 地址或主机名"
        );
        ensure!(self.port > 0, "端口范围为 1–65535");
        ensure!(
            !self.username.is_empty()
                && self.username.len() <= 64
                && !self.username.starts_with('-')
                && self
                    .username
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "._-@\\".contains(c)),
            "SSH 用户名无效"
        );
        ensure!(
            self.group.len() <= 120
                && self.note.len() <= 2000
                && self.identity_file.len() <= 4096
                && !self.identity_file.contains(['\0', '\n', '\r']),
            "主机配置过长或含非法字符"
        );
        ensure!(
            self.tags.len() <= 32
                && self
                    .tags
                    .iter()
                    .all(|tag| !tag.trim().is_empty() && tag.len() <= 80),
            "标签最多 32 个，每个不超过 80 字节"
        );
        ensure!(self.tunnels.len() <= 16, "每台主机最多配置 16 条隧道");
        for tunnel in &self.tunnels {
            tunnel.validate()?;
        }
        if let Some(proxy) = &self.proxy {
            proxy.validate()?;
        }
        Ok(())
    }
}
impl Tunnel {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            ["local", "remote", "dynamic"].contains(&self.kind.as_str()) && self.listen_port > 0,
            "隧道类型或监听端口无效"
        );
        if self.kind != "dynamic" {
            ensure!(
                self.target_port > 0
                    && !self.target_host.is_empty()
                    && self
                        .target_host
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || ".-_".contains(c))
                    && !self.target_host.starts_with('-'),
                "隧道目标地址或端口无效（IPv6 可使用对应域名）"
            );
        }
        Ok(())
    }
    pub fn arguments(&self) -> Result<(&'static str, String)> {
        self.validate()?;
        Ok(match self.kind.as_str() {
            "local" => (
                "-L",
                format!(
                    "127.0.0.1:{}:{}:{}",
                    self.listen_port, self.target_host, self.target_port
                ),
            ),
            "remote" => (
                "-R",
                format!(
                    "127.0.0.1:{}:{}:{}",
                    self.listen_port, self.target_host, self.target_port
                ),
            ),
            _ => ("-D", format!("127.0.0.1:{}", self.listen_port)),
        })
    }
}

// Initialization can be requested concurrently by several IPC commands. Serialize
// only migrations; established connections must remain genuine read connections.
static MIGRATION_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
const SCHEMA_VERSION: u32 = 6;

pub(crate) fn open(path: &Path) -> Result<Connection> {
    let mut connection = Connection::open(path).context("无法打开 Pixiu Shell SQLite 数据库")?;
    connection.busy_timeout(std::time::Duration::from_secs(5))?;
    let version: u32 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    ensure!(version <= SCHEMA_VERSION, "数据库版本较新，请升级 Pixiu Shell");
    if version == SCHEMA_VERSION {
        return Ok(connection);
    }
    let _migration = MIGRATION_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("数据库初始化锁不可用"))?;
    // Another startup command may have completed migration while we waited.
    let version: u32 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version == SCHEMA_VERSION {
        return Ok(connection);
    }
    connection.pragma_update(None, "journal_mode", "WAL")?;
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS local_hosts (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL,
            port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535), username TEXT NOT NULL,
            group_name TEXT NOT NULL, identity_file TEXT NOT NULL, note TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ai_conversations (
            id TEXT PRIMARY KEY, target TEXT, host_name TEXT NOT NULL,
            title TEXT NOT NULL, messages TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ai_conversations_updated_at ON ai_conversations(updated_at);
        CREATE TABLE IF NOT EXISTS host_groups(name TEXT PRIMARY KEY CHECK(length(name)>0));
        CREATE TABLE IF NOT EXISTS ssh_identities (
            id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, path TEXT NOT NULL UNIQUE,
            key_type TEXT NOT NULL, fingerprint TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS command_history (
            id TEXT PRIMARY KEY,
            scope TEXT NOT NULL,
            host_name TEXT NOT NULL,
            host_address TEXT NOT NULL,
            command TEXT NOT NULL,
            use_count INTEGER NOT NULL DEFAULT 1,
            last_used_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS command_history_scope_command ON command_history(scope, command);
        CREATE INDEX IF NOT EXISTS command_history_last_used ON command_history(last_used_at DESC);",
    )?;
    let columns: Vec<String> = {
        let mut statement = tx.prepare("PRAGMA table_info(local_hosts)")?;
        statement
            .query_map([], |row| row.get(1))?
            .collect::<rusqlite::Result<_>>()?
    };
    for (name, definition) in [
        ("proxy", "TEXT NOT NULL DEFAULT 'null'"),
        ("tags", "TEXT NOT NULL DEFAULT '[]'"),
        ("tunnels", "TEXT NOT NULL DEFAULT '[]'"),
        ("has_password", "INTEGER NOT NULL DEFAULT 0"),
        ("identity_id", "TEXT"),
    ] {
        if !columns.iter().any(|column| column == name) {
            tx.execute_batch(&format!(
                "ALTER TABLE local_hosts ADD COLUMN {name} {definition}"
            ))?;
        }
    }
    tx.execute_batch("INSERT OR IGNORE INTO host_groups(name) SELECT DISTINCT group_name FROM local_hosts WHERE group_name<>'';")?;
    tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    tx.commit()?;
    Ok(connection)
}

pub(crate) fn list(connection: &Connection) -> Result<Vec<LocalHost>> {
    let mut statement = connection.prepare("SELECT h.id,h.name,h.address,h.port,h.username,h.group_name,h.identity_id,COALESCE(i.path,h.identity_file),h.note,h.tags,h.tunnels,h.has_password,h.proxy FROM local_hosts h LEFT JOIN ssh_identities i ON i.id=h.identity_id ORDER BY h.group_name,h.name")?;
    let hosts = statement.query_map([], |row| {
        let id: String = row.get(0)?;
        Ok((
            id,
            LocalHost {
                id: None,
                name: row.get(1)?,
                address: row.get(2)?,
                port: row.get(3)?,
                username: row.get(4)?,
                group: row.get(5)?,
                identity_id: row.get::<_, Option<String>>(6)?.map(|id| Uuid::parse_str(&id)).transpose().map_err(|error| rusqlite::Error::FromSqlConversionFailure(6, rusqlite::types::Type::Text, Box::new(error)))?,
                identity_file: row.get(7)?,
                note: row.get(8)?,
                tags: serde_json::from_str(&row.get::<_, String>(9)?).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        9,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?,
                tunnels: serde_json::from_str(&row.get::<_, String>(10)?).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        10,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?,
                has_password: row.get(11)?,
                proxy: serde_json::from_str(&row.get::<_, String>(12)?).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        12,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?,
            },
        ))
    })?;
    hosts
        .map(|row| {
            let (id, mut host) = row?;
            host.id = Some(Uuid::parse_str(&id)?);
            Ok(host)
        })
        .collect()
}

pub(crate) fn save(connection: &Connection, mut host: LocalHost) -> Result<LocalHost> {
    if let Some(identity_id) = host.identity_id {
        host.identity_file = identity_path(connection, identity_id)?;
    }
    host.validate()?;
    let id = host.id.unwrap_or_else(Uuid::new_v4);
    let tx = connection.unchecked_transaction()?;
    if !host.group.is_empty() {
        tx.execute(
            "INSERT OR IGNORE INTO host_groups(name) VALUES(?1)",
            [&host.group],
        )?;
    }
    tx.execute("INSERT INTO local_hosts(id,name,address,port,username,group_name,identity_id,identity_file,note,tags,tunnels,has_password,proxy) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,address=excluded.address,port=excluded.port,username=excluded.username,group_name=excluded.group_name,identity_id=excluded.identity_id,identity_file=excluded.identity_file,note=excluded.note,tags=excluded.tags,tunnels=excluded.tunnels,has_password=excluded.has_password,proxy=excluded.proxy",
        params![id.to_string(),host.name,host.address,host.port,host.username,host.group,host.identity_id.map(|value| value.to_string()),host.identity_file,host.note,serde_json::to_string(&host.tags)?,serde_json::to_string(&host.tunnels)?,host.has_password,serde_json::to_string(&host.proxy)?])?;
    tx.commit()?;
    host.id = Some(id);
    Ok(host)
}

pub(crate) fn identities(connection: &Connection) -> Result<Vec<SshIdentity>> {
    connection
        .prepare("SELECT id,name,path,key_type,fingerprint FROM ssh_identities ORDER BY name")?
        .query_map([], |row| {
            Ok(SshIdentity {
                id: Uuid::parse_str(&row.get::<_, String>(0)?).map_err(|error| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error)))?,
                name: row.get(1)?,
                path: row.get(2)?,
                key_type: row.get(3)?,
                algorithm: String::new(),
                fingerprint: row.get(4)?,
                has_passphrase: false,
            })
        })?
        .collect::<rusqlite::Result<_>>()
        .map_err(Into::into)
}

fn identity_path(connection: &Connection, id: Uuid) -> Result<String> {
    connection
        .query_row("SELECT path FROM ssh_identities WHERE id=?1", [id.to_string()], |row| row.get(0))
        .context("选择的 SSH 身份不存在，请重新选择")
}

pub(crate) fn identity_exists(connection: &Connection, id: Uuid) -> Result<()> {
    connection
        .query_row(
            "SELECT 1 FROM ssh_identities WHERE id=?1",
            [id.to_string()],
            |_| Ok(()),
        )
        .context("SSH 密钥不存在，请刷新后重试")
}

pub(crate) fn save_identity(connection: &Connection, mut identity: SshIdentity) -> Result<SshIdentity> {
    crate::identity::inspect(&mut identity)?;
    let tx = connection.unchecked_transaction()?;
    tx.execute("INSERT INTO ssh_identities(id,name,path,key_type,fingerprint) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET name=excluded.name,path=excluded.path,key_type=excluded.key_type,fingerprint=excluded.fingerprint", params![identity.id.to_string(), identity.name, identity.path, identity.key_type, identity.fingerprint])?;
    tx.commit()?;
    Ok(identity)
}

/// Removing an entry leaves every host's last resolved path intact. This only
/// removes Pixiu's reusable reference; it never touches the user's key file.
pub(crate) fn delete_identity(connection: &Connection, id: Uuid) -> Result<()> {
    let tx = connection.unchecked_transaction()?;
    tx.execute(
        "UPDATE local_hosts SET identity_file=(SELECT path FROM ssh_identities WHERE id=?1),identity_id=NULL WHERE identity_id=?2",
        params![id.to_string(), id.to_string()],
    )?;
    tx.execute("DELETE FROM ssh_identities WHERE id=?1", [id.to_string()])?;
    tx.commit()?;
    crate::credentials::delete_identity_passphrase(id)?;
    Ok(())
}

pub(crate) fn groups(connection: &Connection) -> Result<Vec<String>> {
    Ok(connection
        .prepare("SELECT name FROM host_groups ORDER BY name")?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?)
}

/// Matches a group path and every nested child (`a`, `a/b`, `a/b/c`).
fn group_tree_sql(column: &str) -> String {
    format!(
        "substr({column}, 1, length(?1)) = ?1 AND (length({column}) = length(?1) OR substr({column}, length(?1) + 1, 1) = '/')"
    )
}

fn group_tree_exists(connection: &Connection, name: &str) -> Result<bool> {
    Ok(connection.query_row(
        &format!(
            "SELECT EXISTS(SELECT 1 FROM host_groups WHERE {})",
            group_tree_sql("name")
        ),
        [name],
        |row| row.get(0),
    )?)
}

fn retarget_group_tree(connection: &Connection, source: &str, destination: &str) -> Result<()> {
    connection.execute(
        &format!(
            "UPDATE local_hosts SET group_name = ?2 || substr(group_name, length(?1) + 1) WHERE {}",
            group_tree_sql("group_name")
        ),
        params![source, destination],
    )?;
    connection.execute(
        &format!(
            "UPDATE host_groups SET name = ?2 || substr(name, length(?1) + 1) WHERE {}",
            group_tree_sql("name")
        ),
        params![source, destination],
    )?;
    Ok(())
}

pub(crate) fn save_group(
    connection: &Connection,
    previous: Option<&str>,
    name: &str,
) -> Result<()> {
    let name = name.trim();
    ensure!(
        !name.is_empty() && name.len() <= 120,
        "分组名称不能为空且不能超过 120 字节"
    );
    let tx = connection.unchecked_transaction()?;
    if let Some(previous) = previous.map(str::trim).filter(|value| !value.is_empty()) {
        if previous != name {
            ensure!(group_tree_exists(&tx, previous)?, "要重命名的文件夹不存在");
            ensure!(
                !name.starts_with(&format!("{previous}/")),
                "不能把文件夹重命名到自身的子路径"
            );
            ensure!(!group_tree_exists(&tx, name)?, "已存在同名文件夹");
            retarget_group_tree(&tx, previous, name)?;
        }
    } else {
        tx.execute("INSERT INTO host_groups(name) VALUES(?1)", [name])?;
    }
    tx.commit()?;
    Ok(())
}

pub(crate) fn move_group(connection: &Connection, source: &str, target: &str) -> Result<()> {
    let source = source.trim();
    let target = target.trim();
    ensure!(
        !source.is_empty() && !target.is_empty(),
        "请选择有效的目标文件夹"
    );
    ensure!(
        source != target && !target.starts_with(&format!("{source}/")),
        "不能移动到当前文件夹或其子文件夹"
    );
    let name = source.rsplit('/').next().unwrap_or(source);
    let destination = format!("{target}/{name}");
    ensure!(destination != source, "文件夹已位于该目录下");
    ensure!(
        destination.len() <= 120,
        "移动后的分组路径不能超过 120 字节"
    );

    let tx = connection.unchecked_transaction()?;
    ensure!(group_tree_exists(&tx, source)?, "要移动的文件夹不存在");
    ensure!(
        !group_tree_exists(&tx, &destination)?,
        "目标文件夹中已存在同名目录"
    );
    retarget_group_tree(&tx, source, &destination)?;
    tx.commit()?;
    Ok(())
}
pub(crate) fn delete_group(connection: &Connection, name: &str) -> Result<()> {
    let name = name.trim();
    ensure!(!name.is_empty(), "请选择要删除的文件夹");
    let tx = connection.unchecked_transaction()?;
    ensure!(group_tree_exists(&tx, name)?, "要删除的文件夹不存在");
    tx.execute(
        &format!(
            "UPDATE local_hosts SET group_name='' WHERE {}",
            group_tree_sql("group_name")
        ),
        [name],
    )?;
    tx.execute(
        &format!("DELETE FROM host_groups WHERE {}", group_tree_sql("name")),
        [name],
    )?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host() -> LocalHost {
        LocalHost {
            id: None,
            name: "开发机".into(),
            address: "127.0.0.1".into(),
            port: 22,
            username: "ops".into(),
            group: "本地".into(),
            identity_id: None,
            identity_file: String::new(),
            note: String::new(),
            tags: vec![],
            tunnels: vec![],
            has_password: false,
            proxy: None,
        }
    }

    #[test]
    fn read_connections_do_not_require_a_writer_lock() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("readers.db");
        let writer = open(&path)?;
        writer.execute_batch(
            "BEGIN IMMEDIATE; INSERT INTO settings(key,value) VALUES('pending','uncommitted');",
        )?;
        let (sender, receiver) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            let result = open(&path).and_then(|connection| {
                list(&connection)?;
                groups(&connection)?;
                Ok(())
            });
            let _ = sender.send(result);
        });
        let result = receiver.recv_timeout(std::time::Duration::from_millis(500));
        writer.execute_batch("ROLLBACK;")?;
        reader
            .join()
            .map_err(|_| anyhow::anyhow!("reader panicked"))?;
        result.context("opening a read connection incorrectly waits for a writer")??;
        Ok(())
    }

    #[test]
    fn concurrent_startup_and_reads_keep_all_host_writes() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("startup.db");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(12));
        let workers: Vec<_> = (0..12)
            .map(|index| {
                let path = path.to_path_buf();
                let barrier = std::sync::Arc::clone(&barrier);
                std::thread::spawn(move || -> Result<()> {
                    barrier.wait();
                    let db = open(&path)?;
                    let mut value = host();
                    value.name = format!("host-{index}");
                    save(&db, value)?;
                    for _ in 0..10 {
                        let reader = open(&path)?;
                        list(&reader)?;
                        groups(&reader)?;
                        crate::preferences::load(&reader)?;
                    }
                    Ok(())
                })
            })
            .collect();
        for worker in workers {
            worker
                .join()
                .map_err(|_| anyhow::anyhow!("worker panicked"))??;
        }
        assert_eq!(list(&open(&path)?)?.len(), 12);
        Ok(())
    }

    #[test]
    fn persists_and_updates_without_duplication() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("hosts.db");
        let mut saved = save(&open(&path)?, host())?;
        saved.name = "修改后的名称".into();
        save(&open(&path)?, saved)?;
        let result = list(&open(&path)?)?;
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "修改后的名称");
        Ok(())
    }

    #[test]
    fn identity_references_resolve_and_delete_keeps_the_key_path() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let db = open(&directory.path().join("identities.db"))?;
        let path = directory.path().join("id_ed25519");
        std::fs::write(
            &path,
            "-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----\n",
        )?;
        let identity = save_identity(
            &db,
            SshIdentity {
                id: Uuid::new_v4(),
                name: "production".into(),
                path: path.to_string_lossy().into_owned(),
                key_type: String::new(),
                algorithm: String::new(),
                fingerprint: String::new(),
                has_passphrase: false,
            },
        )?;
        let mut record = host();
        record.identity_id = Some(identity.id);
        let saved = save(&db, record)?;
        assert_eq!(saved.identity_file, identity.path);
        assert_eq!(list(&db)?[0].identity_id, Some(identity.id));
        delete_identity(&db, identity.id)?;
        let restored = list(&db)?.remove(0);
        assert_eq!(restored.identity_id, None);
        assert_eq!(restored.identity_file, identity.path);
        Ok(())
    }

    #[test]
    fn rejects_ssh_option_and_control_character_injection() {
        for address in [
            "-oProxyCommand=touch /tmp/x",
            "host\nother",
            "host;cmd",
            "user@host",
            "",
        ] {
            let mut value = host();
            value.address = address.into();
            assert!(value.validate().is_err());
        }
        let mut value = host();
        value.address = "2001:db8::1".into();
        assert!(value.validate().is_ok());
        value.port = 0;
        assert!(value.validate().is_err());
    }
    #[test]
    fn v1_migration_preserves_hosts_and_group_operations() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("legacy.db");
        let id = Uuid::new_v4().to_string();
        let legacy = Connection::open(&path)?;
        legacy.execute_batch("CREATE TABLE local_hosts(id TEXT PRIMARY KEY,name TEXT,address TEXT,port INTEGER,username TEXT,group_name TEXT,identity_file TEXT,note TEXT); PRAGMA user_version=1;")?;
        legacy.execute(
            "INSERT INTO local_hosts VALUES(?1,'legacy','127.0.0.1',22,'ops','old','','note')",
            [&id],
        )?;
        drop(legacy);
        let db = open(&path)?;
        let mut records = list(&db)?;
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].name, "legacy");
        assert_eq!(groups(&db)?, ["old"]);
        save_group(&db, Some("old"), "production")?;
        assert_eq!(list(&db)?[0].group, "production");
        let mut host = records.remove(0);
        host.group = "production".into();
        host.tags = vec!["Linux".into(), "API".into()];
        host.tunnels = vec![Tunnel {
            kind: "local".into(),
            listen_port: 8080,
            target_host: "127.0.0.1".into(),
            target_port: 80,
        }];
        host.proxy = Some(crate::proxy::Proxy {
            kind: "socks5".into(),
            address: "127.0.0.1".into(),
            port: 1080,
            username: "proxy-user".into(),
            has_password: true,
        });
        save(&db, host)?;
        drop(db);
        let db = open(&path)?;
        assert_eq!(list(&db)?[0].tags, ["Linux", "API"]);
        assert_eq!(list(&db)?[0].tunnels[0].listen_port, 8080);
        let restored = list(&db)?;
        let proxy = restored[0].proxy.as_ref().context("proxy not persisted")?;
        assert_eq!(proxy.address, "127.0.0.1");
        assert_eq!(proxy.port, 1080);
        assert!(proxy.has_password);
        delete_group(&db, "production")?;
        assert_eq!(list(&db)?[0].group, "");
        assert_eq!(list(&db)?.len(), 1);
        save_group(&db, None, "empty")?;
        assert!(groups(&open(&path)?)?.contains(&"empty".into()));
        Ok(())
    }

    #[test]
    fn renaming_a_folder_moves_nested_groups_and_hosts() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let db = open(&directory.path().join("nested-groups.db"))?;
        save_group(&db, None, "prod")?;
        save_group(&db, None, "prod/db")?;
        let mut record = host();
        record.group = "prod/db".into();
        save(&db, record)?;
        save_group(&db, Some("prod"), "online")?;
        assert_eq!(groups(&db)?, ["online", "online/db"]);
        assert_eq!(list(&db)?[0].group, "online/db");
        delete_group(&db, "online")?;
        assert!(groups(&db)?.is_empty());
        assert_eq!(list(&db)?[0].group, "");
        Ok(())
    }

    #[test]
    fn folder_tree_operations_do_not_match_a_shared_prefix() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let db = open(&directory.path().join("group-prefixes.db"))?;
        save_group(&db, None, "prod")?;
        save_group(&db, None, "prod/api")?;
        save_group(&db, None, "production")?;
        let mut prod_host = host();
        prod_host.group = "prod/api".into();
        save(&db, prod_host)?;
        let mut production_host = host();
        production_host.name = "production-host".into();
        production_host.group = "production".into();
        save(&db, production_host)?;

        save_group(&db, Some("prod"), "online")?;
        assert_eq!(groups(&db)?, ["online", "online/api", "production"]);
        assert_eq!(list(&db)?[0].group, "online/api");
        assert_eq!(list(&db)?[1].group, "production");

        delete_group(&db, "online")?;
        assert_eq!(groups(&db)?, ["production"]);
        assert_eq!(list(&db)?[0].group, "");
        assert_eq!(list(&db)?[1].group, "production");
        Ok(())
    }

    #[test]
    fn folder_rename_rejects_missing_or_conflicting_targets() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let db = open(&directory.path().join("group-conflicts.db"))?;
        save_group(&db, None, "prod")?;
        save_group(&db, None, "staging")?;

        assert!(save_group(&db, Some("missing"), "online").is_err());
        assert!(save_group(&db, Some("prod"), "staging").is_err());
        assert_eq!(groups(&db)?, ["prod", "staging"]);
        Ok(())
    }

    #[test]
    fn folder_move_rejects_a_missing_source() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let db = open(&directory.path().join("group-missing-source.db"))?;
        save_group(&db, None, "target")?;

        assert!(move_group(&db, "missing", "target").is_err());
        assert_eq!(groups(&db)?, ["target"]);
        Ok(())
    }

    #[test]
    fn folder_delete_rejects_a_missing_source() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let db = open(&directory.path().join("group-missing-delete.db"))?;
        save_group(&db, None, "existing")?;

        assert!(delete_group(&db, "missing").is_err());
        assert_eq!(groups(&db)?, ["existing"]);
        Ok(())
    }

    #[test]
    fn tunnel_arguments_bind_loopback_and_reject_injection() -> Result<()> {
        let mut tunnel = Tunnel {
            kind: "local".into(),
            listen_port: 8080,
            target_host: "localhost".into(),
            target_port: 80,
        };
        assert_eq!(
            tunnel.arguments()?,
            ("-L", "127.0.0.1:8080:localhost:80".into())
        );
        tunnel.kind = "remote".into();
        assert_eq!(tunnel.arguments()?.0, "-R");
        tunnel.kind = "dynamic".into();
        assert_eq!(tunnel.arguments()?, ("-D", "127.0.0.1:8080".into()));
        tunnel.kind = "local".into();
        tunnel.target_host = "host -oProxyCommand=cmd".into();
        assert!(tunnel.arguments().is_err());
        Ok(())
    }
}
