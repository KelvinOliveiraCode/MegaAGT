use anyhow::{Context, Result};
use base64::Engine;
use reqwest::{Client, Method, Response};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Duration;

/// Cabecalho aceito pelo servidor para escopo de diretório de trabalho.
/// Sem ele, toda chamada resolve para o diretório padrão do processo.
pub const DIRECTORY_HEADER: &str = "x-opencode-directory";

/// Registro do serviço local (URL + senha) publicado pelo `opencode serve`.
#[derive(Clone, Debug)]
pub struct ServiceInfo {
    pub url: String,
    pub password: String,
}

fn home_dir() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("USERPROFILE") {
        return Some(PathBuf::from(p));
    }
    std::env::var("HOME").ok().map(PathBuf::from)
}

fn registration_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("XDG_STATE_HOME") {
        return Some(PathBuf::from(p).join("opencode").join("service.json"));
    }
    home_dir().map(|h| h.join(".local").join("state").join("opencode").join("service.json"))
}

/// Evita que apareca uma janela de console ao subir o serviço.
/// CreateProcess sem esta flag abre um terminal novo, piscando na tela.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Le o registro do servico (~/.local/state/opencode/service.json).
pub fn discover_service() -> Result<ServiceInfo> {
    let path = registration_path()
        .context("nao foi possível localizar o diretório de estado do usuário")?;
    let text = std::fs::read_to_string(&path).with_context(|| {
        format!(
            "registro do serviço não encontrado em {}\nAbra o OpenCode uma vez para que o serviço seja publicado.",
            path.display()
        )
    })?;
    let v: Value = serde_json::from_str(&text).context("registro do serviço inválido")?;
    let url = v["url"]
        .as_str()
        .context("url ausente no registro do serviço")?
        .trim_end_matches('/')
        .to_string();
    let password = v["password"]
        .as_str()
        .context("senha ausente no registro do serviço")?
        .to_string();
    Ok(ServiceInfo { url, password })
}

/// Caminho do arquivo de registro, para diagnostico.
pub fn registration_file() -> Option<PathBuf> {
    registration_path()
}

/// Localiza o executavel do OpenCode.
///
/// `Command::new("opencode")` falha com ENOENT numa instalacao via npm: o que
/// existe no PATH sao os shims `opencode.cmd` e `opencode.ps1`, e o
/// `CreateProcess` nao resolve shim — ele quer um executavel de verdade. Foi
/// exatamente isso que deixou o "iniciar servico" do app sem nunca funcionar.
///
/// Ordem: `.exe` no PATH → alvo do shim npm → desiste (o chamador cai no `cmd /c`).
pub fn opencode_bin() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let p = dir.join("opencode.exe");
            if p.is_file() {
                return Some(p);
            }
        }
    }
    // alvo do shim: %APPDATA%\npm\node_modules\@opencode\cli\bin\opencode.exe
    std::env::var_os("APPDATA").and_then(|a| {
        let p = PathBuf::from(a)
            .join("npm")
            .join("node_modules")
            .join("@opencode")
            .join("cli")
            .join("bin")
            .join("opencode.exe");
        p.is_file().then_some(p)
    })
}

/// Monta o comando do CLI, ja sem janela de console no Windows.
fn cli(args: &[&str]) -> std::process::Command {
    use std::process::{Command, Stdio};
    let mut c = match opencode_bin() {
        Some(exe) => {
            let mut c = Command::new(exe);
            c.args(args);
            c
        }
        // ultimo recurso: o shim do npm via cmd
        None => {
            let mut c = Command::new("cmd");
            c.args(["/c", "opencode"]);
            c.args(args);
            c
        }
    };
    // o filho nao pode herdar os handles do app: segura-los impede o
    // processo de sair quando o Hub fecha
    c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

/// Dispara um subcomando do CLI (`service start`, `service restart`, ...).
pub fn run_cli(args: &[&str]) -> Result<()> {
    cli(args)
        .spawn()
        .with_context(|| format!("falha ao executar 'opencode {}'", args.join(" ")))?;
    Ok(())
}

/// Dispara `opencode service start` (nao bloqueia).
pub fn start_service() -> Result<()> {
    run_cli(&["service", "start"])
}

/// Reinicia o servico em segundo plano.
pub fn restart_service() -> Result<()> {
    run_cli(&["service", "restart"])
}

/// Interrompe o servico.
pub fn stop_service() -> Result<()> {
    run_cli(&["service", "stop"])
}

/// Executa o CLI e devolve a saida. So para diagnostico (bloqueia).
pub fn cli_version() -> Option<String> {
    use std::process::Stdio;
    let mut c = cli(&["--version"]);
    c.stdout(Stdio::piped());
    let out = c.output().ok()?;
    let txt = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!txt.is_empty()).then_some(txt)
}

/// Cliente HTTP do servico OpenCode: Basic auth + escopo opcional de diretório.
#[derive(Clone)]
pub struct Api {
    /// Sem timeout global. Cada chamada define o seu proprio; o stream SSE
    /// precisa de uma conexão que permanece aberta indefinidamente.
    http: Client,
    base: String,
    authorization: String,
    directory: Option<String>,
}

impl Api {
    pub fn new(info: &ServiceInfo) -> Self {
        Self::with_directory(info, None)
    }

