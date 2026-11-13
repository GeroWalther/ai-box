// A chat completion that streams — tool calls included.
//
// `chat_completion` waits for the whole reply before returning, which is right
// for an agent step nobody is watching but wrong for Screen Assist, where the
// reply is spoken: every token of the JSON answer arrived before the first word
// was said. This streams the text as Token events while assembling the same
// assistant message `chat_completion` returns — content plus OpenAI-shaped
// tool_calls — so the caller's agent loop does not change at all.
//
// Tool calls arrive in pieces in both wire formats. OpenAI sends them as
// deltas keyed by `index`, the id and name in the first and the arguments as a
// JSON string spread across the rest. Anthropic opens a `tool_use` block, then
// streams its input as `input_json_delta` fragments. Both are assembled here
// and handed back exactly as the non-streaming call would have.

use std::collections::BTreeMap;

use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{backoff, emit_ev, friendly_http_error, is_transient, providers, EventSink, StreamEvent, MAX_ATTEMPTS};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatStreamParams {
    base_url: String,
    api_key: String,
    model: String,
    messages: Value,
    #[serde(default)]
    tools: Value,
    temperature: f32,
    /// "low", "none"… for models that think before answering; see
    /// `GenerateParams::reasoning`.
    #[serde(default)]
    reasoning: Option<String>,
}

/// Stream a reply, emitting its text as it comes, and return the assembled
/// assistant message (`content`, and `tool_calls` when the model made any).
pub(crate) async fn chat_stream_core(p: ChatStreamParams, sink: &dyn EventSink) -> Result<Value, String> {
    let (direct, bare_model) = providers::split(&p.model);
    let has_tools = p.tools.as_array().map(|a| !a.is_empty()).unwrap_or(false);
    let anthropic = direct == Some(providers::Direct::Anthropic);

    let (url, mut body) = if anthropic {
        let mut body = providers::anthropic_body(&bare_model, &p.messages, &p.tools, p.temperature, 8192);
        body["stream"] = json!(true);
        (providers::Direct::Anthropic.chat_url().to_string(), body)
    } else {
        let url = match direct {
            Some(d) => d.chat_url().to_string(),
            None => format!("{}/chat/completions", p.base_url.trim_end_matches('/')),
        };
        let mut body = json!({
            "model": bare_model,
            "messages": p.messages,
            "temperature": p.temperature,
            "stream": true,
        });
        if has_tools {
            body["tools"] = p.tools.clone();
        }
        (url, body)
    };

    // Reasoning effort, in each provider's dialect, only where it is understood.
    let mut has_effort = false;
    if let Some(effort) = p.reasoning.as_deref().filter(|e| !e.is_empty()) {
        match direct {
            Some(providers::Direct::Google) | Some(providers::Direct::OpenAi) => {
                body["reasoning_effort"] = json!(effort);
                has_effort = true;
            }
            None if url.contains("openrouter.ai") => {
                body["reasoning"] = json!({ "effort": effort });
                has_effort = true;
            }
            _ => {}
        }
    }

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    // Retry the connection only — nothing has been emitted yet, so it is safe.
    let resp = {
        let mut attempt = 0;
        loop {
            attempt += 1;
            let mut req = client.post(&url).json(&body);
            if anthropic {
                req = req
                    .header("x-api-key", p.api_key.trim())
                    .header("anthropic-version", "2023-06-01");
            } else {
                req = req
                    .header("HTTP-Referer", "https://ai-box.local")
                    .header("X-Title", "AI Studio");
                if !p.api_key.is_empty() {
                    req = req.header("Authorization", format!("Bearer {}", p.api_key.trim()));
                }
            }
            match req.send().await {
                Ok(r) if r.status().is_success() => break r,
                Ok(r) => {
                    let s = r.status();
                    if is_transient(s) && attempt < MAX_ATTEMPTS {
                        backoff(attempt).await;
                        continue;
                    }
                    let text = r.text().await.unwrap_or_default();
                    // A model that must think, or will not be told how hard:
                    // ask again with the provider's own default.
                    if has_effort && s == reqwest::StatusCode::BAD_REQUEST {
                        has_effort = false;
                        body.as_object_mut().map(|o| {
                            o.remove("reasoning_effort");
                            o.remove("reasoning")
                        });
                        continue;
                    }
                    return Err(friendly_http_error(s, &text));
                }
                Err(e) => {
                    if attempt < MAX_ATTEMPTS {
                        backoff(attempt).await;
                        continue;
                    }
                    return Err(format!("Request failed: {e}"));
                }
            }
        }
    };

    let mut asm = Assembler::default();
    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();
    // No total timeout on the client, so bound the silence between chunks
    // instead: a stalled connection must not leave the overlay thinking forever.
    let idle = std::time::Duration::from_secs(120);
    'read: loop {
        let chunk = match tokio::time::timeout(idle, stream.next()).await {
            Ok(Some(c)) => c,
            Ok(None) => break,
            Err(_) => return Err("The model stopped responding.".into()),
        };
        let bytes = chunk.map_err(|e| format!("Stream error: {e}"))?;
        buffer.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(nl) = buffer.find('\n') {
            let line = buffer[..nl].trim().to_string();
            buffer.drain(..=nl);
            let Some(data) = line.strip_prefix("data:").map(str::trim) else { continue };
            if data == "[DONE]" {
                break 'read;
            }
            let Ok(ev) = serde_json::from_str::<Value>(data) else { continue };
            let step = if anthropic { asm.feed_anthropic(&ev) } else { asm.feed_openai(&ev) };
            match step {
                Step::Text(t) => emit_ev(sink, StreamEvent::Token { content: t }),
                Step::Stop => break 'read,
                Step::Error(e) => return Err(e),
                Step::Nothing => {}
            }
        }
    }

    // See `chat_completion`: a local model that ran out of room returns 200,
    // nothing, and finish_reason "length".
    if asm.finish.as_deref() == Some("length") && asm.content.trim().is_empty() && asm.calls.is_empty() {
        return Err(crate::ran_out_of_context(&bare_model));
    }
    Ok(asm.message())
}

