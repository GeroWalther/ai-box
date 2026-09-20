// Talking to Anthropic, OpenAI and Google directly, on the user's own keys.
//
// OpenRouter remains the default and is untouched: one key, every model, one
// wire format. This exists for the case OpenRouter cannot serve — credit sitting
// unused on a provider account the user already pays for.
//
// Two of the three speak the OpenAI wire format, so they need nothing but a base
// URL and a header: OpenAI itself, and Google, which publishes an
// OpenAI-compatible endpoint of its own. Anthropic does not, so it gets a real
// translation to and from the Messages API rather than a shim — the shapes
// differ in ways that matter (system prompts are a field, images are a source
// object, tool results are user turns), and pretending otherwise fails at
// exactly the moment a tool is called.

use serde::{Deserialize, Serialize};

/// A provider the user can reach with their own key, rather than through
/// OpenRouter. Model ids carry the prefix, so one string says where to go.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direct {
    Anthropic,
    OpenAi,
    Google,
}

impl Direct {
    pub fn from_prefix(prefix: &str) -> Option<Self> {
        match prefix {
            "anthropic" => Some(Self::Anthropic),
            "openai" => Some(Self::OpenAi),
            "google" => Some(Self::Google),
            _ => None,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::Anthropic => "anthropic",
            Self::OpenAi => "openai",
            Self::Google => "google",
        }
    }

    /// Where chat requests go. Anthropic's is its own API, not a compatibility
    /// endpoint — see `anthropic_chat`.
    pub fn chat_url(self) -> &'static str {
        match self {
            Self::Anthropic => "https://api.anthropic.com/v1/messages",
            Self::OpenAi => "https://api.openai.com/v1/chat/completions",
            Self::Google => "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        }
    }
}

/// Split "anthropic:claude-opus-5" into its provider and its real model id.
/// A bare id belongs to OpenRouter and comes back as `None`.
pub fn split(model: &str) -> (Option<Direct>, String) {
    match model.split_once(':') {
        Some((prefix, rest)) => match Direct::from_prefix(prefix) {
            Some(d) => (Some(d), rest.to_string()),
            // ":free" and the like are part of an OpenRouter id, not a prefix.
            None => (None, model.to_string()),
        },
        None => (None, model.to_string()),
    }
}

/// One model offered by a direct provider.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModel {
    /// Prefixed id, ready to store as the chosen model.
    pub id: String,
    pub name: String,
    /// Takes an image. Screen Assist needs this; chat does not.
    pub sees: bool,
    /// Takes audio in the same request.
    pub hears: bool,
    /// Can call tools, without which the agent and acting are both dead ends.
    pub tools: bool,
}

