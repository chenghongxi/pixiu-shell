use anyhow::{Context, Result};
use zeroize::Zeroizing;

// Keyring service names are part of the credential identity: renaming them
// orphans everything a previous version stored, so the legacy names survive
// here only for the one-time migration in crate::migrate.
pub(crate) const PLATFORM_SERVICE: &str = "com.lbemi.pixiu-shell.platform";
pub(crate) const SSH_SERVICE: &str = "com.lbemi.pixiu-shell.ssh";
pub(crate) const AI_SERVICE: &str = "com.lbemi.pixiu-shell.ai";
pub(crate) const PROXY_SERVICE: &str = "com.lbemi.pixiu-shell.proxy";
pub(crate) const LEGACY_PLATFORM_SERVICE: &str = "com.chenlian.tshell.platform";
pub(crate) const LEGACY_SSH_SERVICE: &str = "com.chenlian.tshell.ssh";
pub(crate) const LEGACY_AI_SERVICE: &str = "com.chenlian.tshell.ai";
pub(crate) const LEGACY_PROXY_SERVICE: &str = "com.chenlian.tshell.proxy";
pub(crate) const AI_ACCOUNT: &str = "openai-compatible-api-key";
pub(crate) const LEGACY_SCREEN_LOCK_ACCOUNT: &str = "__tshell_screen_lock";

pub(crate) trait AuthStore: Send + Sync {
    fn read(&self, account: &str) -> Result<Option<Zeroizing<String>>>;
    fn write(&self, account: &str, value: &str) -> Result<()>;
    fn delete(&self, account: &str) -> Result<()>;
}
pub(crate) struct KeychainStore;
impl AuthStore for KeychainStore {
    fn read(&self, account: &str) -> Result<Option<Zeroizing<String>>> {
        match keyring::Entry::new(PLATFORM_SERVICE, account)?.get_password() {
            Ok(value) => Ok(Some(Zeroizing::new(value))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error).context("无法读取系统凭据，请检查系统凭据库权限"),
        }
    }
    fn write(&self, account: &str, value: &str) -> Result<()> {
        keyring::Entry::new(PLATFORM_SERVICE, account)?
            .set_password(value)
            .context("保存系统凭据失败")
    }
    fn delete(&self, account: &str) -> Result<()> {
        match keyring::Entry::new(PLATFORM_SERVICE, account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error).context("清除系统凭据失败"),
        }
    }
}
#[cfg(test)]
#[derive(Default)]
pub(crate) struct MemoryStore(pub std::sync::Mutex<std::collections::HashMap<String, String>>);
#[cfg(test)]
impl AuthStore for MemoryStore {
    fn read(&self, account: &str) -> Result<Option<Zeroizing<String>>> {
        Ok(self
            .0
            .lock()
            .map_err(|_| anyhow::anyhow!("store lock"))?
            .get(account)
            .map(|value| Zeroizing::new(value.to_owned())))
    }
    fn write(&self, account: &str, value: &str) -> Result<()> {
        self.0
            .lock()
            .map_err(|_| anyhow::anyhow!("store lock"))?
            .insert(account.to_owned(), value.to_owned());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<()> {
        self.0
            .lock()
            .map_err(|_| anyhow::anyhow!("store lock"))?
            .remove(account);
        Ok(())
    }
}
