require("dotenv").config();

const express = require("express");
const axios = require("axios");
const {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  MessageFlags,
} = require("discord.js");

// =====================================================
// BASIC APP / RAILWAY KEEPALIVE
// =====================================================
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (_, res) => {
  res.send("Bot is running");
});

app.listen(PORT, () => {
  console.log(`HTTP server listening on :${PORT}`);
});

// =====================================================
// ENV
// =====================================================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const SYNC_CHANNEL_ID = process.env.SYNC_CHANNEL_ID;
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID || null;

const SOURCE_UNIVERSE_ID = process.env.SOURCE_UNIVERSE_ID;
const TARGET_UNIVERSE_ID = process.env.TARGET_UNIVERSE_ID;
const SOURCE_API_KEY = process.env.SOURCE_API_KEY;
const TARGET_API_KEY = process.env.TARGET_API_KEY;

const AUTO_SEND_PANEL = String(process.env.AUTO_SEND_PANEL || "true") === "true";
const PANEL_MESSAGE_TEXT =
  process.env.PANEL_MESSAGE_TEXT ||
  "Klik tombol di bawah untuk melakukan transfer data dari Experience A ke Experience B.";

// =====================================================
// VALIDATION
// =====================================================
if (
  !DISCORD_TOKEN ||
  !CLIENT_ID ||
  !GUILD_ID ||
  !SYNC_CHANNEL_ID ||
  !SOURCE_UNIVERSE_ID ||
  !TARGET_UNIVERSE_ID ||
  !SOURCE_API_KEY ||
  !TARGET_API_KEY
) {
  console.error("Missing required environment variables.");
  process.exit(1);
}

// =====================================================
// DISCORD CLIENT
// =====================================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

// =====================================================
// ROBLOX CONFIG
// =====================================================
const ROBLOX_USERS_API = "https://users.roblox.com/v1/usernames/users";
const ROBLOX_CLOUD_BASE = "https://apis.roblox.com/cloud/v2";

const REQUEST_TIMEOUT_MS = 30000;
const MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 1200;

// Sesuaikan datastore di sini
const DATASTORES = [
  { name: "CoupleSystem_V1", scope: "global", keyBuilder: (userId) => `${userId}` },
  { name: "DailyStreak_WIB_V1", scope: "global", keyBuilder: (userId) => `${userId}` },
  { name: "EmoteFavorites_v1", scope: "global", keyBuilder: (userId) => `Player_${userId}` },
  { name: "GamepassTitleData_v1", scope: "global", keyBuilder: (userId) => `Player_${userId}` },
  { name: "HoloMusicFavorites_v1", scope: "global", keyBuilder: (userId) => `${userId}` },
  { name: "PlayerLikes_v1", scope: "global", keyBuilder: (userId) => `${userId}` },
  { name: "PlayerStats", scope: "global", keyBuilder: (userId) => `Player_${userId}` },
  { name: "PlayerStatus_v1", scope: "global", keyBuilder: (userId) => `${userId}` },
  { name: "TitleData_v1", scope: "global", keyBuilder: (userId) => `Player_${userId}` },
];

// =====================================================
// MEMORY STORE
// =====================================================
const activeJobs = new Map(); // ticketChannelId => job
const pendingConfirmations = new Map(); // userId => { createdAt }
const panelMessages = new Map(); // guildId => messageId

// =====================================================
// HELPERS
// =====================================================
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeUsername(input) {
  return String(input || "")
    .trim()
    .replace(/^@+/, "")
    .replace(/\s+/g, "");
}

function normalizeCompareText(value) {
  return String(value || "").trim().toLowerCase();
}

function createRobloxHttp(apiKey) {
  return axios.create({
    timeout: REQUEST_TIMEOUT_MS,
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    },
  });
}

const sourceHttp = createRobloxHttp(SOURCE_API_KEY);
const targetHttp = createRobloxHttp(TARGET_API_KEY);