/// What a provider will serve this key, newest first where the API says so.
///
/// Every one of these is a live call rather than a table baked into the app: a
/// model released next month should appear without a release.
pub async fn list_models(provider: Direct, api_key: &str) -> Result<Vec<ProviderModel>, String> {
    let key = api_key.trim();
    if key.is_empty() {
        return Ok(Vec::new());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    match provider {
        Direct::Anthropic => {
            let resp = client
                .get("https://api.anthropic.com/v1/models?limit=100")
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01")
                .send()
                .await
                .map_err(|e| format!("Request failed: {e}"))?;
            let json = read_json(resp).await?;
            Ok(json["data"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .filter_map(|m| {
                    let id = m["id"].as_str()?;
                    Some(ProviderModel {
                        id: format!("anthropic:{id}"),
                        name: m["display_name"].as_str().unwrap_or(id).to_string(),
                        // Every current Claude model takes images and tools;
                        // none takes audio.
                        sees: true,
                        hears: false,
                        tools: true,
                    })
                })
                .collect())
        }
        Direct::OpenAi => {
            let resp = client
                .get("https://api.openai.com/v1/models")
                .header("Authorization", format!("Bearer {key}"))
                .send()
                .await
                .map_err(|e| format!("Request failed: {e}"))?;
            let json = read_json(resp).await?;
            let mut models: Vec<ProviderModel> = json["data"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .filter_map(|m| {
                    let id = m["id"].as_str()?;
                    // The list mixes in embeddings, speech, moderation and
                    // image models, none of which answer a chat request.
                    if !is_openai_chat_model(id) {
                        return None;
                    }
                    Some(ProviderModel {
                        id: format!("openai:{id}"),
                        name: id.to_string(),
                        sees: true,
                        hears: id.contains("audio") || id.contains("realtime"),
                        tools: true,
                    })
                })
                .collect();
            models.sort_by(|a, b| a.name.cmp(&b.name));
            Ok(models)
        }
        Direct::Google => {
            let resp = client
                .get(format!(
                    "https://generativelanguage.googleapis.com/v1beta/models?key={key}&pageSize=200"
                ))
                .send()
                .await
                .map_err(|e| format!("Request failed: {e}"))?;
            let json = read_json(resp).await?;
            Ok(json["models"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .filter_map(|m| {
                    // "models/gemini-3.7-flash" — the prefix is Google's, not ours.
                    let full = m["name"].as_str()?;
                    let id = full.strip_prefix("models/").unwrap_or(full);
                    let methods = m["supportedGenerationMethods"]
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .filter_map(|x| x.as_str())
                                .any(|x| x == "generateContent")
                        })
                        .unwrap_or(true);
                    if !methods {
                        return None;
                    }
                    Some(ProviderModel {
                        id: format!("google:{id}"),
                        name: m["displayName"].as_str().unwrap_or(id).to_string(),
                        sees: true,
                        // Gemini's multimodal models take audio in the same
                        // request, which is what Screen Assist's push-to-talk
                        // needs.
                        hears: id.contains("gemini"),
                        tools: true,
                    })
                })
                .collect())
        }
    }
}

/// Does this OpenAI id name something that answers a chat request?
fn is_openai_chat_model(id: &str) -> bool {
    const NOT_CHAT: &[&str] = &[
        "embedding", "whisper", "tts", "dall-e", "moderation", "image", "transcribe", "search",
        "davinci", "babbage", "codex-mini",
    ];
    if NOT_CHAT.iter().any(|bad| id.contains(bad)) {
        return false;
    }
    id.starts_with("gpt") || id.starts_with('o') || id.starts_with("chatgpt")
}

async fn read_json(resp: reqwest::Response) -> Result<serde_json::Value, String> {
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(crate::friendly_http_error(status, &text));
    }
    resp.json().await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_prefix_says_where_the_model_lives() {
        assert_eq!(split("anthropic:claude-opus-5").0, Some(Direct::Anthropic));
        assert_eq!(split("anthropic:claude-opus-5").1, "claude-opus-5");
        assert_eq!(split("openai:gpt-5").0, Some(Direct::OpenAi));
        assert_eq!(split("google:gemini-3.7-flash").1, "gemini-3.7-flash");
    }

    #[test]
    fn an_openrouter_id_is_left_alone() {
        // Bare ids, vendor-slashed ids and :free suffixes are all OpenRouter's.
        for id in [
            "google/gemini-3.7-flash",
            "thinkingmachines/inkling:free",
            "gpt-5",
        ] {
            let (provider, model) = split(id);
            assert!(provider.is_none(), "{id} should stay on OpenRouter");
            assert_eq!(model, id);
        }
    }

    #[test]
    fn the_openai_list_keeps_only_models_that_chat() {
        for good in ["gpt-5.2", "gpt-4o", "o3", "chatgpt-4o-latest"] {
            assert!(is_openai_chat_model(good), "{good} should be offered");
        }
        for bad in [
            "text-embedding-3-large",
            "whisper-1",
            "dall-e-3",
            "gpt-4o-transcribe",
            "omni-moderation-latest",
        ] {
            assert!(!is_openai_chat_model(bad), "{bad} should be filtered out");
        }
    }
}

// ---- Anthropic ------------------------------------------------------------

/// One chat completion against Anthropic's Messages API, in and out of the
/// OpenAI shape the rest of the app speaks.
///
/// A translation rather than a compatibility shim, because the shapes differ
/// where it counts: the system prompt is a field and not a message, an image is
/// a source object and not a data URL, a tool result is a USER turn and not a
/// role of its own, and `max_tokens` is required rather than optional. A shim
/// that ignores any of those works until the first tool call and then stops.
pub async fn anthropic_chat(
    api_key: &str,
    model: &str,
    messages: &serde_json::Value,
    tools: &serde_json::Value,
    temperature: f32,
) -> Result<serde_json::Value, String> {
    let (system, turns) = to_anthropic_messages(messages);
    let mut body = serde_json::json!({
        "model": model,
        // Required by this API, unlike OpenAI's. Generous: the caller's own
        // prompt decides the length, and a truncated answer is worse than a
        // slightly larger ceiling.
        "max_tokens": 8192,
        "temperature": temperature,
        "messages": turns,
    });
    if !system.is_empty() {
        body["system"] = serde_json::Value::String(system);
    }
    let tools = to_anthropic_tools(tools);
    if !tools.is_empty() {
        body["tools"] = serde_json::Value::Array(tools);
    }

    let resp = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?
        .post(Direct::Anthropic.chat_url())
        .header("x-api-key", api_key.trim())
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let json = read_json(resp).await?;
    Ok(from_anthropic_message(&json))
}

/// Pull the system prompt out and rewrite every turn into Anthropic's shape.
fn to_anthropic_messages(messages: &serde_json::Value) -> (String, Vec<serde_json::Value>) {
    let mut system = String::new();
    let mut out: Vec<serde_json::Value> = Vec::new();

    for m in messages.as_array().cloned().unwrap_or_default() {
        let role = m["role"].as_str().unwrap_or("user");
        match role {
            // Anthropic takes the system prompt as a field. Several of them are
            // joined rather than dropped — this app sends a second one carrying
            // the state of the Mac.
            "system" => {
                if let Some(text) = m["content"].as_str() {
                    if !system.is_empty() {
                        system.push_str("\n\n");
                    }
                    system.push_str(text);
                }
            }
            // A tool result is a user turn here, not a role of its own.
            "tool" => out.push(serde_json::json!({
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": m["tool_call_id"].as_str().unwrap_or(""),
                    "content": m["content"].as_str().unwrap_or(""),
                }],
            })),
            "assistant" => {
                let mut blocks: Vec<serde_json::Value> = Vec::new();
                if let Some(text) = m["content"].as_str() {
                    if !text.trim().is_empty() {
                        blocks.push(serde_json::json!({ "type": "text", "text": text }));
                    }
                }
                for call in m["tool_calls"].as_array().cloned().unwrap_or_default() {
                    // OpenAI carries arguments as a JSON *string*; Anthropic
                    // wants the object.
                    let args: serde_json::Value = call["function"]["arguments"]
                        .as_str()
                        .and_then(|a| serde_json::from_str(a).ok())
                        .unwrap_or_else(|| serde_json::json!({}));
                    blocks.push(serde_json::json!({
                        "type": "tool_use",
                        "id": call["id"].as_str().unwrap_or(""),
                        "name": call["function"]["name"].as_str().unwrap_or(""),
                        "input": args,
                    }));
                }
                if !blocks.is_empty() {
                    out.push(serde_json::json!({ "role": "assistant", "content": blocks }));
                }
            }
            _ => out.push(serde_json::json!({
                "role": "user",
                "content": to_anthropic_content(&m["content"]),
            })),
        }
    }
    (system, out)
}

