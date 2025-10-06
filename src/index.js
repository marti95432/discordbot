import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  StringSelectMenuBuilder,
  ButtonStyle,
  EmbedBuilder,
  AttachmentBuilder,
  PermissionsBitField
} from 'discord.js';

const {
  DISCORD_TOKEN,
  GUILD_ID,
  SUPPORT_ROLE_ID,
  LOG_CHANNEL_ID,
  TICKETS_CATEGORY_ID,
  FAQ_CHANNEL_ID
} = process.env;

if (!DISCORD_TOKEN || !GUILD_ID || !SUPPORT_ROLE_ID || !LOG_CHANNEL_ID) {
  console.error('Missing required env vars. Please set DISCORD_TOKEN, GUILD_ID, SUPPORT_ROLE_ID, LOG_CHANNEL_ID.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// ---------- Slash Commands ----------
const commands = [
  new SlashCommandBuilder()
    .setName('setup_tickets')
    .setDescription('Post the “Open Ticket” panel in the current channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('conprob')
    .setDescription('Tag a user and suggest trying a connection link.')
    .addUserOption(o => o.setName('user').setDescription('User to tag').setRequired(true))
    .addStringOption(o => o.setName('link').setDescription('Direct connect link (e.g., fivem://connect/IP:PORT)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('faq')
    .setDescription('Show where to read the FAQ (if configured).'),

  // Staff-only close command meant to be used inside a ticket.
  new SlashCommandBuilder()
    .setName('close')
    .setDescription('Close this ticket and archive a simple transcript.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands((await client.application?.id) ?? client.user.id, GUILD_ID), {
    body: commands
  });
  console.log('Slash commands registered.');
}

// ---------- UI Custom IDs ----------
const IDS = {
  OPEN_TICKET_BTN: 'open_ticket_btn',
  STEP_FAQ_YES: 'step_faq_yes',
  STEP_FAQ_NO: 'step_faq_no',
  STEP_SUPPORT_SELECT: 'step_support_select', // values: ingame / other
  STEP_INGAME_REPORT_YES: 'step_ingame_report_yes',
  STEP_INGAME_REPORT_NO: 'step_ingame_report_no',
  CLOSE_TICKET: 'close_ticket_btn'
};

// ---------- Helpers ----------
async function getOrCreateTicketsCategory(guild) {
  if (TICKETS_CATEGORY_ID) {
    const cat = guild.channels.cache.get(TICKETS_CATEGORY_ID);
    if (cat && cat.type === ChannelType.GuildCategory) return cat;
  }
  // Try find by name
  const existing = guild.channels.cache.find(ch => ch.type === ChannelType.GuildCategory && ch.name.toLowerCase() === 'tickets');
  if (existing) return existing;

  // Create new
  return await guild.channels.create({
    name: 'Tickets',
    type: ChannelType.GuildCategory,
    permissionOverwrites: [
      // Default: everyone can’t see tickets
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel]
      },
      // Support can see all tickets by default (override per-channel too)
      {
        id: SUPPORT_ROLE_ID,
        allow: [PermissionFlagsBits.ViewChannel]
      }
    ]
  });
}

function ticketIntroEmbed(user) {
  return new EmbedBuilder()
    .setTitle('🎟️ Need help?')
    .setDescription(
      `Let’s make sure we help you efficiently.\n\n` +
      `1) **Have you read our FAQ**${FAQ_CHANNEL_ID ? ` in <#${FAQ_CHANNEL_ID}>` : ''}?\n` +
      `2) **Do you need in-game support** or something else?\n` +
      `3) If in-game: **Have you filed an in-game /report** already?\n\n` +
      `Click **Open Ticket** to begin.`
    )
    .setFooter({ text: `Requested by ${user.tag}` })
    .setTimestamp();
}

function openTicketButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(IDS.OPEN_TICKET_BTN)
      .setStyle(ButtonStyle.Primary)
      .setLabel('Open Ticket')
      .setEmoji('🎫')
  );
}

function faqStepRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.STEP_FAQ_YES).setStyle(ButtonStyle.Success).setLabel('I read the FAQ ✅'),
    new ButtonBuilder().setCustomId(IDS.STEP_FAQ_NO).setStyle(ButtonStyle.Danger).setLabel("I haven't ❌")
  );
}

function supportTypeRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(IDS.STEP_SUPPORT_SELECT)
      .setPlaceholder('Choose the type of support you need…')
      .addOptions(
        { label: 'In-game support', value: 'ingame', description: 'Issues while playing on the server' },
        { label: 'Other support', value: 'other', description: 'Discord, donations, bans, website, etc.' }
      )
  );
}

function ingameReportRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.STEP_INGAME_REPORT_YES).setStyle(ButtonStyle.Success).setLabel('Yes, I filed /report'),
    new ButtonBuilder().setCustomId(IDS.STEP_INGAME_REPORT_NO).setStyle(ButtonStyle.Secondary).setLabel('Not yet')
  );
}

async function createTicketChannel(guild, opener) {
  const cat = await getOrCreateTicketsCategory(guild);

  // limit visibility to opener + support
  const channel = await guild.channels.create({
    name: `ticket-${opener.username}`.toLowerCase().replace(/[^a-z0-9\-]/g, ''),
    type: ChannelType.GuildText,
    parent: cat.id,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: SUPPORT_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      { id: opener.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
    ]
  });

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.CLOSE_TICKET).setStyle(ButtonStyle.Danger).setLabel('Close Ticket').setEmoji('🔒')
  );

  await channel.send({
    content: `<@${opener.id}> <@&${SUPPORT_ROLE_ID}>`,
    embeds: [
      new EmbedBuilder()
        .setTitle('Ticket created')
        .setDescription('Please describe your issue with as much detail as possible (what you tried, screenshots/logs, etc.). A staff member will be with you shortly.')
        .setTimestamp()
    ],
    components: [closeRow]
  });

  return channel;
}

async function archiveTicket(channel, closedBy) {
  // Basic “transcript”: fetch recent messages and attach as a .txt
  const messages = await channel.messages.fetch({ limit: 100 });
  const sorted = Array.from(messages.values()).sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  const lines = sorted.map(m => {
    const ts = new Date(m.createdTimestamp).toISOString();
    const author = `${m.author.tag} (${m.author.id})`;
    const content = m.cleanContent || '';
    const attachments = m.attachments.size ? ` [attachments: ${[...m.attachments.values()].map(a => a.url).join(', ')}]` : '';
    return `[${ts}] ${author}: ${content}${attachments}`;
  });

  const buffer = Buffer.from(lines.join('\n') || 'No messages.', 'utf8');
  const file = new AttachmentBuilder(buffer, { name: `${channel.name}-transcript.txt` });

  const logChannel = channel.guild.channels.cache.get(LOG_CHANNEL_ID);
  if (logChannel && logChannel.isTextBased()) {
    await logChannel.send({
      content: `🗂️ Ticket **${channel.name}** closed by <@${closedBy.id}>`,
      files: [file]
    });
  }

  // Lock the channel (deny send for everyone incl. opener)
  const overwrites = channel.permissionOverwrites.cache;
  for (const ow of overwrites.values()) {
    // set SEND_MESSAGES deny for everyone except SUPPORT_ROLE (they keep view & send)
    if (ow.id !== SUPPORT_ROLE_ID) {
      await channel.permissionOverwrites.edit(ow.id, { SendMessages: false }).catch(() => {});
    }
  }

  await channel.send({ content: '🔒 Ticket closed. Transcript saved to logs.' });
}