function getRetryAfterMs(err) {
  const raw =
    err?.response?.headers?.["retry-after"] ||
    err?.response?.headers?.["Retry-After"];
  if (!raw) return null;

  const n = Number(raw);
  if (Number.isFinite(n)) return n * 1000;
  return null;
}

function getErrorMessage(err) {
  if (err?.response?.data) {
    try {
      return JSON.stringify(err.response.data);
    } catch {
      return String(err.response.data);
    }
  }

  return err?.message || String(err);
}

function getErrorStatus(err) {
  return err?.response?.status || null;
}

function isRetryable(err) {
  const status = getErrorStatus(err);
  if (!status) return true;
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function isUnknownInteractionError(err) {
  return (
    err?.code === 10062 ||
    String(err?.message || "").toLowerCase().includes("unknown interaction")
  );
}

async function withRetry(label, fn, job = null) {
  let lastErr;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (job?.cancelled) {
      throw new Error("JOB_CANCELLED");
    }

    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      if (job?.cancelled) {
        throw new Error("JOB_CANCELLED");
      }

      if (!isRetryable(err) || attempt === MAX_RETRIES) {
        throw err;
      }

      const retryAfterMs = getRetryAfterMs(err);
      const backoffMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      const waitMs = retryAfterMs || backoffMs;

      console.log(`[RETRY] ${label} attempt ${attempt}/${MAX_RETRIES}, wait=${waitMs}ms`);
      await sleep(waitMs);
    }
  }

  throw lastErr;
}

function datastoreEntryUrl(universeId, datastoreName, scope, key) {
  const ds = encodeURIComponent(datastoreName);
  const sc = encodeURIComponent(scope || "global");
  const entryKey = encodeURIComponent(key);

  return `${ROBLOX_CLOUD_BASE}/universes/${universeId}/data-stores/${ds}/scopes/${sc}/entries/${entryKey}`;
}

function extractEntryValue(responseData) {
  if (!responseData || typeof responseData !== "object") return undefined;

  if (Object.prototype.hasOwnProperty.call(responseData, "value")) {
    return responseData.value;
  }

  if (
    responseData.entry &&
    typeof responseData.entry === "object" &&
    Object.prototype.hasOwnProperty.call(responseData.entry, "value")
  ) {
    return responseData.entry.value;
  }

  return undefined;
}

async function getDatastoreEntry(http, universeId, datastoreName, scope, key, job) {
  const url = datastoreEntryUrl(universeId, datastoreName, scope, key);

  const res = await withRetry(
    `GET ${datastoreName}:${key}`,
    async () => {
      return await http.get(url, {
        signal: job?.abortController?.signal,
      });
    },
    job
  );

  return res.data;
}

async function putDatastoreEntry(http, universeId, datastoreName, scope, key, value, job) {
  const url = datastoreEntryUrl(universeId, datastoreName, scope, key);

  const res = await withRetry(
    `PUT ${datastoreName}:${key}`,
    async () => {
      return await http.put(
        url,
        { value },
        {
          signal: job?.abortController?.signal,
        }
      );
    },
    job
  );

  return res.data;
}

async function patchDatastoreEntry(http, universeId, datastoreName, scope, key, value, job) {
  const url = datastoreEntryUrl(universeId, datastoreName, scope, key);

  const res = await withRetry(
    `PATCH ${datastoreName}:${key}`,
    async () => {
      return await http.patch(
        url,
        { value },
        {
          signal: job?.abortController?.signal,
        }
      );
    },
    job
  );

  return res.data;
}

async function writeTargetEntry(datastoreName, scope, key, value, job) {
  try {
    await patchDatastoreEntry(
      targetHttp,
      TARGET_UNIVERSE_ID,
      datastoreName,
      scope,
      key,
      value,
      job
    );
    return "updated";
  } catch (err) {
    const status = getErrorStatus(err);

    if (status === 404) {
      await putDatastoreEntry(
        targetHttp,
        TARGET_UNIVERSE_ID,
        datastoreName,
        scope,
        key,
        value,
        job
      );
      return "created";
    }

    throw err;
  }
}

