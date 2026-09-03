/**
 * sync-tiny-ops.js
 * ---------------------------------------------------------------------------
 * Lê as Ordens de Produção "em aberto" do Tiny (Olist ERP) e cria, no Firestore
 * do Dr Chef Produção, um card na coluna "A Cortar" para cada OP que ainda não
 * existe por lá. Feito para rodar de tempos em tempos (ex: a cada 20 min) via
 * GitHub Actions — veja .github/workflows/sync.yml.
 *
 * O QUE ESTE SCRIPT NÃO FAZ (de propósito):
 * - Não atualiza OPs que já existem no Dr Chef (só cria as que faltam).
 * - Não move cards de coluna, não mexe em costureira/cortador/valores.
 * - Não decide sozinho quantidade de peças cortadas nem nada operacional —
 *   isso continua sendo preenchido à mão no Dr Chef, como sempre foi.
 *
 * Para cada OP nova, além dos dados básicos (ref/cor/tamanho/qtd), o script
 * também busca/calcula:
 * - modelo: só "MODELO <número>" (ex: "MODELO 90"), extraído da descrição.
 * - nomeProduto: palavra-chave do produto + gênero (ex: "DÓLMÃ FEMININO"),
 *   também extraído da descrição.
 * - qty: sempre número inteiro, sem vírgula (ex: "6,00" vira "6").
 * - fabric (tecido): lido na tela de edição da própria OP no Tiny, seção
 *   "Composição" — pega a primeira linha cujo nome começa com "TECIDO"
 *   (ex: "TECIDO OXFORD ( BNY ) - BRANCO" vira fabric = "OXFORD ( BNY ) - BRANCO").
 * - ean: o GTIN/EAN da variação exata (cor+tamanho) do produto, lido em
 *   Cadastros > Produtos > Variações (cada variação tem um EAN próprio,
 *   diferente do EAN do produto "pai").
 *   Isso exige abrir telas de cada OP nova individualmente (só as novas,
 *   não todas as em aberto), então o script demora um pouco mais quando
 *   há OPs novas para criar.
 *
 * CONFIGURAÇÃO (variáveis de ambiente / GitHub Secrets — veja README.md):
 *   - TINY_SESSION_B64        sessão do Tiny já logada, em base64 (gerada
 *                             com setup-tiny-session.js)
 *   - FIREBASE_SERVICE_ACCOUNT o JSON da conta de serviço do Firebase, em
 *                             base64 (Firebase Console > Configurações do
 *                             projeto > Contas de serviço > Gerar nova
 *                             chave privada)
 *   - TINY_USERNAME           usuário/e-mail de login do Tiny (só é usado
 *                             se for preciso renovar a sessão sozinho —
 *                             ver "RENOVAÇÃO AUTOMÁTICA DE SESSÃO" abaixo)
 *   - TINY_SENHA              senha de login do Tiny (idem)
 *
 * RENOVAÇÃO AUTOMÁTICA DE SESSÃO
 * ---------------------------------------------------------------------------
 * O cookie de sessão do Tiny (KEYCLOAK_SESSION) expira ~24h após o login,
 * então o TINY_SESSION_B64 salvo manualmente fica velho com o tempo. Para
 * não depender de alguém renovar isso à mão todo dia, o script agora faz
 * login sozinho (via Playwright, com TINY_USERNAME/TINY_SENHA) quando
 * necessário, em duas situações:
 *
 *   1) PROATIVA: antes mesmo de tentar usar a sessão salva, o script olha a
 *      validade do cookie KEYCLOAK_SESSION dentro do TINY_SESSION_B64. Se
 *      faltar menos de RENEW_THRESHOLD_MINUTOS (padrão 90min) para expirar
 *      (ou já tiver expirado), ele já faz login automático direto, sem nem
 *      tentar a sessão velha.
 *   2) REATIVA: se, por qualquer motivo, a sessão salva se mostrar inválida
 *      na hora de usar (fomos redirecionados pro login), o script tenta o
 *      login automático nesse momento, como um segundo mecanismo de segurança.
 *
 * Este login automático é o MESMO fluxo testado isoladamente em
 * test-tiny-login.js (não muda, não tenta contornar nada): abre a tela de
 * login normal, preenche usuário/senha, envia, e verifica objetivamente o
 * resultado. Ele NUNCA tenta contornar Cloudflare, CAPTCHA ou verificação
 * adicional (2FA/código) — se detectar qualquer um desses cenários, ou se o
 * login vier com credenciais inválidas, a sincronização É INTERROMPIDA
 * (process.exit(1)) com um alerta bem visível: uma anotação de erro do
 * GitHub Actions (aparece em destaque na página do run) e um resumo no
 * GITHUB_STEP_SUMMARY explicando que é preciso renovar manualmente. Ou seja,
 * nunca falha em silêncio — ou sincroniza normalmente, ou para com um aviso
 * claro pedindo ação manual.
 *
 * A sessão renovada automaticamente NÃO é salva de volta no secret
 * TINY_SESSION_B64 (fica só na memória daquela execução) — então, depois
 * que a sessão manual expira de vez, o robô passa a logar sozinho a cada
 * execução (list custa uns 10s a mais por rodada, sem problema nenhum pra
 * uma rotina que roda a cada 20min). Isso é intencional: evita a
 * complexidade/risco de o workflow reescrever secrets do repositório sozinho.
 */