/// User content: text as text, a data-URL image as a base64 source, and audio
/// dropped with a note — no Claude model takes it, and silently sending nothing
/// would leave the model answering a question it never heard.
fn to_anthropic_content(content: &serde_json::Value) -> serde_json::Value {
    if let Some(text) = content.as_str() {
        return serde_json::json!([{ "type": "text", "text": text }]);
    }
    let mut blocks: Vec<serde_json::Value> = Vec::new();
    for part in content.as_array().cloned().unwrap_or_default() {
        match part["type"].as_str().unwrap_or("") {
            "text" => blocks.push(serde_json::json!({
                "type": "text",
                "text": part["text"].as_str().unwrap_or(""),
            })),
            "image_url" => {
                let url = part["image_url"]["url"].as_str().unwrap_or("");
                if let Some((media_type, data)) = split_data_url(url) {
                    blocks.push(serde_json::json!({
                        "type": "image",
                        "source": { "type": "base64", "media_type": media_type, "data": data },
                    }));
                } else if !url.is_empty() {
                    blocks.push(serde_json::json!({
                        "type": "image",
                        "source": { "type": "url", "url": url },
                    }));
                }
            }
            "input_audio" => blocks.push(serde_json::json!({
                "type": "text",
                "text": "(The user asked this out loud. This model cannot hear, so the \
recording could not be included — say so rather than guessing at the question.)",
            })),
            _ => {}
        }
    }
    serde_json::Value::Array(blocks)
}

/// "data:image/png;base64,AAAA" → ("image/png", "AAAA")
fn split_data_url(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(',')?;
    let media_type = meta.split(';').next()?.to_string();
    if media_type.is_empty() || data.is_empty() {
        return None;
    }
    Some((media_type, data.to_string()))
}

/// OpenAI's `{type:"function", function:{name, description, parameters}}` →
/// Anthropic's flat `{name, description, input_schema}`.
fn to_anthropic_tools(tools: &serde_json::Value) -> Vec<serde_json::Value> {
    tools
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|t| {
            let f = &t["function"];
            let name = f["name"].as_str()?;
            Some(serde_json::json!({
                "name": name,
                "description": f["description"].as_str().unwrap_or(""),
                "input_schema": if f["parameters"].is_null() {
                    serde_json::json!({ "type": "object", "properties": {} })
                } else {
                    f["parameters"].clone()
                },
            }))
        })
        .collect()
}

