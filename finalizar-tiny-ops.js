/**
 * finalizar-tiny-ops.js  —  FASE 2 do sync (Tiny -> Dr Chef)
 * ---------------------------------------------------------------------------
 * A Fase 1 (sync-tiny-ops.js) traz OPs novas do Tiny pro quadro "A Cortar".
 * Esta Fase 2 faz o caminho de volta: quando uma OP chega na coluna
 * "Costura Finalizada" no Dr Chef, o robô abre a OP no Tiny e:
 *
 *   1. (se a quantidade que retornou da costura for diferente da planejada)
 *      edita a quantidade da OP no Tiny pra a quantidade conferida e marca
 *      a OP com a tag "estoque divergente".
 *   2. lança o estoque pela Ordem de Produção ("Lançar estoque" no menu da
 *      linha -> depósito "Geral" -> "Lançar"). O Tiny, sozinho, dá baixa nos
 *      insumos pela estrutura, dá entrada do produto acabado e sincroniza o
 *      estoque com os marketplaces.
 *   3. muda a situação da OP no Tiny pra "Finalizada".
 *
 * Depois grava flags no doc do Firestore pra nunca repetir (`tinyEstoqueLancado`).
 * As etapas seguintes do quadro (Caseado/Acabamento/Produto Acabado/Lançar
 * Estoque) continuam 100% manuais no Dr Chef — a Fase 2 não mexe nelas.
 *
 * O QUE ESTA FASE NÃO FAZ:
 *   - OP criada manualmente no Dr Chef (sem origem no Tiny) -> ignora.
 *   - OP que já teve `tinyEstoqueLancado === true` -> ignora.
 *   - Nunca "estorna" nada. Se algo der errado numa OP, para NELA, alerta e
 *     tenta de novo na próxima rodada (até TINY_ESTOQUE_MAX_TENTATIVAS).
 *
 * CONFIGURAÇÃO (variáveis de ambiente — todas opcionais):
 *   - TINY_ESTOQUE_ENABLED        "false" desliga a Fase 2 inteira. Padrão: ligada.
 *   - TINY_ESTOQUE_DRY_RUN        "true" = só simula: loga o que faria, não
 *                                 clica em nada que muda estado e não grava
 *                                 no Firestore.
 *   - TINY_ESTOQUE_SO_OP          números de OP separados por vírgula
 *                                 (ex "3526,3531"). Se preenchido, só processa
 *                                 essas. Bom pra testar numa OP só.
 *   - TINY_ESTOQUE_DEPOSITO       nome do depósito de entrada. Padrão "Geral".
 *   - TINY_ESTOQUE_MAX_TENTATIVAS depois de N falhas seguidas numa mesma OP,
 *                                 o robô marca `tinyEstoqueBloqueado` e para de
 *                                 tentar (precisa de olhar humano). Padrão 5.
 *
 * Seletores da tela do Tiny (erp.olist.com/ordens_producao), confirmados 2026-09-06:
 *   - lista .................... #tabelaListagem tbody tr  (tr.id = id interno da OP)
 *   - nº da OP ................. td[2]  (data-value ou texto)
 *   - situação ................ td[11] .icon-led  (icon-led-yellow=pendente,
 *                                -blue=em andamento, -green=finalizada, -grey=cancelada)
 *   - busca ................... #pesquisa-mini  + Enter
 *   - abrir menu "..." ........ tr  td .button-navigate
 *   - menu ................... .listaMenu.dropdown-menu  (compartilhado; itens <li>)
 *       "Lançar estoque" / "Estornar estoque" (um ou outro, conforme estado)
 *       .dropdown-item-situacoes .icon-led-green  (finalizar)
 *   - tela de edição ......... URL  #edit/<idInterno> ;  campo #quantidade ;
 *                              #botaoSalvar ; marcadores: input visível ao lado
 *                              do hidden #campoMarcacoesObjeto
 *   - painel "Depósitos" ..... <select> de depósito + botão "Lançar"
 */
'use strict';

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const TINY_LIST_URL = 'https://erp.olist.com/ordens_producao';
const DEBUG_DIR = path.join(process.cwd(), 'fase2-debug');

