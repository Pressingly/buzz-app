//! The Askii models a key can run, for the bundled goose's model picker, a
//! Pressingly fork addition. goose lists LiteLLM models through `/model/info`
//! within a fixed 5 s, which Askii's full metadata outlasts; `/v1/models`
//! carries the names alone. The host is the compiled `BUZZ_BUILD_ASKII_URL`,
//! never one the frontend passes, so a key only ever goes to Askii.
use std::time::Duration;

use serde::Deserialize;

const TIMEOUT: Duration = Duration::from_secs(20);
const MAX_BODY: usize = 2 * 1024 * 1024;

fn models_url() -> Option<String> {
    option_env!("BUZZ_BUILD_ASKII_URL")
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .map(|url| format!("{}/v1/models", url.trim_end_matches('/')))
}

#[derive(Deserialize)]
struct ModelList {
    data: Vec<ListedModel>,
}

#[derive(Deserialize)]
struct ListedModel {
    id: String,
}

/// The distinct model IDs in an OpenAI-style model list, sorted.
fn model_ids(body: &[u8]) -> Result<Vec<String>, String> {
    let list: ModelList =
        serde_json::from_slice(body).map_err(|_| "Askii returned an unreadable model list")?;
    let mut ids: Vec<String> = list
        .data
        .into_iter()
        .map(|model| model.id.trim().to_owned())
        .filter(|id| !id.is_empty())
        .collect();
    ids.sort();
    ids.dedup();
    Ok(ids)
}

async fn read_bounded(mut response: reqwest::Response) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Askii's model list was cut off")?
    {
        if body.len() + chunk.len() > MAX_BODY {
            return Err("Askii's model list is too large".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// The models `key` can run on the build's Askii, or none in a build without
/// one.
#[tauri::command]
pub(crate) async fn askii_models(key: String) -> Result<Vec<String>, String> {
    let Some(url) = models_url() else {
        return Ok(Vec::new());
    };
    if !crate::askii_key::valid_key(&key) {
        return Err("The Askii key is not valid".into());
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(TIMEOUT)
        .build()
        .map_err(|_| "Askii's model list is unavailable")?;
    let response = client
        .get(url)
        .bearer_auth(key)
        .send()
        .await
        .map_err(|_| "Askii did not answer for its model list")?;
    if !response.status().is_success() {
        return Err(format!(
            "Askii's model list answered {}",
            response.status().as_u16()
        ));
    }
    model_ids(&read_bounded(response).await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_distinct_ids_in_order() {
        let body = br#"{"object":"list","data":[{"id":"gpt-5-mini","object":"model"},{"id":"claude-sonnet-4-5"},{"id":"gpt-5-mini"},{"id":"  "}]}"#;
        assert_eq!(
            model_ids(body).unwrap(),
            vec!["claude-sonnet-4-5".to_owned(), "gpt-5-mini".to_owned()]
        );
    }

    #[test]
    fn refuses_a_body_that_is_not_a_model_list() {
        assert!(model_ids(b"<html>sign in</html>").is_err());
        assert!(model_ids(br#"{"error":"nope"}"#).is_err());
    }
}
