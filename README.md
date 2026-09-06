# Sincronização automática: Tiny ↔ Dr Chef Produção

Roda sozinho, de graça, a cada 20 minutos, usando o GitHub Actions (não
precisa de servidor nem de deixar seu computador ligado). São duas fases:

**Fase 1 — Tiny → Dr Chef (`sync-tiny-ops.js`):** verifica as Ordens de
Produção "em aberto" no Tiny (Olist ERP) e cria automaticamente um card na
coluna **"A Cortar"** do Dr Chef para cada OP que ainda não existir por lá.
Depois disso, o time preenche tudo normalmente no Dr Chef — a automação só
cuida da etapa chata de digitar os dados iniciais.

**Fase 2 — Dr Chef → Tiny (`finalizar-tiny-ops.js`):** quando uma OP chega na
coluna **"Costura Finalizada"** no Dr Chef, o robô abre a OP no Tiny, **lança
o estoque pela Ordem de Produção** (o Tiny sozinho dá baixa nos insumos pela
estrutura, dá entrada do produto acabado e sincroniza com os marketplaces) e
muda a situação da OP para **"Finalizada"**. Se a quantidade que voltou da
costura for diferente da planejada, o robô primeiro **corrige a quantidade da
OP no Tiny** e marca a OP com a tag **"estoque divergente"**. As etapas
seguintes do quadro (Caseado / Acabamento / Produto Acabado / Lançar Estoque)
seguem 100% manuais no Dr Chef — a Fase 2 não mexe nelas.

> A Fase 2 só age em OPs que vieram do Tiny (criadas pela Fase 1). OP criada
> manualmente no Dr Chef é ignorada. Cada OP é lançada **uma única vez**
> (flag `tinyEstoqueLancado` no doc do Firestore).

## Por que tudo isso é "lendo a tela" e não via API

O Tiny/Olist tem uma API oficial, mas ela **não** tem nenhum endpoint para
Ordens de Produção (conferimos isso direto na tela de cadastro de aplicativo
da API do Tiny). Por isso a única forma de automatizar — nas duas fases — é
"ler a tela" da lista de Ordens de Produção, com um navegador automatizado
(Playwright) rodando escondido.

## O que você precisa

- Uma conta no GitHub (gratuita) — se ainda não tem, é só criar em github.com.
- Node.js instalado no seu computador, só para o passo único de configuração
  (não precisa ficar rodando nada localmente depois).
- Acesso ao Firebase Console do projeto `drchef-producao` (você já tem).

## Passo a passo

### 1. Baixe o Node.js (se ainda não tiver)

https://nodejs.org — baixe a versão "LTS" e instale normalmente.

### 2. Crie um repositório no GitHub

- Crie um repositório novo, por exemplo `drchef-tiny-sync`.
- Marque como **público**. Isso é importante: repositórios públicos têm
  minutos ilimitados e gratuitos no GitHub Actions; privados têm um limite
  mensal que essa sincronização (rodando a cada 20 min) estouraria rápido.
  Não tem problema de segurança em deixar público — nenhuma senha ou chave
  fica no código, tudo isso vai em "Secrets" (que ficam escondidos mesmo em
  repositório público).

### 3. Suba os arquivos desta pasta para o repositório

Pelo site do GitHub mesmo (botão "Add file" → "Upload files") ou via git,
como preferir. Estrutura final esperada:

```
.github/workflows/sync.yml
package.json
sync-tiny-ops.js          <- Fase 1 (Tiny -> Dr Chef)
finalizar-tiny-ops.js     <- Fase 2 (Dr Chef -> Tiny)
setup-tiny-session.js
.gitignore
README.md
```

### 4. Gere a chave da conta de serviço do Firebase

1. Abra o [Firebase Console](https://console.firebase.google.com/project/drchef-producao/settings/serviceaccounts/adminsdk).
2. Vá em **Configurações do projeto → Contas de serviço**.
3. Clique em **"Gerar nova chave privada"**. Um arquivo `.json` será baixado.
4. Converta esse arquivo para base64. No Windows, abra o PowerShell na pasta
   onde o arquivo foi baixado e rode (troque pelo nome real do arquivo):

   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("drchef-producao-firebase-adminsdk-xxxxx.json")) | Set-Clipboard
   ```

   Isso já copia o resultado para a área de transferência.

**Guarde esse arquivo `.json` com cuidado (ou apague depois de usar) — ele dá
acesso total ao banco de dados, sem passar pelas regras de segurança.**

### 5. Gere a sessão logada do Tiny

Isso evita guardar sua senha do Tiny em qualquer lugar: você loga uma vez,
manualmente, numa janela de navegador que o script abre, e ele salva só os
"cookies" dessa sessão.

No seu computador, dentro da pasta do projeto:

```
npm install
npx playwright install chromium
node setup-tiny-session.js
```

Uma janela do Chrome vai abrir na tela de Ordens de Produção do Tiny. Faça
login normalmente. Depois de ver a listagem carregada, volte ao terminal e
aperte ENTER. Isso cria o arquivo `tiny-session.json`.

Converta esse arquivo para base64 também (mesmo comando de antes, trocando o
nome do arquivo):

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("tiny-session.json")) | Set-Clipboard
```

