---
name: release-desktop
description: Use ao publicar uma nova versão do PartilharTela — bump de versão, CHANGELOG, tag, instalador NSIS e GitHub Release compatível com o auto-update (electron-updater).
---

# Release do app desktop

O auto-update compara `apps/desktop/package.json#version` com o último GitHub Release de
`samuelmel/partilhartela` (`build.publish`, `releaseType: release`). Release sem os
artefatos certos quebra a atualização para todos os usuários.

## Passos

1. Escolha o semver: só `fix` → patch; `feat` → minor; quebra de protocolo server↔cliente → major.
   Tags antigas fora do padrão existem (`1.0.3`, `versao_1.4`...); a próxima versão deve ser maior que todas.
2. Atualize `version` em `apps/desktop/package.json` **e** em `package.json` (raiz), depois `npm install` para sincronizar o `package-lock.json`.
3. Adicione a seção no topo de `CHANGELOG.md` (`## [X.Y.Z] - AAAA-MM-DD`, grupos Correções/Novidades/Documentação/Manutenção).
4. Verifique: `npm run typecheck && npm run typecheck:web && npm run build && npm run build:web`.
5. Commit `chore(release): vX.Y.Z` e tag anotada `git tag -a vX.Y.Z -m "vX.Y.Z"`.
6. `npm run dist` → em `apps/desktop/release/` ficam `PartilharTela Setup X.Y.Z.exe`,
   `PartilharTela Setup X.Y.Z.exe.blockmap` e `latest.yml`.
7. Só com autorização do usuário: `git push origin master --follow-tags` e
   `gh release create vX.Y.Z --title "vX.Y.Z" --notes-file <notas.md>` anexando o `.exe`, o `.blockmap` e o `latest.yml`.
   Pré-requisito: `gh auth status` ok. Sem `gh`, pare e avise.
   **Renomeie antes de subir**: o `latest.yml` referencia `PartilharTela-Setup-X.Y.Z.exe` (hífens), mas o
   GitHub troca espaços por pontos no upload. Copie o `.exe` e o `.blockmap` para nomes com hífen, senão o auto-update não acha o arquivo.

## Conferir

- `latest.yml` deve citar a mesma versão do `package.json` do desktop.
- O server (Render) é implantado à parte; mudanças no formato de `/rooms` exigem subir o server antes de liberar o instalador.
