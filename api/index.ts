// Vercel serverless adapter: every request is handled by the same handler
// the standalone server uses. Set GEMINI_API_KEY in the Vercel project
// settings (Environment Variables) — never commit it.
import { createHandler } from '../main.ts';

const handler = createHandler();

export default function (req: any, res: any): void {
  handler(req, res);
}
