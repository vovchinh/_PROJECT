import { test, expect } from '@playwright/test';
import { setup, calls, tab, wid, widB } from './helpers/live-fixture.js';

const firstChannel = {
  id: 'channel-1',
  username: 'chidi.vibes2',
  is_default: true,
  is_active: true,
};
const secondChannel = {
  id: 'channel-2',
  username: 'chidi.second',
  is_default: false,
  is_active: true,
};
const settings = (page) => page.locator('.tiktok-channel-settings');
const home = (page) => page.getByRole('region', { name: 'Kết nối TikTok LIVE', exact: true });

async function start(page, options = {}) {
  const seed = options.seed;
  return setup(page, {
    ...options,
    sellerMode: true,
    seed(state) {
      state.channels = [{ ...firstChannel }];
      state.connections = [];
      state.sessions = [];
      state.campaigns = [];
      state.comments = [];
      seed?.(state);
    },
  });
}

function noBusinessWrites(state) {
  for (const name of [
    'save_live_campaign',
    'save_live_session',
    'claim_live_comment',
    'commit_live_sale_ticket',
    'reserve_inventory',
    'claim_live_print_job',
    'finish_live_print_job',
  ])
    expect(calls(state, name), name).toHaveLength(0);
  expect(state.tickets).toHaveLength(0);
  expect(state.pageErrors).toEqual([]);
}

async function reload(page) {
  await page.getByRole('button', { name: 'Tải lại', exact: true }).click();
}

test('Typing chidi.vibes2 character by character adds the complete ID without navigating away', async ({
  page,
}) => {
  const state = await start(page, {
    seed: (s) => {
      s.channels = [];
    },
  });
  await tab(page, 'Thiết lập Live & máy in');
  const address = page.url();
  const input = page.getByLabel('TikTok ID 1', { exact: true });
  await input.click();
  await input.pressSequentially('chidi.vibes2', { delay: 30 });
  await expect(input).toHaveValue('chidi.vibes2');
  await expect(input).toBeFocused();
  await expect(settings(page)).toBeVisible();
  expect(page.url()).toBe(address);
  expect(calls(state, 'save_tiktok_channel')).toHaveLength(0);
  await settings(page).getByRole('button', { name: 'LƯU', exact: true }).click();
  await expect(settings(page).getByRole('button', { name: 'SỬA', exact: true })).toBeVisible();
  expect(calls(state, 'save_tiktok_channel')).toHaveLength(1);
  expect(calls(state, 'save_tiktok_channel')[0].input.p_payload.username).toBe('chidi.vibes2');
  expect(state.channels).toHaveLength(1);
  expect(state.channels[0].username).toBe('chidi.vibes2');
  noBusinessWrites(state);
});

test('SỬA does not submit the old ID and permits typing chidi.vibes2 before explicit save', async ({
  page,
}) => {
  const state = await start(page, {
    seed: (s) => {
      s.channels[0].username = 'chidi.old';
    },
  });
  await tab(page, 'Thiết lập Live & máy in');
  const address = page.url();
  const input = page.getByLabel('TikTok ID 1', { exact: true });
  await expect(input).toHaveAttribute('readonly', '');
  await settings(page).getByRole('button', { name: 'SỬA', exact: true }).click();
  await expect(settings(page).getByRole('button', { name: 'LƯU', exact: true })).toBeVisible();
  await expect(input).not.toHaveAttribute('readonly', '');
  expect(calls(state, 'save_tiktok_channel')).toHaveLength(0);
  await input.click();
  await input.press('ControlOrMeta+A');
  await input.press('Backspace');
  await input.pressSequentially('chidi.vibes2', { delay: 30 });
  await expect(input).toHaveValue('chidi.vibes2');
  await expect(input).toBeFocused();
  await expect(settings(page)).toBeVisible();
  expect(page.url()).toBe(address);
  expect(calls(state, 'save_tiktok_channel')).toHaveLength(0);
  await settings(page).getByRole('button', { name: 'LƯU', exact: true }).click();
  await expect(settings(page).getByRole('button', { name: 'SỬA', exact: true })).toBeVisible();
  await expect(input).toHaveAttribute('readonly', '');
  expect(calls(state, 'save_tiktok_channel')).toHaveLength(1);
  expect(calls(state, 'save_tiktok_channel')[0].input.p_payload).toMatchObject({
    id: firstChannel.id,
    username: 'chidi.vibes2',
  });
  expect(state.channels).toHaveLength(1);
  expect(state.channels[0].username).toBe('chidi.vibes2');
  noBusinessWrites(state);
});

