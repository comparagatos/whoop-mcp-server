import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { WhoopAuthError, WhoopError, type WhoopClient } from '@yuridivonis/whoop-client';
import type { WhoopDatabase } from './database.js';
import { whoopMessage } from './whoop-messages.js';

/**
 * A small JSON API for a web app of the owner's (WOD Live), next to /mcp.
 *
 * - CORS: only the web clients already allowed to sign in (MCP_ALLOWED_REDIRECT_HOSTS and
 *   the defaults) may call /mcp and /api from a browser. Every call still needs a valid
 *   bearer token from the same sign-in as /mcp, so the password stays the only way in.
 * - GET /api/whoop?days=N: WHOOP's own records (cycles, recoveries, sleeps incl. naps,
 *   workouts) as JSON, so the app doesn't parse the tools' Markdown.
 * - GET/PUT /api/store[?profile=name]: one JSON document per person using the app, so its
 *   history survives a wiped browser or a new phone. It lives in the same database as the sign-ins.
 * - GET/PUT /api/log?day=YYYYMMDD[&profile=name]: the 24-hour heart-rate record the iOS app
 *   keeps (one row every 10 s), one document per person and day.
 * - GET /api/log/days[?profile=name]: which days have a record.
 */

const STORE_KEY = 'web_app_store';
const STORE_LIMIT = '8mb';
const LOG_LIMIT = '2mb';
const PROFILE = /^[a-z0-9_-]{1,32}$/;
const DAY = /^\d{8}$/;

/** The person a request is for: empty means the owner, which keeps the original store key. */
function profileOf(req: Request): string | null {
	const raw = String(req.query.profile ?? '').trim().toLowerCase();
	if (raw === '') return '';
	return PROFILE.test(raw) ? raw : null;
}

const storeKey = (profile: string) => (profile ? `${STORE_KEY}:${profile}` : STORE_KEY);
const logKey = (profile: string, day: string) => `web_app_log:${profile || 'owner'}:${day}`;
const DAY_MS = 24 * 60 * 60 * 1000;

export function webCors(allowedHosts: readonly string[]): RequestHandler {
	return (req: Request, res: Response, next: NextFunction) => {
		if (!req.path.startsWith('/mcp') && !req.path.startsWith('/api/')) {
			next();
			return;
		}
		const origin = req.headers.origin;
		let allowed = false;
		if (typeof origin === 'string') {
			try {
				const url = new URL(origin);
				allowed = url.protocol === 'https:' && allowedHosts.includes(url.hostname);
			} catch {
				allowed = false;
			}
		}
		if (allowed && origin) {
			res.vary('Origin');
			res.set('Access-Control-Allow-Origin', origin);
			res.set('Access-Control-Expose-Headers', 'WWW-Authenticate');
			if (req.method === 'OPTIONS') {
				res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
				res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, Mcp-Protocol-Version');
				res.set('Access-Control-Max-Age', '600');
				res.status(204).end();
				return;
			}
		}
		next();
	};
}

/** The global JSON parser must skip /api/store, which takes larger bodies after sign-in is checked. */
export function jsonExceptStore(): RequestHandler {
	const json = express.json();
	return (req: Request, res: Response, next: NextFunction) => (req.path === '/api/store' || req.path === '/api/log' ? next() : json(req, res, next));
}

function whoopFailure(res: Response, error: unknown): void {
	if (error instanceof WhoopAuthError) {
		res.status(409).json({ error: 'whoop_not_connected', message: 'WHOOP is not connected. Ask your AI to run get_auth_url.' });
		return;
	}
	const message = error instanceof WhoopError ? whoopMessage(error) : 'WHOOP could not be reached.';
	res.status(502).json({ error: 'whoop_unavailable', message });
}