#[derive(Debug, PartialEq)]
enum Step {
    Text(String),
    Stop,
    Error(String),
    Nothing,
}

#[derive(Default)]
struct Call {
    id: String,
    name: String,
    args: String,
}

/// Collects one streamed reply into the message the rest of the app expects.
#[derive(Default)]
struct Assembler {
    content: String,
    /// By stream index: OpenAI's tool-call index, or Anthropic's block index.
    calls: BTreeMap<u64, Call>,
    finish: Option<String>,
}

impl Assembler {
    fn feed_openai(&mut self, ev: &Value) -> Step {
        if let Some(msg) = ev["error"]["message"].as_str() {
            return Step::Error(msg.to_string());
        }
        let choice = &ev["choices"][0];
        if let Some(f) = choice["finish_reason"].as_str() {
            self.finish = Some(f.to_string());
        }
        let delta = &choice["delta"];
        for tc in delta["tool_calls"].as_array().into_iter().flatten() {
            let i = tc["index"].as_u64().unwrap_or(0);
            let call = self.calls.entry(i).or_default();
            if let Some(id) = tc["id"].as_str().filter(|s| !s.is_empty()) {
                call.id = id.to_string();
            }
            if let Some(name) = tc["function"]["name"].as_str().filter(|s| !s.is_empty()) {
                call.name.push_str(name);
            }
            if let Some(a) = tc["function"]["arguments"].as_str() {
                call.args.push_str(a);
            }
        }
        match delta["content"].as_str() {
            Some(t) if !t.is_empty() => {
                self.content.push_str(t);
                Step::Text(t.to_string())
            }
            _ => Step::Nothing,
        }
    }

    fn feed_anthropic(&mut self, ev: &Value) -> Step {
        let i = ev["index"].as_u64().unwrap_or(0);
        match ev["type"].as_str().unwrap_or("") {
            "content_block_start" if ev["content_block"]["type"] == "tool_use" => {
                self.calls.insert(
                    i,
                    Call {
                        id: ev["content_block"]["id"].as_str().unwrap_or("").to_string(),
                        name: ev["content_block"]["name"].as_str().unwrap_or("").to_string(),
                        args: String::new(),
                    },
                );
                Step::Nothing
            }
            "content_block_delta" => match ev["delta"]["type"].as_str().unwrap_or("") {
                "text_delta" => {
                    let t = ev["delta"]["text"].as_str().unwrap_or("");
                    if t.is_empty() {
                        return Step::Nothing;
                    }
                    self.content.push_str(t);
                    Step::Text(t.to_string())
                }
                "input_json_delta" => {
                    if let Some(call) = self.calls.get_mut(&i) {
                        call.args.push_str(ev["delta"]["partial_json"].as_str().unwrap_or(""));
                    }
                    Step::Nothing
                }
                _ => Step::Nothing,
            },
            "message_delta" => {
                if let Some(r) = ev["delta"]["stop_reason"].as_str() {
                    // Anthropic's "max_tokens" is OpenAI's "length".
                    self.finish = Some(if r == "max_tokens" { "length".into() } else { r.into() });
                }
                Step::Nothing
            }
            "message_stop" => Step::Stop,
            "error" => Step::Error(
                ev["error"]["message"].as_str().unwrap_or("The model stopped with an error").to_string(),
            ),
            _ => Step::Nothing,
        }
    }

