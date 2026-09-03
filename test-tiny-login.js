/**
 * test-tiny-login.js
 * ---------------------------------------------------------------------------
 * TESTE ISOLADO — não faz parte da automação de produção (sync-tiny-ops.js).
 *
 * Objetivo único: verificar se é possível fazer login automatizado no Tiny
 * (Olist ERP / Keycloak) a partir de um runner do GitHub Actions, usando
 * Playwright, e diagnosticar objetivamente o que acontece.
 *
 * Este script NUNCA:
 *   - grava ou sobrescreve o storageState usado pela automação de produção
 *     (usa um arquivo/pasta totalmente separados, e nem chega a salvar sessão
 *     em lugar nenhum persistente do repositório);
 *   - tenta contornar CAPTCHA, 2FA ou qualquer proteção do Cloudflare —
 *     se detectar isso, apenas registra o cenário e para;
 *   - imprime usuário, senha, cookies, conteúdo de storageState, headers de
 *     autenticação ou qualquer token nos logs.
 *
 * Variáveis de ambiente esperadas (GitHub Secrets):
 *   TINY_USERNAME   usuário/e-mail de login do Tiny
 *   TINY_SENHA      senha de login do Tiny
 *
 * Saída: imprime um bloco de diagnóstico e termina com:
 *   exit code 0  -> status LOGIN_OK
 *   exit code 1  -> qualquer outro status (CLOUDFLARE_CHALLENGE,
 *                   CREDENCIAIS_INVALIDAS, VERIFICACAO_ADICIONAL,
 *                   LOGIN_INDETERMINADO, ou erro inesperado)
 *
 * Em caso de qualquer status != LOGIN_OK, tenta salvar um screenshot em
 * ./test-login-screenshot.png (o workflow sobe isso como artifact) — mas só
 * depois de limpar os campos de usuário/senha da tela, para nunca vazar o
 * que foi digitado numa imagem.
 */
const { chromium } = require('playwright');
const fs = require('fs');

const LOGIN_URL = 'https://erp.olist.com/ordens_producao'; // redireciona pro login do Keycloak, igual ao fluxo real
const SCREENSHOT_PATH = './test-login-screenshot.png';

const STATUS = {
  LOGIN_OK: 'LOGIN_OK',
  CLOUDFLARE_CHALLENGE: 'CLOUDFLARE_CHALLENGE',
  CREDENCIAIS_INVALIDAS: 'CREDENCIAIS_INVALIDAS',
  VERIFICACAO_ADICIONAL: 'VERIFICACAO_ADICIONAL',
  LOGIN_INDETERMINADO: 'LOGIN_INDETERMINADO',
};

function agora() {
  return Date.now();
}

function precisaVar(nome) {
  const v = process.env[nome];
  if (!v) {
    console.error(`ERRO: variável de ambiente ${nome} não definida (configure em GitHub Secrets).`);
    process.exit(1);
  }
  return v;
}

// -----------------------------------------------------------------------
// Detecção de desafio do Cloudflare (edge, antes mesmo de qualquer form)
// -----------------------------------------------------------------------
async function detectarCloudflareChallenge(page) {
  const titulo = (await page.title().catch(() => '')) || '';
  const tituloLower = titulo.toLowerCase();
  const sinaisTitulo = ['just a moment', 'attention required', 'checking your browser', 'cloudflare'];
  if (sinaisTitulo.some(s => tituloLower.includes(s))) return true;

  // iframes/widgets de challenge (Turnstile, hCaptcha via Cloudflare, etc.)
  const temIframeChallenge = await page.evaluate(() => {
    const iframes = Array.from(document.querySelectorAll('iframe'));
    return iframes.some(f => {
      const src = (f.src || '').toLowerCase();
      return src.includes('challenges.cloudflare.com') || src.includes('turnstile');
    });
  }).catch(() => false);
  if (temIframeChallenge) return true;

  const temTextoChallenge = await page.evaluate(() => {
    const texto = (document.body && document.body.innerText || '').toLowerCase();
    return texto.includes('verifique se você é humano') ||
           texto.includes('verify you are human') ||
           texto.includes('ray id') ||
           texto.includes('cloudflare');
  }).catch(() => false);

  return temTextoChallenge;
}

