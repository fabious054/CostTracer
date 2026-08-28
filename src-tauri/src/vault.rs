//! Thin wrapper over the OS-native secret store via the `keyring` crate:
//! macOS Keychain, Windows Credential Manager, Linux Secret Service.
//!
//! The stored value is one JSON blob. Windows Credential Manager caps a credential blob at
//! 2560 bytes (UTF-16), which a temporary credential's `session_token` alone can blow past — so
//! the blob is split into fixed-size chunks across sibling entries and reassembled on load.

use keyring::Entry;

use crate::error::{AppError, AppResult};
use crate::model::StoredCredential;

const SERVICE: &str = "com.costtracer.app";
const ACCOUNT: &str = "aws-connection";
/// Well under the Windows 2560-byte (UTF-16) limit; our content is ASCII, so 1 char == 1 UTF-16 unit.
const CHUNK_CHARS: usize = 900;
/// Hard ceiling on chunks (≈14 KB of JSON) — larger than any real credential blob.
const MAX_CHUNKS: usize = 16;

fn entry(account: &str) -> AppResult<Entry> {
    Entry::new(SERVICE, account).map_err(AppError::from)
}

fn chunk_account(index: usize) -> String {
    if index == 0 {
        ACCOUNT.to_string()
    } else {
        format!("{ACCOUNT}-{index}")
    }
}

fn split_chars(s: &str, n: usize) -> Vec<String> {
    let chars: Vec<char> = s.chars().collect();
    if chars.is_empty() {
        return vec![String::new()];
    }
    chars.chunks(n).map(|c| c.iter().collect()).collect()
}

pub fn save(blob: &StoredCredential) -> AppResult<()> {
    let json = serde_json::to_string(blob)?;
    let chunks = split_chars(&json, CHUNK_CHARS);
    if chunks.len() > MAX_CHUNKS {
        return Err(AppError::msg("credential blob is unexpectedly large"));
    }

    // Entry 0 carries the chunk count on its first line, then its own slice of the JSON.
    let first = format!("{}\n{}", chunks.len(), chunks[0]);
    entry(&chunk_account(0))?.set_password(&first)?;
    for (i, chunk) in chunks.iter().enumerate().skip(1) {
        entry(&chunk_account(i))?.set_password(chunk)?;
    }

    // Drop any leftover chunks from a previously larger blob.
    for i in chunks.len()..MAX_CHUNKS {
        match entry(&chunk_account(i))?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(AppError::from(e)),
        }
    }
    Ok(())
}

pub fn load() -> AppResult<Option<StoredCredential>> {
    let first = match entry(&chunk_account(0))?.get_password() {
        Ok(s) => s,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(e) => return Err(AppError::from(e)),
    };

    let (count_line, chunk0) = first
        .split_once('\n')
        .ok_or_else(|| AppError::msg("vault entry is corrupt (no chunk header)"))?;
    let count: usize = count_line
        .trim()
        .parse()
        .map_err(|_| AppError::msg("vault entry is corrupt (bad chunk count)"))?;

    let mut json = String::from(chunk0);
    for i in 1..count {
        match entry(&chunk_account(i))?.get_password() {
            Ok(s) => json.push_str(&s),
            Err(keyring::Error::NoEntry) => {
                return Err(AppError::msg("vault entry is incomplete (missing chunk)"))
            }
            Err(e) => return Err(AppError::from(e)),
        }
    }

    Ok(Some(serde_json::from_str(&json)?))
}

pub fn delete() -> AppResult<()> {
    for i in 0..MAX_CHUNKS {
        match entry(&chunk_account(i))?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(AppError::from(e)),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{split_chars, CHUNK_CHARS};

    #[test]
    fn splits_and_rejoins_losslessly() {
        let original = "x".repeat(CHUNK_CHARS * 3 + 17);
        let chunks = split_chars(&original, CHUNK_CHARS);
        assert_eq!(chunks.len(), 4);
        assert!(chunks.iter().take(3).all(|c| c.chars().count() == CHUNK_CHARS));
        assert_eq!(chunks.concat(), original);
    }

    #[test]
    fn empty_string_is_one_chunk() {
        assert_eq!(split_chars("", CHUNK_CHARS), vec![String::new()]);
    }
}
