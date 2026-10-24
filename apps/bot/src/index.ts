import 'dotenv/config';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type MessageCreateOptions,
  type VoiceBasedChannel
} from 'discord.js';
import { backend, type ChannelRoom } from './backend.js';

// Bot do PartilharTela: liga cada canal de voz a uma sala. Primeira pessoa entrou = sala criada e
// botão no chat do canal; canal vazio = sala encerrada e mensagem editada. Só lê voice states.

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error('[PartilharTela] Defina DISCORD_BOT_TOKEN no apps/bot/.env.');
  process.exit(1);
}
if (!backend.configured) {
  console.error('[PartilharTela] Defina BOT_API_SECRET (o mesmo valor do apps/server/.env).');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

const telaCommand = new SlashCommandBuilder()
  .setName('tela')
  .setDescription('Abre a sala do PartilharTela do canal de voz em que você está')
  .setContexts(InteractionContextType.Guild);

/** Pessoas (não bots) num canal de voz, pelo cache de voice states. */
function humansIn(guild: Guild, channelId: string): string[] {
  return guild.voiceStates.cache
    .filter((state) => state.channelId === channelId && !state.member?.user.bot)
    .map((state) => state.id);
}

function roomMessage(room: ChannelRoom, channelName: string, withButton = true): MessageCreateOptions {
  const text = `🖥️ **Sala de tela do canal ${channelName}** — quem está na call pode assistir ou transmitir pelo PartilharTela. Código: \`${room.code}\``;
  if (!withButton) return { content: `${text}\n${room.joinUrl}` };
  const button = new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Assistir / Compartilhar tela').setURL(room.joinUrl);
  return { content: text, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)] };
}

/** O Discord recusa botões com URL que ele não aceita (ex.: http://localhost); aí manda o link no texto. */
function isInvalidForm(error: unknown): boolean {
  return error instanceof DiscordAPIError && error.code === 50035;
}

// Eventos do mesmo canal rodam em fila: entrar e sair rápido não cria duas salas nem encerra fora de ordem.
const queues = new Map<string, Promise<unknown>>();
function inChannelQueue<T>(channelId: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(channelId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  queues.set(channelId, next);
  void next.finally(() => {
    if (queues.get(channelId) === next) queues.delete(channelId);
  }).catch(() => undefined);
  return next;
}

async function openRoom(channel: VoiceBasedChannel): Promise<ChannelRoom> {
  const room = await backend.ensureRoom(channel.guild.id, channel.id, channel.name);
  if (room.messageId) return room;
  try {
    const message = await channel.send(roomMessage(room, channel.name)).catch(async (error: unknown) => {
      if (!isInvalidForm(error)) throw error;
      return channel.send(roomMessage(room, channel.name, false));
    });
    await backend.setMessage(channel.guild.id, channel.id, message.channelId, message.id);
    return { ...room, messageChannelId: message.channelId, messageId: message.id };
  } catch (error) {
    // Sem permissão de enviar no chat do canal: a sala existe e o /tela continua funcionando.
    console.warn(`[PartilharTela] Não consegui enviar a mensagem no canal ${channel.id}:`, error instanceof Error ? error.message : error);
    return room;
  }
}

async function closeRoom(guild: Guild, channelId: string): Promise<void> {
  if (humansIn(guild, channelId).length > 0) return;
  const result = await backend.endRoom(guild.id, channelId);
  if (!result.ended || !result.messageChannelId || !result.messageId) return;
  try {
    const channel = await client.channels.fetch(result.messageChannelId);
    if (channel?.isTextBased()) {
      await channel.messages.edit(result.messageId, { content: '🔒 Sala encerrada.', components: [] });
    }
  } catch (error) {
    console.warn('[PartilharTela] Não consegui editar a mensagem da sala:', error instanceof Error ? error.message : error);
  }
}

function logFailure(action: string) {
  return (error: unknown) => console.error(`[PartilharTela] Falha ao ${action}:`, error instanceof Error ? error.message : error);
}

/** Envia ao servidor o estado completo de um servidor do Discord e acerta as salas com a realidade. */
async function syncGuild(guild: Guild): Promise<void> {
  const states = guild.voiceStates.cache
    .filter((state) => state.channelId && !state.member?.user.bot)
    .map((state) => ({ userId: state.id, channelId: state.channelId! }));
  await backend.replaceVoiceStates(guild.id, states);

  const { rooms } = await backend.listRooms(guild.id);
  for (const room of rooms) {
    if (humansIn(guild, room.channelId).length === 0) {
      void inChannelQueue(room.channelId, () => closeRoom(guild, room.channelId)).catch(logFailure('encerrar sala'));
    }
  }
  for (const channelId of new Set(states.map((state) => state.channelId))) {
    const channel = guild.channels.cache.get(channelId);
    if (channel?.isVoiceBased()) {
      void inChannelQueue(channelId, () => openRoom(channel)).catch(logFailure('abrir sala'));
    }
  }
}

async function syncAll(): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    await syncGuild(guild).catch(logFailure(`sincronizar o servidor ${guild.id}`));
  }
  // Salas de servidores que removeram o bot enquanto ele estava fora do ar.
  try {
    const { rooms } = await backend.listAllRooms();
    const gone = new Set(rooms.filter((room) => !client.guilds.cache.has(room.guildId)).map((room) => room.guildId));
    for (const guildId of gone) {
      await backend.replaceVoiceStates(guildId, []);
      for (const room of rooms.filter((r) => r.guildId === guildId)) await backend.endRoom(guildId, room.channelId);
    }
  } catch (error) {
    logFailure('limpar salas órfãs')(error);
  }
}