const CFG = {
  enabled: String(process.env.TINY_ESTOQUE_ENABLED || 'true').toLowerCase() !== 'false',
  dryRun: String(process.env.TINY_ESTOQUE_DRY_RUN || 'false').toLowerCase() === 'true',
  deposito: process.env.TINY_ESTOQUE_DEPOSITO || 'Geral',
  maxTentativas: Number(process.env.TINY_ESTOQUE_MAX_TENTATIVAS || 5),
  soOps: String(process.env.TINY_ESTOQUE_SO_OP || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  tagDivergente: 'estoque divergente',
};

// ---------------------------------------------------------------------------
// Helpers puros (sem browser)
// ---------------------------------------------------------------------------

// Sinal POSITIVO rápido de que a OP veio do Tiny (criada pela Fase 1). Só serve
// pra log — a decisão real de "é uma OP do Tiny?" é: existe na listagem do Tiny.
// (Muitos cards de OPs reais do Tiny foram criados à mão no app antes do sync
// rodar, então NÃO dá pra exigir essa marca.)
function temMarcaSyncTiny(dados) {
  if (Array.isArray(dados.history) && dados.history.some((h) => h && h.by === 'sync-tiny')) {
    return true;
  }
  if (typeof dados.obs === 'string' && /Importado automaticamente do Tiny/i.test(dados.obs)) {
    return true;
  }
  return false;
}

// "6" | 6 | "6,00" | "1.234,50" | " 2 " -> Number (NaN se não der)
function parseQtd(bruta) {
  if (bruta === null || bruta === undefined || bruta === '') return NaN;
  let texto = String(bruta).trim();
  if (texto.includes(',') && texto.includes('.')) {
    texto = texto.replace(/\./g, '').replace(',', '.'); // "1.234,50" BR
  } else if (texto.includes(',')) {
    texto = texto.replace(',', '.'); // "6,00"
  }
  return parseFloat(texto);
}

// Number -> "6,00" (formato que o campo Quantidade da OP do Tiny espera)
function formatQtdBR(n) {
  return Number(n).toFixed(2).replace('.', ',');
}

// Classe .icon-led-<cor> -> rótulo da situação da OP no Tiny.
function situacaoPelaClasse(className) {
  const c = String(className || '');
  if (/icon-led-green/.test(c)) return 'finalizada';
  if (/icon-led-blue/.test(c)) return 'em_andamento';
  if (/icon-led-(grey|gray)/.test(c)) return 'cancelada';
  if (/icon-led-yellow/.test(c)) return 'em_aberto';
  return 'desconhecida';
}

// ---------------------------------------------------------------------------
// Interações com a tela do Tiny (Playwright)
// ---------------------------------------------------------------------------

async function salvarPrintDebug(page, apelido) {
  try {
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const arq = path.join(DEBUG_DIR, `${Date.now()}-${apelido}.png`);
    await page.screenshot({ path: arq, fullPage: true });
    return arq;
  } catch (_) {
    return null;
  }
}

// Vai pra listagem, busca a OP pelo número e devolve { idInterno, situacao }.
// null => a busca respondeu e a OP não está no Tiny (tratar como OP local).
// Lança erro só se a busca não responder de jeito nenhum (problema transitório).
//
// IMPORTANTE (2 pegadinhas da tela de OPs do Tiny):
//  1) a tabela vem VAZIA numa sessão nova — é a própria busca que carrega a lista;
//  2) a sessão salva pode ter um filtro de situação (ex "Em aberto") no
//     localStorage. Se a OP no Tiny estiver "Finalizada"/"Em andamento", a busca
//     dentro desse filtro devolve "sem resultados". Por isso clicamos a aba
//     "Todas" antes de buscar, pra a busca cobrir qualquer situação.
async function acharLinhaDaOp(page, numeroOp, log) {
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    await page.goto(TINY_LIST_URL, { waitUntil: 'domcontentloaded' });
    if (page.url().includes('login')) throw new Error('SESSAO_EXPIROU_NO_MEIO');

    try {
      await page.waitForSelector('#pesquisa-mini', { state: 'visible', timeout: 20000 });
    } catch (e) {
      if (tentativa === 3) throw new Error('a tela de OPs do Tiny não carregou (campo de busca ausente após 3 tentativas)');
      await page.waitForTimeout(2000);
      continue;
    }

    // Limpa o filtro de situação: clica a aba "Todas".
    try {
      const abaTodas = page
        .locator('a.item-sit')
        .filter({ hasText: /^\s*Todas\b/i })
        .first();
      if (await abaTodas.count()) {
        await abaTodas.click();
        await page.waitForTimeout(1500);
      }
    } catch (e) {
      log(`[Fase 2] OP ${numeroOp}: não consegui clicar na aba "Todas" (${e.message}) — sigo assim mesmo.`);
    }

    await page.fill('#pesquisa-mini', '');
    await page.fill('#pesquisa-mini', String(numeroOp));
    // Dois gatilhos: Enter no campo e o botão de lupa (onclick="listar();").
    // O botão é o mais confiável; o Enter é reforço.
    await page.locator('#pesquisa-mini').press('Enter').catch(() => {});
    const botaoBusca = page.locator('button:has(i.fa-search), .input-group-btn button').first();
    if (await botaoBusca.count()) {
      await botaoBusca.click().catch(() => {});
    }

    // Espera a busca responder: OU aparece linha, OU aparece "sem resultados".
    let respondeu = true;
    try {
      await page.waitForFunction(
        () => {
          const rows = document.querySelectorAll('#tabelaListagem tbody tr').length;
          const semRes = /não retornou resultados|nao retornou resultados|nenhum registro/i.test(
            document.body.innerText
          );
          return rows > 0 || semRes;
        },
        { timeout: 15000 }
      );
    } catch (e) {
      respondeu = false;
    }
    await page.waitForTimeout(800);

    const res = await page.evaluate((num) => {
      const linhas = Array.from(document.querySelectorAll('#tabelaListagem tbody tr'));
      let match = null;
      for (const tr of linhas) {
        const tds = tr.querySelectorAll('td');
        const cel = tds[2];
        if (!cel) continue;
        const valor = (cel.getAttribute('data-value') || cel.textContent || '').trim();
        if (valor === String(num)) {
          const led = tds[11] ? tds[11].querySelector('.icon-led') : null;
          // td[10] = coluna "Integrações": ganha um selo .estoque_lancado / "E" /
          // original-title="Estoque lançado" quando o estoque foi lançado.
          const tdInteg = tds[10];
          const estoqueLancado = !!(
            tdInteg &&
            (tdInteg.querySelector('.estoque_lancado, [original-title*="stoque lan" i]') ||
              /estoque lan[çc]ado/i.test(tdInteg.getAttribute('original-title') || '') ||
              tdInteg.textContent.trim().toUpperCase() === 'E')
          );
          match = {
            idInterno: tr.id || null,
            ledClass: led ? led.className : '',
            estoqueLancado,
          };
          break;
        }
      }
      const semRes = /não retornou resultados|nao retornou resultados|nenhum registro/i.test(
        document.body.innerText
      );
      return { total: linhas.length, match, semRes };
    }, numeroOp);

    if (res.match && res.match.idInterno) {
      return {
        idInterno: res.match.idInterno,
        situacao: situacaoPelaClasse(res.match.ledClass),
        estoqueLancado: res.match.estoqueLancado,
      };
    }
    if (res.semRes || (respondeu && res.total > 0)) {
      log(`[Fase 2] OP ${numeroOp}: a busca no Tiny respondeu e a OP não apareceu (linhas=${res.total}, semResultado=${res.semRes}).`);
      return null;
    }
    // Não respondeu (nem linha, nem "sem resultados") — problema transitório, tenta de novo.
    if (tentativa === 3) {
      throw new Error('a busca de OPs no Tiny não respondeu após 3 tentativas');
    }
    log(`[Fase 2] OP ${numeroOp}: busca no Tiny não respondeu (tentativa ${tentativa}/3), repetindo...`);
    await page.waitForTimeout(2000);
  }
  return null;
}

