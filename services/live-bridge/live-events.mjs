import { CommentQueue, normalizeComment, providerAlias, providerTime } from './intake-core.mjs';
const fail = (code) => {
  throw Object.assign(Error(code), { code });
};
export function normalizeLiveEvent(value, now = Date.now()) {
  if (!value || !['VIEWER_COUNT', 'MEMBER_JOIN'].includes(value.type)) fail('INVALID_LIVE_EVENT');
  const keys =
    value.type === 'VIEWER_COUNT'
      ? ['type', 'event_id', 'occurred_at', 'viewer_count']
      : ['type', 'event_id', 'occurred_at'];
  if (Object.keys(value).some((key) => !keys.includes(key))) fail('INVALID_LIVE_EVENT_FIELD');
  const checked = normalizeComment(
    {
      message_id: value.event_id,
      author_external_id: 'event',
      author_display_name: 'event',
      text: 'event',
      occurred_at: value.occurred_at,
    },
    now,
  );
  if (
    value.type === 'VIEWER_COUNT' &&
    (!Number.isSafeInteger(value.viewer_count) ||
      value.viewer_count < 0 ||
      value.viewer_count > 2147483647)
  )
    fail('INVALID_VIEWER_COUNT');
  return {
    type: value.type,
    event_id: checked.message_id,
    occurred_at: checked.occurred_at,
    ...(value.type === 'VIEWER_COUNT' ? { viewer_count: value.viewer_count } : {}),
  };
}
export function normalizeTikTokEvent(type, data, now = Date.now()) {
  const id = providerAlias(data?.common?.msgId, data?.msgId, 'MESSAGE_ID');
  let count;
  if (type === 'VIEWER_COUNT') {
    if (data?.total != null) {
      if (typeof data.total !== 'string' || !/^(0|[1-9]\d{0,9})$/u.test(data.total))
        fail('INVALID_VIEWER_COUNT');
      count = Number(data.total);
      if (data.viewerCount != null && count !== data.viewerCount)
        fail('PROVIDER_VIEWER_COUNT_CONFLICT');
    } else count = data?.viewerCount;
  } else if (type === 'MEMBER_JOIN') {
    const userId = providerAlias(data?.user?.id, data?.user?.userId, 'AUTHOR_ID');
    if (
      typeof userId !== 'string' ||
      !userId.trim() ||
      userId.length > 200 ||
      /[\u0000-\u001f\u007f]/u.test(userId)
    )
      fail('INVALID_AUTHOR_ID');
  }
  return normalizeLiveEvent(
    {
      type,
      event_id: id,
      occurred_at: providerTime(data, now),
      ...(type === 'VIEWER_COUNT' ? { viewer_count: count } : {}),
    },
    now,
  );
}
export class LiveEventQueue extends CommentQueue {
  constructor(options) {
    super({
      ...options,
      normalize: normalizeLiveEvent,
      key: (row) => `${row.type}:${row.event_id}`,
      kind: 'live_events',
    });
  }
}
export async function flushLiveEvents(queue, client) {
  const batch = queue.peek(100);
  if (!batch.length) return { inserted: 0, duplicates: 0 };
  const result = await client.rpc('ingest_live_events', {
    p_workspace_id: queue.workspaceId,
    p_session_id: queue.sessionId,
    p_events: batch,
  });
  if (
    !Number.isInteger(result?.inserted) ||
    !Number.isInteger(result?.duplicates) ||
    result.inserted < 0 ||
    result.duplicates < 0 ||
    result.inserted + result.duplicates !== batch.length
  )
    fail('INGEST_ACK_INVALID');
  await queue.ack(batch);
  return result;
}