async function resolveRobloxUser(username) {
  const clean = sanitizeUsername(username);
  if (!clean) return null;

  const res = await axios.post(
    ROBLOX_USERS_API,
    {
      usernames: [clean],
      excludeBannedUsers: false,
    },
    {
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        "Content-Type": "application/json",
      },
    }
  );

  const list = Array.isArray(res.data?.data) ? res.data.data : [];
  if (list.length === 0) return null;

  const inputNormalized = normalizeCompareText(clean);

  const exactMatch = list.find((user) => {
    const nameMatch = normalizeCompareText(user?.name) === inputNormalized;
    const requestedMatch =
      normalizeCompareText(user?.requestedUsername) === inputNormalized;
    return Boolean(user?.id) && (nameMatch || requestedMatch);
  });

  if (!exactMatch) return null;

  return {
    id: String(exactMatch.id),
    name: exactMatch.name,
    displayName: exactMatch.displayName || exactMatch.name,
  };
}

function buildPanelComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("transfer_data")
        .setLabel("TRANSFER DATA")
        .setStyle(ButtonStyle.Success)
    ),
  ];
}

function buildConfirmComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("confirm_already_left_map")
        .setLabel("SUDAH")
        .setStyle(ButtonStyle.Primary)
    ),
  ];
}

function buildCloseTicketComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("close_ticket")
        .setLabel("CLOSE TICKET")
        .setStyle(ButtonStyle.Danger)
    ),
  ];
}

function buildTransferModal() {
  return new ModalBuilder()
    .setCustomId("transfer_modal")
    .setTitle("Transfer Data Roblox")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("roblox_username")
          .setLabel("Username Roblox (tanpa @)")
          .setPlaceholder("contoh: Builderman")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(20)
      )
    );
}

async function ensurePanelMessage() {
  if (!AUTO_SEND_PANEL) return;

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const channel = await guild.channels.fetch(SYNC_CHANNEL_ID);

    if (!channel || channel.type !== ChannelType.GuildText) {
      console.log("SYNC_CHANNEL_ID is not a text channel");
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle("Transfer Data Experience")
      .setDescription(PANEL_MESSAGE_TEXT)
      .setColor(0x2b8cff)
      .setFooter({ text: "Gunakan tombol untuk memulai transfer data." })
      .setTimestamp();

    const sent = await channel.send({
      embeds: [embed],
      components: buildPanelComponents(),
    });

    panelMessages.set(guild.id, sent.id);
    console.log(`Panel message sent: ${sent.id}`);
  } catch (err) {
    console.error("Failed to send panel message:", getErrorMessage(err));
  }
}