// Localizador da linha (id numérico -> precisa de seletor de atributo, não "#123").
function linhaLocator(page, idInterno) {
  return page.locator(`#tabelaListagem tbody tr[id="${idInterno}"]`);
}

// O menu "..." do Tiny é um jQuery contextMenu compartilhado (#jqContextMenu).
// Quando aberto, tem a classe "open" e fica POR CIMA de tudo — se não fechar,
// intercepta o clique do botão da próxima linha. E o Escape NÃO fecha: só
// fecha clicando fora (ex: no campo de busca).

async function menuEstaAberto(page) {
  return page.evaluate(() => {
    const m = document.querySelector('#jqContextMenu');
    return !!(m && /\bopen\b/.test(m.className));
  });
}

async function fecharMenu(page) {
  for (let i = 0; i < 4; i++) {
    if (!(await menuEstaAberto(page))) return;
    await page.locator('#pesquisa-mini').click({ force: true }).catch(() => {});
    await page.waitForTimeout(300);
  }
}

// Abre o menu "..." da linha. Fecha qualquer menu aberto ANTES (o menu é
// compartilhado). Retry porque às vezes não abre no 1º clique.
async function abrirMenuDaLinha(page, idInterno) {
  const gatilho = linhaLocator(page, idInterno).locator('td .button-navigate').first();
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    await fecharMenu(page);
    await gatilho.scrollIntoViewIfNeeded().catch(() => {});
    await gatilho.click({ force: true }).catch(() => {});
    try {
      await page.waitForFunction(
        () => {
          const m = document.querySelector('#jqContextMenu');
          if (!m || !/\bopen\b/.test(m.className)) return false;
          return m.querySelectorAll('li').length > 0;
        },
        { timeout: 4000 }
      );
      await page.waitForTimeout(300);
      return;
    } catch (e) {
      if (tentativa === 3) throw new Error('não consegui abrir o menu "..." da OP');
      await page.waitForTimeout(600);
    }
  }
}