const { chromium } = require('playwright');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const TINY_LIST_URL = 'https://erp.olist.com/ordens_producao';
const PRODUCTS_LIST_URL = 'https://erp.olist.com/produtos';

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

function precisaVar(nome) {
  const v = process.env[nome];
  if (!v) {
    console.error(`Faltou configurar a variável de ambiente ${nome}. Veja o README.md.`);
    process.exit(1);
  }
  return v;
}

// ---------------------------------------------------------------------------
// 0) Renovação automática de sessão (login via Playwright quando necessário)
//    — mesma lógica já validada isoladamente em test-tiny-login.js.
// ---------------------------------------------------------------------------
const RENEW_THRESHOLD_MINUTOS = Number(process.env.RENEW_THRESHOLD_MINUTOS || 90);

const LOGIN_STATUS = {
  LOGIN_OK: 'LOGIN_OK',
  CLOUDFLARE_CHALLENGE: 'CLOUDFLARE_CHALLENGE',
  CREDENCIAIS_INVALIDAS: 'CREDENCIAIS_INVALIDAS',
  VERIFICACAO_ADICIONAL: 'VERIFICACAO_ADICIONAL',
  LOGIN_INDETERMINADO: 'LOGIN_INDETERMINADO',
};

// Escreve um alerta BEM visível: uma anotação de erro do GitHub Actions
// (aparece em destaque na página do run) + um resumo no GITHUB_STEP_SUMMARY
// (aparece no topo da página do run). Objetivo: nunca falhar em silêncio.
function alertarFalhaCritica(mensagemPrincipal, linhasDetalhe) {
  console.error(`::error::${mensagemPrincipal}`);
  log(`ERRO CRÍTICO: ${mensagemPrincipal}`);
  for (const l of linhasDetalhe) log(`  - ${l}`);

  const resumoMd = [
    '## ❌ Sincronização Tiny → Dr Chef FALHOU — ação manual necessária',
    '',
    `**${mensagemPrincipal}**`,
    '',
    ...linhasDetalhe.map(l => `- ${l}`),
    '',
    'O que fazer: confira o login manualmente em https://erp.olist.com. Se a sessão salva é que expirou e o login automático não deu conta sozinho, rode `node setup-tiny-session.js` de novo e atualize o secret `TINY_SESSION_B64`.',
  ].join('\n');

  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, resumoMd + '\n'); } catch (_) { /* nunca deixa o alerta quebrar o script */ }
  }
}

