import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { signIn, startTestServer, type TestServer } from './helpers.js';

const APP = 'https://comparagatos.github.io';

describe('web app API', () => {
	let server: TestServer;
	let token: string;

	before(async () => {
		server = await startTestServer();
		token = (await signIn(server.baseUrl)).tokens.access_token;
	});

	after(async () => {
		await server.close();
	});

	it('answers the browser preflight for the allowed app only', async () => {
		const ok = await fetch(`${server.baseUrl}/api/store`, { method: 'OPTIONS', headers: { Origin: APP, 'Access-Control-Request-Method': 'PUT' } });
		assert.equal(ok.status, 204);
		assert.equal(ok.headers.get('access-control-allow-origin'), APP);
		assert.match(ok.headers.get('access-control-allow-headers') ?? '', /Authorization/);
		const other = await fetch(`${server.baseUrl}/api/store`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'PUT' } });
		assert.equal(other.headers.get('access-control-allow-origin'), null);
		const mcp = await fetch(`${server.baseUrl}/mcp`, { method: 'OPTIONS', headers: { Origin: APP, 'Access-Control-Request-Method': 'POST' } });
		assert.equal(mcp.status, 204);
	});

	it('needs a sign-in token', async () => {
		assert.equal((await fetch(`${server.baseUrl}/api/store`, { headers: { Origin: APP } })).status, 401);
		assert.equal((await fetch(`${server.baseUrl}/api/whoop`)).status, 401);
		const put = await fetch(`${server.baseUrl}/api/store`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: { a: 1 } }) });
		assert.equal(put.status, 401);
	});

	it('keeps the app document', async () => {
		const auth = { Authorization: `Bearer ${token}`, Origin: APP };
		const empty = await (await fetch(`${server.baseUrl}/api/store`, { headers: auth })).json() as { data: unknown };
		assert.equal(empty.data, null);
		const big = { sess: Array.from({ length: 3000 }, (_, i) => ({ id: i, series: Array(60).fill(120) })) };
		const put = await fetch(`${server.baseUrl}/api/store`, { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ data: big }) });
		assert.equal(put.status, 200);
		assert.equal(put.headers.get('access-control-allow-origin'), APP);
		const back = await (await fetch(`${server.baseUrl}/api/store`, { headers: auth })).json() as { data: typeof big; updatedAt: string };
		assert.equal(back.data.sess.length, 3000);
		assert.ok(back.updatedAt);
	});

	it('says so when WHOOP is not connected', async () => {
		const res = await fetch(`${server.baseUrl}/api/whoop?days=7`, { headers: { Authorization: `Bearer ${token}` } });
		assert.equal(res.status, 409);
		assert.equal(((await res.json()) as { error: string }).error, 'whoop_not_connected');
	});
});

describe('web app API: profiles and 24-hour records', () => {
	let server: TestServer;
	let auth: Record<string, string>;

	before(async () => {
		server = await startTestServer();
		auth = { Authorization: `Bearer ${(await signIn(server.baseUrl)).tokens.access_token}`, 'Content-Type': 'application/json' };
	});

	after(async () => {
		await server.close();
	});

	it('keeps one document per profile, the owner\'s untouched', async () => {
		await fetch(`${server.baseUrl}/api/store`, { method: 'PUT', headers: auth, body: JSON.stringify({ data: { who: 'owner' } }) });
		await fetch(`${server.baseUrl}/api/store?profile=pareja`, { method: 'PUT', headers: auth, body: JSON.stringify({ data: { who: 'pareja' } }) });
		const owner = await (await fetch(`${server.baseUrl}/api/store`, { headers: auth })).json() as { data: { who: string } };
		const other = await (await fetch(`${server.baseUrl}/api/store?profile=pareja`, { headers: auth })).json() as { data: { who: string } };
		assert.equal(owner.data.who, 'owner');
		assert.equal(other.data.who, 'pareja');
		assert.equal((await fetch(`${server.baseUrl}/api/store?profile=../x`, { headers: auth })).status, 400);
	});

	it('stores and lists daily records', async () => {
		const rows = Array.from({ length: 8640 }, (_, i) => [1_760_000_000_000 + i * 10_000, 60 + (i % 20), i % 3 ? 55 : -1]);
		const put = await fetch(`${server.baseUrl}/api/log?day=20261015&profile=pareja`, { method: 'PUT', headers: auth, body: JSON.stringify({ data: rows }) });
		assert.equal(put.status, 200);
		assert.equal(((await put.json()) as { rows: number }).rows, 8640);
		const back = await (await fetch(`${server.baseUrl}/api/log?day=20261015&profile=pareja`, { headers: auth })).json() as { data: number[][] };
		assert.equal(back.data.length, 8640);
		const days = await (await fetch(`${server.baseUrl}/api/log/days?profile=pareja`, { headers: auth })).json() as { days: string[] };
		assert.deepEqual(days.days, ['20261015']);
		const none = await (await fetch(`${server.baseUrl}/api/log?day=20261015`, { headers: auth })).json() as { data: unknown[] };
		assert.equal(none.data.length, 0);
		assert.equal((await fetch(`${server.baseUrl}/api/log?day=2026-10-15`, { headers: auth })).status, 400);
		assert.equal((await fetch(`${server.baseUrl}/api/log?day=20261015`)).status, 401);
	});
});