// Clica um item do menu (pelo texto). O <li> não tem <a> — o clique é no <li>.
// Feito via evaluate porque o menu do Tiny é jQuery com delegação de eventos.
async function clicarItemMenu(page, regexTexto) {
  const ok = await page.evaluate((re) => {
    const rx = new RegExp(re, 'i');
    const li = [...document.querySelectorAll('#jqContextMenu li')].find(
      (el) =>
        rx.test(el.textContent.trim()) &&
        getComputedStyle(el).display !== 'none' &&
        el.getBoundingClientRect().width > 0
    );
    if (!li) return false;
    (li.querySelector('a') || li).click();
    return true;
  }, regexTexto);
  if (!ok) throw new Error(`item de menu "${regexTexto}" não encontrado/visível`);
  await page.waitForTimeout(600);
}

// Com o menu aberto: "Lançar estoque" visível => ainda não lançou;
// "Estornar estoque" visível => já lançado. Retenta algumas vezes porque o menu
// pode estar renderizando/animando quando a primeira leitura acontece.
async function lerEstadoDoEstoquePeloMenu(page) {
  for (let i = 1; i <= 4; i++) {
    const estado = await page.evaluate(() => {
      const lis = [...document.querySelectorAll('#jqContextMenu li')];
      const visivel = (txt) =>
        lis.some(
          (li) =>
            new RegExp('^\\s*' + txt + '\\s*$', 'i').test(li.textContent.trim()) &&
            getComputedStyle(li).display !== 'none' &&
            li.getBoundingClientRect().width > 0
        );
      if (visivel('Estornar estoque')) return 'lancado';
      if (visivel('Lançar estoque')) return 'nao_lancado';
      return 'indeterminado';
    });
    if (estado !== 'indeterminado') return estado;
    await page.waitForTimeout(500);
  }
  return 'indeterminado';
}

