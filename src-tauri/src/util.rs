use std::time::{SystemTime, UNIX_EPOCH};

/// Current UTC time as unix seconds. Dates cross the IPC boundary as `i64` seconds.
pub fn now_unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
