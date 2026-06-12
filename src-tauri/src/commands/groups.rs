use frost_app_core::config::GroupSummary;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[tauri::command]
pub async fn list_groups(state: State<'_, AppState>) -> AppResult<Vec<GroupSummary>> {
    state
        .with_config(|config| {
            config
                .group
                .iter()
                .map(|(id, g)| frost_app_core::config::summarize_group(id, g).map_err(Into::into))
                .collect()
        })
        .await
}

#[tauri::command]
pub async fn remove_group(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state
        .mutate_config(|config| {
            config
                .group
                .remove(&id)
                .map(|_| ())
                .ok_or_else(|| AppError::new("config", "group not found"))
        })
        .await
}
