use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use chacha20poly1305::{
    aead::{Aead, KeyInit as AeadKeyInit, Payload},
    Key, XChaCha20Poly1305, XNonce,
};
use hmac::{digest::KeyInit as HmacKeyInit, Mac, SimpleHmac};
use hkdf::Hkdf;
use rand_core::{OsRng, RngCore};
use sha2::Sha256;
use zeroize::{Zeroize, ZeroizeOnDrop};

// ── Error ─────────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub enum VaultCryptoError {
    Argon2(argon2::Error),
    Aead,
    HkdfExpand,
    InvalidSaltLength,
}

impl std::fmt::Display for VaultCryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Argon2(e) => write!(f, "KDF error: {e}"),
            Self::Aead => write!(f, "AEAD error: authentication failed or bad ciphertext"),
            Self::HkdfExpand => write!(f, "HKDF expand failed"),
            Self::InvalidSaltLength => write!(f, "salt must be at least 8 bytes"),
        }
    }
}

impl std::error::Error for VaultCryptoError {}

impl From<argon2::Error> for VaultCryptoError {
    fn from(e: argon2::Error) -> Self {
        Self::Argon2(e)
    }
}

// ── Key material wrapper ───────────────────────────────────────────────────────

/// A 256-bit key that is zeroed on drop.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct SecretKey([u8; 32]);

impl SecretKey {
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    fn as_mut_bytes(&mut self) -> &mut [u8; 32] {
        &mut self.0
    }
}

// ── KDF parameters ─────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct KdfParams {
    /// Memory cost in kibibytes.
    pub m_cost: u32,
    /// Number of iterations.
    pub t_cost: u32,
    /// Parallelism (lanes).
    pub p_cost: u32,
}

impl KdfParams {
    /// Production default: 64 MiB, 3 iterations, 1 lane.
    /// Meets OWASP Argon2id recommended minimums with headroom.
    pub fn default_production() -> Self {
        Self {
            m_cost: 65536,
            t_cost: 3,
            p_cost: 1,
        }
    }

    /// Fast params for unit tests only. Never use in production.
    #[cfg(test)]
    pub fn test_fast() -> Self {
        Self {
            m_cost: 4096,
            t_cost: 1,
            p_cost: 1,
        }
    }
}

// ── Encrypted envelope ──────────────────────────────────────────────────────────

/// The on-disk/in-redb representation of one encrypted record or key slot.
#[derive(Clone, Debug)]
pub struct EncryptedEnvelope {
    /// 192-bit XChaCha20-Poly1305 nonce.
    pub nonce: [u8; 24],
    /// Ciphertext + 16-byte Poly1305 authentication tag.
    pub ciphertext: Vec<u8>,
}

// ── Primitive operations ────────────────────────────────────────────────────────

/// Derive a 256-bit Key-Encryption Key from a master passphrase using Argon2id.
///
/// `salt` must be at least 8 bytes; use 32 bytes in production (see `generate_salt`).
pub fn derive_kek(
    passphrase: &[u8],
    salt: &[u8],
    params: &KdfParams,
) -> Result<SecretKey, VaultCryptoError> {
    if salt.len() < 8 {
        return Err(VaultCryptoError::InvalidSaltLength);
    }
    let p = Params::new(params.m_cost, params.t_cost, params.p_cost, Some(32))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, p);
    let mut key = SecretKey([0u8; 32]);
    argon2.hash_password_into(passphrase, salt, key.as_mut_bytes())?;
    Ok(key)
}

/// Derive a per-record encryption key from the VEK using HKDF-SHA256.
///
/// `info` should encode the record's identity, e.g.
/// `b"zync:vault:record:v1:<record_id>:<revision>"`.
pub fn derive_record_key(vek: &SecretKey, info: &[u8]) -> Result<SecretKey, VaultCryptoError> {
    let hk = Hkdf::<Sha256>::new(None, vek.as_bytes());
    let mut key = SecretKey([0u8; 32]);
    hk.expand(info, key.as_mut_bytes())
        .map_err(|_| VaultCryptoError::HkdfExpand)?;
    Ok(key)
}

