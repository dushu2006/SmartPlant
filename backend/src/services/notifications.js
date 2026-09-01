'use strict';

/**
 * Notification service — in-app notifications with deduplication.
 * Channels (browser push / email / SMS) are pluggable: register a channel
 * function in `channels` and it will be called for every notification.
 * PRD §51.
 */
const { createNotification } = require('../store/audit');
const usersStore = require('../store/users');

const channels = {
  console: (n) => {
    require('../logger').info('notification', { user: n.user_id, type: n.type, title: n.title });
  },
};

function registerChannel(name, fn) {
  channels[name] = fn;
}

/**
 * Send a notification. Deduplication is enforced by dedupe_key (unique index).
 * When recipients is omitted, all ACTIVE users receive it.
 */
function notify({ recipients, type, title, body, entityType, entityId, dedupeKey }) {
  let userIds = recipients;
  if (!userIds || !userIds.length) {
    const rows = usersStore.list({ status: 'ACTIVE', pageSize: 500 }).rows;
    userIds = rows.map((u) => u.id);
  }
  const sent = [];
  for (const userId of userIds) {
    const created = createNotification({
      id: require('crypto').randomUUID(),
      user_id: userId,
      type,
      title,
      body: body ?? null,
      entity_type: entityType ?? null,
      entity_id: entityId ?? null,
      dedupe_key: dedupeKey ?? null,
    });
    if (created) {
      const n = { user_id: userId, type, title, body, entity_type: entityType, entity_id: entityId };
      for (const ch of Object.values(channels)) {
        try {
          ch(n);
        } catch (err) {
          require('../logger').warn('notification channel failed', { error: err.message });
        }
      }
      sent.push(n);
    }
  }
  return sent;
}

module.exports = { notify, registerChannel };