// Verifica, sem usar a sessão (só olhando o storageState salvo), se o cookie
// KEYCLOAK_SESSION está perto de expirar. Se não conseguir ler/entender o
// cookie por qualquer motivo, devolve "não precisa renovar" — o mecanismo
// reativo (abaixo) continua sendo a rede de segurança garantida.
function sessaoProximaDoVencimento(storageStatePath, limiteMinutos) {
  try {
    const dados = JSON.parse(fs.readFileSync(storageStatePath, 'utf8'));
    const cookie = (dados.cookies || []).find(c => c.name === 'KEYCLOAK_SESSION' && /tiny\.com\.br$/i.test(c.domain || ''));
    if (!cookie || !cookie.expires || cookie.expires <= 0) {
      return { precisaRenovar: false, motivo: 'cookie KEYCLOAK_SESSION não encontrado ou sem validade definida' };
    }
    const minutosRestantes = (cookie.expires * 1000 - Date.now()) / 60000;
    if (minutosRestantes < limiteMinutos) {
      return { precisaRenovar: true, minutosRestantes, motivo: `faltam ${minutosRestantes.toFixed(0)}min para o cookie de sessão expirar (limite: ${limiteMinutos}min)` };
    }
    return { precisaRenovar: false, minutosRestantes, motivo: `sessão ainda válida por ~${minutosRestantes.toFixed(0)}min` };
  } catch (err) {
    return { precisaRenovar: false, motivo: `não consegui checar a validade da sessão salva (${err.message})` };
  }
}

// --- Helpers de login automático (idênticos, em espírito, ao test-tiny-login.js) ---

