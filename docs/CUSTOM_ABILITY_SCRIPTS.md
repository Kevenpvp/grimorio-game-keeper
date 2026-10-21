# Scripts JavaScript personalizados de habilidades

Os scripts ficam em `supabase/functions/ability-runtime/scripts/` e são executados no servidor pela Edge Function `ability-runtime`. Eles não são executados como código arbitrário no navegador.

## Eventos disponíveis

Cada arquivo exporta um objeto com qualquer subconjunto dos quatro métodos abaixo. Um script pode implementar somente os eventos de que precisa.

- `"turno_avançou"(contexto, api)`: disparado quando o turno individual de um personagem avança. No turno geral, recebe um evento para cada personagem participante cujo contador individual foi avançado.
- `"habilidade_ativada"(contexto, api)`: disparado após a habilidade atribuída que seleciona esse script ser ativada com sucesso.
- `"efeito_aplicado_no_caster"(contexto, api)`: disparado quando um efeito é aplicado ao personagem que possui a habilidade com script configurado.
- `"efeito_removido_no_caster"(contexto, api)`: disparado quando um efeito é removido desse personagem.

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

## Métodos permitidos em `api`

```ts
api.registrarLog("Mensagem", { qualquerDado: 123 });

await api.alterarRecurso({
  personagem: "caster", // ou "alvo"
  recurso: "hp",        // "hp", "mana", "corpo", "sanidade"
  operacao: "somar",    // "somar", "subtrair", "definir"
  quantidade: 10,
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
```

`alterarRecurso` respeita os limites do recurso (HP/Mana até o máximo calculado; Corpo/Sanidade entre 0 e 100). `aplicarEfeito` usa os mesmos tipos e restrições de efeito do combate; duração e quantidade são validadas. `removerEfeito` só pode remover um efeito no Caster ou no Alvo do evento e, se estiver numa batalha, não pode remover de outra batalha.

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