/// Derive a stable keyed fingerprint for equality-only comparisons.
pub fn derive_secret_fingerprint(
    vek: &SecretKey,
    secret: &str,
) -> Result<String, VaultCryptoError> {
    let fingerprint_key = derive_record_key(vek, b"zync:vault:fingerprint:v1")?;
    let mut mac = <SimpleHmac<Sha256> as HmacKeyInit>::new_from_slice(fingerprint_key.as_bytes())
        .map_err(|_| VaultCryptoError::HkdfExpand)?;
    mac.update(secret.as_bytes());
    let digest = mac.finalize().into_bytes();
    Ok(base64::engine::general_purpose::STANDARD.encode(digest))
}

/// Encrypt `plaintext` with XChaCha20-Poly1305 using a random nonce.
///
/// `aad` is authenticated but not encrypted (e.g. vault_id + record_id + revision).
pub fn encrypt_record(
    key: &SecretKey,
    plaintext: &[u8],
    aad: &[u8],
) -> Result<EncryptedEnvelope, VaultCryptoError> {
    let mut nonce_bytes = [0u8; 24];
    OsRng.fill_bytes(&mut nonce_bytes);
    encrypt_with_nonce(key, &nonce_bytes, plaintext, aad)
}

/// Decrypt an `EncryptedEnvelope` produced by `encrypt_record`.
///
/// Returns `Err(VaultCryptoError::Aead)` on wrong key, tampered ciphertext, or tampered AAD.
pub fn decrypt_record(
    key: &SecretKey,
    envelope: &EncryptedEnvelope,
    aad: &[u8],
) -> Result<Vec<u8>, VaultCryptoError> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key.as_bytes()));
    let nonce = XNonce::from_slice(&envelope.nonce);
    let payload = Payload {
        msg: &envelope.ciphertext,
        aad,
    };
    cipher
        .decrypt(nonce, payload)
        .map_err(|_| VaultCryptoError::Aead)
}

/// Generate a cryptographically random 32-byte vault salt.
pub fn generate_salt() -> [u8; 32] {
    let mut salt = [0u8; 32];
    OsRng.fill_bytes(&mut salt);
    salt
}

/// Generate a cryptographically random 256-bit Vault Encryption Key.
pub fn generate_vek() -> SecretKey {
    let mut key = SecretKey([0u8; 32]);
    OsRng.fill_bytes(key.as_mut_bytes());
    key
}

// ── Internal helper (exposed for deterministic tests) ─────────────────────────