export function registerWebApi(app: Express, deps: { client: WhoopClient; db: WhoopDatabase; requireAuth: RequestHandler }): void {
	const { client, db, requireAuth } = deps;

	app.get('/api/whoop', requireAuth, async (req: Request, res: Response) => {
		const days = Math.min(90, Math.max(1, Number.parseInt(String(req.query.days ?? '14'), 10) || 14));
		const start = new Date(Date.now() - days * DAY_MS).toISOString();
		try {
			const [cycles, recoveries, sleeps, workouts] = await Promise.all([
				client.cycles({ start }),
				client.recoveries({ start }),
				client.sleeps({ start }),
				client.workouts({ start }),
			]);
			res.set('Cache-Control', 'no-store');
			res.json({ fetchedAt: new Date().toISOString(), days, cycles, recoveries, sleeps, workouts });
		} catch (error) {
			whoopFailure(res, error);
		}
	});

	app.get('/api/store', requireAuth, (req: Request, res: Response) => {
		const profile = profileOf(req);
		if (profile === null) {
			res.status(400).json({ error: 'bad_request', message: 'profile: letters, numbers, - or _, up to 32.' });
			return;
		}
		const raw = db.getSetting(storeKey(profile));
		res.set('Cache-Control', 'no-store');
		if (!raw) {
			res.json({ data: null, updatedAt: null });
			return;
		}
		res.type('application/json').send(raw);
	});

	app.put('/api/store', requireAuth, express.json({ limit: STORE_LIMIT }), (req: Request, res: Response) => {
		const profile = profileOf(req);
		if (profile === null) {
			res.status(400).json({ error: 'bad_request', message: 'profile: letters, numbers, - or _, up to 32.' });
			return;
		}
		const data = req.body?.data;
		if (data === undefined || data === null || typeof data !== 'object') {
			res.status(400).json({ error: 'bad_request', message: 'Send {"data": {...}}.' });
			return;
		}
		const updatedAt = new Date().toISOString();
		db.setSetting(storeKey(profile), JSON.stringify({ data, updatedAt }));
		res.json({ ok: true, updatedAt });
	});

	app.get('/api/log/days', requireAuth, (req: Request, res: Response) => {
		const profile = profileOf(req);
		if (profile === null) {
			res.status(400).json({ error: 'bad_request', message: 'Bad profile.' });
			return;
		}
		res.set('Cache-Control', 'no-store');
		res.json({ days: db.settingKeys(`web_app_log:${profile || 'owner'}:`).map(k => k.slice(-8)).sort() });
	});

	app.get('/api/log', requireAuth, (req: Request, res: Response) => {
		const profile = profileOf(req);
		const day = String(req.query.day ?? '');
		if (profile === null || !DAY.test(day)) {
			res.status(400).json({ error: 'bad_request', message: 'Use ?day=YYYYMMDD and an optional profile.' });
			return;
		}
		res.set('Cache-Control', 'no-store');
		const raw = db.getSetting(logKey(profile, day));
		if (!raw) {
			res.json({ day, data: [], updatedAt: null });
			return;
		}
		res.type('application/json').send(raw);
	});

	app.put('/api/log', requireAuth, express.json({ limit: LOG_LIMIT }), (req: Request, res: Response) => {
		const profile = profileOf(req);
		const day = String(req.query.day ?? '');
		const rows = req.body?.data;
		if (profile === null || !DAY.test(day) || !Array.isArray(rows) || rows.length > 20000) {
			res.status(400).json({ error: 'bad_request', message: 'Send {"data": [[t, hr, hrv], ...]} with ?day=YYYYMMDD.' });
			return;
		}
		const clean = rows.filter(
			(r: unknown): r is number[] => Array.isArray(r) && r.length === 3 && r.every(v => typeof v === 'number' && Number.isFinite(v)),
		);
		const updatedAt = new Date().toISOString();
		db.setSetting(logKey(profile, day), JSON.stringify({ day, data: clean, updatedAt }));
		res.json({ ok: true, rows: clean.length, updatedAt });
	});
}
