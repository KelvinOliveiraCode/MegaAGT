mod api;

use api::Api;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

/// Estado compartilhado: cliente da API (com diretório de trabalho) e o
/// diretório atualmente selecionado.
struct AppState {
    inner: Mutex<Inner>,
}

struct Inner {
    api: Option<Api>,
    directory: Option<String>,
}

impl AppState {
    fn ensure(&self) -> anyhow::Result<Api> {
        let mut guard = self.inner.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        if let Some(api) = guard.api.as_ref() {
            return Ok(api.clone());
        }
        let info = api::discover_service()?;
        let api = Api::with_directory(&info, guard.directory.clone());
        guard.api = Some(api.clone());
        Ok(api)
    }

    fn directory(&self) -> Option<String> {
        self.inner.lock().ok().and_then(|g| g.directory.clone())
    }

    fn set_directory(&self, directory: Option<String>) -> anyhow::Result<()> {
        let mut guard = self.inner.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        guard.directory = directory.filter(|d| !d.trim().is_empty());
        guard.api = None;
        Ok(())
    }

    fn invalidate(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.api = None;
        }
    }
}

/// Executa uma chamada a API. Em 401 (servico reiniciado) redescobre o
/// servico e tenta mais uma vez.
async fn run<F, Fut>(state: &State<'_, AppState>, f: F) -> Result<Value, String>
where
    F: Fn(Api) -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<Value>>,
{
    let api = state.ensure().map_err(|e| e.to_string())?;
    match f(api.clone()).await {
        Ok(v) => Ok(v),
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("401") {
                state.invalidate();
                let api2 = state.ensure().map_err(|e| e.to_string())?;
                f(api2).await.map_err(|e| e.to_string())
            } else {
                Err(msg)
            }
        }
    }
}

// ---------------- servico ----------------

#[tauri::command(rename_all = "snake_case")]
async fn service_status(state: State<'_, AppState>) -> Result<Value, String> {
    let result = run(&state, |api| async move {
        let info = api.get("/api/info").await?;
        Ok(json!({
            "connected": true,
            "url": api.base(),
            "directory": api.directory(),
            "info": info
        }))
    })
    .await;
    match result {
        Ok(v) => Ok(v),
        Err(e) => Ok(json!({
            "connected": false,
            "url": "",
            "directory": state.directory(),
            "error": e
        })),
    }
}

#[tauri::command(rename_all = "snake_case")]
async fn start_service(state: State<'_, AppState>) -> Result<Value, String> {
    api::start_service().map_err(|e| e.to_string())?;
    for _ in 0..24 {
        tokio::time::sleep(Duration::from_millis(600)).await;
        if let Ok(info) = api::discover_service() {
            state.invalidate();
            let api = Api::with_directory(&info, state.directory());
            if api.get("/api/info").await.is_ok() {
                return Ok(json!({
                    "connected": true,
                    "url": api.base(),
                    "directory": api.directory()
                }));
            }
        }
    }
    Err("o serviço não ficou pronto a tempo. Abra o OpenCode uma vez e tente de novo.".to_string())
}

/// Espera o servico responder. Retorna o estado quando responde.
async fn aguardar_servico(state: &State<'_, AppState>, tentativas: u32) -> Option<Value> {
    for _ in 0..tentativas {
        tokio::time::sleep(Duration::from_millis(600)).await;
        if let Ok(info) = api::discover_service() {
            state.invalidate();
            let api = Api::with_directory(&info, state.directory());
            if let Ok(v) = api.get("/api/info").await {
                return Some(json!({
                    "connected": true,
                    "url": api.base(),
                    "directory": api.directory(),
                    "info": v
                }));
            }
        }
    }
    None
}

/// Garante o servico no ar: se ja responde, nao faz nada.
///
/// Usado na abertura do app. Antes so havia `start_service`, que exigia um
/// clique — e que, alem disso, nunca funcionou porque nao achava o executavel
/// do CLI (ver `api::opencode_bin`).
#[tauri::command(rename_all = "snake_case")]
async fn ensure_service(state: State<'_, AppState>) -> Result<Value, String> {
    if let Some(v) = aguardar_servico(&state, 1).await {
        return Ok(v);
    }
    api::start_service().map_err(|e| e.to_string())?;
    aguardar_servico(&state, 30)
        .await
        .ok_or_else(|| "o serviço não ficou pronto a tempo.".to_string())
}

