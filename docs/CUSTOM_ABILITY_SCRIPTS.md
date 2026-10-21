# Scripts JavaScript personalizados de habilidades

Os scripts ficam em `supabase/functions/ability-runtime/scripts/` e são executados no servidor pela Edge Function `ability-runtime`. Eles não são executados como código arbitrário no navegador.

## Eventos disponíveis

Cada arquivo exporta um objeto com qualquer subconjunto dos seis métodos abaixo. Um script pode implementar somente os eventos de que precisa.

- `"turno_avançou"(contexto, api)`: disparado quando o turno individual de um personagem avança. No turno geral, recebe um evento para cada personagem participante cujo contador individual foi avançado.
- `"habilidade_ativada"(contexto, api)`: disparado após a habilidade atribuída que seleciona esse script ser ativada com sucesso.
- `"efeito_aplicado_no_caster"(contexto, api)`: disparado quando um efeito é aplicado ao personagem que possui a habilidade com script configurado.
- `"efeito_removido_no_caster"(contexto, api)`: disparado quando um efeito é removido desse personagem.
- `"recebeu_dano"(contexto, api)`: chamado durante a aplicação de dano, depois de o dano causado ter sido calculado e modificado. O Caster é quem recebeu o dano e `contexto.alvo` é a origem, se houver.
- `"causou_dano"(contexto, api)`: chamado durante a aplicação de dano, após defesa e mitigação normais. O Caster é a origem do dano e pode alterar o dano final antes de a operação terminar.

### Argumento `contexto`

- `contexto.idEvento`: identificador estável do evento, útil para logs e para evitar ações duplicadas em lógica customizada.
- `contexto.evento`: nome do evento.
- `contexto.habilidade`: `id`, `idNaFicha`, `nome` e `scriptKey`.
- `contexto.caster`: `id`, `nome` e `nomeJogador` do personagem dono da habilidade.
- `contexto.alvo`: o alvo original, quando existe; senão `null`.
- `contexto.batalha`: `id`, `nome`, `turnoGeral` e `ativa`, ou `null).
- `contexto.turno`: `individual` e `geral` quando conhecidos.
- `contexto.efeito`: snapshot do efeito relacionado, ou `null`.
- `contexto.dados`: payload adicional salvo com o evento, por exemplo o custo de Mana ou o efeito completo.
- `contexto.atributos`: valores extras configurados pelo mestre na habilidade, indexados pela chave API. Os valores podem ser números, strings ou booleanos.
- `contexto.estado`: estado persistente daquela habilidade na ficha do personagem; use os métodos da API para atualizá-lo.
- `contexto.dano`: presente em `recebeu_dano` e `causou_dano`. Contém `origemId`, `personagemAtingidoId`, `categoria`, `tipoDanoId`, `grauMagia`, `danoBrutoPorGolpe`, `danoFinalPorGolpe`, `danoFinalTotal`, `hpAntes` e `hpDepois`.

## Métodos permitidos em `api`

```ts
api.registrarLog("Mensagem", { qualquerDado: 123 });

await api.alterarRecurso({
  personagem: "caster", // ou "alvo"
  recurso: "hp",        // "hp", "mana", "corpo", "sanidade"
  operacao: "somar",    // "somar", "subtrair", "definir"
  quantidade: 10,
});

const hp = await api.consultarRecurso({ personagem: "caster", recurso: "hp" });
// { atual: 80, maximo: 100 }

const acumulado = await api.ajustarEstadoNumerico({
  chave: "superaquecimento",
  delta: 12, // use valor negativo para gastar; mínimo padrão 0
});

const efeitoId = await api.aplicarEfeito({
  personagem: "alvo", // ou "caster"
  efeito: {
    nome: "Marca Arcana",
    tipo: "status",
    atributo: "speed",
    polaridade: "debuff",
    modoValor: "percent",
    quantidade: 15,
    duracao: 2,
  },
});

await api.removerEfeito({ efeitoId });

// Somente durante "causou_dano": altera os valores finais após defesa/mitigação.
await api.modificarDanoFinal({ valoresPorGolpe: [20, 35, 40] });
```

`alterarRecurso` respeita os limites do recurso (HP/Mana até o máximo calculado; Corpo/Sanidade entre 0 e 100). Modificações de HP por soma/subtração e alterações numéricas de estado usam operações atômicas no banco. `consultarRecurso` retorna valor atual e máximo. `ajustarEstadoNumerico` soma ou subtrai uma chave numérica do estado sem perder incrementos concorrentes. `modificarDanoFinal` só funciona durante `causou_dano`, deve enviar um valor para cada golpe e limita cada golpe a 0–1.000.000 após defesa e mitigação. `aplicarEfeito` usa os mesmos tipos e restrições de efeito do combate; duração e quantidade são validadas. `removerEfeito` só pode remover um efeito no Caster ou no Alvo do evento e, se estiver numa batalha, não pode remover de outra batalha.

## Exemplo: Demônio Interno

O script pronto está em [`scripts/demonio-interno.ts`](../supabase/functions/ability-runtime/scripts/demonio-interno.ts) e o registro usa a chave `demonio_interno`.

Ele acumula o dano final recebido em `contexto.estado.dano_superaquecimento`. Quando o personagem causa dano depois disso, calcula uma parcela do superaquecimento de acordo com `contexto.atributos.porcentagem_maxima_dano_refletido`, acrescenta essa parcela ao último golpe após as defesas/mitigações, paga o custo em HP e desconta a quantidade refletida do acúmulo. O custo usa `contexto.atributos.percentual_hp_perdido_por_refletir` como porcentagem do HP **máximo** do Caster.

Os dois atributos vêm pré-configurados: **Porcentagem máxima de dano refletido** (50) e **% de HP que perde para refletir** (10). É possível ajustar os valores na página Habilidades.

## Como adicionar um script

1. Crie um arquivo `.ts` em `supabase/functions/ability-runtime/scripts/`. Use `example.ts` como modelo.
2. Registre a chave no mapa `abilityScriptRegistry` de `scripts/registry.ts`.
3. Adicione a mesma chave e o rótulo para o mestre em `src/lib/custom-ability-scripts.ts`.
4. Na página **Habilidades**, escolha o script no campo **Script JavaScript personalizado** e salve a habilidade.
5. Aplique as migrações pendentes e publique a Edge Function:

```sh
npx drizzle-kit migrate
supabase functions deploy ability-runtime
```

As variáveis padrão da Edge Function do Supabase `SUPABASE_URL`, `SUPABASE_ANON_KEY` e `SUPABASE_SERVICE_ROLE_KEY` precisam estar disponíveis. A função exige usuário autenticado com papel de mestre para processar eventos.

## Boas práticas

Scripts são código confiável revisado no repositório. Não aceite nem execute o texto JavaScript digitado no banco ou por jogadores. Evite um script de efeito aplicado que sempre aplique outro efeito semelhante: isso pode criar uma cadeia de eventos. O runtime limita cada execução a cinco lotes de eventos; eventos que falharem ficam registrados como `failed` na tabela `ability_script_events` para diagnóstico. Como os scripts podem fazer várias ações, use `contexto.idEvento` para desenvolver lógica idempotente quando necessário.