test('Seller saves only TikTok ID, sees one default channel, and has no manual session setup', async ({
  page,
}) => {
  const state = await start(page, {
    seed: (s) => {
      s.channels = [];
    },
  });
  await expect(home(page)).toContainText('Thêm TikTok ID');
  await expect(page.getByLabel('Phiên đang vận hành')).toHaveCount(0);
  await tab(page, 'Thiết lập Live & máy in');
  await expect(settings(page).getByRole('heading', { name: 'Quản lý kênh TikTok' })).toBeVisible();
  await page.getByLabel('TikTok ID 1', { exact: true }).fill('@ChiDi.Vibes2');
  await settings(page).getByRole('button', { name: 'LƯU', exact: true }).click();
  await expect(settings(page).getByRole('button', { name: 'SỬA', exact: true })).toBeVisible();
  expect(calls(state, 'save_tiktok_channel')[0].input).toMatchObject({
    p_workspace_id: wid,
    p_payload: { username: 'chidi.vibes2', is_default: true, is_active: true },
  });
  expect(Object.keys(calls(state, 'save_tiktok_channel')[0].input.p_payload).sort()).toEqual([
    'is_active',
    'is_default',
    'username',
  ]);
  for (const label of [
    'Tên hồ sơ kết nối',
    'Mã chiến dịch',
    'Mã phiên',
    'Room / username của nguồn',
  ])
    await expect(page.getByLabel(label, { exact: true })).toHaveCount(0);
  for (const action of ['Tạo chiến dịch', 'Tạo phiên live', 'Thêm tài khoản TikTok'])
    await expect(page.getByRole('button', { name: action, exact: true })).toHaveCount(0);
  await expect(settings(page).locator('input[type=password]')).toHaveCount(0);
  await tab(page, 'Bàn live');
  await expect(home(page).getByText('@chidi.vibes2', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Chọn kênh TikTok')).toHaveCount(0);
  await expect(home(page).getByRole('button', { name: 'KẾT NỐI LIVE', exact: true })).toBeEnabled();
  noBusinessWrites(state);
});

test('An ID with LIVE history can be saved as a new default channel while preserving the original', async ({
  page,
}) => {
  const state = await start(page, {
    seed: (s) => {
      s.channels[0].username = 'chidi.original';
      s.channelHistoryIds = [firstChannel.id];
      s.sessions = [
        {
          id: 'historical-live',
          integration_account_id: firstChannel.id,
          campaign_id: 'historical-campaign',
          title: 'Phiên đã kết thúc',
          provider: 'tiktok_live',
          room_id: 'chidi.original',
          status: 'ended',
          connection_status: 'disconnected',
        },
      ];
    },
  });
  const originalSessions = structuredClone(state.sessions);
  await tab(page, 'Thiết lập Live & máy in');
  await settings(page).getByRole('button', { name: 'SỬA', exact: true }).click();
  const input = page.getByLabel('TikTok ID 1', { exact: true });
  await input.click();
  await input.press('ControlOrMeta+A');
  await input.press('Backspace');
  await input.pressSequentially('chidi.vibes2', { delay: 30 });
  await settings(page).getByRole('button', { name: 'LƯU', exact: true }).click();
  await expect(settings(page).getByRole('alert')).toContainText('TIKTOK_CHANNEL_USED');
  expect(state.channels[0].username).toBe('chidi.original');
  await settings(page)
    .getByRole('button', { name: 'LƯU THÀNH TIKTOK ID MỚI', exact: true })
    .click();
  await expect(settings(page).getByRole('button', { name: 'SỬA', exact: true })).toHaveCount(2);
  await expect(page.getByLabel('TikTok ID 1', { exact: true })).toHaveValue('chidi.original');
  await expect(page.getByLabel('TikTok ID 2', { exact: true })).toHaveValue('chidi.vibes2');
  const attempts = calls(state, 'save_tiktok_channel');
  expect(attempts).toHaveLength(2);
  expect(attempts[0].input.p_payload.id).toBe(firstChannel.id);
  expect(attempts[1].input.p_payload).not.toHaveProperty('id');
  expect(attempts[1].input.p_payload).toMatchObject({
    username: 'chidi.vibes2',
    is_default: true,
    is_active: true,
  });
  expect(attempts[1].input.p_request_id).not.toBe(attempts[0].input.p_request_id);
  expect(state.channels).toHaveLength(2);
  expect(state.channels.filter((channel) => channel.is_default)).toHaveLength(1);
  expect(state.channels.find((channel) => channel.is_default).username).toBe('chidi.vibes2');
  expect(state.sessions).toEqual(originalSessions);
  expect(calls(state, 'request_tiktok_connection')).toHaveLength(0);
  noBusinessWrites(state);
});

test('Channel save validates username and retries the same request ID after a failed response', async ({
  page,
}) => {
  const state = await start(page, {
    seed: (s) => {
      s.channels = [];
      s.channelSaveFailures = 1;
    },
  });
  await tab(page, 'Thiết lập Live & máy in');
  await page.getByLabel('TikTok ID 1', { exact: true }).fill('bad handle');
  await settings(page).getByRole('button', { name: 'LƯU', exact: true }).click();
  await expect(settings(page).getByRole('alert')).toContainText('TikTok ID tối đa 24');
  expect(calls(state, 'save_tiktok_channel')).toHaveLength(0);
  await page.getByLabel('TikTok ID 1', { exact: true }).fill('shop_retry');
  await settings(page).getByRole('button', { name: 'LƯU', exact: true }).click();
  await expect(settings(page).getByRole('alert')).toContainText('Mất phản hồi');
  await settings(page).getByRole('button', { name: 'LƯU', exact: true }).click();
  await expect(settings(page).getByRole('button', { name: 'SỬA', exact: true })).toBeVisible();
  const attempts = calls(state, 'save_tiktok_channel');
  expect(attempts).toHaveLength(2);
  expect(attempts[0].input).toEqual(attempts[1].input);
  expect(state.channels).toHaveLength(1);
  noBusinessWrites(state);
});

test('Additional channels can be saved, edited and selected while the default is used on first entry', async ({
  page,
}) => {
  const state = await start(page);
  await tab(page, 'Thiết lập Live & máy in');
  await settings(page).getByRole('button', { name: 'THÊM TIKTOK ID', exact: true }).click();
  await page.getByLabel('TikTok ID 2', { exact: true }).fill('chidi.second');
  await settings(page).getByLabel('Chọn làm kênh mặc định').check();
  await settings(page).getByRole('button', { name: 'LƯU', exact: true }).click();
  await expect(settings(page).getByRole('button', { name: 'SỬA', exact: true })).toHaveCount(2);
  expect(state.channels.filter((c) => c.is_default)).toHaveLength(1);
  expect(state.channels.find((c) => c.is_default).username).toBe('chidi.second');
  const secondRow = settings(page)
    .locator('.tiktok-channel-row')
    .filter({ has: page.getByLabel('TikTok ID 2', { exact: true }) });
  await secondRow.getByRole('button', { name: 'SỬA', exact: true }).click();
  await page.getByLabel('TikTok ID 2', { exact: true }).fill('chidi.second_2');
  await secondRow.getByRole('button', { name: 'LƯU', exact: true }).click();
  await expect(secondRow.getByRole('button', { name: 'SỬA', exact: true })).toBeVisible();
  expect(calls(state, 'save_tiktok_channel').at(-1).input.p_payload.id).toBe('channel-2');
  await tab(page, 'Bàn live');
  await page.getByLabel('Chọn kênh TikTok').selectOption('channel-2');
  await expect(page.getByLabel('Chọn kênh TikTok')).toHaveValue('channel-2');
  noBusinessWrites(state);
});

test('Existing default channel is selected automatically; offline response creates no session or sale', async ({
  page,
}) => {
  const state = await start(page, {
    seed: (s) => {
      s.channels = [
        { ...firstChannel, is_default: false },
        { ...secondChannel, is_default: true },
      ];
    },
  });
  await expect(page.getByLabel('Chọn kênh TikTok')).toHaveValue('channel-2');
  await home(page).getByRole('button', { name: 'KẾT NỐI LIVE', exact: true }).click();
  await expect(home(page).getByText('Vui lòng bật live', { exact: true })).toBeVisible();
  expect(calls(state, 'request_tiktok_connection')[0].input).toMatchObject({
    p_channel_id: 'channel-2',
    p_desired_state: 'connected',
  });
  expect(state.sessions).toHaveLength(0);
  expect(state.campaigns).toHaveLength(0);
  await expect(page.getByRole('heading', { name: 'Bình luận và gợi ý SKU' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Số thứ tự khách hàng' })).not.toContainText(
    'STT 001',
  );
  noBusinessWrites(state);
});

test('Waiting for provider remains pending, disables repeated connect and never opens a made-up session', async ({
  page,
}) => {
  const state = await start(page, {
    seed: (s) => {
      s.channelOutcome = 'waiting';
    },
  });
  await home(page).getByRole('button', { name: 'KẾT NỐI LIVE', exact: true }).click();
  await expect(
    home(page).getByRole('button', { name: 'ĐANG KẾT NỐI…', exact: true }),
  ).toBeDisabled();
  await expect(home(page).getByRole('button', { name: 'Ngắt kết nối', exact: true })).toBeEnabled();
  await expect(home(page)).not.toContainText('Đang nhận LIVE của');
  expect(calls(state, 'request_tiktok_connection')).toHaveLength(1);
  expect(state.sessions).toHaveLength(0);
  noBusinessWrites(state);
});

test('Actual LIVE response opens its server session and stable refresh does not clear the selected feed', async ({
  page,
}) => {
  const state = await start(page, {
    seed: (s) => {
      s.channelOutcome = 'live';
    },
  });
  await home(page).getByRole('button', { name: 'KẾT NỐI LIVE', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Bình luận và gợi ý SKU' })).toBeVisible();
  await expect(page.locator('.live-comment')).toContainText('Khách @chidi.vibes2');
  expect(calls(state, 'get_live_intake').at(-1).input.p_session_id).toBe('live-channel-1');
  expect(state.sessions).toHaveLength(1);
  const count = calls(state, 'get_live_intake').length;
  await reload(page);
  await expect.poll(() => calls(state, 'get_live_intake').length).toBeGreaterThan(count);
  await expect(page.locator('.live-comment')).toContainText('Khách @chidi.vibes2');
  expect(
    calls(state, 'get_live_intake')
      .slice(count)
      .every((r) => r.input.p_session_id === 'live-channel-1'),
  ).toBe(true);
  noBusinessWrites(state);
});

test('Switching from a LIVE channel to an offline channel clears previous comments and metrics', async ({
  page,
}) => {
  const state = await start(page, {
    seed: (s) => {
      s.channelOutcome = 'live';
      s.channels.push({ ...secondChannel });
    },
  });
  await home(page).getByRole('button', { name: 'KẾT NỐI LIVE', exact: true }).click();
  await expect(page.locator('.live-comment')).toContainText('Khách @chidi.vibes2');
  await page.getByLabel('Chọn kênh TikTok').selectOption('channel-2');
  await expect(page.locator('.live-comment')).toHaveCount(0);
  await expect(home(page)).toContainText('Chưa kết nối');
  await expect(page.getByRole('region', { name: 'Số thứ tự khách hàng' })).not.toContainText(
    'STT 001',
  );
  await expect.poll(() => calls(state, 'get_live_intake').at(-1).input.p_session_id).toBeNull();
  await reload(page);
  await expect(page.getByLabel('Chọn kênh TikTok')).toHaveValue('channel-2');
  await expect(page.locator('.live-comment')).toHaveCount(0);
  expect(calls(state, 'request_tiktok_connection')).toHaveLength(1);
  noBusinessWrites(state);
});

test('Provider LIVE end refreshes to offline automatically and permits reconnect without an approval dialog', async ({
  page,
}) => {
  const state = await start(page, {
    seed: (s) => {
      s.channelOutcome = 'live';
    },
  });
  const dialogs = [];
  const providerRequests = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  page.on('request', (request) => {
    const host = new URL(request.url()).hostname;
    if (/(^|\.)(tiktok\.com|tiktokv\.com|douyin\.com|eulerstream\.com)$/u.test(host))
      providerRequests.push(request.url());
  });
  await home(page).getByRole('button', { name: 'KẾT NỐI LIVE', exact: true }).click();
  await expect(home(page)).toContainText('Đang nhận LIVE của @chidi.vibes2');
  const connection = state.connections[0];
  Object.assign(connection, {
    desired_state: 'disconnected',
    connection_status: 'OFFLINE',
    message_code: 'live_ended',
    heartbeat_at: new Date().toISOString(),
    connected_since: null,
    revision: connection.revision + 1,
  });
  Object.assign(state.sessions[0], {
    status: 'ended',
    connection_status: 'disconnected',
    ended_at: new Date().toISOString(),
  });
  await reload(page);
  await expect(home(page)).toContainText('Phiên TikTok đã kết thúc. Đã tự động ngắt kết nối.');
  await expect(home(page)).not.toContainText('Đang nhận LIVE của');
  await expect(home(page).getByRole('button', { name: 'KẾT NỐI LIVE', exact: true })).toBeEnabled();
  await expect(home(page).getByRole('button', { name: 'Ngắt kết nối', exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('Email', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Mật khẩu', { exact: true })).toHaveCount(0);
  expect(dialogs).toEqual([]);
  expect(providerRequests).toEqual([]);
  expect(calls(state, 'request_tiktok_connection')).toHaveLength(1);
  expect(state.sessions).toHaveLength(1);
  expect(state.campaigns).toHaveLength(1);
  noBusinessWrites(state);
});

test('Disconnect and reconnect reuse existing server session without duplicating campaigns or business records', async ({
  page,
}) => {
  const state = await start(page, {
    seed: (s) => {
      s.channelOutcome = 'live';
    },
  });
  await home(page).getByRole('button', { name: 'KẾT NỐI LIVE', exact: true }).click();
  await expect(home(page)).toContainText('Đang nhận LIVE của @chidi.vibes2');
  await home(page).getByRole('button', { name: 'Ngắt kết nối', exact: true }).click();
  await expect(home(page).getByRole('button', { name: 'KẾT NỐI LIVE', exact: true })).toBeEnabled();
  await home(page).getByRole('button', { name: 'KẾT NỐI LIVE', exact: true }).click();
  await expect(home(page)).toContainText('Đang nhận LIVE của @chidi.vibes2');
  expect(calls(state, 'request_tiktok_connection').map((r) => r.input.p_desired_state)).toEqual([
    'connected',
    'disconnected',
    'connected',
  ]);
  expect(
    new Set(calls(state, 'request_tiktok_connection').map((r) => r.input.p_request_id)).size,
  ).toBe(3);
  expect(state.sessions).toHaveLength(1);
  expect(state.campaigns).toHaveLength(1);
  noBusinessWrites(state);
});

test('Connection request retry keeps the same UUID and never assumes LIVE on a network failure', async ({
  page,
}) => {
  const state = await start(page);
  let failed = false;
  await page.route('**/rpc/request_tiktok_connection', async (route) => {
    if (failed) return route.fallback();
    failed = true;
    state.requests.push({
      path: new URL(route.request().url()).pathname,
      input: route.request().postDataJSON(),
    });
    return route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Kết nối gián đoạn; thử lại.' }),
    });
  });
  await home(page).getByRole('button', { name: 'KẾT NỐI LIVE', exact: true }).click();
  await expect(home(page).getByRole('alert')).toContainText('Kết nối gián đoạn');
  await home(page).getByRole('button', { name: 'KẾT NỐI LIVE', exact: true }).click();
  await expect(home(page).getByText('Vui lòng bật live', { exact: true })).toBeVisible();
  const attempts = calls(state, 'request_tiktok_connection');
  expect(attempts).toHaveLength(2);
  expect(attempts[0].input).toEqual(attempts[1].input);
  expect(state.sessions).toHaveLength(0);
  noBusinessWrites(state);
});

test('Stale stored LIVE heartbeat never enters a session or claims to receive live comments', async ({
  page,
}) => {
  const state = await start(page, {
    seed: (s) => {
      s.connections = [
        {
          channel_id: firstChannel.id,
          desired_state: 'connected',
          connection_status: 'LIVE',
          current_session_id: 'stale-session',
          heartbeat_at: new Date(Date.now() - 120000).toISOString(),
          message_code: 'connected',
        },
      ];
    },
  });
  await expect(home(page)).toContainText('Chưa xác nhận được kết nối');
  await expect(home(page).getByRole('button', { name: 'THỬ KẾT NỐI LẠI' })).toBeEnabled();
  await expect(home(page)).not.toContainText('Đang nhận LIVE của');
  expect(
    calls(state, 'get_live_intake').every((r) => r.input.p_session_id !== 'stale-session'),
  ).toBe(true);
  noBusinessWrites(state);
});

test('Viewer can read saved channels but cannot change usernames or issue connection requests', async ({
  page,
}) => {
  const state = await start(page, { role: 'viewer' });
  await expect(
    home(page).getByRole('button', { name: 'KẾT NỐI LIVE', exact: true }),
  ).toBeDisabled();
  await tab(page, 'Thiết lập Live & máy in');
  await expect(page.getByLabel('TikTok ID 1', { exact: true })).toHaveAttribute('readonly', '');
  await expect(settings(page).getByRole('button', { name: /LƯU|SỬA|THÊM TIKTOK ID/ })).toHaveCount(
    0,
  );
  expect(calls(state, 'save_tiktok_channel')).toHaveLength(0);
  expect(calls(state, 'request_tiktok_connection')).toHaveLength(0);
  noBusinessWrites(state);
});

test('390px layout keeps one connect action and clears the old workspace channel on workspace change', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await start(page);
  await expect(home(page).getByRole('button', { name: 'KẾT NỐI LIVE', exact: true })).toBeVisible();
  const connectBox = await home(page)
    .getByRole('button', { name: 'KẾT NỐI LIVE', exact: true })
    .boundingBox();
  const navigationBox = await page.getByRole('navigation', { name: 'Phân hệ Live' }).boundingBox();
  expect(connectBox.y + connectBox.height).toBeLessThan(navigationBox.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath('tiktok-connect-mobile.png'), fullPage: true });
  await home(page).getByRole('button', { name: 'Đổi TikTok ID', exact: true }).click();
  await expect(page.getByLabel('TikTok ID 1', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await page.screenshot({
    path: testInfo.outputPath('tiktok-settings-mobile.png'),
    fullPage: true,
  });
  await tab(page, 'Bàn live');
  await page.getByLabel('Workspace đang làm việc').selectOption(widB);
  await expect(home(page)).toContainText('Thêm TikTok ID');
  await expect(home(page)).not.toContainText('@chidi.vibes2');
  expect(calls(state, 'request_tiktok_connection')).toHaveLength(0);
  noBusinessWrites(state);
});

const metric = (page, label) => page.getByLabel(label, { exact: true }).locator('strong');
const duration = (page) =>
  page.locator('.tiktok-live-metrics > div').filter({ hasText: 'Thời lượng' }).locator('strong');
function setRuntime(state, viewers = null) {
  const now = new Date().toISOString();
  state.runtime = {
    listener: { online: true, ready: true, heartbeat_at: now },
    telemetry: {
      session_id: 'live-channel-1',
      current_viewer_count: viewers,
      peak_viewer_count: viewers,
      last_viewer_update_at: viewers == null ? null : now,
      last_provider_event_at: now,
      last_ingest_at: now,
      last_member_at: null,
      member_event_count: 0,
    },
    diagnostics: {
      provider_version: '2.5.0',
      last_error_code: null,
      active_listener_count: 1,
      started_at: now,
      heartbeat_at: now,
    },
  };
}

test('Viewer events display actual zero and peak without comments; comments-only keep unknown viewers', async ({
  page,
}) => {
  const state = await start(page, {
    seed(s) {
      s.channelOutcome = 'live';
      setRuntime(s, 0);
      s.runtime.telemetry.peak_viewer_count = 18;
    },
  });
  await home(page).getByRole('button', { name: 'KẾT NỐI LIVE', exact: true }).click();
  await expect(metric(page, 'Người đang xem')).toHaveText('0');
  await expect(metric(page, 'Người xem cao nhất')).toHaveText('18');
  state.comments = [];
  await reload(page);
  await expect(page.locator('.live-comment')).toHaveCount(0);
  await expect(metric(page, 'Người đang xem')).toHaveText('0');
  state.comments.push({
    ...state.comment,
    id: 'comment-only',
    session_id: 'live-channel-1',
    campaign_id: 'cp-channel-1',
    raw_text: 'Bình luận không phải người xem',
  });
  state.runtime.telemetry.current_viewer_count = null;
  state.runtime.telemetry.peak_viewer_count = null;
  state.runtime.telemetry.last_viewer_update_at = null;
  state.runtime.telemetry.member_event_count = 400;
  await reload(page);
  await expect(page.locator('.live-comment')).toContainText('Bình luận không phải người xem');
  await expect(metric(page, 'Người đang xem')).toHaveText('—');
  await expect(metric(page, 'Người xem cao nhất')).toHaveText('—');
  noBusinessWrites(state);
});

test('Viewer data retains its actual value with a stale indicator after 45 seconds', async ({
  page,
}) => {
  const state = await start(page, {
    seed(s) {
      s.channelOutcome = 'live';
      setRuntime(s, 9);
      s.runtime.telemetry.last_viewer_update_at = new Date(Date.now() - 46000).toISOString();
    },
  });
  await home(page).getByRole('button', { name: 'KẾT NỐI LIVE', exact: true }).click();
  await expect(metric(page, 'Người đang xem')).toHaveText('9');
  await expect(page.getByLabel('Người đang xem', { exact: true })).toContainText(
    'Dữ liệu chưa cập nhật',
  );
  noBusinessWrites(state);
});

test('Waiting times out at 90 seconds without a listener; retry sends a fresh command without inventing LIVE', async ({
  page,
}) => {
  await page.clock.install({ time: new Date() });
  const state = await start(page, {
    seed(s) {
      s.channelOutcome = 'waiting';
    },
  });
  await home(page).getByRole('button', { name: 'KẾT NỐI LIVE', exact: true }).click();
  await expect(
    home(page).getByRole('button', { name: 'ĐANG KẾT NỐI…', exact: true }),
  ).toBeDisabled();
  await expect(home(page)).toContainText('Ứng dụng nhận LIVE trên máy quầy chưa hoạt động');
  await page.clock.fastForward(91000);
  await expect(home(page).getByRole('button', { name: 'THỬ KẾT NỐI LẠI' })).toBeEnabled();
  expect(state.connections[0].connection_status).toBe('CONNECTING');
  await home(page).getByRole('button', { name: 'THỬ KẾT NỐI LẠI' }).click();
  await expect.poll(() => calls(state, 'request_tiktok_connection').length).toBe(2);
  expect(calls(state, 'request_tiktok_connection')[0].input.p_request_id).not.toBe(
    calls(state, 'request_tiktok_connection')[1].input.p_request_id,
  );
  expect(state.sessions).toHaveLength(0);
  await expect(home(page)).not.toContainText('Đang nhận LIVE của');
  noBusinessWrites(state);
});

test('An unanswered RPC stops the busy state after 12 seconds and retry preserves its UUID', async ({
  page,
}) => {
  await page.clock.install({ time: new Date() });
  const state = await start(page);
  let release,
    failed = false;
  await page.route('**/rpc/request_tiktok_connection', async (route) => {
    if (failed) return route.fallback();
    failed = true;
    state.requests.push({
      path: new URL(route.request().url()).pathname,
      input: route.request().postDataJSON(),
    });
    await new Promise((resolve) => {
      release = resolve;
    });
    await route.abort().catch(() => {});
  });
  await home(page).getByRole('button', { name: 'KẾT NỐI LIVE', exact: true }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.clock.fastForward(13000);
  await expect(home(page).getByRole('alert')).toContainText('Chưa nhận được phản hồi');
  await expect(home(page).getByRole('button', { name: 'KẾT NỐI LIVE', exact: true })).toBeEnabled();
  await home(page).getByRole('button', { name: 'KẾT NỐI LIVE', exact: true }).click();
  await expect(home(page).getByText('Vui lòng bật live', { exact: true })).toBeVisible();
  release();
  expect(calls(state, 'request_tiktok_connection')).toHaveLength(2);
  expect(calls(state, 'request_tiktok_connection')[0].input).toEqual(
    calls(state, 'request_tiktok_connection')[1].input,
  );
  noBusinessWrites(state);
});

test('Session duration ticks without comments or polling and freezes at persisted end time', async ({
  page,
}) => {
  await page.clock.install({ time: new Date() });
  const state = await start(page, {
    seed(s) {
      s.channelOutcome = 'live';
      setRuntime(s, 0);
    },
  });
  await home(page).getByRole('button', { name: 'KẾT NỐI LIVE', exact: true }).click();
  await expect(duration(page)).toHaveText(/\d\d:\d\d:\d\d/u);
  const count = calls(state, 'get_live_intake').length;
  const initial = await duration(page).innerText();
  await page.clock.runFor(2100);
  await expect(duration(page)).not.toHaveText(initial);
  expect(calls(state, 'get_live_intake')).toHaveLength(count);
  const startedAt = Date.parse(state.sessions[0].started_at);
  Object.assign(state.sessions[0], {
    status: 'ended',
    ended_at: new Date(startedAt + 3700000).toISOString(),
  });
  Object.assign(state.connections[0], {
    desired_state: 'disconnected',
    connection_status: 'OFFLINE',
    message_code: 'live_ended',
    connected_since: null,
  });
  await reload(page);
  await expect(duration(page)).toHaveText('01:01:40');
  await page.clock.runFor(2200);
  await expect(duration(page)).toHaveText('01:01:40');
  noBusinessWrites(state);
});

for (const role of ['owner', 'manager', 'staff', 'viewer']) {
  test(`Runtime diagnostics show only allowed fields and respect ${role} permissions`, async ({
    page,
  }) => {
    const state = await start(page, {
      role,
      seed(s) {
        setRuntime(s);
        s.runtime.diagnostics.last_error_code = 'SUPABASE_INGEST_FAILED';
        s.runtime.diagnostics.token = 'SHOULD_NEVER_RENDER';
      },
    });
    const summary = page.getByText('Kiểm tra kết nối LIVE', { exact: true });
    if (['owner', 'manager'].includes(role)) {
      await expect(summary).toBeVisible();
      await summary.click();
      await expect(page.locator('.tiktok-diagnostics')).toContainText('2.5.0');
      await expect(page.locator('.tiktok-diagnostics')).toContainText('Chưa lưu được dữ liệu LIVE');
      await expect(page.locator('.tiktok-diagnostics')).toContainText('Chưa có thông tin');
    } else await expect(summary).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('SHOULD_NEVER_RENDER');
    noBusinessWrites(state);
  });
}

test('Missing 012 only disables runtime metrics and preserves the working LIVE board', async ({
  page,
}) => {
  const state = await start(page, {
    seed(s) {
      s.runtimeMissing = true;
      s.channelOutcome = 'live';
    },
  });
  await expect(home(page)).toContainText('Kiểm tra migration 012');
  await home(page).getByRole('button', { name: 'KẾT NỐI LIVE', exact: true }).click();
  await expect(page.locator('.live-comment')).toContainText('Khách @chidi.vibes2');
  await expect(metric(page, 'Người đang xem')).toHaveText('—');
  noBusinessWrites(state);
});

test('Realtime telemetry event and re-subscription refetch authoritative runtime without a comment event', async ({
  page,
}) => {
  const state = await start(page, {
    realtime: true,
    seed(s) {
      s.channelOutcome = 'live';
      setRuntime(s, 2);
    },
  });
  await home(page).getByRole('button', { name: 'KẾT NỐI LIVE', exact: true }).click();
  await expect(metric(page, 'Người đang xem')).toHaveText('2');
  await expect
    .poll(() =>
      state.sockets.flatMap((s) => s.joins).some((j) => j.topic.startsWith('realtime:live:')),
    )
    .toBe(true);
  const liveSocket = state.sockets.find((s) =>
    s.joins.some((j) => j.topic.startsWith('realtime:live:')),
  );
  const join = liveSocket.joins.find((j) => j.topic.startsWith('realtime:live:'));
  const telemetryBinding = join.payload.config.postgres_changes.findIndex(
    (f) => f.table === 'live_session_telemetry',
  );
  expect(telemetryBinding).toBeGreaterThan(-1);
  expect(join.payload.config.postgres_changes[telemetryBinding].filter).toBe(
    `workspace_id=eq.${wid}`,
  );
  state.runtime.telemetry.current_viewer_count = 7;
  liveSocket.send({
    topic: join.topic,
    join_ref: join.join_ref,
    ref: null,
    event: 'postgres_changes',
    payload: {
      ids: [telemetryBinding + 1],
      data: {
        schema: 'public',
        table: 'live_session_telemetry',
        type: 'UPDATE',
        record: { workspace_id: wid, current_viewer_count: 999 },
        old_record: {},
        columns: [],
        errors: null,
        commit_timestamp: new Date().toISOString(),
      },
    },
  });
  await expect(metric(page, 'Người đang xem')).toHaveText('7');
  state.runtime.telemetry.current_viewer_count = 11;
  const socketsBefore = state.sockets.length;
  liveSocket.socket.close();
  await expect.poll(() => state.sockets.length).toBeGreaterThan(socketsBefore);
  await expect(metric(page, 'Người đang xem')).toHaveText('11');
  noBusinessWrites(state);
});

test('A late runtime response from a previous workspace cannot populate the new workspace', async ({
  page,
}) => {
  const state = await start(page, {
    seed(s) {
      s.channelOutcome = 'live';
      setRuntime(s, 5);
    },
  });
  await home(page).getByRole('button', { name: 'KẾT NỐI LIVE', exact: true }).click();
  await expect(metric(page, 'Người đang xem')).toHaveText('5');
  let release,
    caught = false;
  await page.route('**/rpc/get_live_runtime', async (route) => {
    if (caught || route.request().postDataJSON().p_workspace_id !== wid) return route.fallback();
    caught = true;
    await new Promise((resolve) => {
      release = resolve;
    });
    await route
      .fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ...state.runtime,
          telemetry: { ...state.runtime.telemetry, current_viewer_count: 999 },
        }),
      })
      .catch(() => {});
  });
  await reload(page);
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.getByLabel('Workspace đang làm việc').selectOption(widB);
  await expect(home(page)).toContainText('Thêm TikTok ID');
  release();
  await expect(metric(page, 'Người đang xem')).toHaveText('—');
  await expect(home(page)).not.toContainText('@chidi.vibes2');
  noBusinessWrites(state);
});