// Edita a quantidade da OP no Tiny + adiciona um marcador, na tela #edit/<id>.
// Usado só quando a quantidade conferida difere da planejada.
async function editarQuantidadeEMarcador(page, idInterno, novaQtd, marcador, log) {
  await page.goto(`${TINY_LIST_URL}#edit/${idInterno}`, { waitUntil: 'domcontentloaded' });
  await page.locator('#quantidade').waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(800);

  const antes = await page.locator('#quantidade').inputValue();
  await page.locator('#quantidade').fill(formatQtdBR(novaQtd));
  await page.locator('#quantidade').press('Tab'); // dispara o recálculo da estrutura

  // Marcadores: o bloco tem o hidden #campoMarcacoesObjeto + um input visível de
  // tag (jQuery UI autocomplete). Acha o bloco pelo label "Marcadores".
  try {
    const grupoMarc = page
      .locator('.form-group, .field, .campo, fieldset, div')
      .filter({ has: page.locator('label', { hasText: /^\s*marcadores\s*$/i }) })
      .filter({ has: page.locator('#campoMarcacoesObjeto') })
      .first();
    const inputMarc = grupoMarc.locator('input:not([type="hidden"]):visible').first();
    if (await inputMarc.count()) {
      const jaTem = (await grupoMarc.innerText().catch(() => ''))
        .toLowerCase()
        .includes(marcador.toLowerCase());
      if (!jaTem) {
        await inputMarc.click();
        await inputMarc.type(marcador, { delay: 20 });
        await inputMarc.press(','); // "separados por vírgula ou tab"
        await page.waitForTimeout(300);
      }
    } else {
      log(`[Fase 2] OP interna ${idInterno}: campo de marcadores não achado na edição — sigo sem a tag.`);
    }
  } catch (e) {
    log(`[Fase 2] OP interna ${idInterno}: não consegui adicionar o marcador "${marcador}" (${e.message}) — sigo sem ele.`);
  }

  await page.locator('#botaoSalvar').click();
  await aceitarConfirmacaoSeAparecer(page);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1600);
  log(`[Fase 2] OP interna ${idInterno}: quantidade ${antes} -> ${formatQtdBR(novaQtd)}, marcador "${marcador}".`);
}

// Menu "..." -> "Lançar estoque" -> painel "Depósitos" -> depósito -> "Lançar".
// Só deve ser chamada quando a linha NÃO tem o selo "estoque lançado" (o
// chamador checa). Não lê o estado pelo menu (era frágil no headless).
async function lancarEstoque(page, numeroOp, idInterno, log) {
  await abrirMenuDaLinha(page, idInterno);

  // Segurança extra: se por acaso o menu mostrar "Estornar estoque" (já lançado),
  // NÃO clica (clicar estornaria). Aborta como "já estava".
  const estado = await lerEstadoDoEstoquePeloMenu(page);
  if (estado === 'lancado') {
    await fecharMenu(page);
    log(`[Fase 2] OP ${numeroOp}: menu mostrou "Estornar estoque" — estoque já lançado, pulando.`);
    return 'ja_estava';
  }

  await clicarItemMenu(page, '^\\s*Lançar estoque\\s*$');

  const botaoLancar = page.getByRole('button', { name: /^\s*Lançar\s*$/i });
  await botaoLancar.waitFor({ state: 'visible', timeout: 10000 });

  const selectDeposito = page.locator('select:visible').first();
  if (await selectDeposito.count()) {
    try {
      await selectDeposito.selectOption({ label: CFG.deposito });
    } catch (_) {
      log(`[Fase 2] OP ${numeroOp}: depósito "${CFG.deposito}" não encontrado na lista — mantendo o selecionado.`);
    }
  }

  await botaoLancar.click();
  await aceitarConfirmacaoSeAparecer(page);

  // Espera o painel "Depósitos" sumir (= o lançamento foi processado).
  try {
    await page.getByRole('button', { name: /^\s*Lançar\s*$/i }).waitFor({ state: 'hidden', timeout: 15000 });
  } catch (e) {
    throw new Error('cliquei "Lançar" mas o painel de depósito não fechou (lançamento pode não ter completado)');
  }
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(2500);

  // NÃO reabrimos o menu pra "confirmar": essa checagem era frágil (o menu às
  // vezes não renderiza a tempo e dava falso-negativo mesmo com o estoque já
  // lançado). A proteção contra lançar 2x é o pré-check no INÍCIO desta função
  // (menu mostra "Estornar estoque" => já lançado => pula) + o Tiny, que não
  // lança o mesmo estoque duas vezes.
  log(`[Fase 2] OP ${numeroOp}: cliquei "Lançar" (depósito "${CFG.deposito}") — painel fechou.`);
  return 'lancado_agora';
}