async function detectarCloudflareChallenge(page) {
  const titulo = (await page.title().catch(() => '')) || '';
  const tituloLower = titulo.toLowerCase();
  const sinaisTitulo = ['just a moment', 'attention required', 'checking your browser', 'cloudflare'];
  if (sinaisTitulo.some(s => tituloLower.includes(s))) return true;

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

async function localizarCamposLogin(page) {
  const passwordCandidatos = ['input[type="password"]'];
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

async function lerSinaisNaPaginaDeLogin(page) {
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
  };
}

// Faz o login automático de ponta a ponta (mesmo fluxo do test-tiny-login.js)
// numa aba/contexto novo e isolado. NUNCA tenta contornar Cloudflare, CAPTCHA
// ou verificação adicional — só detecta e reporta.
// Devolve { ok: true, context, page } (chamador assume posse do contexto, já
// autenticado e pronto em TINY_LIST_URL) ou { ok: false, status, detalhe }.
async function tentarLoginAutomatico(browser) {
  const username = process.env.TINY_USERNAME;
  const senha = process.env.TINY_SENHA;
  if (!username || !senha) {
    return {
      ok: false,
      status: 'CREDENCIAIS_AUSENTES',
      detalhe: 'TINY_USERNAME e/ou TINY_SENHA não configurados nos GitHub Secrets — não é possível tentar renovar sozinho.',
    };
  }

  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    log('Renovação automática: abrindo tela de login do Tiny...');
    await page.goto(TINY_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

    if (await detectarCloudflareChallenge(page)) {
      await context.close();
      return { ok: false, status: LOGIN_STATUS.CLOUDFLARE_CHALLENGE, detalhe: 'Sinal de desafio/verificação do Cloudflare detectado antes do formulário de login.' };
    }

    const { usernameInput, passwordInput } = await localizarCamposLogin(page);
    if (!usernameInput || !passwordInput) {
      await context.close();
      return { ok: false, status: LOGIN_STATUS.LOGIN_INDETERMINADO, detalhe: 'Não foi possível localizar de forma confiável os campos de usuário e/ou senha na página.' };
    }

    await usernameInput.fill(username);
    await passwordInput.fill(senha);

    const botaoEntrar = page.getByRole('button', { name: /entrar/i }).first();
    if (await botaoEntrar.count() > 0) {
      await botaoEntrar.click();
    } else {
      await passwordInput.press('Enter');
    }

    await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const urlFinal = page.url();
    const aindaEmTelaDeAuth = urlFinal.includes('accounts.tiny.com.br') || urlFinal.includes('/login');

    if (await detectarCloudflareChallenge(page)) {
      await context.close();
      return { ok: false, status: LOGIN_STATUS.CLOUDFLARE_CHALLENGE, detalhe: 'Sinal de desafio/verificação do Cloudflare detectado após o envio do login.' };
    }

    if (!aindaEmTelaDeAuth && urlFinal.includes('erp.olist.com')) {
      log('Renovação automática: login OK, sessão nova obtida.');
      return { ok: true, context, page };
    }

    const sinais = await lerSinaisNaPaginaDeLogin(page);
    await context.close();
    if (sinais.credenciaisInvalidas) {
      return { ok: false, status: LOGIN_STATUS.CREDENCIAIS_INVALIDAS, detalhe: 'Página de login reportou usuário/senha incorretos.' };
    }
    if (sinais.verificacaoAdicional) {
      return { ok: false, status: LOGIN_STATUS.VERIFICACAO_ADICIONAL, detalhe: 'Detectado pedido de verificação adicional (código, 2FA ou captcha) que não aparece no login manual comum.' };
    }
    return { ok: false, status: LOGIN_STATUS.LOGIN_INDETERMINADO, detalhe: 'Após o envio do login, não foi possível confirmar sucesso nem nenhum dos cenários de falha conhecidos.' };
  } catch (err) {
    await context.close().catch(() => {});
    return { ok: false, status: LOGIN_STATUS.LOGIN_INDETERMINADO, detalhe: `Erro inesperado durante o login automático: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// 1) Extrai as OPs "em aberto" da tabela do Tiny (com paginação)
// ---------------------------------------------------------------------------
async function extrairOpsDoTiny(page) {
  const todasAsOps = [];

  async function extrairPaginaAtual() {
    return page.evaluate(() => {
      const linhas = Array.from(document.querySelectorAll('#tabelaListagem tbody tr'));
      return linhas.map(tr => {
        const tds = tr.querySelectorAll('td');
        // Índices confirmados olhando a tabela real do Tiny em 30/08/2026.
        // Se o Tiny mudar as colunas visíveis, ajuste aqui.
        const numero = tds[2] ? tds[2].getAttribute('data-value') || tds[2].textContent.trim() : '';
        const dataCriacaoTs = tds[4] ? tds[4].getAttribute('data-value') : null;
        const dataPrevistaTs = tds[5] ? tds[5].getAttribute('data-value') : null;
        const skuDescricao = tds[6] ? tds[6].textContent.trim() : '';
        const quantidade = tds[7] ? (tds[7].getAttribute('data-value') || tds[7].textContent.trim()) : '';
        const unidade = tds[8] ? tds[8].textContent.trim() : '';
        return {
          idInternoTiny: tr.id || null,
          numero,
          dataCriacaoTs,
          dataPrevistaTs,
          skuDescricao,
          quantidade,
          unidade,
        };
      });
    });
  }

  let pagina = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ops = await extrairPaginaAtual();
    todasAsOps.push(...ops);
    log(`Página ${pagina}: ${ops.length} OPs lidas.`);

    // Descobre se existe próxima página (função irParaPagina(N, listar) do Tiny)
    const proximaPagina = pagina + 1;
    const temProximaPagina = await page.evaluate((n) => {
      const link = Array.from(document.querySelectorAll('.link-pg'))
        .find(a => a.textContent.trim() === String(n).padStart(2, '0'));
      return !!link;
    }, proximaPagina);

    if (!temProximaPagina) break;

    await page.evaluate((n) => {
      // eslint-disable-next-line no-undef
      irParaPagina(n, listar);
    }, proximaPagina);
    await page.waitForTimeout(1500); // dá tempo do AJAX recarregar a tabela
    pagina = proximaPagina;
  }

  return todasAsOps;
}

// ---------------------------------------------------------------------------
// 1b) Busca o tecido de uma OP específica, abrindo sua tela de edição e
//     lendo a tabela "Composição" (primeira linha que começa com "TECIDO").
// ---------------------------------------------------------------------------
async function buscarTecido(page, idInternoTiny) {
  if (!idInternoTiny) return '';
  try {
    await page.goto(`${TINY_LIST_URL}#edit/${idInternoTiny}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#composicao-produto tbody tr', { timeout: 15000 });
    return await page.evaluate(() => {
      const linhas = Array.from(document.querySelectorAll('#composicao-produto tbody tr'));
      for (const tr of linhas) {
        const primeiraCelula = tr.querySelector('td');
        if (!primeiraCelula) continue;
        const texto = primeiraCelula.textContent.trim();
        if (/^tecido\b/i.test(texto)) {
          return texto.replace(/^tecido\s*/i, '').trim();
        }
      }
      return '';
    });
  } catch (err) {
    log(`Aviso: não consegui buscar o tecido da OP interna ${idInternoTiny}: ${err.message}`);
    return '';
  }
}

// ---------------------------------------------------------------------------
// 1c) Busca o EAN/GTIN de uma variação específica (ref = código do SKU da
//     variação, ex: "5133M") em Cadastros > Produtos > Variações. Cada
//     variação (cor + tamanho) tem seu próprio EAN, diferente do EAN do
//     produto "pai". Para produtos sem variação, o próprio Código (SKU) já
//     é o ref e o EAN vem direto da listagem de produtos.
// ---------------------------------------------------------------------------
async function buscarEAN(page, ref) {
  if (!ref) return '';
  try {
    await page.goto(PRODUCTS_LIST_URL, { waitUntil: 'networkidle' });

    // Garante que nenhum filtro de uma busca anterior (ex: "variações") está
    // escondendo o produto que queremos.
    const limparFiltros = await page.$('a:has-text("limpar filtros")');
    if (limparFiltros) {
      await limparFiltros.click();
      await page.waitForLoadState('networkidle');
    }

    await page.fill('#pesquisa-mini', ref);
    await page.keyboard.press('Enter');
    await page.waitForLoadState('networkidle');

    const semResultado = await page.locator('text=Sua pesquisa não retornou resultados').count();
    if (semResultado > 0) return '';

    await page.waitForSelector('#tabelaListagem tbody tr', { timeout: 15000 });
    const linhas = page.locator('#tabelaListagem tbody tr');
    const totalLinhas = await linhas.count();

    for (let i = 0; i < totalLinhas; i++) {
      const linha = linhas.nth(i);
      // Coluna "Código (SKU)" do produto "pai" (índice 4 na listagem).
      const codigoBase = (await linha.locator('td').nth(4).innerText()).trim();

      if (codigoBase === ref) {
        // Produto simples (sem variações): a célula seguinte já é o EAN.
        return (await linha.locator('td').nth(5).innerText()).trim();
      }

      const linkVariacoes = linha.locator('a.link', { hasText: 'variaç' });
      if (await linkVariacoes.count() === 0) continue;

      await linkVariacoes.first().click();
      await page.waitForSelector('#tabela_variacoes tbody tr', { timeout: 15000 });
      const linhasVar = page.locator('#tabela_variacoes tbody tr');
      const totalVar = await linhasVar.count();
      let eanEncontrado = '';
      for (let j = 0; j < totalVar; j++) {
        // Colunas da tabela de variações: [0] thumb, [1] Variação,
        // [2] Código (SKU), [3] GTIN/EAN, ...
        const sku = (await linhasVar.nth(j).locator('td').nth(2).innerText()).trim();
        if (sku === ref) {
          eanEncontrado = (await linhasVar.nth(j).locator('td').nth(3).innerText()).trim();
          break;
        }
      }
      const fechar = page.locator('text=fechar').first();
      if (await fechar.count()) await fechar.click().catch(() => {});
      if (eanEncontrado) return eanEncontrado;
    }

    return '';
  } catch (err) {
    log(`Aviso: não consegui buscar o EAN do produto "${ref}": ${err.message}`);
    return '';
  }
}

// ---------------------------------------------------------------------------
// 2) Converte um registro do Tiny para o formato do Dr Chef Produção
// ---------------------------------------------------------------------------

// Palavras de gênero reconhecidas na descrição do produto
// (ex: "... MODELO 90 FEMININO ...").
const GENEROS = ['FEMININO', 'MASCULINO', 'UNISSEX', 'INFANTIL'];

// A partir do trecho de descrição entre o SKU e a cor/tamanho (ex:
// "DÓLMÃ MODELO 90 FEMININO OXFORD BRANCO"), extrai:
// - modelo: só "MODELO <número>" (ex: "MODELO 90")
// - nomeProduto: a palavra-chave do produto + gênero (ex: "DÓLMÃ FEMININO")
// Se não achar o padrão "MODELO <número>" na descrição, mantém o texto
// completo em ambos os campos (comportamento antigo), pra não perder
// informação em produtos fora do padrão — o time ajusta na tela como sempre.
function extrairModeloENome(descricaoModelo) {
  const textoOriginal = (descricaoModelo || '').trim();
  const matchModelo = textoOriginal.match(/MODELO\s*\d+/i);

  const generoRegex = new RegExp(`\\b(${GENEROS.join('|')})\\b`, 'i');
  const matchGenero = textoOriginal.match(generoRegex);
  const genero = matchGenero ? matchGenero[0].toUpperCase() : '';

  if (!matchModelo) {
    return { modelo: textoOriginal, nomeProduto: textoOriginal };
  }

  const modelo = matchModelo[0].toUpperCase().replace(/\s+/g, ' ');

  // Palavra-chave do produto = tudo antes de "MODELO", tirando o gênero caso
  // ele apareça antes do "MODELO" também (ex: "TOUCA UNISSEX MODELO 65...").
  let palavraChave = textoOriginal.slice(0, matchModelo.index);
  if (genero) {
    palavraChave = palavraChave.replace(new RegExp(`\\b${genero}\\b`, 'i'), '');
  }
  palavraChave = palavraChave.replace(/\s+/g, ' ').trim();

  const nomeProduto = genero ? `${palavraChave} ${genero}`.trim() : palavraChave;

  return { modelo, nomeProduto };
}

// A quantidade sempre vira número inteiro, sem vírgula — o Dr Chef só usa
// peças inteiras (ex: "6,00" vira "6", "10,50" vira "11" arredondado).
function formatarQuantidadeInteira(bruta) {
  if (bruta === null || bruta === undefined || bruta === '') return '';
  let texto = String(bruta).trim();
  if (texto.includes(',') && texto.includes('.')) {
    // formato brasileiro "1.234,50": ponto é separador de milhar, vírgula é decimal.
    texto = texto.replace(/\./g, '').replace(',', '.');
  } else if (texto.includes(',')) {
    // só vírgula: assume separador decimal ("6,00" -> "6.00").
    texto = texto.replace(',', '.');
  }
  const numero = parseFloat(texto);
  if (isNaN(numero)) return String(bruta).trim();
  return String(Math.round(numero));
}

function tinyParaDrChef(opTiny) {
  // skuDescricao vem como "SKU - MODELO - COR - TAMANHO" (o SKU vem colado
  // com a descrição, separado por " - "). Ex:
  // "5133G - DÓLMÃ MODELO 90 FEMININO OXFORD BRANCO - BRANCO - G"
  const partes = opTiny.skuDescricao.split(' - ').map(s => s.trim()).filter(Boolean);
  const ref = partes[0] || '';
  const resto = partes.slice(1); // [modelo, cor, tamanho] na maioria dos casos

  // ATENÇÃO: em alguns produtos cadastrados no Tiny a ordem "cor" / "tamanho"
  // sai trocada (depende de como foi digitado na hora do cadastro do produto).
  // Isso aqui é o melhor palpite automático — o time confere/ajusta esses
  // campos na tela do Dr Chef como já faz hoje, sem problema.
  const tamanho = resto.length >= 1 ? resto[resto.length - 1] : '';
  const cor = resto.length >= 2 ? resto[resto.length - 2] : '';
  const descricaoModelo = resto.length >= 3 ? resto.slice(0, -2).join(' - ') : (resto[0] || '');
  const { modelo, nomeProduto } = extrairModeloENome(descricaoModelo);

  const deadlineDate = opTiny.dataPrevistaTs
    ? new Date(Number(opTiny.dataPrevistaTs) * 1000).toISOString().slice(0, 10)
    : '';

  return {
    op: opTiny.numero,
    ref,
    modelo: modelo || ref,
    nomeProduto: nomeProduto || opTiny.skuDescricao || '',
    ean: opTiny.ean || '',
    qty: formatarQuantidadeInteira(opTiny.quantidade),
    size: tamanho,
    fabric: opTiny.fabric || '',
    color: cor,
    deadline: deadlineDate,
    priority: 'normal',
    obs: `Importado automaticamente do Tiny (OP ${opTiny.numero}).`,
    localizacao: '',
    tipoCliente: 'drchef',
    clienteB2bId: '',
    numeroPedido: '',
    obsCliente: '',
    iniciarEm: 'cortar',
  };
}

function genId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ---------------------------------------------------------------------------
// Data de corte: só consideramos OPs criadas a partir desta data (inclusive).
// OPs mais antigas que isso são ignoradas, mesmo que ainda estejam "em
// aberto" no Tiny e não existam no Dr Chef.
//
// Pode ser configurada com a variável de ambiente DATA_CORTE (formato
// AAAA-MM-DD). Se não for definida, usa o primeiro dia do mês atual.
// ---------------------------------------------------------------------------
function calcularDataDeCorte() {
  if (process.env.DATA_CORTE) {
    const d = new Date(process.env.DATA_CORTE + 'T00:00:00Z');
    if (!isNaN(d.getTime())) return d;
    log(`Aviso: DATA_CORTE="${process.env.DATA_CORTE}" não é uma data válida (use AAAA-MM-DD). Ignorando.`);
  }
  const agora = new Date();
  return new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), 1));
}

