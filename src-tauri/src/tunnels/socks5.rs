//! Minimal SOCKS5 (RFC 1928) implementation for dynamic SSH forwarding.
//!
//! Scope: version 5, no authentication, CONNECT command, IPv4/domain/IPv6 targets.
//! UDP ASSOCIATE and BIND are intentionally unsupported.

use anyhow::{bail, Result};
use std::fmt;

pub const VERSION: u8 = 0x05;
pub const METHOD_NO_AUTH: u8 = 0x00;
pub const CMD_CONNECT: u8 = 0x01;
pub const ATYP_IPV4: u8 = 0x01;
pub const ATYP_DOMAIN: u8 = 0x03;
pub const ATYP_IPV6: u8 = 0x04;
pub const REP_SUCCEEDED: u8 = 0x00;
pub const REP_GENERAL_FAILURE: u8 = 0x01;
pub const REP_CMD_NOT_SUPPORTED: u8 = 0x07;
pub const REP_ATYP_NOT_SUPPORTED: u8 = 0x08;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectTarget {
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Socks5Error {
    UnsupportedVersion(u8),
    UnsupportedCommand(u8),
    UnsupportedAddressType(u8),
    InvalidMessage(&'static str),
}

impl fmt::Display for Socks5Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedVersion(v) => write!(f, "unsupported SOCKS version {}", v),
            Self::UnsupportedCommand(c) => write!(f, "unsupported SOCKS command {}", c),
            Self::UnsupportedAddressType(a) => write!(f, "unsupported SOCKS address type {}", a),
            Self::InvalidMessage(msg) => write!(f, "invalid SOCKS message: {}", msg),
        }
    }
}

impl std::error::Error for Socks5Error {}

pub fn validate_client_greeting(buf: &[u8]) -> Result<()> {
    if buf.len() < 2 {
        bail!(Socks5Error::InvalidMessage("greeting too short"));
    }
    if buf[0] != VERSION {
        bail!(Socks5Error::UnsupportedVersion(buf[0]));
    }
    let nmethods = buf[1] as usize;
    if buf.len() != 2 + nmethods {
        bail!(Socks5Error::InvalidMessage("greeting method count mismatch"));
    }
    Ok(())
}

pub fn method_selection_reply() -> [u8; 2] {
    [VERSION, METHOD_NO_AUTH]
}

pub fn parse_connect_request(buf: &[u8]) -> Result<ConnectTarget, Socks5Error> {
    if buf.len() < 4 {
        return Err(Socks5Error::InvalidMessage("connect request too short"));
    }
    if buf[0] != VERSION {
        return Err(Socks5Error::UnsupportedVersion(buf[0]));
    }
    if buf[1] != CMD_CONNECT {
        return Err(Socks5Error::UnsupportedCommand(buf[1]));
    }
    // buf[2] reserved
    parse_target(buf[3], &buf[4..])
}

fn parse_target(atyp: u8, rest: &[u8]) -> Result<ConnectTarget, Socks5Error> {
    match atyp {
        ATYP_IPV4 => {
            if rest.len() < 6 {
                return Err(Socks5Error::InvalidMessage("ipv4 target too short"));
            }
            let host = format!("{}.{}.{}.{}", rest[0], rest[1], rest[2], rest[3]);
            let port = u16::from_be_bytes([rest[4], rest[5]]);
            Ok(ConnectTarget { host, port })
        }
        ATYP_DOMAIN => {
            if rest.is_empty() {
                return Err(Socks5Error::InvalidMessage("domain target missing length"));
            }
            let len = rest[0] as usize;
            if rest.len() < 1 + len + 2 {
                return Err(Socks5Error::InvalidMessage("domain target too short"));
            }
            let domain = std::str::from_utf8(&rest[1..1 + len])
                .map_err(|_| Socks5Error::InvalidMessage("domain is not valid utf-8"))?
                .to_string();
            let port_bytes = &rest[1 + len..1 + len + 2];
            let port = u16::from_be_bytes([port_bytes[0], port_bytes[1]]);
            Ok(ConnectTarget {
                host: domain,
                port,
            })
        }
        ATYP_IPV6 => {
            if rest.len() < 18 {
                return Err(Socks5Error::InvalidMessage("ipv6 target too short"));
            }
            let mut parts = Vec::with_capacity(8);
            for chunk in rest[..16].chunks(2) {
                parts.push(format!("{:x}", u16::from_be_bytes([chunk[0], chunk[1]])));
            }
            let host = parts.join(":");
            let port = u16::from_be_bytes([rest[16], rest[17]]);
            Ok(ConnectTarget { host, port })
        }
        other => Err(Socks5Error::UnsupportedAddressType(other)),
    }
}

pub fn connect_success_reply() -> [u8; 10] {
    [
        VERSION, REP_SUCCEEDED, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0,
    ]
}

pub fn error_reply(rep: u8) -> [u8; 10] {
    [
        VERSION, rep, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0,
    ]
}

pub fn socks5_error_to_reply(error: &Socks5Error) -> u8 {
    match error {
        Socks5Error::UnsupportedCommand(_) => REP_CMD_NOT_SUPPORTED,
        Socks5Error::UnsupportedAddressType(_) => REP_ATYP_NOT_SUPPORTED,
        _ => REP_GENERAL_FAILURE,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_client_greeting_accepts_no_auth() {
        assert!(validate_client_greeting(&[0x05, 0x01, 0x00]).is_ok());
    }

    #[test]
    fn parse_connect_ipv4_target() {
        let msg = [0x05, 0x01, 0x00, 0x01, 192, 168, 1, 10, 0x00, 0x50];
        let target = parse_connect_request(&msg).unwrap();
        assert_eq!(
            target,
            ConnectTarget {
                host: "192.168.1.10".to_string(),
                port: 80,
            }
        );
    }

    #[test]
    fn parse_connect_domain_target() {
        let msg = [
            0x05, 0x01, 0x00, 0x03, 0x0B, b'g', b'r', b'a', b'f', b'a', b'n', b'a', b'.', b'i',
            b'n', b't', 0x01, 0xBB,
        ];
        let target = parse_connect_request(&msg).unwrap();
        assert_eq!(
            target,
            ConnectTarget {
                host: "grafana.int".to_string(),
                port: 443,
            }
        );
    }

    #[test]
    fn rejects_non_connect_command() {
        let msg = [0x05, 0x03, 0x00, 0x01, 127, 0, 0, 1, 0, 0x50];
        assert!(matches!(
            parse_connect_request(&msg),
            Err(Socks5Error::UnsupportedCommand(3))
        ));
    }
}