// ---------- Client Events ----------
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}.`);
  await registerCommands();
});

// Handle slash commands
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      if (commandName === 'setup_tickets') {
        const embed = ticketIntroEmbed(interaction.user);
        await interaction.reply({
          embeds: [embed],
          components: [openTicketButton()]
        });
      }

      if (commandName === 'conprob') {
        const user = interaction.options.getUser('user', true);
        const link = interaction.options.getString('link') || 'fivem://connect/YOUR-IP:PORT';

        await interaction.reply({
          content:
            `Hey ${user}, if you’re having trouble connecting, try this link:\n` +
            `**${link}**\n\n` +
            `• Make sure FiveM is closed before clicking.\n` +
            `• Disable VPNs and turn off Windows Metered Connection.\n` +
            `• If it still fails: restart router/PC and try again.`,
          allowedMentions: { users: [user.id] }
        });
      }

      if (commandName === 'faq') {
        if (FAQ_CHANNEL_ID) {
          await interaction.reply({ content: `Please read our FAQ in <#${FAQ_CHANNEL_ID}> first.`, ephemeral: true });
        } else {
          await interaction.reply({ content: `FAQ channel isn’t configured. Ask an admin to set \`FAQ_CHANNEL_ID\` in .env.`, ephemeral: true });
        }
      }

      if (commandName === 'close') {
        if (interaction.channel?.parent?.type !== ChannelType.GuildCategory || !interaction.channel.parent.name.toLowerCase().includes('ticket')) {
          return interaction.reply({ content: 'Use /close inside a ticket channel.', ephemeral: true });
        }
        await interaction.deferReply({ ephemeral: true });
        await archiveTicket(interaction.channel, interaction.user);
        await interaction.editReply({ content: 'Ticket closed and archived.' });
      }
      return;
    }

    // Handle ticket UI flow
    if (interaction.isButton() || interaction.isStringSelectMenu()) {
      // OPEN TICKET pressed (start flow)
      if (interaction.customId === IDS.OPEN_TICKET_BTN) {
        const faqEmbed = new EmbedBuilder()
          .setTitle('Step 1/3 — Have you read the FAQ?')
          .setDescription(FAQ_CHANNEL_ID
            ? `Please confirm you have read the FAQ in <#${FAQ_CHANNEL_ID}>. It may already solve your issue.`
            : `Please confirm you have read the server’s FAQ or pinned guides.`
          );

        return interaction.reply({ embeds: [faqEmbed], components: [faqStepRow()], ephemeral: true });
      }

      // Step: FAQ answer
      if (interaction.customId === IDS.STEP_FAQ_NO) {
        return interaction.update({
          embeds: [
            new EmbedBuilder()
              .setTitle('Please read the FAQ first 🙏')
              .setDescription(FAQ_CHANNEL_ID
                ? `Check <#${FAQ_CHANNEL_ID}> and then try again.`
                : `Check the server’s FAQ/pins and then try again.`
              )
          ],
          components: []
        });
      }
      if (interaction.customId === IDS.STEP_FAQ_YES) {
        const embed = new EmbedBuilder()
          .setTitle('Step 2/3 — What kind of support do you need?')
          .setDescription('Choose one option below.');
        return interaction.update({ embeds: [embed], components: [supportTypeRow()] });
      }

      // Step: support type pick
      if (interaction.customId === IDS.STEP_SUPPORT_SELECT && interaction.isStringSelectMenu()) {
        const choice = interaction.values?.[0];
        if (choice === 'other') {
          // create ticket immediately
          await interaction.update({ content: 'Creating your ticket…', embeds: [], components: [], ephemeral: true });
          const ticket = await createTicketChannel(interaction.guild, interaction.user);
          return interaction.followUp({ content: `✅ Ticket created: ${ticket}`, ephemeral: true });
        }
        if (choice === 'ingame') {
          const embed = new EmbedBuilder()
            .setTitle('Step 3/3 — Did you make an in-game /report?')
            .setDescription('If not, please try **/report** in-game first; staff often responds quicker there.');
          return interaction.update({ embeds: [embed], components: [ingameReportRow()] });
        }
      }

      // Step: in-game report answer
      if (interaction.customId === IDS.STEP_INGAME_REPORT_NO) {
        return interaction.update({
          embeds: [
            new EmbedBuilder()
              .setTitle('Please file an in-game /report first')
              .setDescription('Open FiveM, join the server, and type **/report** with a short description. If you still need help afterward, open a ticket again.')
          ],
          components: []
        });
      }

      if (interaction.customId === IDS.STEP_INGAME_REPORT_YES) {
        await interaction.update({ content: 'Creating your ticket…', embeds: [], components: [], ephemeral: true });
        const ticket = await createTicketChannel(interaction.guild, interaction.user);
        return interaction.followUp({ content: `✅ Ticket created: ${ticket}`, ephemeral: true });
      }

      // Close ticket via button (works for staff & opener; channel perms enforce)
      if (interaction.customId === IDS.CLOSE_TICKET) {
        if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageChannels) && interaction.user.id !== interaction.channel.topic) {
          // allow if staff; opener check via channel.topic optional
        }
        await interaction.deferReply({ ephemeral: true });
        await archiveTicket(interaction.channel, interaction.user);
        return interaction.editReply({ content: 'Ticket closed.' });
      }
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      try { await interaction.reply({ content: 'Something went wrong handling that action.', ephemeral: true }); } catch {}
    }
  }
});

client.login(DISCORD_TOKEN);