### 6. Cadastre os dois "Secrets" no GitHub

No repositório: **Settings → Secrets and variables → Actions → New
repository secret**. Crie dois secrets:

| Nome | Valor |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | o base64 do passo 4 |
| `TINY_SESSION_B64` | o base64 do passo 5 |

### 7. Pronto

O GitHub já vai rodar a sincronização automaticamente a cada 20 minutos.
Para conferir se está funcionando (ou forçar uma execução na hora), vá na
aba **Actions** do repositório, clique em "Sincronizar OPs do Tiny com o Dr
Chef Produção" e depois em "Run workflow". Os logs de cada execução mostram
quantas OPs foram encontradas e quantas foram criadas.

## Manutenção

- **A sessão do Tiny pode expirar** de tempos em tempos (o Tiny pode
  derrubar sessões antigas por segurança). Se os logs do GitHub Actions
  começarem a mostrar o erro "a sessão salva do Tiny expirou", é só repetir
  o passo 5 e atualizar o secret `TINY_SESSION_B64` com o novo valor.
- **Se o Tiny mudar o layout da tela de Ordens de Produção**, a extração
  pode parar de funcionar. Os logs do Actions mostram o erro nesse caso.

## Data de corte (só OPs deste mês para frente)

Por padrão, o `.github/workflows/sync.yml` já vem configurado com
`DATA_CORTE: '2026-08-01'` — ou seja, só entram no Dr Chef as OPs criadas no
Tiny a partir de 1º de agosto de 2026 (quando essa automação foi feita).
OPs mais antigas que isso são ignoradas, mesmo que ainda apareçam como "em
aberto" no Tiny.

Para mudar essa data no futuro, é só editar o valor de `DATA_CORTE` direto
no arquivo `.github/workflows/sync.yml` (formato `AAAA-MM-DD`) e salvar —
não precisa mexer em Secrets nem reinstalar nada.

## Fase 2: lançar estoque no Tiny (Costura Finalizada)

Configurada por variáveis de ambiente no `.github/workflows/sync.yml`
(todas opcionais):

| Variável | Padrão | O que faz |
|---|---|---|
| `TINY_ESTOQUE_ENABLED` | `true` | `false` desliga a Fase 2 (a Fase 1 continua). |
| `TINY_ESTOQUE_DRY_RUN` | `false` | `true` = só simula: loga o que faria, não clica em nada nem grava no Firestore. |
| `TINY_ESTOQUE_SO_OP` | vazio | Números de OP separados por vírgula (ex `3526`). Se preenchido, só processa essas. |
| `TINY_ESTOQUE_DEPOSITO` | `Geral` | Depósito de entrada das mercadorias. |
| `TINY_ESTOQUE_MAX_TENTATIVAS` | `5` | Depois de N falhas seguidas numa OP, marca `tinyEstoqueBloqueado` e para de tentar (aparece um alerta no run). |

**Testar com segurança:** na aba **Actions → Run workflow**, marque
*"Fase 2 em modo simulação"* e/ou preencha *"rodar só nessas OPs"* com um
número de OP de teste. Em modo simulação nada é alterado no Tiny nem no
Firestore.

**Se uma OP for bloqueada** (`tinyEstoqueBloqueado: true` no doc): resolva no
Tiny na mão (lançar estoque + finalizar) e então, no doc do Firestore, ou
apague o campo `tinyEstoqueBloqueado` (o robô tenta de novo) ou marque
`tinyEstoqueLancado: true` (o robô considera pronto e não mexe mais).

**Flags que a Fase 2 grava no doc `orders`:** `tinyEstoqueLancado`,
`tinyEstoqueLancadoAt`, `tinyEstoqueLancadoQtd`, `tinyEstoqueDivergente`,
`tinyOpFinalizada`, e um item `{type:'tiny-estoque'}` no `history`.

## Limitações (de propósito)

- **Fase 1** só **cria** cards novos em "A Cortar". Nunca atualiza, move ou
  apaga um card que já existe.
- **Fase 2** nunca **estorna** nada no Tiny. Se algo falha numa OP, ela para
  nessa OP, alerta e tenta de novo na próxima rodada.
- O modelo/cor/tamanho são separados automaticamente a partir da descrição
  do produto no Tiny. Na grande maioria dos casos funciona certinho, mas
  alguns produtos foram cadastrados no Tiny com a ordem "cor" e "tamanho"
  trocada — nesses casos raros, é só corrigir esses dois campos à mão no Dr
  Chef depois, os outros dados já vêm certos.