async function createTicketChannel(guild, discordUser, robloxUser) {
  const baseName = `transfer-${robloxUser.name}-${robloxUser.id}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 90);

  const channel = await guild.channels.create({
    name: baseName,
    type: ChannelType.GuildText,
    parent: TICKET_CATEGORY_ID || undefined,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionsBitField.Flags.ViewChannel],
      },
      {
        id: discordUser.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
        ],
      },
      {
        id: client.user.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ManageChannels,
          PermissionsBitField.Flags.ReadMessageHistory,
        ],
      },
    ],
  });

  return channel;
}

async function lockTicketChannel(channel, discordUserId) {
  const guild = channel.guild;

  await channel.permissionOverwrites.set([
    {
      id: guild.roles.everyone.id,
      deny: [PermissionsBitField.Flags.ViewChannel],
    },
    {
      id: discordUserId,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.ReadMessageHistory,
      ],
      deny: [PermissionsBitField.Flags.SendMessages],
    },
    {
      id: client.user.id,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ManageChannels,
        PermissionsBitField.Flags.ReadMessageHistory,
      ],
    },
  ]);
}

async function safeLockTicketChannel(channel, discordUserId) {
  try {
    await lockTicketChannel(channel, discordUserId);
  } catch (err) {
    console.log(`Failed to lock ticket channel ${channel.id}: ${getErrorMessage(err)}`);
  }
}

async function safeSendDM(user, content) {
  try {
    await user.send(content);
    return true;
  } catch (err) {
    console.log(`Failed to DM user ${user.id}: ${getErrorMessage(err)}`);
    return false;
  }
}

async function safeDeleteChannel(channel) {
  try {
    await channel.delete("Ticket closed");
  } catch (err) {
    console.log(`Failed to delete channel ${channel?.id}: ${getErrorMessage(err)}`);
  }
}

function cancelJob(job, reason = "Cancelled by user") {
  if (!job || job.cancelled) return;
  job.cancelled = true;
  job.cancelReason = reason;

  try {
    job.abortController.abort(reason);
  } catch (_) {}
}

function formatResultsTable(results) {
  return results
    .map((r, i) => {
      return `${i + 1}. **${r.datastore}** | key: \`${r.key}\` | status: **${r.status}**`;
    })
    .join("\n");
}

async function processTransferJob(job) {
  const { ticketChannel, discordUser, robloxUser } = job;

  const progressEmbed = new EmbedBuilder()
    .setTitle("Transfer Data Sedang Diproses")
    .setDescription(
      [
        `**Username:** ${robloxUser.name}`,
        `**User ID:** ${robloxUser.id}`,
        "",
        "Sedang mengecek datastore source dan memindahkan data yang ditemukan ke target.",
      ].join("\n")
    )
    .setColor(0xf1c40f)
    .setTimestamp();

  await ticketChannel.send({
    embeds: [progressEmbed],
    components: buildCloseTicketComponents(),
  });

  const results = [];
  let foundCount = 0;
  let movedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const ds of DATASTORES) {
    if (job.cancelled) {
      throw new Error("JOB_CANCELLED");
    }

    const key = ds.keyBuilder(robloxUser.id);

    try {
      const sourceData = await getDatastoreEntry(
        sourceHttp,
        SOURCE_UNIVERSE_ID,
        ds.name,
        ds.scope,
        key,
        job
      );

      if (job.cancelled) {
        throw new Error("JOB_CANCELLED");
      }

      const value = extractEntryValue(sourceData);

      if (typeof value === "undefined") {
        results.push({
          datastore: ds.name,
          key,
          status: "skip (value undefined)",
        });
        skippedCount++;
        continue;
      }

      foundCount++;

      const writeStatus = await writeTargetEntry(ds.name, ds.scope, key, value, job);
      movedCount++;

      results.push({
        datastore: ds.name,
        key,
        status: `transferred (${writeStatus})`,
      });
    } catch (err) {
      if (job.cancelled || err.message === "JOB_CANCELLED" || err.code === "ERR_CANCELED") {
        throw new Error("JOB_CANCELLED");
      }

      const status = getErrorStatus(err);

      if (status === 404) {
        results.push({
          datastore: ds.name,
          key,
          status: "skip (key tidak ada)",
        });
        skippedCount++;
      } else {
        results.push({
          datastore: ds.name,
          key,
          status: `failed (${getErrorMessage(err)})`,
        });
        failedCount++;
      }
    }
  }

  if (job.cancelled) {
    throw new Error("JOB_CANCELLED");
  }

  const detailText = formatResultsTable(results).slice(0, 3800);

  const successEmbed = new EmbedBuilder()
    .setTitle("Transfer Data Berhasil")
    .setDescription(
      [
        `**Username:** ${robloxUser.name}`,
        `**User ID:** ${robloxUser.id}`,
        "",
        `**Datastore ditemukan:** ${foundCount}`,
        `**Berhasil dipindahkan:** ${movedCount}`,
        `**Di-skip:** ${skippedCount}`,
        `**Gagal:** ${failedCount}`,
        "",
        "### Hasil per datastore",
        detailText || "Tidak ada detail.",
        "",
        "**Silakan masuk bermain lagi ke Map Oleng Beach.**",
      ].join("\n")
    )
    .setColor(0x2ecc71)
    .setTimestamp();

  await ticketChannel.send({
    embeds: [successEmbed],
    components: buildCloseTicketComponents(),
  });

  await safeLockTicketChannel(ticketChannel, discordUser.id);

  await safeSendDM(
    discordUser,
    [
      "Transfer data Roblox berhasil.",
      `Username: ${robloxUser.name}`,
      `User ID: ${robloxUser.id}`,
      `Datastore ditemukan: ${foundCount}`,
      `Berhasil dipindahkan: ${movedCount}`,
      `Di-skip: ${skippedCount}`,
      `Gagal: ${failedCount}`,
      "",
      "Silakan masuk bermain lagi ke Map Oleng Beach.",
    ].join("\n")
  );
}