// -----------------------------------------------------------------------
// Localização robusta dos campos de usuário/senha
// -----------------------------------------------------------------------
async function localizarCampos(page) {
  const passwordCandidatos = [
    'input[type="password"]',
  ];
  let passwordInput = null;
  for (const sel of passwordCandidatos) {
    const loc = page.locator(sel).first();
    if (await loc.count() > 0) {
      try {
        await loc.waitFor({ state: 'visible', timeout: 12000 });
        passwordInput = loc;
        break;
      } catch (e) { /* tenta o próximo candidato */ }
    }
  }
  if (!passwordInput) return { usernameInput: null, passwordInput: null };

  // Usuário: preferimos atributos semânticos; se não achar, caímos para o
  // primeiro campo de texto visível dentro do mesmo <form> do campo de senha.
  const usernameCandidatos = [
    'input[type="email"]',
    'input[autocomplete="username"]',
    'input[name="username"]',
    'input#username',
  ];
  let usernameInput = null;
  for (const sel of usernameCandidatos) {
    const loc = page.locator(sel).first();
    if (await loc.count() > 0) {
      usernameInput = loc;
      break;
    }
  }
  if (!usernameInput) {
    try {
      const formComSenha = page.locator('form').filter({ has: page.locator('input[type="password"]') }).first();
      const candidato = formComSenha.locator('input[type="text"], input:not([type])').first();
      if (await candidato.count() > 0) usernameInput = candidato;
    } catch (e) { /* segue sem username encontrado */ }
  }

  return { usernameInput, passwordInput };
}

// -----------------------------------------------------------------------
// Limpa qualquer campo de usuário/senha visível na página antes de tirar
// screenshot, para nunca vazar o que foi digitado numa imagem salva.
// -----------------------------------------------------------------------
async function limparCamposSensiveis(page) {
  await page.evaluate(() => {
    const seletores = 'input[type="password"], input[type="email"], input[type="text"], input:not([type])';
    document.querySelectorAll(seletores).forEach(el => {
      try { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
    });
  }).catch(() => {});
}

async function salvarScreenshotSeguro(page) {
  try {
    await limparCamposSensiveis(page);
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: false });
    return true;
  } catch (e) {
    console.log(`(não foi possível salvar screenshot: ${e.message})`);
    return false;
  }
}

// -----------------------------------------------------------------------
// Detecta mensagens de erro / verificação adicional no texto da página,
// sem depender de seletores muito específicos do Keycloak.
// -----------------------------------------------------------------------
async function lerSinaisNaPagina(page) {
  const texto = await page.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
  const textoLower = texto.toLowerCase();

  const padroesCredenciaisInvalidas = [
    'usuário ou senha inválid',
    'usuario ou senha invalid',
    'credenciais inválidas',
    'invalid username or password',
    'invalid user credentials',
    'senha incorreta',
    'usuário incorreto',
  ];
  const padroesVerificacaoAdicional = [
    'código de verificação',
    'codigo de verificacao',
    'digite o código',
    'verification code',
    'autenticação de dois fatores',
    'two-factor',
    '2fa',
    'enviamos um código',
    'recaptcha',
    'hcaptcha',
    'captcha',
  ];

  const matchCredenciais = padroesCredenciaisInvalidas.find(p => textoLower.includes(p));
  const matchVerificacao = padroesVerificacaoAdicional.find(p => textoLower.includes(p));

  return {
    credenciaisInvalidas: !!matchCredenciais,
    verificacaoAdicional: !!matchVerificacao,
    // guardamos só qual padrão bateu (string fixa nossa, não conteúdo da página) — não vaza nada sensível.
    padraoCredenciais: matchCredenciais || null,
    padraoVerificacao: matchVerificacao || null,
  };
}

