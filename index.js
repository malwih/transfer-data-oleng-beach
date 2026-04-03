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
  StringSelectMenuBuilder,
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
  "Klik tombol di bawah untuk memulai proses transfer data akun kamu dari **Map Lama** ke **Map Baru**.";

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

const DATASTORES = [
  {
    name: "CoupleSystem_V1",
    label: "Couple",
    description: "Data couple / pasangan",
    scope: "global",
    keyBuilder: (userId) => `${userId}`,
  },
  {
    name: "PlayerLikes_v1",
    label: "Like",
    description: "Data like pemain",
    scope: "global",
    keyBuilder: (userId) => `${userId}`,
  },
  {
    name: "DailyStreak_WIB_V1",
    label: "Streak",
    description: "Data streak harian",
    scope: "global",
    keyBuilder: (userId) => `${userId}`,
  },
  {
    name: "PlayerStatus_v1",
    label: "Status Player",
    description: "Status player",
    scope: "global",
    keyBuilder: (userId) => `${userId}`,
  },
  {
    name: "EmoteFavorites_v1",
    label: "Emote Favorite",
    description: "Emote favorit pemain",
    scope: "global",
    keyBuilder: (userId) => `Player_${userId}`,
  },
  {
    name: "GamepassTitleData_v1",
    label: "Title (via tombol)",
    description: "Title dari fitur tombol",
    scope: "global",
    keyBuilder: (userId) => `Player_${userId}`,
  },
  {
    name: "HoloMusicFavorites_v1",
    label: "Music Favorite",
    description: "Musik favorit pemain",
    scope: "global",
    keyBuilder: (userId) => `${userId}`,
  },
  {
    name: "PlayerStats",
    label: "Jumlah Donate",
    description: "Jumlah donate pemain",
    scope: "global",
    keyBuilder: (userId) => `Player_${userId}`,
  },
  {
    name: "TitleData_v1",
    label: "VVIP dan Title (dari admin)",
    description: "VVIP dan title dari admin",
    scope: "global",
    keyBuilder: (userId) => `Player_${userId}`,
  },
];

const DATASTORE_MAP = new Map(DATASTORES.map((ds) => [ds.name, ds]));
const ALL_DATASTORE_NAMES = DATASTORES.map((ds) => ds.name);

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

function formatJson(value, maxLength = 1200) {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength)}... [dipotong]`;
  } catch {
    const text = String(value);
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength)}... [dipotong]`;
  }
}

function isDeepEqual(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return String(a) === String(b);
  }
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
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

function formatIdentityLines(robloxUser) {
  return [
    `**👤 Username:** ${robloxUser.name}`,
    `**🪪 Display Name:** ${robloxUser.displayName}`,
    `**🆔 User ID:** ${robloxUser.id}`,
  ];
}

function buildPanelComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("transfer_data")
        .setLabel("🚀 TRANSFER DATA")
        .setStyle(ButtonStyle.Success)
    ),
  ];
}

function buildConfirmComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("confirm_already_left_map")
        .setLabel("✅ SUDAH, SAYA SUDAH KELUAR MAP")
        .setStyle(ButtonStyle.Primary)
    ),
  ];
}

function buildOverwriteConfirmComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("agree_overwrite_transfer")
        .setLabel("✅ SETUJU")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("disagree_overwrite_transfer")
        .setLabel("❌ TIDAK SETUJU")
        .setStyle(ButtonStyle.Danger)
    ),
  ];
}

function buildCloseTicketComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("close_ticket")
        .setLabel("🗑️ CLOSE TICKET")
        .setStyle(ButtonStyle.Danger)
    ),
  ];
}

function buildRetryTransferComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("retry_transfer")
        .setLabel("🔁 TRANSFER ULANG")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("close_ticket")
        .setLabel("🗑️ CLOSE TICKET")
        .setStyle(ButtonStyle.Danger)
    ),
  ];
}

function buildDatastoreSelectComponents(job) {
  const selected = new Set(job.selectedDatastores || []);
  const options = DATASTORES.map((ds) => ({
    label: ds.label,
    description: ds.description,
    value: ds.name,
    default: selected.has(ds.name),
  }));

  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("select_datastores")
        .setPlaceholder("📦 Pilih datastore yang ingin ditransfer")
        .setMinValues(1)
        .setMaxValues(DATASTORES.length)
        .addOptions(options)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("select_all_datastores")
        .setLabel("📦 Pilih Semua")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("start_selected_transfer")
        .setLabel("✅ Mulai Transfer Sekarang")
        .setStyle(ButtonStyle.Success)
    ),
  ];
}