/// Anthropic's content blocks → the single assistant message the app expects.
fn from_anthropic_message(reply: &serde_json::Value) -> serde_json::Value {
    let mut text = String::new();
    let mut calls: Vec<serde_json::Value> = Vec::new();

    for block in reply["content"].as_array().cloned().unwrap_or_default() {
        match block["type"].as_str().unwrap_or("") {
            "text" => text.push_str(block["text"].as_str().unwrap_or("")),
            "tool_use" => calls.push(serde_json::json!({
                "id": block["id"].as_str().unwrap_or(""),
                "type": "function",
                "function": {
                    "name": block["name"].as_str().unwrap_or(""),
                    // Back to a JSON string, which is what the OpenAI shape —
                    // and therefore the rest of this app — parses.
                    "arguments": serde_json::to_string(&block["input"]).unwrap_or_else(|_| "{}".into()),
                },
            })),
            // Thinking blocks are not shown: the app has nowhere to put them,
            // and they are not the answer.
            _ => {}
        }
    }

    let mut msg = serde_json::json!({ "role": "assistant", "content": text });
    if !calls.is_empty() {
        msg["tool_calls"] = serde_json::Value::Array(calls);
    }
    msg
}

#[cfg(test)]
mod translation_tests {
    use super::*;

    #[test]
    fn the_system_prompt_becomes_a_field_and_several_are_joined() {
        let msgs = serde_json::json!([
            { "role": "system", "content": "You look at screens." },
            { "role": "system", "content": "Bluetooth is on." },
            { "role": "user", "content": "what is this" },
        ]);
        let (system, turns) = to_anthropic_messages(&msgs);
        assert_eq!(system, "You look at screens.\n\nBluetooth is on.");
        assert_eq!(turns.len(), 1, "only the user turn survives as a message");
        assert_eq!(turns[0]["role"], "user");
    }

    #[test]
    fn a_screenshot_becomes_a_base64_source() {
        let msgs = serde_json::json!([{
            "role": "user",
            "content": [
                { "type": "text", "text": "look" },
                { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAB" } },
            ],
        }]);
        let (_, turns) = to_anthropic_messages(&msgs);
        let img = &turns[0]["content"][1];
        assert_eq!(img["type"], "image");
        assert_eq!(img["source"]["media_type"], "image/png");
        assert_eq!(img["source"]["data"], "AAAB");
    }

    #[test]
    fn audio_is_replaced_by_an_admission_not_dropped() {
        let msgs = serde_json::json!([{
            "role": "user",
            "content": [{ "type": "input_audio", "input_audio": { "data": "AAA", "format": "wav" } }],
        }]);
        let (_, turns) = to_anthropic_messages(&msgs);
        let text = turns[0]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("cannot hear"), "the model must be told: {text}");
    }

    #[test]
    fn a_tool_round_trip_survives_both_directions() {
        // Assistant asks for a tool: arguments are a STRING going in...
        let msgs = serde_json::json!([{
            "role": "assistant",
            "content": null,
            "tool_calls": [{
                "id": "call_1",
                "type": "function",
                "function": { "name": "system", "arguments": "{\"action\":\"bluetooth\"}" },
            }],
        }, {
            "role": "tool",
            "tool_call_id": "call_1",
            "content": "Bluetooth is off.",
        }]);
        let (_, turns) = to_anthropic_messages(&msgs);
        assert_eq!(turns[0]["content"][0]["type"], "tool_use");
        // ...and an OBJECT once translated.
        assert_eq!(turns[0]["content"][0]["input"]["action"], "bluetooth");
        // The result comes back as a user turn, which is the part a shim misses.
        assert_eq!(turns[1]["role"], "user");
        assert_eq!(turns[1]["content"][0]["tool_use_id"], "call_1");

        // ...and coming back, arguments are a string again.
        let reply = serde_json::json!({
            "content": [
                { "type": "text", "text": "Done." },
                { "type": "tool_use", "id": "toolu_9", "name": "system", "input": { "action": "wifi" } },
            ],
        });
        let msg = from_anthropic_message(&reply);
        assert_eq!(msg["content"], "Done.");
        assert_eq!(msg["tool_calls"][0]["function"]["arguments"], "{\"action\":\"wifi\"}");
    }

    #[test]
    fn openai_tools_are_flattened_to_anthropics_shape() {
        let tools = serde_json::json!([{
            "type": "function",
            "function": {
                "name": "click",
                "description": "Click something",
                "parameters": { "type": "object", "properties": { "x": { "type": "number" } } },
            },
        }]);
        let out = to_anthropic_tools(&tools);
        assert_eq!(out[0]["name"], "click");
        assert_eq!(out[0]["input_schema"]["properties"]["x"]["type"], "number");
        assert!(out[0].get("function").is_none(), "must be flat, not nested");
    }
}