    pub fn with_directory(info: &ServiceInfo, directory: Option<String>) -> Self {
        let raw = format!("opencode:{}", info.password);
        let encoded = base64::engine::general_purpose::STANDARD.encode(raw.as_bytes());
        let http = Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .tcp_keepalive(Duration::from_secs(30))
            .pool_idle_timeout(Duration::from_secs(90))
            .pool_max_idle_per_host(4)
            .build()
            .expect("falha ao construir o cliente http");
        Api {
            http,
            base: info.url.trim_end_matches('/').to_string(),
            authorization: format!("Basic {}", encoded),
            directory: directory.filter(|d| !d.trim().is_empty()),
        }
    }

    pub fn with_dir(&self, directory: Option<String>) -> Self {
        let mut next = self.clone();
        next.directory = directory.filter(|d| !d.trim().is_empty());
        next
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    pub fn directory(&self) -> Option<&str> {
        self.directory.as_deref()
    }

    fn build(&self, method: Method, path: &str, body: Option<Value>) -> reqwest::RequestBuilder {
        let url = format!("{}{}", self.base, path);
        let mut req = self
            .http
            .request(method, &url)
            .header("Authorization", self.authorization.clone())
            .header("Accept", "application/json");
        if let Some(dir) = &self.directory {
            req = req.header(DIRECTORY_HEADER, dir.clone());
        }
        if let Some(b) = body {
            req = req.json(&b);
        }
        req
    }

    async fn send(&self, method: Method, path: &str, body: Option<Value>) -> Result<Value> {
        let req = self.build(method, path, body).timeout(Duration::from_secs(120));
        let res = req
            .send()
            .await
            .context("falha de conexão com o serviço OpenCode")?;
        parse_response(res).await
    }

    pub async fn get(&self, path: &str) -> Result<Value> {
        self.send(Method::GET, path, None).await
    }

    pub async fn post(&self, path: &str, body: Value) -> Result<Value> {
        self.send(Method::POST, path, Some(body)).await
    }

    pub async fn patch(&self, path: &str, body: Value) -> Result<Value> {
        self.send(Method::PATCH, path, Some(body)).await
    }

    pub async fn delete(&self, path: &str) -> Result<Value> {
        self.send(Method::DELETE, path, None).await
    }

    /// Conecta ao stream SSE de eventos. Nao define timeout algum: a conexão
    /// precisa sobreviver a heartbeats e a respostas que nunca terminam.
    pub async fn events(&self) -> Result<Response> {
        let req = self
            .build(Method::GET, "/api/event", None)
            .header("Cache-Control", "no-cache")
            .header("Accept", "text/event-stream");
        req.send()
            .await
            .context("falha ao conectar ao stream de eventos")?
            .error_for_status()
            .context("o servidor recusou a conexão com o stream de eventos")
    }
}

async fn parse_response(res: Response) -> Result<Value> {
    let status = res.status();
    let text = res.text().await.context("falha ao ler a resposta")?;
    if !status.is_success() {
        let snippet: String = if text.chars().count() > 600 {
            let head: String = text.chars().take(600).collect();
            format!("{head}…")
        } else {
            text
        };
        anyhow::bail!("HTTP {}: {}", status.as_u16(), snippet);
    }
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(trimmed).context("a resposta nao e JSON valido")
}

/// "provider/model" ou "provider/model#variant" -> Model.Ref
///
/// Atencao: o schema `Model.Ref` do OpenCode exige os campos **`id`** e
/// `providerID` (e rejeita campos desconhecidos com `additionalProperties:
/// false`). Usar "model" aqui faz o servidor responder HTTP 400.
pub fn parse_model_ref(s: &str) -> Value {
    let (body, variant) = match s.split_once('#') {
        Some((b, v)) => (b, Some(v.to_string())),
        None => (s, None),
    };
    // o id do modelo pode conter "/" (ex.: "kilo/dots-studio/notes:free"),
    // entao so' o primeiro separador divide provider de id
    let (provider_id, model) = match body.split_once('/') {
        Some((p, m)) => (p.to_string(), m.to_string()),
        None => (String::new(), body.to_string()),
    };
    let mut obj = json!({ "providerID": provider_id, "id": model });
    if let Some(v) = variant {
        obj["variant"] = json!(v);
    }
    obj
}

fn url_encode(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            _ => format!("%{:02X}", c as u32),
        })
        .collect()
}

/// GET paginado seguindo `cursor.next`, devolvendo todos os itens de `data`.
/// `query` sao parametros extras aplicados a primeira pagina (e propagados).
pub async fn paginate_get(api: &Api, path: &str, query: &[(&str, String)]) -> Result<Vec<Value>> {
    let mut out: Vec<Value> = Vec::new();
    let mut cursor: Option<String> = None;
    let extra: String = query
        .iter()
        .map(|(k, v)| format!("{}={}", k, url_encode(v)))
        .collect::<Vec<_>>()
        .join("&");

    for _ in 0..200 {
        let mut params: Vec<String> = Vec::new();
        if !extra.is_empty() {
            params.push(extra.clone());
        }
        if let Some(c) = &cursor {
            params.push(format!("cursor={}", url_encode(c)));
        }
        let url = if params.is_empty() {
            path.to_string()
        } else {
            format!("{}?{}", path, params.join("&"))
        };
        let v = api.get(&url).await?;
        if let Some(arr) = v["data"].as_array() {
            out.extend(arr.clone());
        }
        match v["cursor"]["next"].as_str() {
            Some(n) if !n.is_empty() => cursor = Some(n.to_string()),
            _ => break,
        }
    }
    Ok(out)
}
