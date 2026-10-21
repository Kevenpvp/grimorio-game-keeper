# Grimorio Game Keeper

Implement exactly the screenshot and nothing else

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/87db2ada-3f7d-4b8a-b087-56a49c749524).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Scripts customizados de habilidades

A API de habilidades, os quatro eventos e os métodos disponíveis estão documentados em [docs/CUSTOM_ABILITY_SCRIPTS.md](docs/CUSTOM_ABILITY_SCRIPTS.md). Os scripts executáveis do servidor ficam em `supabase/functions/ability-runtime/scripts/`; após criar/registrar um script e selecionar sua chave na página **Habilidades**, publique as migrações e a Edge Function `ability-runtime`.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