let readyOnce = false;
client.once(Events.ClientReady, async (ready) => {
  console.info(`[PartilharTela] Bot conectado como ${ready.user.tag}; backend ${backend.baseUrl}`);
  const devGuildId = process.env.DISCORD_DEV_GUILD_ID;
  try {
    // Servidor de teste: o comando aparece na hora. Global: pode levar alguns minutos na primeira vez.
    if (devGuildId) await ready.application.commands.set([telaCommand.toJSON()], devGuildId);
    else await ready.application.commands.set([telaCommand.toJSON()]);
  } catch (error) {
    logFailure('registrar o comando /tela')(error);
  }
  await syncAll();
  readyOnce = true;
});

// Nova sessão no gateway (não retomada): eventos perdidos não voltam, então ressincroniza.
client.on(Events.ShardReady, () => {
  if (readyOnce) void syncAll();
});

client.on(Events.GuildCreate, (guild) => void syncGuild(guild).catch(logFailure('sincronizar novo servidor')));

client.on(Events.GuildDelete, (guild) => {
  void backend.replaceVoiceStates(guild.id, []).catch(logFailure('limpar voice states'));
  void backend.listRooms(guild.id).then(({ rooms }) => Promise.all(rooms.map((room) => backend.endRoom(guild.id, room.channelId))))
    .catch(logFailure('encerrar salas do servidor removido'));
});

client.on(Events.ChannelDelete, (channel) => {
  if (!('guild' in channel) || !channel.isVoiceBased()) return;
  void inChannelQueue(channel.id, () => backend.endRoom(channel.guild.id, channel.id)).catch(logFailure('encerrar sala de canal apagado'));
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  // Mutar/ensurdecer também gera evento; só interessa trocar de canal.
  if (oldState.channelId === newState.channelId) return;
  if (newState.member?.user.bot ?? oldState.member?.user.bot) return;
  const guild = newState.guild;

  // Fila por pessoa: trocar de canal e sair rápido não grava o canal antigo por último.
  const channelId = newState.channelId;
  void inChannelQueue(`user:${guild.id}:${newState.id}`, () => backend.setVoiceState(guild.id, newState.id, channelId))
    .catch(logFailure('atualizar voice state'));

  if (oldState.channelId && humansIn(guild, oldState.channelId).length === 0) {
    const oldChannelId = oldState.channelId;
    void inChannelQueue(oldChannelId, () => closeRoom(guild, oldChannelId)).catch(logFailure('encerrar sala'));
  }
  const channel = newState.channel;
  if (channel) {
    void inChannelQueue(channel.id, () => openRoom(channel)).catch(logFailure('abrir sala'));
  }
});

async function handleTela(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({ content: 'Use /tela dentro de um servidor.', flags: MessageFlags.Ephemeral });
    return;
  }
  const channel = interaction.guild.voiceStates.cache.get(interaction.user.id)?.channel;
  if (!channel) {
    await interaction.reply({ content: 'Entre num canal de voz e use /tela de novo.', flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply();
  try {
    const room = await inChannelQueue(channel.id, () => openRoom(channel));
    const message = roomMessage(room, channel.name);
    await interaction.editReply({ content: message.content, components: message.components }).catch(async (error: unknown) => {
      if (!isInvalidForm(error)) throw error;
      await interaction.editReply({ content: roomMessage(room, channel.name, false).content, components: [] });
    });
  } catch (error) {
    logFailure('responder /tela')(error);
    await interaction.editReply({ content: 'Não consegui abrir a sala agora. Tente de novo em alguns segundos.' }).catch(() => undefined);
  }
}

client.on(Events.InteractionCreate, (interaction) => {
  if (interaction.isChatInputCommand() && interaction.commandName === 'tela') {
    void handleTela(interaction).catch(logFailure('tratar /tela'));
  }
});

process.on('SIGINT', () => {
  void client.destroy().then(() => process.exit(0));
});

await client.login(token);
