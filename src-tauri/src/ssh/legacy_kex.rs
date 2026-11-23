//! Explicit, per-hop compatibility for legacy key exchange.

use crate::types::ConnectionConfig;
use russh::{kex, AlgorithmKind};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub(crate) enum LegacyKex {
    #[serde(rename = "diffie-hellman-group-exchange-sha1")]
    GroupExchange,
    #[serde(rename = "diffie-hellman-group14-sha1")]
    Group14,
    #[serde(rename = "diffie-hellman-group1-sha1")]
    Group1,
}

impl LegacyKex {
    fn name(self) -> kex::Name {
        match self {
            Self::GroupExchange => kex::DH_GEX_SHA1,
            Self::Group14 => kex::DH_G14_SHA1,
            Self::Group1 => kex::DH_G1_SHA1,
        }
    }
}

/// Append one algorithm after the modern defaults.
pub(super) fn apply(config: &mut russh::client::Config, approval: Option<LegacyKex>) {
    if let Some(algorithm) = approval {
        config.preferred.kex.to_mut().push(algorithm.name());
    }
}

/// Offer an explicit retry only for a KEX mismatch with a supported legacy option.
pub(super) fn challenge(error: anyhow::Error, config: &ConnectionConfig) -> anyhow::Error {
    if config.legacy_kex.is_some() {
        return error;
    }
    let Some(russh::Error::NoCommonAlgo {
        kind: AlgorithmKind::Kex,
        theirs,
        ..
    }) = error.downcast_ref::<russh::Error>()
    else {
        return error;
    };
    let algorithm = [
        LegacyKex::Group14,
        LegacyKex::GroupExchange,
        LegacyKex::Group1,
    ]
    .into_iter()
    .find(|algorithm| {
        theirs
            .iter()
            .any(|offered| offered == algorithm.name().as_ref())
    });
    let Some(algorithm) = algorithm else {
        return error;
    };
    let challenge = serde_json::json!({
        "connectionId": config.id,
        "host": config.host,
        "port": config.port,
        "algorithm": algorithm,
    });
    anyhow::anyhow!("ZYNC_LEGACY_KEX:{challenge}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approval_appends_only_the_chosen_algorithm() {
        let mut config = russh::client::Config::default();
        let baseline = config.preferred.kex.clone();
        apply(&mut config, None);
        assert_eq!(config.preferred.kex, baseline);
        apply(&mut config, Some(LegacyKex::GroupExchange));
        assert_eq!(&config.preferred.kex[..baseline.len()], baseline.as_ref());
        assert_eq!(&config.preferred.kex[baseline.len()..], &[kex::DH_GEX_SHA1]);
        assert!(!config.preferred.kex.contains(&kex::DH_G1_SHA1));
    }

    #[test]
    fn only_key_exchange_mismatches_offer_an_exception() {
        let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "fixture",
            "name": "Fixture",
            "host": "fixture.invalid",
            "port": 2222,
            "username": "fixture",
            "auth_method": { "type": "Password", "password": "" }
        }))
        .unwrap();
        let mismatch = |kind| {
            russh::Error::NoCommonAlgo {
                kind,
                ours: vec!["curve25519-sha256".into()],
                theirs: vec![
                    kex::DH_G1_SHA1.as_ref().into(),
                    kex::DH_GEX_SHA1.as_ref().into(),
                ],
            }
            .into()
        };
        let error = challenge(mismatch(AlgorithmKind::Kex), &config).to_string();
        let payload = error.strip_prefix("ZYNC_LEGACY_KEX:").unwrap();
        let payload: serde_json::Value = serde_json::from_str(payload).unwrap();
        assert_eq!(payload["algorithm"], kex::DH_GEX_SHA1.as_ref());
        assert_eq!(payload["connectionId"], "fixture");
        assert_eq!(payload["port"], 2222);

        for kind in [AlgorithmKind::Cipher, AlgorithmKind::Key] {
            assert!(challenge(mismatch(kind), &config).is::<russh::Error>());
        }
    }
}