// ---------------------------------------------------------------------------
// 3) Programa principal
// ---------------------------------------------------------------------------
(async () => {
  const tinySessionB64 = precisaVar('TINY_SESSION_B64');
  const firebaseSaB64 = precisaVar('FIREBASE_SERVICE_ACCOUNT');

  // --- Firebase Admin ---
  const serviceAccountJson = JSON.parse(Buffer.from(firebaseSaB64, 'base64').toString('utf8'));
  admin.initializeApp({ credential: admin.credential.cert(serviceAccountJson) });
  const db = admin.firestore();

  // --- Tiny (Playwright) ---
  const storageStatePath = path.join(process.cwd(), '.tiny-session-runtime.json');
  fs.writeFileSync(storageStatePath, Buffer.from(tinySessionB64, 'base64').toString('utf8'));

  const browser = await chromium.launch({ headless: true });
  let context;
  let page;

  // 1) Verificação PROATIVA: a sessão salva está perto de expirar (ou já
  //    expirou)? Se sim, nem tenta usá-la — já faz login automático direto.
  const checagem = sessaoProximaDoVencimento(storageStatePath, RENEW_THRESHOLD_MINUTOS);
  if (checagem.precisaRenovar) {
    log(`Sessão salva perto de expirar (${checagem.motivo}). Renovando automaticamente antes de sincronizar...`);
    const resultado = await tentarLoginAutomatico(browser);
    if (!resultado.ok) {
      alertarFalhaCritica('Renovação automática (proativa) da sessão do Tiny falhou.', [
        `Status: ${resultado.status}`,
        `Detalhe: ${resultado.detalhe}`,
      ]);
      await browser.close();
      fs.unlinkSync(storageStatePath);
      process.exit(1);
    }
    context = resultado.context;
    page = resultado.page; // já está em TINY_LIST_URL, autenticado
  } else {
    log(`Checagem de validade da sessão: ${checagem.motivo}.`);
    context = await browser.newContext({ storageState: storageStatePath });
    page = await context.newPage();

    log('Abrindo lista de Ordens de Produção no Tiny...');
    await page.goto(TINY_LIST_URL, { waitUntil: 'networkidle' });

    // 2) Verificação REATIVA: mesmo sem sinal prévio de expiração, a sessão
    //    salva se mostrou inválida na prática agora? Tenta renovar sozinho.
    if (page.url().includes('login')) {
      log('A sessão salva do Tiny se mostrou inválida (fomos redirecionados para o login). Tentando renovação automática...');
      await context.close();
      const resultado = await tentarLoginAutomatico(browser);
      if (!resultado.ok) {
        alertarFalhaCritica('A sessão salva do Tiny expirou e a renovação automática (reativa) também falhou.', [
          `Status: ${resultado.status}`,
          `Detalhe: ${resultado.detalhe}`,
        ]);
        await browser.close();
        fs.unlinkSync(storageStatePath);
        process.exit(1);
      }
      context = resultado.context;
      page = resultado.page; // já está em TINY_LIST_URL, autenticado
    }
  }

  const opsTinyTodas = await extrairOpsDoTiny(page);
  log(`Total de OPs em aberto encontradas no Tiny: ${opsTinyTodas.length}`);

  // --- Aplica a data de corte (só OPs deste mês para frente, por padrão) ---
  const dataDeCorte = calcularDataDeCorte();
  log(`Data de corte: só considerando OPs criadas a partir de ${dataDeCorte.toISOString().slice(0, 10)}.`);
  const opsTiny = opsTinyTodas.filter(op => {
    if (!op.dataCriacaoTs) return false; // sem data de criação, não arrisca
    const dataCriacao = new Date(Number(op.dataCriacaoTs) * 1000);
    return dataCriacao >= dataDeCorte;
  });
  log(`OPs dentro da data de corte: ${opsTiny.length} (de ${opsTinyTodas.length} em aberto no total).`);

  // --- Busca quais OPs já existem no Dr Chef (Firestore) ---
  const ordersSnap = await db.collection('orders').get();
  const opsJaExistentes = new Set();
  ordersSnap.forEach(doc => {
    const data = doc.data();
    if (data && data.op) opsJaExistentes.add(String(data.op));
  });
  log(`OPs já cadastradas no Dr Chef: ${opsJaExistentes.size}`);

  // --- Descobre quais são realmente novas ---
  const novasOps = opsTiny.filter(op => op.numero && !opsJaExistentes.has(String(op.numero)));
  log(`OPs novas a criar: ${novasOps.length}`);

  // --- Para cada OP nova, busca o tecido e o EAN nas telas do Tiny ---
  for (const opTiny of novasOps) {
    opTiny.fabric = await buscarTecido(page, opTiny.idInternoTiny);
    if (opTiny.fabric) {
      log(`OP ${opTiny.numero}: tecido = "${opTiny.fabric}"`);
    } else {
      log(`OP ${opTiny.numero}: tecido não encontrado na Composição.`);
    }

    const ref = (opTiny.skuDescricao.split(' - ')[0] || '').trim();
    opTiny.ean = await buscarEAN(page, ref);
    if (opTiny.ean) {
      log(`OP ${opTiny.numero}: EAN = "${opTiny.ean}"`);
    } else {
      log(`OP ${opTiny.numero}: EAN não encontrado para o SKU "${ref}".`);
    }
  }

  await browser.close();

  // --- Cria as que faltam ---
  let criadas = 0;
  for (const opTiny of novasOps) {
    const form = tinyParaDrChef(opTiny);
    // ISO string (não epoch numérico) para bater com o formato que o próprio
    // app do Dr Chef usa em createdAt/updatedAt/history[].at em todo lugar.
    const now = new Date().toISOString();
    const novoDoc = {
      id: genId(),
      ...form,
      status: 'cortar', // coluna "A Cortar"
      createdAt: now,
      history: [{ type: 'created', status: 'cortar', at: now, by: 'sync-tiny' }],
    };

    await db.collection('orders').doc(novoDoc.id).set(novoDoc);
    criadas++;
    log(`Criada no Dr Chef: OP ${opTiny.numero} (${form.modelo} / ${form.color} / ${form.size})`);
  }

  log(`Sincronização concluída. ${criadas} OP(s) nova(s) criada(s) em "A Cortar".`);
  fs.unlinkSync(storageStatePath);
  process.exit(0);
})().catch(err => {
  console.error('Erro na sincronização:', err);
  process.exit(1);
});