/// Reinicia o servico: derruba e sobe de novo, esperando ficar pronto.
#[tauri::command(rename_all = "snake_case")]
async fn restart_service(state: State<'_, AppState>) -> Result<Value, String> {
    api::restart_service().map_err(|e| e.to_string())?;
    aguardar_servico(&state, 40)
        .await
        .ok_or_else(|| "o serviço não voltou a tempo.".to_string())
}

/// Interrompe o servico em segundo plano.
#[tauri::command(rename_all = "snake_case")]
async fn stop_service(state: State<'_, AppState>) -> Result<Value, String> {
    api::stop_service().map_err(|e| e.to_string())?;
    state.invalidate();
    Ok(json!({ "connected": false }))
}

/// Diagnostico do servico: onde esta o registro, se existe, onde esta o
/// executavel do CLI, e se o servico responde.
#[tauri::command(rename_all = "snake_case")]
async fn service_diagnostics(state: State<'_, AppState>) -> Result<Value, String> {
    let registro = api::registration_file();
    let registro_existe = registro.as_ref().map(|p| p.is_file()).unwrap_or(false);
    let bin = api::opencode_bin();
    let servico = api::discover_service().ok();

    let (connected, url, info) = match &servico {
        Some(info) => {
            let api = Api::new(info);
            match api.get("/api/info").await {
                Ok(v) => (true, api.base().to_string(), v),
                Err(e) => (false, api.base().to_string(), json!({ "erro": e.to_string() })),
            }
        }
        None => (false, String::new(), json!({})),
    };

    Ok(json!({
        "connected": connected,
        "url": url,
        "info": info,
        "directory": state.directory(),
        "registro": registro.map(|p| p.to_string_lossy().to_string()),
        "registroExiste": registro_existe,
        "cliPath": bin.as_ref().map(|p| p.to_string_lossy().to_string()),
        "cliNoPath": bin.is_some(),
    }))
}

/// Versao do CLI. Lento (spawna um processo) entao nao entra em service_diagnostics.
#[tauri::command(rename_all = "snake_case")]
async fn cli_version() -> Result<Value, String> {
    Ok(json!({ "version": api::cli_version() }))
}

/// Seleciona o diretório de trabalho. Ausente volta para "todos os diretórios".
#[tauri::command(rename_all = "snake_case")]
async fn set_directory(
    state: State<'_, AppState>,
    directory: Option<String>,
) -> Result<Value, String> {
    state
        .set_directory(directory.clone())
        .map_err(|e| e.to_string())?;
    Ok(json!({ "directory": directory }))
}

/// Localização padrão do serviço: o diretório em que o `opencode service`
/// foi publicado e o projeto correspondente. E' o mesmo par que o CLI usa
/// para `opencode session list`.
#[tauri::command(rename_all = "snake_case")]
async fn default_location(state: State<'_, AppState>) -> Result<Value, String> {
    run(&state, |api| async move { api.get("/api/location").await }).await
}

#[tauri::command(rename_all = "snake_case")]
async fn list_projects(state: State<'_, AppState>) -> Result<Value, String> {
    run(&state, |api| async move {
        let v = api.get("/api/project").await?;
        Ok(json!({ "data": v }))
    })
    .await
}

// ---------------- sessões ----------------