    fn message(self) -> Value {
        let mut msg = json!({ "role": "assistant", "content": self.content });
        let calls: Vec<Value> = self
            .calls
            .into_values()
            .filter(|c| !c.name.is_empty())
            .enumerate()
            .map(|(n, c)| {
                json!({
                    // Some local servers never send an id; the loop still has
                    // to pair each result with its call.
                    "id": if c.id.is_empty() { format!("call_{n}") } else { c.id },
                    "type": "function",
                    "function": {
                        "name": c.name,
                        "arguments": if c.args.trim().is_empty() { "{}".to_string() } else { c.args },
                    },
                })
            })
            .collect();
        if !calls.is_empty() {
            msg["tool_calls"] = Value::Array(calls);
        }
        msg
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_text_and_tool_call_deltas_assemble_into_one_message() {
        let mut a = Assembler::default();
        let evs = [
            json!({"choices":[{"delta":{"content":"Clicking "}}]}),
            json!({"choices":[{"delta":{"content":"now"}}]}),
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"click","arguments":""}}]}}]}),
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"x\":"}}]}}]}),
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"10}"}}]}}]}),
            json!({"choices":[{"delta":{},"finish_reason":"tool_calls"}]}),
        ];
        let texts: Vec<Step> = evs.iter().map(|e| a.feed_openai(e)).collect();
        assert_eq!(texts[0], Step::Text("Clicking ".into()));
        let m = a.message();
        assert_eq!(m["content"], "Clicking now");
        assert_eq!(m["tool_calls"][0]["id"], "c1");
        assert_eq!(m["tool_calls"][0]["function"]["name"], "click");
        assert_eq!(m["tool_calls"][0]["function"]["arguments"], "{\"x\":10}");
    }

    #[test]
    fn anthropic_tool_use_blocks_assemble_into_openai_tool_calls() {
        let mut a = Assembler::default();
        let evs = [
            json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"On it."}}),
            json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"system","input":{}}}),
            json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"action\":"}}),
            json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"bluetooth\"}"}}),
            json!({"type":"message_delta","delta":{"stop_reason":"tool_use"}}),
        ];
        for e in &evs {
            a.feed_anthropic(e);
        }
        assert_eq!(a.feed_anthropic(&json!({"type":"message_stop"})), Step::Stop);
        let m = a.message();
        assert_eq!(m["content"], "On it.");
        assert_eq!(m["tool_calls"][0]["id"], "tu_1");
        assert_eq!(m["tool_calls"][0]["function"]["arguments"], "{\"action\":\"bluetooth\"}");
    }

    #[test]
    fn a_plain_answer_has_no_tool_calls_and_missing_ids_are_filled() {
        let mut a = Assembler::default();
        a.feed_openai(&json!({"choices":[{"delta":{"content":"{\"say\":\"hi\"}"}}]}));
        assert!(a.message().get("tool_calls").is_none());

        let mut b = Assembler::default();
        b.feed_openai(&json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"scroll"}}]}}]}));
        let m = b.message();
        assert_eq!(m["tool_calls"][0]["id"], "call_0");
        assert_eq!(m["tool_calls"][0]["function"]["arguments"], "{}");
    }

    #[test]
    fn errors_inside_the_stream_surface_as_errors() {
        let mut a = Assembler::default();
        assert_eq!(
            a.feed_openai(&json!({"error":{"message":"Rate limited"}})),
            Step::Error("Rate limited".into())
        );
        assert_eq!(
            a.feed_anthropic(&json!({"type":"error","error":{"message":"Overloaded"}})),
            Step::Error("Overloaded".into())
        );
    }
}