function setupAutoClose(job) {
  job.autoCloseTimeout = setTimeout(async () => {
    try {
      cancelJob(job, "Auto close after 30 minutes");
      await safeDeleteChannel(job.ticketChannel);
      activeJobs.delete(job.ticketChannel.id);
    } catch (err) {
      console.log("Auto close error:", getErrorMessage(err));
    }
  }, 30 * 60 * 1000);
}

async function closeTicketFlow(interaction) {
  const channel = interaction.channel;
  const job = activeJobs.get(channel.id);

  await interaction.reply({
    content: "Ticket akan ditutup.",
    flags: MessageFlags.Ephemeral,
  });

  if (job) {
    cancelJob(job, `Closed by ${interaction.user.tag}`);
    if (job.autoCloseTimeout) clearTimeout(job.autoCloseTimeout);
    activeJobs.delete(channel.id);
  }

  await safeDeleteChannel(channel);
}

function cleanupExpiredConfirmations() {
  const now = Date.now();
  for (const [userId, data] of pendingConfirmations.entries()) {
    if (now - data.createdAt > 10 * 60 * 1000) {
      pendingConfirmations.delete(userId);
    }
  }
}

setInterval(cleanupExpiredConfirmations, 60 * 1000);

// =====================================================
// INTERACTIONS
// =====================================================
client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isButton() && interaction.customId === "transfer_data") {
      pendingConfirmations.set(interaction.user.id, {
        createdAt: Date.now(),
      });

      const confirmEmbed = new EmbedBuilder()
        .setTitle("Konfirmasi Sebelum Transfer Data")
        .setDescription(
          "Apakah sudah keluar dari map **Oleng Beach**?\nAnda harus keluar map supaya transfer data berhasil."
        )
        .setColor(0xf39c12)
        .setTimestamp();

      await interaction.reply({
        embeds: [confirmEmbed],
        components: buildConfirmComponents(),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.isButton() && interaction.customId === "confirm_already_left_map") {
      const pending = pendingConfirmations.get(interaction.user.id);

      if (!pending) {
        await interaction.reply({
          content: "Konfirmasi sudah kadaluarsa. Silakan klik tombol TRANSFER DATA lagi.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      pendingConfirmations.delete(interaction.user.id);
      await interaction.showModal(buildTransferModal());
      return;
    }

    if (interaction.isButton() && interaction.customId === "close_ticket") {
      await closeTicketFlow(interaction);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === "transfer_modal") {
      const usernameInput = interaction.fields.getTextInputValue("roblox_username");
      const username = sanitizeUsername(usernameInput);

      if (!username) {
        await interaction.reply({
          content: "Username tidak boleh kosong.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
      });

      let robloxUser;
      try {
        robloxUser = await resolveRobloxUser(username);
      } catch (err) {
        await interaction.editReply({
          content: `Gagal mengecek username Roblox: ${getErrorMessage(err)}`,
        });
        return;
      }

      if (!robloxUser) {
        await interaction.editReply({
          content: `Username Roblox **${username}** tidak terdaftar di Roblox.`,
        });
        return;
      }

      const guild = interaction.guild;
      const discordUser = interaction.user;

      const ticketChannel = await createTicketChannel(guild, discordUser, robloxUser);

      const job = {
        id: `${ticketChannel.id}:${Date.now()}`,
        ticketChannel,
        discordUser,
        robloxUser,
        createdAt: Date.now(),
        cancelReason: null,
        cancelled: false,
        abortController: new AbortController(),
        autoCloseTimeout: null,
      };

      activeJobs.set(ticketChannel.id, job);
      setupAutoClose(job);

      const firstEmbed = new EmbedBuilder()
        .setTitle("Ticket Transfer Data Dibuat")
        .setDescription(
          [
            `**Username:** ${robloxUser.name}`,
            `**User ID:** ${robloxUser.id}`,
            "",
            "Transfer data sedang diproses.",
            "Jika ticket ditutup sebelum selesai, proses transfer juga akan dibatalkan.",
          ].join("\n")
        )
        .setColor(0x3498db)
        .setTimestamp();

      await ticketChannel.send({
        content: `<@${discordUser.id}>`,
        embeds: [firstEmbed],
        components: buildCloseTicketComponents(),
      });

      await interaction.editReply({
        content: `Ticket berhasil dibuat: ${ticketChannel}`,
      });

      processTransferJob(job)
        .then(async () => {
          console.log(`Job success for ${robloxUser.name} (${robloxUser.id})`);
        })
        .catch(async (err) => {
          const isCancelled =
            job.cancelled ||
            err.message === "JOB_CANCELLED" ||
            err.code === "ERR_CANCELED";

          if (isCancelled) {
            try {
              if (ticketChannel) {
                await ticketChannel.send(
                  `Transfer data dibatalkan. Alasan: ${job.cancelReason || "ticket ditutup"}`
                );
              }
            } catch (_) {}
            return;
          }

          try {
            const failEmbed = new EmbedBuilder()
              .setTitle("Transfer Data Gagal")
              .setDescription(
                [
                  `**Username:** ${robloxUser.name}`,
                  `**User ID:** ${robloxUser.id}`,
                  "",
                  `Error: \`${getErrorMessage(err).slice(0, 3500)}\``,
                ].join("\n")
              )
              .setColor(0xe74c3c)
              .setTimestamp();

            await ticketChannel.send({
              embeds: [failEmbed],
              components: buildCloseTicketComponents(),
            });

            await safeSendDM(
              discordUser,
              [
                "Transfer data Roblox gagal.",
                `Username: ${robloxUser.name}`,
                `User ID: ${robloxUser.id}`,
                `Error: ${getErrorMessage(err)}`,
              ].join("\n")
            );
          } catch (sendErr) {
            console.log("Failed to send failure message:", getErrorMessage(sendErr));
          }
        });

      return;
    }
  } catch (err) {
    if (isUnknownInteractionError(err)) {
      console.error("Interaction expired or already acknowledged:", err.message);
      return;
    }

    console.error("interactionCreate error:", getErrorMessage(err));

    if (interaction.deferred || interaction.replied) {
      try {
        await interaction.followUp({
          content: `Terjadi error: ${getErrorMessage(err)}`,
          flags: MessageFlags.Ephemeral,
        });
      } catch (_) {}
    } else {
      try {
        await interaction.reply({
          content: `Terjadi error: ${getErrorMessage(err)}`,
          flags: MessageFlags.Ephemeral,
        });
      } catch (_) {}
    }
  }
});

// =====================================================
// READY
// =====================================================
client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await ensurePanelMessage();
});

client.login(DISCORD_TOKEN);