// Menu "..." -> "Alterar situação" -> bolinha verde (Finalizada).
// Devolve true/false (conseguiu confirmar a mudança pela situação da linha).
async function finalizarSituacao(page, numeroOp, idInterno, situacaoAtual, log) {
  if (situacaoAtual === 'finalizada') {
    log(`[Fase 2] OP ${numeroOp}: já estava "Finalizada" no Tiny.`);
    return true;
  }

  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    await abrirMenuDaLinha(page, idInterno);
    const cliqueiVerde = await page.evaluate(() => {
      const dot = document.querySelector(
        '#jqContextMenu .dropdown-item-situacoes .icon-led-green'
      );
      if (!dot) return false;
      // dispara um clique "de verdade" (o handler do Tiny é jQuery)
      const opts = { bubbles: true, cancelable: true, view: window };
      dot.dispatchEvent(new MouseEvent('mousedown', opts));
      dot.dispatchEvent(new MouseEvent('mouseup', opts));
      dot.dispatchEvent(new MouseEvent('click', opts));
      if (typeof dot.click === 'function') dot.click();
      return true;
    });
    if (!cliqueiVerde) {
      await fecharMenu(page);
      throw new Error('bolinha verde (Finalizada) não encontrada no menu "alterar situação"');
    }
    await page.waitForTimeout(700);
    await aceitarConfirmacaoSeAparecer(page);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(2000);
    await fecharMenu(page);

    const rel = await acharLinhaDaOp(page, numeroOp, log).catch(() => null);
    if (rel && rel.situacao === 'finalizada') {
      log(`[Fase 2] OP ${numeroOp}: situação -> "Finalizada" no Tiny.`);
      return true;
    }
    if (rel && rel.idInterno) idInterno = rel.idInterno;
    log(`[Fase 2] OP ${numeroOp}: cliquei em Finalizada (tentativa ${tentativa}/2), situação ainda "${rel ? rel.situacao : 'sem leitura'}".`);
  }
  return false;
}

// Aceita modais de confirmação do Tiny (bootbox / sweetalert / modal comum).
// Escopo restrito a containers de diálogo pra nunca clicar num botão solto da
// página. O confirm nativo do navegador é tratado pelo handler page.on('dialog').
async function aceitarConfirmacaoSeAparecer(page) {
  try {
    const dialogo = page
      .locator(
        '.bootbox.modal:visible, .modal.in:visible, .modal.show:visible, .swal2-container:visible, [role="dialog"]:visible'
      )
      .first();
    await dialogo.waitFor({ state: 'visible', timeout: 2500 });
    const btn = dialogo.getByRole('button', {
      name: /^(sim|ok|confirmar|confirmo|continuar|prosseguir)$/i,
    });
    if (await btn.count()) {
      await btn.first().click();
      await page.waitForTimeout(500);
    }
  } catch (_) {
    /* nenhuma confirmação apareceu */
  }
}

// ---------------------------------------------------------------------------
// Orquestração
// ---------------------------------------------------------------------------

