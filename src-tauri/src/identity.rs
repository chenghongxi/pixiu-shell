use crate::storage::SshIdentity;
use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD_NO_PAD};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use uuid::Uuid;
use zeroize::Zeroizing;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GenerateRequest {
    pub name: String,
    pub path: String,
    pub algorithm: String,
    pub passphrase: Option<String>,
}

pub(crate) fn generate(request: GenerateRequest) -> Result<SshIdentity> {
    let path = PathBuf::from(request.path.trim());
    ensure!(path.is_absolute(), "密钥保存位置必须是绝对路径");
    let public_path = public_key_path(&path)?;
    ensure!(
        !path.exists() && !public_path.exists(),
        "密钥文件已存在，请选择其他名称"
    );
    let algorithm = match request.algorithm.as_str() {
        "ed25519" => ssh_key::Algorithm::Ed25519,
        "rsa" => ssh_key::Algorithm::Rsa { hash: Some(ssh_key::HashAlg::Sha512) },
        _ => bail!("仅支持 Ed25519 或 RSA 密钥"),
    };
    let mut key = ssh_key::PrivateKey::random(&mut ssh_key::rand_core::OsRng, algorithm)
        .context("生成 SSH 密钥失败")?;
    key.set_comment(request.name.trim());
    let passphrase = request.passphrase.map(Zeroizing::new).filter(|value| !value.is_empty());
    if let Some(passphrase) = passphrase.as_ref() {
        key = key.encrypt(&mut ssh_key::rand_core::OsRng, passphrase.as_bytes())
            .context("加密 SSH 私钥失败")?;
    }
    let parent = path.parent().context("密钥保存位置无效")?;
    std::fs::create_dir_all(parent).with_context(|| format!("无法创建密钥目录 {}", parent.display()))?;
    key.write_openssh_file(&path, ssh_key::LineEnding::LF)
        .with_context(|| format!("无法写入私钥文件 {}", path.display()))?;
    if let Err(error) = key.public_key().write_openssh_file(&public_path) {
        let _ = std::fs::remove_file(&path);
        return Err(error).context("无法写入公钥文件");
    }
    let mut identity = SshIdentity {
        id: Uuid::new_v4(),
        name: request.name,
        path: path.to_string_lossy().into_owned(),
        key_type: String::new(),
        algorithm: String::new(),
        fingerprint: String::new(),
        has_passphrase: passphrase.is_some(),
    };
    if let Err(error) = inspect(&mut identity) {
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&public_path);
        return Err(error);
    }
    Ok(identity)
}

pub(crate) fn public_key_path(path: &Path) -> Result<PathBuf> {
    let name = path
        .file_name()
        .filter(|name| !name.is_empty())
        .context("密钥保存位置必须包含文件名")?;
    Ok(path.with_file_name(format!("{}.pub", name.to_string_lossy())))
}

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
    identity.algorithm = algorithm(path);
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

pub(crate) fn algorithm(private: &Path) -> String {
    let result = private.file_name().and_then(|file| {
        let public = std::fs::read_to_string(private.with_file_name(format!("{}.pub", file.to_string_lossy()))).ok()?;
        Some(match public.split_whitespace().next()? {
            "ssh-ed25519" => "Ed25519",
            "ssh-rsa" | "rsa-sha2-256" | "rsa-sha2-512" => "RSA",
            value if value.starts_with("ecdsa-") => "ECDSA",
            "ssh-dss" => "DSA",
            value if value.starts_with("sk-ssh-ed25519") => "Ed25519 安全密钥",
            value if value.starts_with("sk-ecdsa-") => "ECDSA 安全密钥",
            _ => "未识别",
        })
    });
    result.unwrap_or("未识别").into()
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
            algorithm: String::new(),
            fingerprint: String::new(),
            has_passphrase: false,
        };
        inspect(&mut identity)?;
        assert_eq!(identity.key_type, "OpenSSH");
        assert_eq!(identity.algorithm, "Ed25519");
        assert!(identity.fingerprint.starts_with("SHA256:"));
        Ok(())
    }

    #[test]
    fn generates_an_encrypted_ed25519_key_pair() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("id_ed25519");
        let identity = generate(GenerateRequest {
            name: "generated key".into(),
            path: path.to_string_lossy().into_owned(),
            algorithm: "ed25519".into(),
            passphrase: Some("test-passphrase".into()),
        })?;

        assert_eq!(identity.key_type, "OpenSSH");
        assert!(identity.has_passphrase);
        assert!(path.is_file());
        assert!(public_key_path(&path)?.is_file());
        let encrypted = ssh_key::PrivateKey::read_openssh_file(&path)?;
        assert!(encrypted.is_encrypted());
        assert!(encrypted.decrypt("test-passphrase")?.is_ed25519());
        Ok(())
    }
}
