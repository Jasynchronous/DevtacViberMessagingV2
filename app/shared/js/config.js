// ─────────────────────────────────────────────────────────────────────────────
// Devtac Messaging – Shared Config (Desk Widget)
//
// Single source of truth for constants shared across all Desk widget pages
// (chat, notification, etc.).
//
// When duplicating this widget for Viber or WhatsApp, only edit this file.
//
// CHANNEL VALUES:
//   SMS      → namespace: devtacsmsmessaging
//   Viber    → namespace: devtacvibermessaging   (future)
//   WhatsApp → namespace: devtacwhatsappmessaging (future)
// ─────────────────────────────────────────────────────────────────────────────

export const CONFIG = {

    // ── Identity ───────────────────────────────────────────────────────────────
    // The Zoho Sigma extension namespace. Change this when duplicating for
    // another channel.
    NAMESPACE: "devtacvibermessaging",

    // The messaging channel. Used as a display label and as the "channel"
    // parameter sent to the backend send function.
    CHANNEL: "Viber",

    // Display name shown in widget headers.
    WIDGET_NAME: "Devtac Viber Messaging",
};

// ── Shorthand helper ──────────────────────────────────────────────────────────
const ns = CONFIG.NAMESPACE;

// ── Template field names ──────────────────────────────────────────────────────
export const TEMPLATE_FIELDS = {
    MODULE:          `${ns}__Module`,
    MESSAGE_CONTENT: `${ns}__Message_Content`,
};

// ── Log record field names ────────────────────────────────────────────────────
export const LOG_FIELDS = {
    DIRECTION:            `${ns}__Direction`,
    STATUS:               `${ns}__Status`,
    MESSAGE_CONTENT:      `${ns}__Message_Content`,
    MESSAGE_TIMESTAMP:    `${ns}__Message_Timestamp`,
    RECIPIENT_NUMBER:     `${ns}__Recipient_Number`,
    SENDER_NUMBER:        `${ns}__Sender_Number`,
    SELECTED_PHONE_FIELD: `${ns}__Selected_Phone_Field`,
};

// ── Catalyst / backend function names ─────────────────────────────────────────
export const FUNCTIONS = {
    SEND_MESSAGE: `${ns}__senddevtacmessage`,
};