(async () => {
  const username = precisaVar('TINY_USERNAME');
  const senha = precisaVar('TINY_SENHA');

  const tempos = {};
  const t0 = agora();

  const browser = await chromium.launch({ headless: true });
  // Contexto isolado, em memória — não persiste em nenhum arquivo do repositório.
  const context = await browser.newContext();
  const page = await context.newPage();

  let status = STATUS.LOGIN_INDETERMINADO;
  let detalhe = '';
  let camposEncontrados = false;
  let redirecionouParaLoginNoInicio = false;
  let screenshotSalvo = false;

  try {
    console.log('=== TESTE ISOLADO DE LOGIN AUTOMATIZADO NO TINY (via GitHub Actions) ===');
    console.log('Este teste NÃO altera a automação de produção nem a sessão usada por ela.\n');

    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    tempos.paginaInicialCarregada = agora() - t0;

    // Segue eventuais redirecionamentos automáticos até estabilizar.
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    tempos.redeEstavelAposAbrir = agora() - t0;

    redirecionouParaLoginNoInicio = page.url().includes('accounts.tiny.com.br') || page.url().includes('/login');

    // 1) Checa desafio do Cloudflare ANTES de mexer em qualquer campo.
    if (await detectarCloudflareChallenge(page)) {
      status = STATUS.CLOUDFLARE_CHALLENGE;
      detalhe = 'Sinal de desafio/verificação do Cloudflare detectado antes do formulário de login.';
    } else {
      // 2) Localiza campos de login de forma robusta.
      const { usernameInput, passwordInput } = await localizarCampos(page);
      camposEncontrados = !!(usernameInput && passwordInput);
      tempos.camposLocalizados = agora() - t0;

      if (!camposEncontrados) {
        status = STATUS.LOGIN_INDETERMINADO;
        detalhe = 'Não foi possível localizar de forma confiável os campos de usuário e/ou senha na página.';
      } else {
        // 3) Preenche e envia (sem logar valores).
        await usernameInput.fill(username);
        await passwordInput.fill(senha);
        tempos.camposPreenchidos = agora() - t0;

        const botaoEntrar = page.getByRole('button', { name: /entrar/i }).first();
        if (await botaoEntrar.count() > 0) {
          await botaoEntrar.click();
        } else {
          // fallback: envia o form pelo teclado a partir do campo de senha.
          await passwordInput.press('Enter');
        }
        tempos.loginEnviado = agora() - t0;

        // 4) Aguarda os redirecionamentos Keycloak -> erp.olist.com.
        await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
        // pequena espera extra para SPA renderizar após o redirecionamento final.
        await page.waitForTimeout(2000);
        tempos.assentouAposLogin = agora() - t0;

        const urlFinal = page.url();
        const aindaEmTelaDeAuth = urlFinal.includes('accounts.tiny.com.br') || urlFinal.includes('/login');

        if (await detectarCloudflareChallenge(page)) {
          status = STATUS.CLOUDFLARE_CHALLENGE;
          detalhe = 'Sinal de desafio/verificação do Cloudflare detectado após o envio do login.';
        } else {
          const sinais = await lerSinaisNaPagina(page);

          if (!aindaEmTelaDeAuth && urlFinal.includes('erp.olist.com')) {
            status = STATUS.LOGIN_OK;
            detalhe = 'Redirecionado para o ERP fora da tela de login/autenticação.';
          } else if (sinais.credenciaisInvalidas) {
            status = STATUS.CREDENCIAIS_INVALIDAS;
            detalhe = 'Página de login reportou usuário/senha incorretos.';
          } else if (sinais.verificacaoAdicional) {
            status = STATUS.VERIFICACAO_ADICIONAL;
            detalhe = 'Detectado pedido de verificação adicional (código, 2FA ou captcha) que não aparece no login manual comum.';
          } else {
            status = STATUS.LOGIN_INDETERMINADO;
            detalhe = 'Após o envio do login, não foi possível confirmar sucesso nem nenhum dos cenários de falha conhecidos.';
          }
        }
      }
    }
  } catch (erro) {
    status = STATUS.LOGIN_INDETERMINADO;
    detalhe = `Erro inesperado durante o teste: ${erro.message}`;
  }

  // Screenshot só em cenários != LOGIN_OK, e só depois de limpar campos sensíveis.
  if (status !== STATUS.LOGIN_OK) {
    screenshotSalvo = await salvarScreenshotSeguro(page);
  }

  const urlFinalSegura = page.url();
  const tituloFinal = await page.title().catch(() => '(indisponível)');

  console.log('----------------------------------------------------------------');
  console.log(`STATUS: ${status}`);
  console.log(`Detalhe: ${detalhe}`);
  console.log(`URL final: ${urlFinalSegura}`);
  console.log(`Título da página final: ${tituloFinal}`);
  console.log(`Redirecionou para tela de login/autenticação logo ao abrir: ${redirecionouParaLoginNoInicio}`);
  console.log(`Campos de usuário/senha encontrados: ${camposEncontrados}`);
  console.log(`Screenshot salvo (apenas se status != LOGIN_OK): ${screenshotSalvo}`);
  console.log('Tempos aproximados (ms desde o início do teste):');
  for (const [etapa, ms] of Object.entries(tempos)) {
    console.log(`  - ${etapa}: ${ms}ms`);
  }
  console.log('----------------------------------------------------------------');
  console.log('Lembrete: nenhum usuário, senha, cookie, storageState, header de');
  console.log('autenticação ou token foi impresso nestes logs.');
  console.log('A sessão usada pela automação de produção (TINY_SESSION_B64) NÃO foi tocada.');

  await browser.close();

  process.exit(status === STATUS.LOGIN_OK ? 0 : 1);
})();
