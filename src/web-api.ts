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
 * - GET/PUT /api/store: one JSON document the app keeps here, so its history survives a
 *   wiped browser or a new phone. It lives in the same database as the sign-ins.
 */

const STORE_KEY = 'web_app_store';
const STORE_LIMIT = '8mb';
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
	return (req: Request, res: Response, next: NextFunction) => (req.path === '/api/store' ? next() : json(req, res, next));
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

	app.get('/api/store', requireAuth, (_req: Request, res: Response) => {
		const raw = db.getSetting(STORE_KEY);
		res.set('Cache-Control', 'no-store');
		if (!raw) {
			res.json({ data: null, updatedAt: null });
			return;
		}
		res.type('application/json').send(raw);
	});

	app.put('/api/store', requireAuth, express.json({ limit: STORE_LIMIT }), (req: Request, res: Response) => {
		const data = req.body?.data;
		if (data === undefined || data === null || typeof data !== 'object') {
			res.status(400).json({ error: 'bad_request', message: 'Send {"data": {...}}.' });
			return;
		}
		const updatedAt = new Date().toISOString();
		db.setSetting(STORE_KEY, JSON.stringify({ data, updatedAt }));
		res.json({ ok: true, updatedAt });
	});
}