async function processarUmaOp({ page, log }, docSnap) {
  const dados = docSnap.data();
  const numeroOp = String(dados.op || '').trim();
  const rotulo = `OP ${numeroOp} (${dados.ref || '?'} / ${dados.color || '?'} / ${dados.size || '?'})`;
  if (!numeroOp) throw new Error('doc sem número de OP (campo "op" vazio)');

  const qtdConferida = parseQtd(
    dados.costura_qtdRetornou != null && dados.costura_qtdRetornou !== ''
      ? dados.costura_qtdRetornou
      : dados.qty
  );
  if (!Number.isFinite(qtdConferida) || qtdConferida <= 0) {
    throw new Error(`quantidade conferida inválida (costura_qtdRetornou=${dados.costura_qtdRetornou}, qty=${dados.qty})`);
  }
  const qtdPlanejada = parseQtd(dados.qty);
  const divergente = dados.costura_qtdDivergente === true || qtdConferida !== qtdPlanejada;

  const marca = temMarcaSyncTiny(dados) ? ' [tem marca sync-tiny]' : '';
  log(`[Fase 2] ${rotulo}${marca}: conferida=${qtdConferida}, planejada=${qtdPlanejada}, divergente=${divergente}.`);

  let linha = await acharLinhaDaOp(page, numeroOp, log);
  if (!linha) {
    log(`[Fase 2] ${rotulo}: não existe no Tiny — tratada como OP local/manual. Ignorada (nenhuma flag gravada; se aparecer no Tiny depois, será processada).`);
    return { ignoradaLocal: true };
  }

  if (CFG.dryRun) {
    log(`[Fase 2] [DRY-RUN] ${rotulo}: FARIA -> ${divergente ? `editar qtd p/ ${qtdConferida} + tag "${CFG.tagDivergente}"; ` : ''}lançar estoque (depósito ${CFG.deposito}); finalizar (situação atual no Tiny: ${linha.situacao}). Nada alterado.`);
    return { dryRun: true };
  }

  // Estado do estoque = selo na coluna "Integrações" da linha (confiável no
  // headless, ao contrário de ler o menu).
  const jaLancado = linha.estoqueLancado === true;
  log(`[Fase 2] ${rotulo}: no Tiny -> situação=${linha.situacao}, estoque ${jaLancado ? 'JÁ LANÇADO' : 'não lançado'}.`);

  // 1) Divergência -> ajusta quantidade + tag, antes de lançar (só se ainda não lançou).
  if (!jaLancado && divergente) {
    await editarQuantidadeEMarcador(page, linha.idInterno, qtdConferida, CFG.tagDivergente, log);
    linha = await acharLinhaDaOp(page, numeroOp, log);
    if (!linha) throw new Error('OP sumiu da listagem depois de editar a quantidade');
  }

  // 2) Lança o estoque (Tiny cuida de baixa de insumo + entrada + marketplace).
  let resultadoLancamento;
  if (jaLancado) {
    resultadoLancamento = 'ja_estava';
    log(`[Fase 2] ${rotulo}: estoque já constava lançado — pulando o lançamento.`);
  } else {
    resultadoLancamento = await lancarEstoque(page, numeroOp, linha.idInterno, log);
  }

  // 3) Finaliza a situação.
  linha = await acharLinhaDaOp(page, numeroOp, log);
  const finalizou = linha
    ? await finalizarSituacao(page, numeroOp, linha.idInterno, linha.situacao, log)
    : false;
  if (!finalizou) {
    // Estoque já foi lançado (o principal). A finalização é secundária — avisa
    // no run mas não trava a OP nem repete o lançamento.
    console.log(`::warning::Fase 2: OP ${numeroOp} teve o estoque lançado no Tiny, mas não consegui confirmar a mudança de situação para "Finalizada". Confira na mão.`);
  }

  // 4) Grava as flags no Firestore.
  const agora = new Date().toISOString();
  await docSnap.ref.update({
    tinyEstoqueLancado: true,
    tinyEstoqueLancadoAt: agora,
    tinyEstoqueLancadoQtd: qtdConferida,
    tinyEstoqueDivergente: divergente,
    tinyOpFinalizada: finalizou,
    tinyEstoqueBloqueado: admin.firestore.FieldValue.delete(),
    tinyEstoqueTentativas: admin.firestore.FieldValue.delete(),
    tinyEstoqueUltimoErro: admin.firestore.FieldValue.delete(),
    history: admin.firestore.FieldValue.arrayUnion({
      type: 'tiny-estoque',
      at: agora,
      by: 'sync-tiny',
      qtd: qtdConferida,
      divergente,
      finalizada: finalizou,
      lancamento: resultadoLancamento,
    }),
  });

  log(`[Fase 2] ${rotulo}: OK — estoque ${resultadoLancamento}, finalizada=${finalizou}, divergente=${divergente}.`);
  return { ok: true, finalizou, divergente };
}

async function registrarFalha({ log, alertarFalhaCritica }, docSnap, err) {
  const dados = docSnap.data();
  const numeroOp = String(dados.op || '').trim();
  const tentativas = Number(dados.tinyEstoqueTentativas || 0) + 1;

  const patch = {
    tinyEstoqueTentativas: tentativas,
    tinyEstoqueUltimoErro: `${new Date().toISOString()} — ${err.message}`,
  };
  const bloqueou = tentativas >= CFG.maxTentativas;
  if (bloqueou) patch.tinyEstoqueBloqueado = true;

  try {
    await docSnap.ref.update(patch);
  } catch (e) {
    log(`[Fase 2] OP ${numeroOp}: nem a falha consegui registrar no Firestore: ${e.message}`);
  }
  log(`[Fase 2] OP ${numeroOp}: FALHOU (tentativa ${tentativas}/${CFG.maxTentativas}) — ${err.message}`);

  if (bloqueou) {
    alertarFalhaCritica(
      `Fase 2: OP ${numeroOp} falhou ${tentativas}x ao lançar estoque no Tiny e foi BLOQUEADA (precisa de ação manual).`,
      [
        `Último erro: ${err.message}`,
        `A OP segue em "Costura Finalizada" no Dr Chef; o estoque NÃO foi lançado no Tiny.`,
        `Depois de resolver: lance/finalize na mão no Tiny e marque "tinyEstoqueLancado: true" no doc; OU só apague "tinyEstoqueBloqueado" pra o robô tentar de novo.`,
      ]
    );
  }
}

