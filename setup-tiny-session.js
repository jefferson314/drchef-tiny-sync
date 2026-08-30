/**
 * setup-tiny-session.js
 * ---------------------------------------------------------------------------
 * Rode este script UMA VEZ, no seu computador (não no servidor/GitHub Actions),
 * para gerar o arquivo "tiny-session.json" que guarda sua sessão já logada no
 * Tiny (Olist ERP). O script de sincronização (sync-tiny-ops.js) usa esse
 * arquivo para acessar o Tiny sem precisar guardar sua senha em lugar nenhum.
 *
 * Como usar:
 *   1) npm install
 *   2) npx playwright install chromium
 *   3) node setup-tiny-session.js
 *   4) Uma janela do Chrome vai abrir no login do Tiny. Faça login normalmente
 *      (usuário, senha, e o que mais o Tiny pedir — 2FA, etc).
 *   5) Depois de logado e com a tela de Ordens de Produção carregando certinho,
 *      volte aqui no terminal e aperte ENTER.
 *   6) O arquivo tiny-session.json vai ser criado nesta pasta.
 *
 * Esse arquivo (tiny-session.json) é sensível — ele dá acesso à sua conta do
 * Tiny enquanto a sessão durar. NÃO suba ele para o Git. Ele deve ir apenas
 * para o GitHub Secrets (veja o README.md) em formato base64.
 *
 * De tempos em tempos (o Tiny pode expirar a sessão), talvez seja preciso
 * rodar este script de novo e atualizar o secret no GitHub.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const readline = require('readline');

function esperarEnter(pergunta) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(pergunta, () => { rl.close(); resolve(); }));
}

(async () => {
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

   await page.goto('https://erp.olist.com/ordens_producao');

   console.log('\n=== Faça login no Tiny na janela que abriu. ===');
    await esperarEnter('Depois de logar e ver a lista de Ordens de Produção, aperte ENTER aqui...\n');

   await context.storageState({ path: 'tiny-session.json' });
    console.log('Sessão salva em tiny-session.json');

   await browser.close();
})();
