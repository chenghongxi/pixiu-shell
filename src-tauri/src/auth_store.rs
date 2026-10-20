use anyhow::{Context, Result};
use zeroize::Zeroizing;

pub(crate) trait AuthStore: Send + Sync {
    fn read(&self, account: &str) -> Result<Option<Zeroizing<String>>>;
    fn write(&self, account: &str, value: &str) -> Result<()>;
    fn delete(&self, account: &str) -> Result<()>;
}
pub(crate) struct KeychainStore;
impl AuthStore for KeychainStore {
    fn read(&self, account: &str) -> Result<Option<Zeroizing<String>>> {
        match keyring::Entry::new("com.chenlian.tshell.platform", account)?.get_password() {
            Ok(value) => Ok(Some(Zeroizing::new(value))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error).context("无法读取系统凭据，请检查系统凭据库权限"),
        }
    }
    fn write(&self, account: &str, value: &str) -> Result<()> {
        keyring::Entry::new("com.chenlian.tshell.platform", account)?
            .set_password(value)
            .context("保存系统凭据失败")
    }
    fn delete(&self, account: &str) -> Result<()> {
        match keyring::Entry::new("com.chenlian.tshell.platform", account)?.delete_credential() {
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