fn encrypt_with_nonce(
    key: &SecretKey,
    nonce_bytes: &[u8; 24],
    plaintext: &[u8],
    aad: &[u8],
) -> Result<EncryptedEnvelope, VaultCryptoError> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key.as_bytes()));
    let nonce = XNonce::from_slice(nonce_bytes);
    let payload = Payload {
        msg: plaintext,
        aad,
    };
    let ciphertext = cipher
        .encrypt(nonce, payload)
        .map_err(|_| VaultCryptoError::Aead)?;
    Ok(EncryptedEnvelope {
        nonce: *nonce_bytes,
        ciphertext,
    })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_PASSPHRASE: &[u8] = b"zync-test-passphrase-v1";
    const TEST_PLAINTEXT: &[u8] = b"ssh-password: hunter2";
    const TEST_AAD: &[u8] = b"vault-id:test-vault|record-id:rec-001|revision:1";

    fn test_params() -> KdfParams {
        KdfParams::test_fast()
    }

    fn test_salt() -> [u8; 32] {
        [0x42u8; 32]
    }

    fn test_nonce() -> [u8; 24] {
        [0xABu8; 24]
    }

    fn hex_encode(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    // ── KDF ──────────────────────────────────────────────────────────────────

    #[test]
    fn kdf_is_deterministic() {
        let salt = test_salt();
        let kek1 = derive_kek(TEST_PASSPHRASE, &salt, &test_params()).unwrap();
        let kek2 = derive_kek(TEST_PASSPHRASE, &salt, &test_params()).unwrap();
        assert_eq!(*kek1.as_bytes(), *kek2.as_bytes());
    }

    #[test]
    fn kdf_different_passphrase_produces_different_key() {
        let salt = test_salt();
        let kek1 = derive_kek(b"passphrase-a", &salt, &test_params()).unwrap();
        let kek2 = derive_kek(b"passphrase-b", &salt, &test_params()).unwrap();
        assert_ne!(*kek1.as_bytes(), *kek2.as_bytes());
    }

    #[test]
    fn kdf_different_salt_produces_different_key() {
        let kek1 = derive_kek(TEST_PASSPHRASE, &[0x11u8; 32], &test_params()).unwrap();
        let kek2 = derive_kek(TEST_PASSPHRASE, &[0x22u8; 32], &test_params()).unwrap();
        assert_ne!(*kek1.as_bytes(), *kek2.as_bytes());
    }

    #[test]
    fn kdf_rejects_short_salt() {
        let err = derive_kek(TEST_PASSPHRASE, &[0u8; 4], &test_params());
        assert!(matches!(err, Err(VaultCryptoError::InvalidSaltLength)));
    }

    // ── HKDF record key ───────────────────────────────────────────────────────

    #[test]
    fn record_key_derivation_is_deterministic() {
        let vek = SecretKey::from_bytes([0x55u8; 32]);
        let info = b"zync:vault:record:v1:rec-001:1";
        let k1 = derive_record_key(&vek, info).unwrap();
        let k2 = derive_record_key(&vek, info).unwrap();
        assert_eq!(*k1.as_bytes(), *k2.as_bytes());
    }

    #[test]
    fn record_key_differs_per_record_id() {
        let vek = SecretKey::from_bytes([0x55u8; 32]);
        let k1 = derive_record_key(&vek, b"zync:vault:record:v1:rec-001:1").unwrap();
        let k2 = derive_record_key(&vek, b"zync:vault:record:v1:rec-002:1").unwrap();
        assert_ne!(*k1.as_bytes(), *k2.as_bytes());
    }

    #[test]
    fn record_key_differs_per_revision() {
        let vek = SecretKey::from_bytes([0x55u8; 32]);
        let k1 = derive_record_key(&vek, b"zync:vault:record:v1:rec-001:1").unwrap();
        let k2 = derive_record_key(&vek, b"zync:vault:record:v1:rec-001:2").unwrap();
        assert_ne!(*k1.as_bytes(), *k2.as_bytes());
    }

    // ── AEAD round-trip ───────────────────────────────────────────────────────

    #[test]
    fn encrypt_decrypt_round_trip() {
        let key = derive_kek(TEST_PASSPHRASE, &test_salt(), &test_params()).unwrap();
        let envelope = encrypt_record(&key, TEST_PLAINTEXT, TEST_AAD).unwrap();
        let plaintext = decrypt_record(&key, &envelope, TEST_AAD).unwrap();
        assert_eq!(plaintext, TEST_PLAINTEXT);
    }

    #[test]
    fn wrong_key_fails_decryption() {
        let key = derive_kek(TEST_PASSPHRASE, &test_salt(), &test_params()).unwrap();
        let wrong_key = derive_kek(b"wrong-passphrase", &test_salt(), &test_params()).unwrap();
        let envelope = encrypt_record(&key, TEST_PLAINTEXT, TEST_AAD).unwrap();
        let result = decrypt_record(&wrong_key, &envelope, TEST_AAD);
        assert!(matches!(result, Err(VaultCryptoError::Aead)));
    }

    #[test]
    fn tampered_ciphertext_fails_decryption() {
        let key = derive_kek(TEST_PASSPHRASE, &test_salt(), &test_params()).unwrap();
        let mut envelope = encrypt_record(&key, TEST_PLAINTEXT, TEST_AAD).unwrap();
        // Flip a bit in the ciphertext body (not the auth tag at the end).
        envelope.ciphertext[0] ^= 0xFF;
        let result = decrypt_record(&key, &envelope, TEST_AAD);
        assert!(matches!(result, Err(VaultCryptoError::Aead)));
    }

    #[test]
    fn tampered_aad_fails_decryption() {
        let key = derive_kek(TEST_PASSPHRASE, &test_salt(), &test_params()).unwrap();
        let envelope = encrypt_record(&key, TEST_PLAINTEXT, TEST_AAD).unwrap();
        let wrong_aad = b"vault-id:attacker|record-id:rec-001|revision:1";
        let result = decrypt_record(&key, &envelope, wrong_aad);
        assert!(matches!(result, Err(VaultCryptoError::Aead)));
    }

    #[test]
    fn tampered_nonce_fails_decryption() {
        let key = derive_kek(TEST_PASSPHRASE, &test_salt(), &test_params()).unwrap();
        let mut envelope = encrypt_record(&key, TEST_PLAINTEXT, TEST_AAD).unwrap();
        envelope.nonce[0] ^= 0xFF;
        let result = decrypt_record(&key, &envelope, TEST_AAD);
        assert!(matches!(result, Err(VaultCryptoError::Aead)));
    }

    // ── Known-answer vector ───────────────────────────────────────────────────
    // Fixed inputs must produce identical output on every platform (Windows/macOS/Linux).
    // If this test fails after pinning, the crypto output changed — investigate before shipping.

    #[test]
    fn known_answer_kdf_is_reproducible() {
        let kek = derive_kek(TEST_PASSPHRASE, &test_salt(), &test_params()).unwrap();
        // Verify non-zero output and stable length.
        assert_eq!(kek.as_bytes().len(), 32);
        assert_ne!(*kek.as_bytes(), [0u8; 32]);
        assert_eq!(
            hex_encode(kek.as_bytes()),
            "b052565b8931ce7601892df5f7be4ff2a8ef6cdc6886f38dc08c8f34de3281e7",
            "KDF known-answer vector changed"
        );
    }

    #[test]
    fn known_answer_aead_is_reproducible() {
        let key = SecretKey::from_bytes([0x77u8; 32]);
        let nonce = test_nonce();
        let envelope = encrypt_with_nonce(&key, &nonce, TEST_PLAINTEXT, TEST_AAD).unwrap();

        // Verify the envelope has correct structure.
        assert_eq!(envelope.nonce, nonce);
        // Ciphertext = plaintext + 16-byte Poly1305 tag.
        assert_eq!(envelope.ciphertext.len(), TEST_PLAINTEXT.len() + 16);
        assert_eq!(
            hex_encode(&envelope.ciphertext),
            "f0fdb9b785c52b0f84b577f7a58bc57b7e82ae7ce49d3b5b7314b7e604b87cd3976944f774",
            "AEAD known-answer vector changed"
        );
    }

    #[test]
    fn fingerprint_is_stable_for_same_secret_and_key() {
        let vek = SecretKey::from_bytes([0x33u8; 32]);
        let first = derive_secret_fingerprint(&vek, "hunter2").unwrap();
        let second = derive_secret_fingerprint(&vek, "hunter2").unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn fingerprint_changes_when_secret_or_key_changes() {
        let vek_a = SecretKey::from_bytes([0x44u8; 32]);
        let vek_b = SecretKey::from_bytes([0x55u8; 32]);
        let base = derive_secret_fingerprint(&vek_a, "hunter2").unwrap();
        let other_secret = derive_secret_fingerprint(&vek_a, "hunter3").unwrap();
        let other_key = derive_secret_fingerprint(&vek_b, "hunter2").unwrap();
        assert_ne!(base, other_secret);
        assert_ne!(base, other_key);
    }

    // ── Zeroize compiles ──────────────────────────────────────────────────────

    #[test]
    fn secret_key_zeroizes_on_drop() {
        // This test verifies that SecretKey implements Zeroize correctly.
        // We can't observe memory after drop, but we can verify the trait is present.
        let mut key = SecretKey::from_bytes([0xFFu8; 32]);
        key.zeroize();
        assert_eq!(*key.as_bytes(), [0u8; 32]);
    }
}
