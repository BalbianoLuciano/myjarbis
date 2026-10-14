# /jarbis-close — Fechar a sessão e deixá-la pronta para a próxima

O user escreveu isto porque o bloco de trabalho terminou. **O comando É a
confirmação**: não pergunte "tem certeza que quer fechar?". Seu trabalho é
deixar a memória num estado que a próxima sessão consiga usar e, depois,
mostrar em poucas linhas o que você escreveu, para que ele corrija se
estiver errado.

Existe porque o hook de `SessionEnd` já fecha a sessão sozinho se você
esquecer — mas escreve um resumo sintético (`[auto] ... 0 observations
saved` mais a lista de commits). Isso é um registro de atividade, não um
handoff: diz que houve três commits, não diz o que fazer amanhã. Essa
diferença é todo o valor deste comando.

---

## Ordem (importa)

### 0. Antes de escrever nada, olhe o estado real

Rode `git status --short`. Se o projeto tem testes e você os rodou nesta
sessão, diga se estão verdes; se **não** rodou, diga isso — não suponha.

Se houver arquivos não commitados ou testes vermelhos: **diga primeiro e
pergunte se fecho de todo jeito.** Nunca feche em silêncio sobre trabalho
pela metade; a próxima abertura não tem como descobrir.

### 1. Observações pendentes

Para cada decisão, gotcha ou progresso desta sessão que você ainda não
salvou: `save_observation` com o `kind` correto, `content` na ordem
WHY → WHAT → HOW, e `files`.

Para o que tem um **valor atual** em vez de uma história (o estado de um
tema, a forma como algo é feito), chame `suggest_topic_key` primeiro e
reutilize a chave que voltar: assim a nota é atualizada em vez de somar
uma rival. Se a nota é um evento pontual, vai sem `topic_key`.

Não salve uma nota por arquivo tocado. Salve o que pouparia uma hora de
quem abrir isto em três semanas.

### 2. O handoff vivo — `set_project_state`

É a primeira coisa que a próxima sessão lê, e **substitui** o conteúdo
anterior: escreva o quadro completo, não um delta.

Inclua, nesta ordem:
- onde o trabalho está hoje;
- o que está **verificado** e o que não está (se rodou a suíte, o número;
  se não rodou, diga);
- a próxima ação concreta, e as seguintes se houver;
- o que já foi medido e decidido, para não ser rediscutido.

### 3. `end_session`

Dois campos, e **você redige os dois** a partir do que aconteceu na
sessão. Não peça ao user que os dite — ser perguntado é exatamente o que
este comando vem evitar.

- `summary` — 1 a 3 bullets de retrospectiva. Sem celebração.
- `next_session` — o "retomar aqui". Uma **ação**, não um diário: verbo +
  path/branch/PR + o comando a rodar, se houver. O que ficou sem
  verificar vai aqui; omitir é o que faz a próxima sessão acreditar que
  estava pronto. ≤ 10 linhas.

### 4. Recapitule curto

Mostre: quais notas você salvou (títulos), o texto literal do
`next_session`, e uma linha se oferecendo para reescrever qualquer um dos
dois se não fizer sentido.

---

## Regras

- **Não invente progresso.** Se a sessão não avançou, o resumo diz isso. Um
  resumo otimista é pior que o sintético, porque nele se acredita.
- **Não commite nem faça push** como parte de fechar, a menos que o user
  peça. Fechar é um ato de memória, não de git.
- **Se não houver sessão aberta** (um hook já fechou, ou nunca foi aberta):
  diga, e ofereça ainda escrever `set_project_state`, que é a parte que
  sobrevive de qualquer forma.
- **Se o user está fechando para trocar de módulo**, não use este comando
  sozinho: feche e abra a sessão nova no módulo destino, confirmando o
  destino primeiro.
- Se a sessão foi longa e talvez falte contexto da primeira metade, diga
  isso no resumo em vez de preencher a lacuna.
