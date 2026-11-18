import type { IncomingMessage, ServerResponse } from 'node:http';
import { TypeSafeRequestError, type TypeSafeIntegration } from './typesafe.js';
import { typeSafeCatalogIssueMessage, typeSafeErrorMessage } from '../shared/typesafe-errors.js';
import type { TypeSafeConnectRequest } from '../shared/typesafe.js';
import { HttpError, jsonBody, only } from './security.js';
const send = (res: ServerResponse, data: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
/** The host validates loopback origin, authenticated session and mutation CSRF before invoking this handler. */
export async function typesafeApi(req: IncomingMessage, res: ServerResponse, url: URL, service: TypeSafeIntegration, sessionId: string): Promise<boolean> {
    const base = '/api/integrations/typesafe';
    if (url.pathname !== base && !url.pathname.startsWith(base + '/'))
        return false;
    const action = url.pathname.slice(base.length), method = req.method ?? 'GET';
    if (!action && method === 'GET') {
        send(res, service.status());
        return true;
    }
    if (!action && method === 'DELETE') {
        send(res, await service.disconnect());
        return true;
    }
    if (!action && method === 'PATCH') {
        const body = await jsonBody(req);
        only(body, ['model', 'enabled']);
        send(res, await service.updateModel(body));
        return true;
    }
    if (method === 'POST' && action === '/connect') {
        try {
            const body = await jsonBody(req);
            only(body, ['nonce', 'apiKey', 'model']);
            const controller = new AbortController(), cancel = () => controller.abort();
            req.once('aborted', cancel);
            res.once('close', cancel);
            try {
                send(res, await service.connectCredential(sessionId, body as unknown as TypeSafeConnectRequest, controller.signal));
                return true;
            }
            finally {
                req.removeListener('aborted', cancel);
                res.removeListener('close', cancel);
            }
        } catch (error) {
            const code = error instanceof TypeSafeRequestError && typeSafeErrorMessage(error.code) ? error.code : 'unknown';
            const status = error instanceof HttpError && [400, 403, 409, 413, 429, 502, 503].includes(error.status) ? error.status : 502;
            const catalogIssue = error instanceof TypeSafeRequestError && typeSafeCatalogIssueMessage(error.catalogIssue) ? error.catalogIssue : undefined;
            send(res, { error: typeSafeErrorMessage(code), code, ...(catalogIssue ? { catalogIssue } : {}) }, status);
            return true;
        }
    }
    if (method === 'POST') {
        const body = await jsonBody(req);
        if (action === '/credential-request') {
            only(body, ['runId', 'interactionId']);
            send(res, service.credentialRequest(sessionId, body));
            return true;
        }
        if (action === '/test') {
            only(body, []);
            send(res, await service.test());
            return true;
        }
    }
    throw new HttpError(404, 'TypeSafe endpoint not found');
}
