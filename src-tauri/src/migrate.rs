//! One-time recovery of data written by the previous TShell-branded build.
//!
//! Renaming the bundle identifier moves the application data directory, and
//! renaming the keyring services orphans every stored secret, including the
//! screen lock hash. Both are copied forward on the first launch of the
//! renamed build; failures are reported but never block startup.

use crate::auth_store::{
    AI_ACCOUNT, AI_SERVICE, LEGACY_AI_SERVICE, LEGACY_PLATFORM_SERVICE, LEGACY_PROXY_SERVICE,
    LEGACY_SCREEN_LOCK_ACCOUNT, LEGACY_SSH_SERVICE, PLATFORM_SERVICE, PROXY_SERVICE, SSH_SERVICE,
};
use anyhow::{Context, Result};
use rusqlite::OptionalExtension;
use std::path::Path;
use zeroize::Zeroizing;
const LEGACY_IDENTIFIER: &str = "com.lbemi.tshell";
const LEGACY_DATABASE: &str = "tshell.sqlite3";
const KNOWN_HOSTS: &str = "known_hosts";
const MIGRATION_KEY: &str = "migrated_from_tshell";

pub(crate) fn run(directory: &Path, database: &Path, known_hosts: &Path) -> Result<()> {
    let Some(parent) = directory.parent() else {
        return Ok(());
    };
    let legacy = parent.join(LEGACY_IDENTIFIER);
    let legacy_database = legacy.join(LEGACY_DATABASE);
    if !legacy_database.is_file() {
        return Ok(());
    }
    if !database.exists() {
        copy_database(&legacy_database, database)?;
    }
    let legacy_known_hosts = legacy.join(KNOWN_HOSTS);
    if legacy_known_hosts.is_file() && !known_hosts.exists() {
        std::fs::copy(&legacy_known_hosts, known_hosts).context("复制 known_hosts 失败")?;
    }
    if !migrated(database)? {
        migrate_secrets(&legacy_database);
        mark_migrated(database)?;
    }
    Ok(())
}

fn copy_database(source: &Path, target: &Path) -> Result<()> {
    // Flush the write-ahead log first; copying the main file alone can drop
    // transactions that were never checkpointed.
    let connection = rusqlite::Connection::open(source).context("打开旧数据库失败")?;
    let _ = connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    drop(connection);
    std::fs::copy(source, target).context("复制旧数据库失败")?;
    Ok(())
}

fn migrated(database: &Path) -> Result<bool> {
    let value: Option<String> = crate::storage::open(database)?
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            [MIGRATION_KEY],
            |row| row.get(0),
        )
        .optional()?;
    Ok(value.as_deref() == Some("true"))
}

fn mark_migrated(database: &Path) -> Result<()> {
    crate::storage::open(database)?.execute(
        "INSERT INTO settings(key,value) VALUES(?1,'true') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [MIGRATION_KEY],
    )?;
    Ok(())
}

fn migrate_secrets(legacy_database: &Path) {
    let db = match crate::storage::open(legacy_database) {
        Ok(db) => db,
        Err(error) => {
            eprintln!("[pixiu-shell] 跳过旧凭据迁移：{error}");
            return;
        }
    };
    let address: Option<String> = db
        .query_row(
            "SELECT value FROM settings WHERE key='platform_url'",
            [],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten();
    if let Some(address) = address.as_deref() {
        // The stored address is user input; the keyring account is the
        // normalized base URL, so both spellings are attempted.
        let mut accounts = vec![address.to_owned()];
        if let Ok(base) = crate::platform::normalize_base(address) {
            accounts.push(base.to_string());
        }
        for account in accounts {
            report(migrate_entry(
                LEGACY_PLATFORM_SERVICE,
                PLATFORM_SERVICE,
                &account,
                &account,
            ));
        }
    }
    report(migrate_entry(
        LEGACY_PLATFORM_SERVICE,
        PLATFORM_SERVICE,
        LEGACY_SCREEN_LOCK_ACCOUNT,
        crate::screen_lock::ACCOUNT,
    ));
    report(migrate_entry(
        LEGACY_AI_SERVICE,
        AI_SERVICE,
        AI_ACCOUNT,
        AI_ACCOUNT,
    ));
    let ids: Vec<String> = match db.prepare("SELECT id FROM local_hosts") {
        Ok(mut statement) => statement
            .query_map([], |row| row.get(0))
            .and_then(|rows| rows.collect())
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    for id in ids {
        report(migrate_entry(LEGACY_SSH_SERVICE, SSH_SERVICE, &id, &id));
        report(migrate_entry(LEGACY_PROXY_SERVICE, PROXY_SERVICE, &id, &id));
    }
}

fn report(result: Result<()>) {
    if let Err(error) = result {
        eprintln!("[pixiu-shell] 迁移旧系统凭据失败：{error}");
    }
}

fn migrate_entry(
    legacy_service: &str,
    service: &str,
    legacy_account: &str,
    account: &str,
) -> Result<()> {
    let source = keyring::Entry::new(legacy_service, legacy_account)?;
    let value = match source.get_password() {
        Ok(value) if !value.is_empty() => Zeroizing::new(value),
        Ok(_) | Err(keyring::Error::NoEntry) => return Ok(()),
        Err(error) => return Err(error).context("读取旧系统凭据失败"),
    };
    let target = keyring::Entry::new(service, account)?;
    if target.get_password().is_ok() {
        return Ok(());
    }
    target.set_password(value.as_str()).context("写入新系统凭据失败")?;
    let _ = source.delete_credential();
    Ok(())
}