/// Lista as sessões do **projeto** do diretório de trabalho, como o CLI faz.
/// Sem diretório definido, devolve todas as sessões conhecidas.
#[tauri::command(rename_all = "snake_case")]
async fn list_sessions(state: State<'_, AppState>) -> Result<Value, String> {
    let directory = state.directory();
    run(&state, move |api| {
        let api = api.with_dir(directory.clone());
        let dir = directory.clone();
        async move {
            let mut query: Vec<(&str, String)> = Vec::new();
            if let Some(dir) = dir {
                // /api/location resolve o projeto do diretório; o filtro
                // "project" e' o que reproduz a lista do CLI (o filtro
                // "directory" ainda traz sessões de projetos "global").
                if let Ok(loc) = api.get("/api/location").await {
                    if let Some(pid) = loc["project"]["id"].as_str() {
                        query.push(("project", pid.to_string()));
                    }
                } else {
                    query.push(("directory", dir));
                }
            }
            let items = api::paginate_get(&api, "/api/session", &query).await?;
            Ok(json!({ "data": items }))
        }
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
async fn get_session(state: State<'_, AppState>, session_id: String) -> Result<Value, String> {
    run(&state, move |api| {
        let session_id = session_id.clone();
        async move { api.get(&format!("/api/session/{}", session_id)).await }
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
async fn create_session(
    state: State<'_, AppState>,
    title: Option<String>,
    agent: Option<String>,
    model: Option<String>,
    directory: Option<String>,
) -> Result<Value, String> {
    let workdir = state
        .directory()
        .or_else(|| directory.filter(|d| !d.trim().is_empty()));
    run(&state, move |api| {
        let api = api.with_dir(workdir.clone());
        let title = title.clone();
        let agent = agent.clone();
        let model = model.clone();
        let dir = workdir.clone();
        async move {
            let mut body = json!({});
            if let Some(t) = title.filter(|t| !t.trim().is_empty()) {
                body["title"] = json!(t);
            }
            if let Some(a) = agent.filter(|a| !a.trim().is_empty()) {
                body["agent"] = json!(a);
            }
            if let Some(m) = model.filter(|m| !m.trim().is_empty()) {
                body["model"] = api::parse_model_ref(&m);
            }
            // O header x-opencode-directory nao define o local da nova sessão:
            // o servidor usa `location.directory` do corpo. Sem isso a sessão
            // nasce no diretório padrão do servico e some da lista do projeto.
            if let Some(d) = dir {
                body["location"] = json!({ "directory": d });
            }
            api.post("/api/session", body).await
        }
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
async fn rename_session(
    state: State<'_, AppState>,
    session_id: String,
    title: String,
) -> Result<Value, String> {
    run(&state, move |api| {
        let session_id = session_id.clone();
        let title = title.clone();
        async move {
            api.patch(
                &format!("/api/session/{}", session_id),
                json!({ "title": title }),
            )
            .await
        }
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
async fn delete_session(state: State<'_, AppState>, session_id: String) -> Result<Value, String> {
    run(&state, move |api| {
        let session_id = session_id.clone();
        async move { api.delete(&format!("/api/session/{}", session_id)).await }
    })
    .await
}

/// Exclusao em lote, usada pela selecao multipla da barra lateral.
/// Devolve o que foi removido e o que falhou.
#[tauri::command(rename_all = "snake_case")]
async fn delete_sessions(
    state: State<'_, AppState>,
    session_ids: Vec<String>,
) -> Result<Value, String> {
    if session_ids.is_empty() {
        return Ok(json!({ "deleted": [], "failed": [] }));
    }
    let mut deleted = Vec::new();
    let mut failed: Vec<Value> = Vec::new();
    for id in session_ids {
        let target = id.clone();
        let outcome = run(&state, move |api| {
            let target = target.clone();
            async move { api.delete(&format!("/api/session/{}", target)).await }
        })
        .await;
        match outcome {
            Ok(_) => deleted.push(id),
            Err(e) => failed.push(json!({ "id": id, "error": e })),
        }
    }
    Ok(json!({ "deleted": deleted, "failed": failed }))
}

#[tauri::command(rename_all = "snake_case")]
async fn list_messages(state: State<'_, AppState>, session_id: String) -> Result<Value, String> {
    run(&state, move |api| {
        let session_id = session_id.clone();
        async move {
            // Sem `order=asc`: o servidor devolve da mais nova para a mais
            // antiga e rejeita cursor combinado com order
            // ("Cursor cannot be combined with order"). A ordenacao
            // cronologica e' feita no frontend, que também cobre o eco local
            // e as mensagens em streaming.
            let items =
                api::paginate_get(&api, &format!("/api/session/{}/message", session_id), &[])
                    .await?;
            Ok(json!({ "data": items }))
        }
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
async fn send_prompt(
    state: State<'_, AppState>,
    session_id: String,
    text: String,
) -> Result<Value, String> {
    run(&state, move |api| {
        let session_id = session_id.clone();
        let text = text.clone();
        async move {
            api.post(
                &format!("/api/session/{}/prompt", session_id),
                json!({ "text": text }),
            )
            .await
        }
    })
    .await
}

/// Executa um slash command do projeto.
#[tauri::command(rename_all = "snake_case")]
async fn run_command(
    state: State<'_, AppState>,
    session_id: String,
    name: String,
    text: String,
) -> Result<Value, String> {
    run(&state, move |api| {
        let session_id = session_id.clone();
        let name = name.clone();
        let text = text.clone();
        async move {
            api.post(
                &format!("/api/session/{}/command", session_id),
                json!({ "name": name.trim_start_matches('/'), "text": text }),
            )
            .await
        }
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
async fn interrupt_session(state: State<'_, AppState>, session_id: String) -> Result<Value, String> {
    run(&state, move |api| {
        let session_id = session_id.clone();
        async move {
            api.post(
                &format!("/api/session/{}/interrupt", session_id),
                json!({}),
            )
            .await
        }
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
async fn compact_session(state: State<'_, AppState>, session_id: String) -> Result<Value, String> {
    run(&state, move |api| {
        let session_id = session_id.clone();
        async move {
            api.post(&format!("/api/session/{}/compact", session_id), json!({}))
                .await
        }
    })
    .await
}

/// Bifurca a sessão. Com `before`, copia o histórico anterior a essa mensagem.
#[tauri::command(rename_all = "snake_case")]
async fn fork_session(
    state: State<'_, AppState>,
    session_id: String,
    before: Option<String>,
) -> Result<Value, String> {
    run(&state, move |api| {
        let session_id = session_id.clone();
        let before = before.clone();
        async move {
            let mut body = json!({});
            if let Some(b) = before.filter(|b| !b.trim().is_empty()) {
                body["before"] = json!(b);
            }
            api.post(&format!("/api/session/{}/fork", session_id), body)
                .await
        }
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
async fn move_session(
    state: State<'_, AppState>,
    session_id: String,
    directory: String,
) -> Result<Value, String> {
    run(&state, move |api| {
        let session_id = session_id.clone();
        let directory = directory.clone();
        async move {
            api.post(
                &format!("/api/session/{}/move", session_id),
                json!({ "directory": directory }),
            )
            .await
        }
    })
    .await
}

// ---------------- revert ----------------

#[tauri::command(rename_all = "snake_case")]
async fn stage_revert(
    state: State<'_, AppState>,
    session_id: String,
    message_id: String,
) -> Result<Value, String> {
    run(&state, move |api| {
        let session_id = session_id.clone();
        let message_id = message_id.clone();
        async move {
            api.post(
                &format!("/api/session/{}/revert/stage", session_id),
                json!({ "messageID": message_id }),
            )
            .await
        }
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
async fn commit_revert(state: State<'_, AppState>, session_id: String) -> Result<Value, String> {
    run(&state, move |api| {
        let session_id = session_id.clone();
        async move {
            api.post(&format!("/api/session/{}/revert/commit", session_id), json!({}))
                .await
        }
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
async fn clear_revert(state: State<'_, AppState>, session_id: String) -> Result<Value, String> {
    run(&state, move |api| {
        let session_id = session_id.clone();
        async move { api.delete(&format!("/api/session/{}/revert", session_id)).await }
    })
    .await
}

// ---------------- modelos / agentes / comandos ----------------

#[tauri::command(rename_all = "snake_case")]
async fn list_models(state: State<'_, AppState>) -> Result<Value, String> {
    run(&state, |api| async move { api.get("/api/model").await }).await
}

#[tauri::command(rename_all = "snake_case")]
async fn list_agents(state: State<'_, AppState>) -> Result<Value, String> {
    run(&state, |api| async move { api.get("/api/agent").await }).await
}

/// Slash commands disponiveis no diretório de trabalho atual.
#[tauri::command(rename_all = "snake_case")]
async fn list_commands(state: State<'_, AppState>) -> Result<Value, String> {
    run(&state, |api| async move { api.get("/api/command").await }).await
}

/// Skills disponiveis no diretório de trabalho atual.
#[tauri::command(rename_all = "snake_case")]
async fn list_skills(state: State<'_, AppState>) -> Result<Value, String> {
    run(&state, |api| async move { api.get("/api/skill").await }).await
}

#[tauri::command(rename_all = "snake_case")]
async fn switch_model(
    state: State<'_, AppState>,
    session_id: String,
    model: String,
) -> Result<Value, String> {
    run(&state, move |api| {
        let session_id = session_id.clone();
        let model = model.clone();
        async move {
            api.post(
                &format!("/api/session/{}/model", session_id),
                json!({ "model": api::parse_model_ref(&model) }),
            )
            .await
        }
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
async fn switch_agent(
    state: State<'_, AppState>,
    session_id: String,
    agent: String,
) -> Result<Value, String> {
    run(&state, move |api| {
        let session_id = session_id.clone();
        let agent = agent.clone();
        async move {
            api.post(
                &format!("/api/session/{}/agent", session_id),
                json!({ "agent": agent }),
            )
            .await
        }
    })
    .await
}

// ---------------- inspecao ----------------

/// Arquivos alterados pela sessão, com contagem de linhas.
#[tauri::command(rename_all = "snake_case")]
async fn session_diff(state: State<'_, AppState>, session_id: String) -> Result<Value, String> {
    run(&state, move |api| {
        let session_id = session_id.clone();
        async move { api.get(&format!("/api/session/{}/diff", session_id)).await }
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
async fn session_stats(state: State<'_, AppState>) -> Result<Value, String> {
    run(&state, |api| async move { api.get("/api/experimental/session/stats").await }).await
}

/// Sessões com execucao em andamento.
#[tauri::command(rename_all = "snake_case")]
async fn active_sessions(state: State<'_, AppState>) -> Result<Value, String> {
    run(&state, |api| async move { api.get("/api/session/active").await }).await
}

/// Status do controle de versão do diretório de trabalho.
#[tauri::command(rename_all = "snake_case")]
async fn vcs_status(state: State<'_, AppState>) -> Result<Value, String> {
    run(&state, |api| async move { api.get("/api/vcs/status").await }).await
}

/// Pedidos de permissao aguardando resposta na sessão.
#[tauri::command(rename_all = "snake_case")]
async fn session_permissions(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Value, String> {
    run(&state, move |api| {
        let session_id = session_id.clone();
        async move { api.get(&format!("/api/session/{}/permission", session_id)).await }
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
async fn reply_permission(
    state: State<'_, AppState>,
    session_id: String,
    request_id: String,
    decision: String,
    message: Option<String>,
) -> Result<Value, String> {
    run(&state, move |api| {
        let session_id = session_id.clone();
        let request_id = request_id.clone();
        let mut body = json!({ "decision": decision });
        if let Some(m) = message.clone().filter(|m| !m.trim().is_empty()) {
            body["message"] = json!(m);
        }
        async move {
            api.post(
                &format!("/api/session/{}/permission/{}/reply", session_id, request_id),
                body,
            )
            .await
        }
    })
    .await
}

/// Marca a transicao de ociosidade como vista pelo visualizador.
#[tauri::command(rename_all = "snake_case")]
async fn mark_viewed(
    state: State<'_, AppState>,
    session_id: String,
    idle: f64,
) -> Result<Value, String> {
    run(&state, move |api| {
        let session_id = session_id.clone();
        async move {
            api.post(
                &format!("/api/session/{}/view", session_id),
                json!({ "idle": idle }),
            )
            .await
        }
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
async fn get_session_log(state: State<'_, AppState>, session_id: String) -> Result<Value, String> {
    run(&state, move |api| {
        let session_id = session_id.clone();
        async move { api.get(&format!("/api/experimental/session/{}/log", session_id)).await }
    })
    .await
}

// ---------------- exportação ----------------

fn downloads_dir() -> Option<PathBuf> {
    let home = std::env::var("USERPROFILE").ok().map(PathBuf::from)?;
    let known = home.join("Downloads");
    if known.is_dir() {
        return Some(known);
    }
    let docs = home.join("Documents");
    if docs.is_dir() {
        return Some(docs);
    }
    Some(home)
}

fn safe_file_stem(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "sessão".to_string()
    } else {
        trimmed.chars().take(60).collect()
    }
}

/// Converte o JSON de exportação em Markdown legivel.
fn export_to_markdown(data: &Value) -> String {
    let info = &data["info"];
    let mut out = String::new();
    let title = info["title"].as_str().unwrap_or("Sessão");
    out.push_str(&format!("# {}\n\n", title.trim()));
    out.push_str(&format!("- id: `{}`\n", info["id"].as_str().unwrap_or("")));
    if let Some(agent) = info["agent"].as_str() {
        out.push_str(&format!("- agente: {}\n", agent));
    }
    if let Some(model) = info["model"].as_str() {
        out.push_str(&format!("- modelo: {}\n", model));
    }
    if let Some(dir) = info["location"]["directory"].as_str() {
        out.push_str(&format!("- diretório: `{}`\n", dir));
    }
    let tokens = &info["tokens"];
    out.push_str(&format!(
        "- tokens: entrada {}, saída {}, raciocínio {}\n",
        tokens["input"].as_u64().unwrap_or(0),
        tokens["output"].as_u64().unwrap_or(0),
        tokens["reasoning"].as_u64().unwrap_or(0),
    ));
    out.push_str(&format!(
        "- custo: ${:.4}\n\n",
        info["cost"].as_f64().unwrap_or(0.0)
    ));

    if let Some(messages) = data["messages"].as_array() {
        for m in messages {
            let role = m["type"].as_str().unwrap_or("");
            if role == "user" {
                out.push_str("## você\n\n");
                if let Some(t) = m["text"].as_str() {
                    out.push_str(t.trim());
                }
                out.push_str("\n\n");
                continue;
            }
            if role != "assistant" {
                continue;
            }
            out.push_str("## assistente\n\n");
            if let Some(parts) = m["content"].as_array() {
                for p in parts {
                    match p["type"].as_str().unwrap_or("") {
                        "text" => {
                            if let Some(t) = p["text"].as_str() {
                                let t = t.trim();
                                if !t.is_empty() {
                                    out.push_str(t);
                                    out.push_str("\n\n");
                                }
                            }
                        }
                        "reasoning" => {
                            let t = p["text"].as_str().unwrap_or("").trim();
                            if !t.is_empty() {
                                out.push_str("<details><summary>raciocínio</summary>\n\n");
                                out.push_str(t);
                                out.push_str("\n\n</details>\n\n");
                            }
                        }
                        "tool" => {
                            let name = p["name"].as_str().unwrap_or("ferramenta");
                            let status = p["state"]["status"].as_str().unwrap_or("");
                            out.push_str(&format!(
                                "> ferramenta **{}** — {}\n\n",
                                name, status
                            ));
                        }
                        _ => {}
                    }
                }
            }
        }
    }
    out
}

/// Exporta a sessão para disco. `format` = "json" | "markdown".
/// Retorna o caminho gravado.
#[tauri::command(rename_all = "snake_case")]
async fn export_session(
    state: State<'_, AppState>,
    session_id: String,
    format: Option<String>,
) -> Result<Value, String> {
    let fmt = format.unwrap_or_else(|| "markdown".to_string());
    let sid = session_id.clone();
    let raw = run(&state, move |api| {
        let session_id = sid.clone();
        async move {
            api.get(&format!("/api/experimental/session/{}/export", session_id))
                .await
        }
    })
    .await?;

    let payload = &raw["data"];
    let (ext, contents) = if fmt == "json" {
        let text = serde_json::to_string_pretty(payload).map_err(|e| e.to_string())?;
        ("json", text)
    } else {
        ("md", export_to_markdown(payload))
    };

    let dir = downloads_dir().ok_or_else(|| "nao foi possível localizar a pasta do usuário".to_string())?;
    let stem = safe_file_stem(
        payload["info"]["title"]
            .as_str()
            .filter(|t| !t.trim().is_empty())
            .unwrap_or(&session_id),
    );
    let path = dir.join(format!("{}.{}", stem, ext));
    std::fs::write(&path, contents)
        .map_err(|e| format!("falha ao gravar {}: {}", path.display(), e))?;
    Ok(json!({ "path": path.to_string_lossy(), "format": ext }))
}

/// Abre uma URL no navegador padrão do usuário.
///
/// O WebView2 do Tauri nao navega para fora: links clicados em respostas
/// precisam ser abertos pelo sistema. O esquema e' validado para nao abrir
/// `file://`, `javascript:` ou outros URIs inesperados.
#[tauri::command(rename_all = "snake_case")]
fn open_external(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    let lowered = trimmed.to_ascii_lowercase();
    if !(lowered.starts_with("http://")
        || lowered.starts_with("https://")
        || lowered.starts_with("mailto:"))
    {
        return Err("esquema de URL nao permitido".to_string());
    }
    // rundll32 url.dll,FileProtocolHandler e' a forma nativa de delegar ao
    // manipulador padrão sem passar por um shell (evita problema de aspas).
    std::process::Command::new("rundll32")
        .arg("url.dll,FileProtocolHandler")
        .arg(trimmed)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Abre uma pasta no Explorador de Arquivos.
#[tauri::command(rename_all = "snake_case")]
fn open_folder(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("a pasta não existe: {}", path));
    }
    if !p.is_dir() {
        // arquivo: abre a pasta que o contem, com o arquivo selecionado
        let parent = p.parent().map(|x| x.to_string_lossy().to_string());
        return match parent {
            Some(dir) => open_folder(dir),
            None => Err("caminho inválido".to_string()),
        };
    }
    std::process::Command::new("explorer")
        .arg(path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Abre o explorador de arquivos com o arquivo selecionado.
#[tauri::command(rename_all = "snake_case")]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(format!("/select,{}", path))
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------- stream de eventos ----------------

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Estado do stream, reportado ao frontend para que a visao de eventos
/// distinga "conectado e silencioso" de "desconectado".
fn emit_stream(app: &AppHandle, state: &str, attempt: u32, detail: Option<&str>) {
    let _ = app.emit(
        "oc-stream",
        json!({
            "state": state,
            "attempt": attempt,
            "at": now_ms(),
            "detail": detail,
        })
        .to_string(),
    );
}

/// Conecta ao SSE `/api/event` e republisha cada evento como `oc-event`.
/// O servidor encerra a conexão ociosa (Keep-Alive ~5s), entao reconexao
/// rapida com recuo limitado e' o comportamento esperado.
async fn event_loop(app: AppHandle) {
    let mut attempt: u32 = 0;
    loop {
        let info = match api::discover_service() {
            Ok(i) => i,
            Err(e) => {
                emit_stream(&app, "offline", attempt, Some(&e.to_string()));
                let _ = api::start_service();
                tokio::time::sleep(Duration::from_secs(3)).await;
                continue;
            }
        };
        let api = Api::new(&info);
        match api.events().await {
            Ok(res) => {
                let mut stream = res.bytes_stream();
                let mut buf = String::new();
                let mut opened = false;
                while let Some(chunk) = stream.next().await {
                    let bytes = match chunk {
                        Ok(b) => b,
                        Err(e) => {
                            emit_stream(&app, "reconnecting", attempt, Some(&e.to_string()));
                            break;
                        }
                    };
                    if !opened {
                        opened = true;
                        attempt = 0;
                        emit_stream(&app, "connected", attempt, None);
                    }
                    buf.push_str(&String::from_utf8_lossy(&bytes));
                    // além das linhas "data:", o stream envia comentarios
                    // ": heartbeat" e ": keep-alive" que devem ser ignorados.
                    while let Some(idx) = buf.find('\n') {
                        let line: String = buf[..idx].trim_end_matches('\r').to_string();
                        buf.drain(..=idx);
                        if let Some(data) = line.strip_prefix("data:") {
                            let data = data.trim();
                            if data.is_empty() {
                                continue;
                            }
                            if let Ok(v) = serde_json::from_str::<Value>(data) {
                                let _ = app.emit("oc-event", v.to_string());
                            }
                        }
                    }
                }
                if opened {
                    emit_stream(
                        &app,
                        "reconnecting",
                        attempt,
                        Some("stream encerrado pelo servidor"),
                    );
                }
            }
            Err(e) => {
                emit_stream(&app, "reconnecting", attempt, Some(&e.to_string()));
            }
        }
        attempt = attempt.saturating_add(1);
        // 250ms, 500ms, 1s, 3s (teto)
        let delay = match attempt {
            1 => 250,
            2 => 500,
            3 => 1000,
            _ => 3000,
        };
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }
}

fn main() {
    tauri::Builder::default()
        .manage(AppState {
            inner: Mutex::new(Inner {
                api: None,
                directory: None,
            }),
        })
        .invoke_handler(tauri::generate_handler![
            service_status,
            start_service,
            ensure_service,
            restart_service,
            stop_service,
            service_diagnostics,
            cli_version,
            set_directory,
            default_location,
            list_projects,
            list_sessions,
            get_session,
            create_session,
            rename_session,
            delete_session,
            delete_sessions,
            list_messages,
            send_prompt,
            run_command,
            interrupt_session,
            compact_session,
            fork_session,
            move_session,
            stage_revert,
            commit_revert,
            clear_revert,
            list_models,
            list_agents,
            list_commands,
            list_skills,
            switch_model,
            switch_agent,
            session_diff,
            session_stats,
            export_session,
            reveal_in_explorer,
            open_external,
            open_folder,
            active_sessions,
            vcs_status,
            session_permissions,
            reply_permission,
            mark_viewed,
            get_session_log,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                event_loop(handle).await;
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("erro ao executar o OpenCode Hub");
}
