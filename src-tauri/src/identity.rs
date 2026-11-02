use crate::storage::SshIdentity;
use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD_NO_PAD};
use sha2::{Digest, Sha256};
use std::path::Path;

/// Read only the non-secret metadata needed to identify a key in the UI. The
/// private key is never copied into Pixiu's database or credential store.
pub(crate) fn inspect(identity: &mut SshIdentity) -> Result<()> {
    identity.name = identity.name.trim().to_owned();
    identity.path = identity.path.trim().to_owned();
    ensure!(
        !identity.name.is_empty() && identity.name.len() <= 120,
        "密钥名称不能为空，且不能超过 120 字节"
    );
    ensure!(
        !identity.path.is_empty()
            && identity.path.len() <= 4096
            && !identity.path.contains(['\0', '\n', '\r']),
        "私钥路径无效"
    );
    let path = Path::new(&identity.path);
    ensure!(path.is_absolute() && path.is_file(), "指定的私钥文件不存在（请填写绝对路径）");
    let private = std::fs::read_to_string(path)
        .with_context(|| format!("无法读取私钥文件 {}", path.display()))?;
    identity.key_type = private_key_type(&private)?;
    identity.fingerprint = public_fingerprint(path).unwrap_or_else(|| "未找到对应 .pub 公钥".into());
    Ok(())
}

fn private_key_type(private: &str) -> Result<String> {
    if private.contains("PuTTY-User-Key-File") {
        bail!("这是 PuTTY/Xshell 的 ppk 私钥，请导出为 OpenSSH 格式后再添加");
    }
    if private.contains("BEGIN SSH2") {
        bail!("这是 SSH2 格式私钥，请导出为 OpenSSH 格式后再添加");
    }
    if private.contains("BEGIN OPENSSH PRIVATE KEY") {
        return Ok("OpenSSH".into());
    }
    for (marker, name) in [
        ("BEGIN RSA PRIVATE KEY", "RSA"),
        ("BEGIN EC PRIVATE KEY", "ECDSA"),
        ("BEGIN PRIVATE KEY", "PKCS#8"),
        ("BEGIN ENCRYPTED PRIVATE KEY", "PKCS#8 (加密)"),
    ] {
        if private.contains(marker) {
            return Ok(name.into());
        }
    }
    bail!("无法识别私钥格式，请选择 OpenSSH 或 PEM 私钥")
}

fn public_fingerprint(private: &Path) -> Option<String> {
    let file = private.file_name()?.to_str()?;
    let public = std::fs::read_to_string(private.with_file_name(format!("{file}.pub"))).ok()?;
    let encoded = public.split_whitespace().nth(1)?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).ok()?;
    let digest = Sha256::digest(bytes);
    Some(format!("SHA256:{}", STANDARD_NO_PAD.encode(digest)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn reads_key_type_and_public_fingerprint() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("id_ed25519");
        std::fs::write(&path, "-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----\n")?;
        std::fs::write(path.with_file_name("id_ed25519.pub"), "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEV4YW1wbGUtS2V5LUZvci1GaW5nZXJwcmludA== demo\n")?;
        let mut identity = SshIdentity {
            id: Uuid::new_v4(),
            name: "production".into(),
            path: path.to_string_lossy().into_owned(),
            key_type: String::new(),
            fingerprint: String::new(),
        };
        inspect(&mut identity)?;
        assert_eq!(identity.key_type, "OpenSSH");
        assert!(identity.fingerprint.starts_with("SHA256:"));
        Ok(())
    }
}
