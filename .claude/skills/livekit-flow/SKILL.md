---
name: livekit-flow
description: Use ao mexer em criação de sala, tokens/permissões LiveKit, conexão Room, publicação de tela/áudio, assinatura de tracks ou estatísticas WebRTC (apps/server/src/index.ts, apps/desktop/src/renderer/main.tsx, apps/web/src/main.tsx).
---

# Fluxo LiveKit do PartilharTela

## Servidor (`apps/server/src/index.ts`)

- Código: `customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6)`; sala LiveKit = `partilhartela-<CODIGO>` (`roomNameFromCode`).
- Salas existem só no Map `rooms` em memória, com expiração (`ROOM_TTL_MS`). `POST /rooms/:code/token` responde 404 para códigos desconhecidos/expirados.
- Tokens: `AccessToken(apiKey, apiSecret, { identity, name, ttl: '15m' })`. Identity = `<CODIGO>-presenter|viewer-<uuid>`. Ambos têm `canPublish` (viewer no desktop também compartilha).
- Resposta dos dois endpoints: `{ code, roomName, token, livekitUrl, expiresIn }` — desktop e web dependem desse formato.
- Rate limit global 30 req/min por IP; `nickname` é cortado em 32 chars (`normalizeNickname`).

## Desktop (`apps/desktop/src/renderer/main.tsx`)

- `connectToRoom` cria `Room({ adaptiveStream, dynacast, publishDefaults: { simulcast: false, videoCodec: 'h264' } })`, registra handlers e só então `room.connect`. Qualquer recurso criado antes do connect (ex.: intervalo de stats) precisa ser liberado no `catch`.
- `publishScreen`: para o áudio anterior, despublica tracks, `setCaptureSource` → `getDisplayMedia` → `LocalVideoTrack` com `contentHint` (`motion`/`detail`) → publica áudio (`ScreenShareAudio`) e vídeo (`ScreenShare`, `videoEncoding` do preset `qualities`). Guardado por `publishingRef` contra cliques duplos.
- Áudio PCM (`createPcmAudio`): chunks Int16 estéreo 48 kHz vindos de `audio:data` são agendados num `AudioContext`. A limpeza (remover listener IPC e fechar o contexto) roda quando a `LocalAudioTrack` é parada — `MediaStreamTrack.stop()` não dispara `ended`.
- Handlers de `RoomEvent` são registrados uma vez por conexão: não leia estado React dentro deles (closure velho); use refs ou o `DisconnectReason`.
- Estatísticas: `readWebRtcStats` lê `room.engine.pcManager` (API interna, `any`) a cada 2 s.

## Web (`apps/web/src/main.tsx`)

Só assina tracks (não publica). Lê `?room=` da URL. Áudio pode exigir clique (`room.startAudio()` via botão "Ativar áudio").

## Testar ponta a ponta

LiveKit local (`docker compose -f infra/docker-compose.yml up -d`) + `npm run dev`; crie a sala no Electron e entre pelo `npm run dev:web` em outra aba com o código.
