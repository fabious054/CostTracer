use serde::{Serialize, Serializer};

/// Every command returns `Result<T, AppError>`. `AppError` serializes to a plain string so the
/// webview receives a readable message (the store turns it into a `validationFailed` / notice).
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Message(String),

    #[error(transparent)]
    Keyring(#[from] keyring::Error),

    #[error(transparent)]
    Json(#[from] serde_json::Error),

    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl AppError {
    pub fn msg(m: impl Into<String>) -> Self {
        Self::Message(m.into())
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