function buildTransferModal() {
  return new ModalBuilder()
    .setCustomId("transfer_modal")
    .setTitle("Transfer Data Map Oleng Beach")
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

function buildDatastoreSelectionEmbed(job) {
  const selectedNames = (job.selectedDatastores || [])
    .map((name) => DATASTORE_MAP.get(name)?.label || name)
    .join(", ");

  return new EmbedBuilder()
    .setTitle("📦 Pilih Data yang Ingin Ditransfer")
    .setDescription(
      [
        ...formatIdentityLines(job.robloxUser),
        "",
        "Silakan pilih **data mana saja** yang ingin kamu transfer dari **Map Lama** ke **Map Baru**.",
        "Kamu bisa pilih **satu data**, **beberapa data**, atau langsung klik **Pilih Semua**.",
        "",
        `**📌 Pilihan saat ini:** ${selectedNames || "Belum ada datastore yang dipilih."}`,
        "",
        "⚠️ **Catatan Penting:**",
        "**Title (dari admin)** tidak dijamin 100% berhasil karena title dari admin **tidak permanen**.",
        "Kalau title dari admin tidak muncul setelah transfer, artinya **masa berlakunya sudah habis**.",
        "",
        "Setelah selesai memilih, klik tombol **✅ Mulai Transfer Sekarang** untuk melanjutkan proses.",
      ].join("\n")
    )
    .setColor(0x5865f2)
    .setTimestamp();
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
      .setTitle("🚀 Transfer Data Map Oleng Beach")
      .setDescription(
        [
          PANEL_MESSAGE_TEXT,
          "",
          "📌 **Fungsi tombol ini:** memindahkan data akun kamu dari **Map Lama** ke **Map Baru**.",
          "⚠️ Pastikan kamu sudah **keluar dari map** sebelum memulai proses transfer.",
          "",
          "Klik tombol di bawah untuk mulai.",
        ].join("\n")
      )
      .setColor(0x2b8cff)
      .setFooter({ text: "Gunakan tombol di bawah untuk memulai transfer data." })
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

function findActiveJobByRobloxUserId(robloxUserId) {
  for (const job of activeJobs.values()) {
    if (!job) continue;
    if (job.cancelled) continue;
    if (!job.ticketChannel) continue;

    if (String(job.robloxUser?.id) === String(robloxUserId)) {
      return job;
    }
  }

  return null;
}

function getSelectedDatastoresForJob(job) {
  const names = Array.isArray(job.selectedDatastores) && job.selectedDatastores.length > 0
    ? job.selectedDatastores
    : ALL_DATASTORE_NAMES;

  return names
    .map((name) => DATASTORE_MAP.get(name))
    .filter(Boolean);
}

function buildProgressEmbed(job) {
  const selectedText = getSelectedDatastoresForJob(job)
    .map((ds) => `• ${ds.label}`)
    .join("\n");

  return new EmbedBuilder()
    .setTitle("⏳ Transfer Data Sedang Diproses")
    .setDescription(
      [
        ...formatIdentityLines(job.robloxUser),
        "",
        "🔄 Sistem sedang memproses transfer data dari **Map Lama** ke **Map Baru**.",
        "🛡️ Untuk memastikan data benar-benar masuk, setiap datastore akan diproses **3 kali** dengan jeda **3 detik** per proses.",
        "",
        "**📦 Datastore yang dipilih:**",
        selectedText || "-",
        "",
        "Mohon tunggu sampai proses selesai. Tombol tutup ticket akan muncul setelah transfer berhasil.",
      ].join("\n")
    )
    .setColor(0xf1c40f)
    .setTimestamp();
}

function buildSuccessSummaryEmbed(job, summary) {
  const selectedText = getSelectedDatastoresForJob(job)
    .map((ds) => `• ${ds.label}`)
    .join("\n");

  return new EmbedBuilder()
    .setTitle("✅ Transfer Data Berhasil Diproses")
    .setDescription(
      [
        ...formatIdentityLines(job.robloxUser),
        "",
        "🎉 Proses transfer data telah selesai diproses.",
        "",
        "**📦 Datastore yang diproses:**",
        selectedText || "-",
        "",
        `✅ **Berhasil:** ${summary.success.length}`,
        `⏭️ **Skip:** ${summary.skipped.length}`,
        `❌ **Gagal:** ${summary.failed.length}`,
        "",
        "📌 Detail per datastore dikirim di bawah ini.",
        "Kamu bisa klik **🔁 Transfer Ulang** jika ingin langsung menjalankan migrasi lagi.",
      ].join("\n")
    )
    .setColor(0x2ecc71)
    .setTimestamp();
}

function buildFailureEmbed(job, errorText) {
  return new EmbedBuilder()
    .setTitle("❌ Transfer Data Gagal")
    .setDescription(
      [
        ...formatIdentityLines(job.robloxUser),
        "",
        "Terjadi kendala saat memproses transfer data.",
        `**Error:** \`${errorText.slice(0, 3500)}\``,
      ].join("\n")
    )
    .setColor(0xe74c3c)
    .setTimestamp();
}

function buildTicketCreatedEmbed(job) {
  return new EmbedBuilder()
    .setTitle("🎫 Ticket Transfer Data Berhasil Dibuat")
    .setDescription(
      [
        ...formatIdentityLines(job.robloxUser),
        "",
        "Silakan pilih dulu datastore yang ingin ditransfer.",
        "Setelah itu, klik tombol **✅ Mulai Transfer Sekarang** untuk memulai proses transfer.",
        "",
        "⚠️ Selama proses berlangsung, mohon jangan tutup ticket dan jangan spam tombol.",
      ].join("\n")
    )
    .setColor(0x3498db)
    .setTimestamp();
}

function buildResultDetailLines(item) {
  const lines = [
    `**🗂️ Label User:** ${item.label}`,
    `**🧩 Datastore Asli:** ${item.datastore}`,
    `**🔑 Key:** \`${item.key}\``,
    `**📌 Status:** ${item.status}`,
  ];

  if (item.reason) {
    lines.push(`**📝 Keterangan:** ${item.reason}`);
  }

  if (Object.prototype.hasOwnProperty.call(item, "sourceValue")) {
    lines.push("**📤 Source / Map Lama:**");
    lines.push("```json");
    lines.push(formatJson(item.sourceValue));
    lines.push("```");
  }

  if (Object.prototype.hasOwnProperty.call(item, "targetBeforeValue")) {
    lines.push("**📥 Target Sebelum Transfer / Map Baru:**");
    lines.push("```json");
    lines.push(formatJson(item.targetBeforeValue));
    lines.push("```");
  }

  if (Object.prototype.hasOwnProperty.call(item, "targetAfterValue")) {
    lines.push("**✅ Target Sesudah Transfer / Map Baru:**");
    lines.push("```json");
    lines.push(formatJson(item.targetAfterValue));
    lines.push("```");
  }

  if (Array.isArray(item.roundChecks) && item.roundChecks.length > 0) {
    lines.push("**🔁 Hasil Verifikasi 3x Proses:**");
    for (const round of item.roundChecks) {
      lines.push(
        `• Ronde ${round.round}: tulis=${round.writeStatus || "-"} | verifikasi=${
          round.verified ? "berhasil" : "tidak cocok"
        }`
      );
    }
  }

  return lines;
}

function splitLinesToChunks(lines, maxLength = 3800) {
  const chunks = [];
  let current = "";

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maxLength) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

async function sendCategoryDetailEmbeds(ticketChannel, title, color, items) {
  if (!items || items.length === 0) return;

  const itemBlocks = [];
  for (const item of items) {
    itemBlocks.push(...buildResultDetailLines(item), "");
  }

  const chunks = splitLinesToChunks(itemBlocks, 3800);

  for (let i = 0; i < chunks.length; i++) {
    const embed = new EmbedBuilder()
      .setTitle(chunks.length > 1 ? `${title} (${i + 1}/${chunks.length})` : title)
      .setDescription(chunks[i])
      .setColor(color)
      .setTimestamp();

    await ticketChannel.send({ embeds: [embed] });
  }
}

function buildDmSuccessText(job, summary) {
  const selectedText = getSelectedDatastoresForJob(job)
    .map((ds) => `• ${ds.label}`)
    .join("\n");

  return [
    "✅ Transfer data Roblox selesai diproses.",
    "",
    ...formatIdentityLines(job.robloxUser).map((line) => line.replace(/\*\*/g, "")),
    "",
    "📦 Datastore yang dipilih:",
    selectedText || "-",
    "",
    `✅ Berhasil: ${summary.success.length}`,
    `⏭️ Skip: ${summary.skipped.length}`,
    `❌ Gagal: ${summary.failed.length}`,
    "",
    "Detail hasil lengkap ada di ticket transfer kamu.",
    "Silakan masuk kembali ke Map Oleng Beach untuk mengecek hasil data terbaru.",
  ].join("\n");
}

function buildDmFailureText(job, err) {
  return [
    "❌ Transfer data Roblox gagal.",
    "",
    ...formatIdentityLines(job.robloxUser).map((line) => line.replace(/\*\*/g, "")),
    "",
    `Error: ${getErrorMessage(err)}`,
  ].join("\n");
}

async function transferSingleDatastore(ds, robloxUser, job) {
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

    const sourceValue = extractEntryValue(sourceData);

    if (typeof sourceValue === "undefined") {
      return {
        datastore: ds.name,
        label: ds.label,
        key,
        status: "skip (value undefined)",
        reason: "Value dari source kosong / undefined.",
      };
    }

    let targetBeforeValue;
    try {
      const targetBeforeData = await getDatastoreEntry(
        targetHttp,
        TARGET_UNIVERSE_ID,
        ds.name,
        ds.scope,
        key,
        job
      );
      targetBeforeValue = extractEntryValue(targetBeforeData);
    } catch (err) {
      if (getErrorStatus(err) !== 404) throw err;
      targetBeforeValue = undefined;
    }

    const roundChecks = [];
    let finalWriteStatus = "unknown";
    let targetAfterValue = undefined;

    for (let round = 1; round <= 3; round++) {
      if (job.cancelled) {
        throw new Error("JOB_CANCELLED");
      }

      const writeStatus = await writeTargetEntry(ds.name, ds.scope, key, sourceValue, job);
      finalWriteStatus = writeStatus;

      await sleep(3000);

      let verifyValue = undefined;
      try {
        const targetAfterData = await getDatastoreEntry(
          targetHttp,
          TARGET_UNIVERSE_ID,
          ds.name,
          ds.scope,
          key,
          job
        );
        verifyValue = extractEntryValue(targetAfterData);
      } catch (err) {
        if (getErrorStatus(err) !== 404) throw err;
      }

      const verified = isDeepEqual(sourceValue, verifyValue);

      roundChecks.push({
        round,
        writeStatus,
        verified,
      });

      targetAfterValue = verifyValue;
    }

    const allVerified = roundChecks.every((item) => item.verified);

    if (!allVerified) {
      return {
        datastore: ds.name,
        label: ds.label,
        key,
        status: "failed (verifikasi tidak cocok)",
        reason: "Setelah 3 ronde proses, hasil target masih tidak sama dengan source.",
        sourceValue,
        targetBeforeValue,
        targetAfterValue,
        roundChecks,
      };
    }

    return {
      datastore: ds.name,
      label: ds.label,
      key,
      status: `transferred (${finalWriteStatus})`,
      reason: "Transfer dan verifikasi 3 ronde berhasil.",
      sourceValue,
      targetBeforeValue,
      targetAfterValue,
      roundChecks,
    };
  } catch (err) {
    if (job.cancelled || err.message === "JOB_CANCELLED" || err.code === "ERR_CANCELED") {
      throw new Error("JOB_CANCELLED");
    }

    const status = getErrorStatus(err);

    if (status === 404) {
      return {
        datastore: ds.name,
        label: ds.label,
        key,
        status: "skip (key tidak ada)",
        reason: "Key datastore tidak ditemukan di source / map lama.",
      };
    }

    return {
      datastore: ds.name,
      label: ds.label,
      key,
      status: `failed (${getErrorMessage(err)})`,
      reason: getErrorMessage(err),
    };
  }
}

async function processTransferJob(job) {
  const { ticketChannel, discordUser, robloxUser } = job;

  const selectedDatastores = getSelectedDatastoresForJob(job);

  await ticketChannel.send({
    embeds: [buildProgressEmbed(job)],
  });

  const results = [];

  for (const ds of selectedDatastores) {
    if (job.cancelled) {
      throw new Error("JOB_CANCELLED");
    }

    const result = await transferSingleDatastore(ds, robloxUser, job);
    results.push(result);
  }

  if (job.cancelled) {
    throw new Error("JOB_CANCELLED");
  }

  const summary = {
    success: results.filter((r) => String(r.status).startsWith("transferred")),
    skipped: results.filter((r) => String(r.status).startsWith("skip")),
    failed: results.filter((r) => String(r.status).startsWith("failed")),
    all: results,
  };

  await ticketChannel.send({
    embeds: [buildSuccessSummaryEmbed(job, summary)],
    components: buildRetryTransferComponents(),
  });

  await sendCategoryDetailEmbeds(ticketChannel, "✅ Detail Datastore Berhasil", 0x2ecc71, summary.success);
  await sendCategoryDetailEmbeds(ticketChannel, "⏭️ Detail Datastore Skip", 0xf1c40f, summary.skipped);
  await sendCategoryDetailEmbeds(ticketChannel, "❌ Detail Datastore Gagal", 0xe74c3c, summary.failed);

  await safeLockTicketChannel(ticketChannel, discordUser.id);

  await safeSendDM(discordUser, buildDmSuccessText(job, summary));
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
        .setTitle("📢 Konfirmasi Sebelum Transfer Data")
        .setDescription(
          [
            "Pastikan kamu **sudah keluar dari Map Oleng Beach** sebelum memulai transfer data.",
            "",
            "⚠️ Kalau kamu masih berada di dalam map saat transfer dilakukan, data bisa tidak sinkron atau tidak ter-update dengan benar.",
            "",
            "Kalau kamu sudah benar-benar keluar dari map, klik tombol di bawah ini.",
          ].join("\n")
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

      const overwriteEmbed = new EmbedBuilder()
        .setTitle("⚠️ Konfirmasi Penting Sebelum Lanjut")
        .setDescription(
          [
            "Jika kamu melanjutkan proses transfer data, maka **data yang ada di Map Baru saat ini akan dikembalikan / ditimpa mengikuti data dari Map Lama** yang terkena banned.",
            "",
            "Artinya, data terbaru yang sekarang ada di Map Baru bisa **terganti** oleh data lama hasil transfer.",
            "",
            "Kalau kamu paham dan setuju, klik **✅ SETUJU**.",
            "Kalau tidak setuju, klik **❌ TIDAK SETUJU** dan proses akan dibatalkan. Jika ingin transfer lagi nanti, kamu harus klik tombol transfer dari awal.",
          ].join("\n")
        )
        .setColor(0xe67e22)
        .setTimestamp();

      await interaction.update({
        embeds: [overwriteEmbed],
        components: buildOverwriteConfirmComponents(),
      });
      return;
    }

    if (interaction.isButton() && interaction.customId === "agree_overwrite_transfer") {
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

    if (interaction.isButton() && interaction.customId === "disagree_overwrite_transfer") {
      pendingConfirmations.delete(interaction.user.id);

      await interaction.update({
        content:
          "Proses dibatalkan. Jika kamu ingin melakukan transfer data, silakan klik tombol **🚀 TRANSFER DATA** dari awal lagi.",
        embeds: [],
        components: [],
      });
      return;
    }

    if (interaction.isButton() && interaction.customId === "close_ticket") {
      await closeTicketFlow(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId === "retry_transfer") {
      const channel = interaction.channel;
      const job = activeJobs.get(channel.id);

      if (!job) {
        await interaction.reply({
          content: "Data job transfer tidak ditemukan. Silakan buat ticket baru.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (job.running) {
        await interaction.reply({
          content: "Transfer masih sedang berjalan. Mohon tunggu sampai selesai.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      job.cancelled = false;
      job.cancelReason = null;
      job.abortController = new AbortController();
      job.running = true;

      await interaction.reply({
        content: "🔁 Transfer ulang dimulai. Mohon tunggu...",
        flags: MessageFlags.Ephemeral,
      });

      processTransferJob(job)
        .then(async () => {
          job.running = false;
          console.log(`Retry job success for ${job.robloxUser.name} (${job.robloxUser.id})`);
        })
        .catch(async (err) => {
          job.running = false;

          const isCancelled =
            job.cancelled ||
            err.message === "JOB_CANCELLED" ||
            err.code === "ERR_CANCELED";

          if (isCancelled) {
            try {
              await channel.send(
                `Transfer data dibatalkan. Alasan: ${job.cancelReason || "ticket ditutup"}`
              );
            } catch (_) {}
            return;
          }

          try {
            await channel.send({
              embeds: [buildFailureEmbed(job, getErrorMessage(err))],
              components: buildRetryTransferComponents(),
            });

            await safeSendDM(job.discordUser, buildDmFailureText(job, err));
          } catch (sendErr) {
            console.log("Failed to send retry failure message:", getErrorMessage(sendErr));
          }
        });

      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === "select_datastores") {
      const channel = interaction.channel;
      const job = activeJobs.get(channel.id);

      if (!job) {
        await interaction.reply({
          content: "Ticket/job tidak ditemukan.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.user.id !== job.discordUser.id) {
        await interaction.reply({
          content: "Hanya pembuat ticket yang bisa memilih datastore.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      job.selectedDatastores = interaction.values.filter((name) => DATASTORE_MAP.has(name));

      await interaction.update({
        embeds: [buildDatastoreSelectionEmbed(job)],
        components: buildDatastoreSelectComponents(job),
      });
      return;
    }

    if (interaction.isButton() && interaction.customId === "select_all_datastores") {
      const channel = interaction.channel;
      const job = activeJobs.get(channel.id);

      if (!job) {
        await interaction.reply({
          content: "Ticket/job tidak ditemukan.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.user.id !== job.discordUser.id) {
        await interaction.reply({
          content: "Hanya pembuat ticket yang bisa memilih datastore.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      job.selectedDatastores = [...ALL_DATASTORE_NAMES];

      await interaction.update({
        embeds: [buildDatastoreSelectionEmbed(job)],
        components: buildDatastoreSelectComponents(job),
      });
      return;
    }

    if (interaction.isButton() && interaction.customId === "start_selected_transfer") {
      const channel = interaction.channel;
      const job = activeJobs.get(channel.id);

      if (!job) {
        await interaction.reply({
          content: "Ticket/job tidak ditemukan.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.user.id !== job.discordUser.id) {
        await interaction.reply({
          content: "Hanya pembuat ticket yang bisa memulai transfer.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (job.running) {
        await interaction.reply({
          content: "Transfer sedang berjalan. Mohon tunggu.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (!Array.isArray(job.selectedDatastores) || job.selectedDatastores.length === 0) {
        await interaction.reply({
          content: "Silakan pilih minimal 1 datastore terlebih dahulu.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      job.running = true;

      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setTitle("✅ Pilihan Datastore Tersimpan")
            .setDescription(
              [
                ...formatIdentityLines(job.robloxUser),
                "",
                "Pilihan datastore kamu sudah disimpan.",
                "Proses transfer data akan segera dimulai.",
              ].join("\n")
            )
            .setColor(0x57f287)
            .setTimestamp(),
        ],
        components: [],
      });

      processTransferJob(job)
        .then(async () => {
          job.running = false;
          console.log(`Job success for ${job.robloxUser.name} (${job.robloxUser.id})`);
        })
        .catch(async (err) => {
          job.running = false;

          const isCancelled =
            job.cancelled ||
            err.message === "JOB_CANCELLED" ||
            err.code === "ERR_CANCELED";

          if (isCancelled) {
            try {
              if (channel) {
                await channel.send(
                  `Transfer data dibatalkan. Alasan: ${job.cancelReason || "ticket ditutup"}`
                );
              }
            } catch (_) {}
            return;
          }

          try {
            await channel.send({
              embeds: [buildFailureEmbed(job, getErrorMessage(err))],
              components: buildRetryTransferComponents(),
            });

            await safeSendDM(job.discordUser, buildDmFailureText(job, err));
          } catch (sendErr) {
            console.log("Failed to send failure message:", getErrorMessage(sendErr));
          }
        });

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

      const existingJob = findActiveJobByRobloxUserId(robloxUser.id);

if (existingJob) {
  await interaction.editReply({
    content: [
      "⚠️ Username Roblox ini sudah memiliki ticket transfer yang masih aktif.",
      "",
      `👤 Username: ${robloxUser.name}`,
      `🪪 Display Name: ${robloxUser.displayName}`,
      `🆔 User ID: ${robloxUser.id}`,
      "",
      `Silakan lanjutkan di ticket yang sudah ada: ${existingJob.ticketChannel}`,
      "Kalau ingin membuat ticket baru, tutup ticket yang lama terlebih dahulu.",
    ].join("\n"),
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
        selectedDatastores: [],
        createdAt: Date.now(),
        cancelReason: null,
        cancelled: false,
        running: false,
        abortController: new AbortController(),
        autoCloseTimeout: null,
      };

      activeJobs.set(ticketChannel.id, job);
      setupAutoClose(job);

      await ticketChannel.send({
        content: `<@${discordUser.id}>`,
        embeds: [buildTicketCreatedEmbed(job)],
      });

      await ticketChannel.send({
        embeds: [buildDatastoreSelectionEmbed(job)],
        components: buildDatastoreSelectComponents(job),
      });

      await interaction.editReply({
        content: `Ticket berhasil dibuat: ${ticketChannel}`,
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