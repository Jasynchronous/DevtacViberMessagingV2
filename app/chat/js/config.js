// ─────────────────────────────────────────────────────────────────────────────
// chat/js/config.js  –  Chat page config
//
// Re-exports shared constants and adds Desk-specific entity/field names.
// Desk custom modules/fields are created via API (no namespace prefix, unlike
// CRM's devtacmessaging__ convention) — these names are confirmed against the
// live cm_devtac_sms_logs module via the Desk API Explorer.
// ─────────────────────────────────────────────────────────────────────────────

export { CONFIG, FUNCTIONS } from "../../shared/js/config.js";

// ── Desk-native module names ───────────────────────────────────────────────────
export const DESK_ENTITY = {
    LOGS: "cm_devtac_sms_logs",
    TEMPLATES: "cm_devtac_sms_templates",
};

// ── Desk-native field API names (cm_devtac_sms_logs) ──────────────────────────
export const LOG_FIELDS = {
    DIRECTION: "cf_direction",         // Picklist: Inbound / Outbound
    MESSAGE_CONTENT: "cf_message_content",   // Multi-Line
    MESSAGE_TIMESTAMP: "cf_message_timestamp", // Date/Time
    MESSAGE_TYPE: "cf_message_type",      // Picklist: Transactional / Promotional
    RECIPIENT_NAME: "cf_recipient_name",    // Single Line
    RECIPIENT_NUMBER: "cf_recipient_number",  // Single Line
    RELATED_TICKET_ID: "cf_related_ticket_id", // Single Line (text, not lookup)
    SENDER_NAME: "cf_sender_name",       // Single Line
    SENDER_NUMBER: "cf_sender_number",     // Single Line
    STATUS: "cf_message_status",    // Picklist: Sending / Sent / Delivered / Received / Failed (kept in sync by send + DLR callback; cf_status is not)
    ERROR_DESCRIPTION: "cf_error_description", // Multi-Line
    SEGMENT_COUNT: "cf_segment_count",     // Integer
    MESSAGE_COUNT: "cf_message_count",     // Integer
    REQUEST_ID: "cf_request_id",        // Single Line
};

// ── Desk-native field API names (cm_devtac_sms_templates) ─────────────────────
export const TEMPLATE_FIELDS = {
    NAME: "name",              // Single Line (Devtac SMS Template Name)
    MESSAGE_CONTENT: "cf_message_content", // Multi-Line
    MODULE: "cf_module",          // Pick List (Devtac SMS Template Module scope)
};