/**
 * Ponto de entrada — chamado pelo sync-tiny-ops.js com a página já autenticada.
 * NUNCA lança pra fora: qualquer erro é logado/alertado e a rodada segue.
 */
async function finalizarOpsCosturaFinalizada({ page, db, log, alertarFalhaCritica }) {
  // A Fase 2 roda quando: está ligada (TINY_ESTOQUE_ENABLED), OU é simulação
  // (DRY_RUN — não altera nada), OU você pediu OPs específicas no "Run workflow"
  // (TINY_ESTOQUE_SO_OP — é justamente o modo de testar 1 OP com a feature ainda
  // desligada).
  if (!CFG.enabled && !CFG.dryRun && !CFG.soOps.length) {
    log('[Fase 2] desligada (TINY_ESTOQUE_ENABLED=false e sem DRY_RUN / SO_OP).');
    return;
  }
  log(
    `[Fase 2] iniciando${CFG.dryRun ? ' (DRY-RUN — nada será alterado)' : ''}` +
      `${CFG.soOps.length ? ` — só as OPs: ${CFG.soOps.join(', ')}` : ''}.`
  );

  const aceitarDialogo = (dialog) => dialog.accept().catch(() => {});
  page.on('dialog', aceitarDialogo);

  try {
    const snap = await db.collection('orders').where('status', '==', 'costuraFinalizada').get();
    log(`[Fase 2] ${snap.size} OP(s) com status "costuraFinalizada" no Firestore.`);

    const candidatas = [];
    snap.forEach((docSnap) => {
      const d = docSnap.data();
      const num = String(d.op || '(sem número)').trim();
      const motivos = [];
      if (d.tinyEstoqueLancado === true) motivos.push('já lançado (tinyEstoqueLancado)');
      if (d.tinyEstoqueBloqueado === true) motivos.push('bloqueado (tinyEstoqueBloqueado)');
      if (!num || num === '(sem número)') motivos.push('sem número de OP');
      if (CFG.soOps.length && !CFG.soOps.includes(num)) motivos.push(`fora do filtro TINY_ESTOQUE_SO_OP (${CFG.soOps.join(',')})`);
      if (motivos.length) {
        log(`[Fase 2]   OP ${num}: pulada — ${motivos.join('; ')}`);
        return;
      }
      candidatas.push(docSnap);
    });

    if (!candidatas.length) {
      log('[Fase 2] nenhuma OP em "Costura Finalizada" pendente de lançamento.');
      return;
    }
    log(
      `[Fase 2] ${candidatas.length} OP(s) candidata(s): ${candidatas.map((d) => d.data().op).join(', ')}. ` +
        `Cada uma só é processada se existir na listagem do Tiny (senão = OP local/manual, ignorada).`
    );

    for (const docSnap of candidatas) {
      try {
        await processarUmaOp({ page, log }, docSnap);
      } catch (err) {
        if (err && err.message === 'SESSAO_EXPIROU_NO_MEIO') {
          alertarFalhaCritica('Fase 2: a sessão do Tiny expirou no meio do processamento.', [
            'As OPs restantes desta rodada não foram processadas; a próxima rodada tenta de novo.',
          ]);
          break;
        }
        await salvarPrintDebug(page, `op-${String(docSnap.data().op || 'x')}-erro`);
        await registrarFalha({ log, alertarFalhaCritica }, docSnap, err);
      }
    }
  } catch (err) {
    alertarFalhaCritica('Fase 2 (lançar estoque no Tiny) falhou por completo.', [err.message]);
  } finally {
    page.off('dialog', aceitarDialogo);
    log('[Fase 2] fim.');
  }
}

module.exports = {
  finalizarOpsCosturaFinalizada,
  _internos: { temMarcaSyncTiny, parseQtd, formatQtdBR, situacaoPelaClasse },
};
