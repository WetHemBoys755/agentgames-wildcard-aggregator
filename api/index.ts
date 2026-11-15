// Vercel adapter — Web `fetch` handler.
//
// The classic (req, res) adapter HANGS on POST in Vercel's Node runtime:
// the request body stream is left unconsumed and the invocation never
// completes (GETs work, every POST hangs, even a bodiless one to a 404
// route). Exporting a Web `fetch` handler instead makes Vercel's own
// launcher convert the request (it consumes the body via
// Readable.toWeb) and write the Response back — the POST hang goes away.
//
// This bridges to the same createHandler() the standalone server uses:
// the Web Request body is buffered once, then handed to the handler as a
// fresh stream, and the handler's reply is captured into a Response.
// Set GEMINI_API_KEY in the Vercel project settings (Environment
// Variables) — never commit it.
import { createHandler } from '../main.ts';
import { Readable } from 'node:stream';

const handler = createHandler();

export async function fetch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;
  const bodyText =
    method !== 'GET' && method !== 'HEAD' ? await request.text() : '';
  const body = bodyText ? Buffer.from(bodyText, 'utf8') : Buffer.alloc(0);

  const result = await new Promise<{
    status: number;
    headers: Record<string, string>;
    body: Buffer;
  }>((resolve) => {
    const chunks: Buffer[] = [];
    const headers: Record<string, string> = {};
    let status = 200;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve({ status, headers, body: Buffer.concat(chunks) });
    };

    const stream = Readable.from(body.length > 0 ? [body] : []);
    const req: any = stream;
    req.url = url.pathname + url.search;
    req.method = method;
    req.headers = Object.fromEntries(request.headers.entries());

    const res: any = {
      statusCode: 200,
      headersSent: false,
      setHeader(name: string, value: string | string[]) {
        headers[String(name).toLowerCase()] = Array.isArray(value)
          ? value.join(', ')
          : String(value);
      },
      appendHeader(name: string, value: string | string[]) {
        headers[String(name).toLowerCase()] = Array.isArray(value)
          ? value.join(', ')
          : String(value);
      },
      getHeader(name: string) {
        return headers[String(name).toLowerCase()];
      },
      writeHead(code: number, h?: Record<string, unknown>) {
        status = code;
        this.statusCode = code;
        this.headersSent = true;
        if (h) {
          for (const [k, v] of Object.entries(h)) {
            headers[String(k).toLowerCase()] = String(v);
          }
        }
      },
      write(chunk: any) {
        chunks.push(
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
        );
        return true;
      },
      end(chunk?: any) {
        if (chunk !== undefined && chunk !== null) this.write(chunk);
        this.headersSent = true;
        finish();
      },
    };

    handler(req, res);
  });

  return new Response(result.body as any, {
    status: result.status,
    headers: result.headers,
  });
}
