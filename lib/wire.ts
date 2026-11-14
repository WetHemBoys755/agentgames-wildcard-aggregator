// The client wires and the one upstream wire this baseline speaks.
//
// The trial's client calls the entry as an OpenAI service (POST /v1/chat/completions) or an Anthropic one
// (POST /v1/messages), with a JSON body or with server-sent events. This baseline forwards both to a
// provider on the openai wire and translates back:
//
//   - the OpenAI path passes the client's body (with the routed model's id) to the provider and streams
//     the provider's JSON or SSE straight back, the way an OpenAI-compatible gateway does;
//   - the Anthropic path rewrites the request to Chat Completions (system prompt, image blocks, tool
//     definitions, tool results and tool choice included) and rewrites the provider's answer into a
//     Messages object, or into the message_start / content_block_start / content_block_delta /
//     content_block_stop / message_delta / message_stop event order, with the stop reason and the usage
//     translated. Tool calls become tool_use blocks and input_json_delta events.
//
// The gemini and anthropic upstream wires are not implemented in this baseline (main.ts answers 501 for a
// provider on either): a real entry needs their request and event shapes too, which is the biggest single
// gap in this starter.
//
// Everything here is a pure function of its arguments: no clock and no randomness, so the same body and the
// same provider answer give the same bytes on a replay. The two model listings use fixed timestamps for the
// same reason: a `created` that moved between runs would be a nondeterministic document.

import { isRecord, type Json } from './providers.ts';

/** One model the entry serves, as GET /v1/models lists it. */
export interface ServedModel {
  id: string;
  provider: string;
  display_name: string;
}

/** A fixed epoch second for every listed model's `created`: nothing in the reply reads the clock. */
const FIXED_OPENAI_CREATED = 1767225600;
/** A fixed instant for every listed model's `created_at`: nothing in the reply reads the clock. */
const FIXED_ANTHROPIC_CREATED_AT = '2026-01-01T00:00:00Z';

/** GET /v1/models on an OpenAI-shaped request: the models this entry serves, in OpenAI's list shape. */
export function openAIModelList(models: readonly ServedModel[]): Json {
  return {
    object: 'list',
    data: models.map((m) => ({ id: m.id, object: 'model', created: FIXED_OPENAI_CREATED, owned_by: m.provider })),
  };
}

/** GET /v1/models on an Anthropic-shaped request (an x-api-key header): Anthropic's model list shape. */
export function anthropicModelList(models: readonly ServedModel[]): Json {
  return {
    data: models.map((m) => ({ type: 'model', id: m.id, display_name: m.display_name, created_at: FIXED_ANTHROPIC_CREATED_AT })),
    has_more: false,
  };
}

/** An error in Anthropic's shape (the Messages API's error envelope). */
export function anthropicError(type: string, message: string): Json {
  return { type: 'error', error: { type, message } };
}

/** An error in OpenAI's shape (Chat Completions). */
export function openAIError(message: string, type: string, code: string | null): Json {
  return { error: { message, type, code } };
}

/** The text of a string or of a block array's text blocks; '' when there is none. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('\n');
}

/** One Anthropic content block as an OpenAI content part: text or an inline image; null for the rest. */
function partOf(block: Json): Json | null {
  if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text };
  if (block.type === 'image' && isRecord(block.source)) {
    const source = block.source;
    if (source.type === 'base64' && typeof source.data === 'string') {
      const media = typeof source.media_type === 'string' ? source.media_type : 'image/png';
      return { type: 'image_url', image_url: { url: `data:${media};base64,${source.data}` } };
    }
    if (source.type === 'url' && typeof source.url === 'string') return { type: 'image_url', image_url: { url: source.url } };
  }
  return null;
}

/** A tool_result block's content as text: its text blocks, or its JSON when it holds something else. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = textOf(content);
    return text !== '' ? text : JSON.stringify(content);
  }
  return content === undefined ? '' : JSON.stringify(content);
}

/** A tool call's arguments as an object: the provider's JSON string, or {} when it is not one. */
function argumentsOf(value: unknown): Json {
  if (isRecord(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Not JSON: an empty input.
    }
  }
  return {};
}

/** OpenAI's finish_reason as Anthropic's stop_reason. */
export function stopReasonOf(finish: unknown): string {
  if (finish === 'length') return 'max_tokens';
  if (finish === 'tool_calls' || finish === 'function_call') return 'tool_use';
  if (finish === 'content_filter') return 'refusal';
  return 'end_turn';
}

/**
 * An Anthropic Messages request as an OpenAI Chat Completions request that names `model`: the system
 * prompt becomes a system message, image blocks become image_url data URLs, tool_use blocks become
 * tool_calls, tool_result blocks become tool messages, tools and tool_choice are rewritten, and the
 * output cap, temperature, top_p, stop sequences and streaming pass through.
 */
export function anthropicToOpenAI(body: Json, model: string): Json {
  const messages: Json[] = [];
  const system = textOf(body.system);
  if (system !== '') messages.push({ role: 'system', content: system });
  const source = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of source) {
    if (!isRecord(raw)) continue;
    const assistant = raw.role === 'assistant';
    const content = raw.content;
    if (typeof content === 'string') {
      messages.push({ role: assistant ? 'assistant' : 'user', content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    if (assistant) {
      const toolCalls: Json[] = [];
      for (const block of content) {
        if (!isRecord(block) || block.type !== 'tool_use') continue;
        toolCalls.push({
          id: typeof block.id === 'string' ? block.id : '',
          type: 'function',
          function: {
            name: typeof block.name === 'string' ? block.name : '',
            arguments: JSON.stringify(isRecord(block.input) ? block.input : {}),
          },
        });
      }
      const text = textOf(content);
      messages.push({
        role: 'assistant',
        content: text !== '' ? text : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    const parts: Json[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'tool_result') {
        messages.push({
          role: 'tool',
          tool_call_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
          content: toolResultText(block.content),
        });
        continue;
      }
      const part = partOf(block);
      if (part !== null) parts.push(part);
    }
    if (parts.length > 0) messages.push({ role: 'user', content: parts });
  }

  const out: Json = { model, messages };
  if (typeof body.max_tokens === 'number') out.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) out.stop = body.stop_sequences;
  if (Array.isArray(body.tools)) {
    const tools = body.tools.flatMap((raw) => {
      if (!isRecord(raw) || typeof raw.name !== 'string') return [];
      return [
        {
          type: 'function',
          function: {
            name: raw.name,
            description: typeof raw.description === 'string' ? raw.description : '',
            parameters: isRecord(raw.input_schema) ? raw.input_schema : { type: 'object', properties: {} },
          },
        },
      ];
    });
    if (tools.length > 0) out.tools = tools;
  }
  const choice = body.tool_choice;
  if (isRecord(choice)) {
    if (choice.type === 'auto') out.tool_choice = 'auto';
    else if (choice.type === 'any') out.tool_choice = 'required';
    else if (choice.type === 'tool' && typeof choice.name === 'string') out.tool_choice = { type: 'function', function: { name: choice.name } };
  }
  if (body.stream === true) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  return out;
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** A Chat Completions answer as an Anthropic Messages object. */
function openAIAnswerToAnthropic(body: Json, model: string): Json {
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const content: Json[] = [];
  const text = typeof message.content === 'string' ? message.content : textOf(message.content);
  if (text !== '') content.push({ type: 'text', text });
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const call of calls) {
    if (!isRecord(call) || !isRecord(call.function)) continue;
    content.push({
      type: 'tool_use',
      id: typeof call.id === 'string' ? call.id : 'toolu_unknown',
      name: typeof call.function.name === 'string' ? call.function.name : '',
      input: argumentsOf(call.function.arguments),
    });
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });
  const usage = isRecord(body.usage) ? body.usage : {};
  return {
    id: `msg_${typeof body.id === 'string' ? body.id : 'aggregate'}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReasonOf(choice.finish_reason),
    stop_sequence: null,
    usage: { input_tokens: numberOrZero(usage.prompt_tokens), output_tokens: numberOrZero(usage.completion_tokens) },
  };
}

/** One server-sent event: `event: <name>` when named, then the JSON data line, then the blank line. */
export function sseEvent(event: string | null, data: unknown): string {
  return `${event === null ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`;
}

/**
 * A Chat Completions SSE stream as the Anthropic event sequence: message_start on the first chunk,
 * content_block_start/delta/stop per text block or tool call, then message_delta with the stop reason and
 * usage, then message_stop. `model` is the model the client asked for, named back to it.
 */
export async function* anthropicEventsFromOpenAI(upstream: ReadableStream<Uint8Array>, model: string): AsyncGenerator<string> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let started = false;
  let finished = false;
  /** The stop reason a finish_reason named, held until the stream's usage chunk has arrived. */
  let pendingStop: string | null = null;
  let textIndex = -1;
  let nextIndex = 0;
  const toolIndexes = new Map<number, number>();
  let inputTokens = 0;
  let outputTokens = 0;

  const startEvents = (): string[] => {
    if (started) return [];
    started = true;
    return [
      sseEvent('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_stream',
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: inputTokens, output_tokens: 0 },
        },
      }),
    ];
  };
  const closeEvents = (): string[] => {
    const out: string[] = [];
    if (textIndex !== -1) {
      out.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: textIndex }));
      textIndex = -1;
    }
    for (const index of [...toolIndexes.values()].sort((a, b) => a - b)) out.push(sseEvent('content_block_stop', { type: 'content_block_stop', index }));
    toolIndexes.clear();
    return out;
  };
  const finishEvents = (stopReason: string): string[] => {
    if (finished) return [];
    finished = true;
    return [
      ...closeEvents(),
      sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } }),
      sseEvent('message_stop', { type: 'message_stop' }),
    ];
  };

  /** One SSE frame's lines as Anthropic events, mutating the stream's state. */
  const eventsOfFrame = (frame: string): string[] => {
    const out: string[] = [];
    for (const line of frame.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') {
        out.push(...startEvents(), ...finishEvents(pendingStop ?? 'end_turn'));
        continue;
      }
      let chunk: unknown;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      if (!isRecord(chunk)) continue;
      if (isRecord(chunk.usage)) {
        inputTokens = numberOrZero(chunk.usage.prompt_tokens);
        outputTokens = numberOrZero(chunk.usage.completion_tokens);
      }
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      const choice = isRecord(choices[0]) ? choices[0] : null;
      if (choice === null) continue;
      const delta = isRecord(choice.delta) ? choice.delta : {};
      out.push(...startEvents());
      if (typeof delta.content === 'string' && delta.content !== '') {
        if (textIndex === -1) {
          textIndex = nextIndex;
          nextIndex += 1;
          out.push(sseEvent('content_block_start', { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } }));
        }
        out.push(sseEvent('content_block_delta', { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: delta.content } }));
      }
      const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const call of calls) {
        if (!isRecord(call)) continue;
        const upstreamIndex = typeof call.index === 'number' ? call.index : toolIndexes.size;
        let index = toolIndexes.get(upstreamIndex);
        if (index === undefined) {
          if (textIndex !== -1) {
            out.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: textIndex }));
            textIndex = -1;
          }
          index = nextIndex;
          nextIndex += 1;
          toolIndexes.set(upstreamIndex, index);
          const fn = isRecord(call.function) ? call.function : {};
          out.push(
            sseEvent('content_block_start', {
              type: 'content_block_start',
              index,
              content_block: {
                type: 'tool_use',
                id: typeof call.id === 'string' && call.id !== '' ? call.id : `toolu_${index}`,
                name: typeof fn.name === 'string' ? fn.name : '',
                input: {},
              },
            }),
          );
        }
        const fn = isRecord(call.function) ? call.function : {};
        if (typeof fn.arguments === 'string' && fn.arguments !== '') {
          out.push(sseEvent('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: fn.arguments } }));
        }
      }
      // Hold the stop reason until the stream's last chunk (the usage one) and [DONE] have arrived: OpenAI
      // sends the usage after the finish_reason, and Anthropic's message_delta carries the output tokens.
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) pendingStop = stopReasonOf(choice.finish_reason);
    }
    return out;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let at = buffer.indexOf('\n\n');
      while (at !== -1) {
        const frame = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        for (const event of eventsOfFrame(frame)) yield event;
        at = buffer.indexOf('\n\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== '') for (const event of eventsOfFrame(buffer)) yield event;
  } finally {
    reader.releaseLock();
  }
  if (!finished) {
    for (const event of startEvents()) yield event;
    for (const event of finishEvents(pendingStop ?? 'end_turn')) yield event;
  }
}

/** A buffered answer from any provider wire. */
export interface Answer {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

function openAIParts(content: unknown): Json[] {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  const parts: Json[] = [];
  for (const raw of content) {
    if (!isRecord(raw)) continue;
    if (raw.type === 'text' && typeof raw.text === 'string') parts.push({ type: 'text', text: raw.text });
    if (raw.type === 'image_url' && isRecord(raw.image_url) && typeof raw.image_url.url === 'string') {
      const url = raw.image_url.url;
      const match = /^data:([^;]+);base64,(.*)$/.exec(url);
      if (match) parts.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
      else parts.push({ type: 'image', source: { type: 'url', url } });
    }
  }
  return parts;
}

function functionTools(body: Json, field: 'tools' | 'functions'): Json[] {
  const source = Array.isArray(body[field]) ? body[field] : [];
  return source.flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const fn = field === 'tools' && isRecord(raw.function) ? raw.function : raw;
    if (typeof fn.name !== 'string') return [];
    return [{
      name: fn.name,
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters: isRecord(fn.parameters) ? fn.parameters : { type: 'object', properties: {} },
    }];
  });
}

/** An OpenAI Chat Completions request as an Anthropic Messages request. */
export function openAIToAnthropic(body: Json, model: string): Json {
  if (Array.isArray(body.choices)) return openAIAnswerToAnthropic(body, model);
  const messages: Json[] = [];
  const systems: string[] = [];
  for (const raw of Array.isArray(body.messages) ? body.messages : []) {
    if (!isRecord(raw)) continue;
    const role = raw.role;
    if (role === 'system' || role === 'developer') {
      const value = textOf(raw.content);
      if (value !== '') systems.push(value);
    } else if (role === 'tool') {
      messages.push({ role: 'user', content: [{
        type: 'tool_result',
        tool_use_id: typeof raw.tool_call_id === 'string' ? raw.tool_call_id : '',
        content: typeof raw.content === 'string' ? raw.content : JSON.stringify(raw.content ?? ''),
      }] });
    } else if (role === 'assistant') {
      const blocks: Json[] = [];
      const text = textOf(raw.content);
      if (text !== '') blocks.push({ type: 'text', text });
      for (const call of Array.isArray(raw.tool_calls) ? raw.tool_calls : []) {
        if (!isRecord(call) || !isRecord(call.function)) continue;
        blocks.push({
          type: 'tool_use',
          id: typeof call.id === 'string' ? call.id : '',
          name: typeof call.function.name === 'string' ? call.function.name : '',
          input: argumentsOf(call.function.arguments),
        });
      }
      messages.push({ role: 'assistant', content: blocks });
    } else {
      messages.push({ role: 'user', content: openAIParts(raw.content) });
    }
  }
  const out: Json = { model, messages };
  if (systems.length > 0) out.system = systems.join('\n');
  if (typeof body.max_tokens === 'number') out.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (Array.isArray(body.stop)) out.stop_sequences = body.stop;
  if (Array.isArray(body.tools)) {
    out.tools = body.tools.flatMap((raw) => {
      if (!isRecord(raw) || !isRecord(raw.function) || typeof raw.function.name !== 'string') return [];
      return [{
        name: raw.function.name,
        description: typeof raw.function.description === 'string' ? raw.function.description : '',
        input_schema: isRecord(raw.function.parameters) ? raw.function.parameters : { type: 'object', properties: {} },
      }];
    });
  }
  if (isRecord(body.tool_choice)) {
    const choice = body.tool_choice;
    if (choice.type === 'auto') out.tool_choice = { type: 'auto' };
    else if (choice.type === 'required') out.tool_choice = { type: 'any' };
    else if (choice.type === 'function' && isRecord(choice.function)) {
      out.tool_choice = { type: 'tool', name: typeof choice.function.name === 'string' ? choice.function.name : '' };
    }
  } else if (body.tool_choice === 'auto') out.tool_choice = { type: 'auto' };
  else if (body.tool_choice === 'required') out.tool_choice = { type: 'any' };
  if (typeof body.stream === 'boolean') out.stream = body.stream;
  return out;
}

function geminiContents(messages: unknown): Json[] {
  const contents: Json[] = [];
  for (const raw of Array.isArray(messages) ? messages : []) {
    if (!isRecord(raw)) continue;
    const role = raw.role === 'assistant' || raw.role === 'model' ? 'model' : 'user';
    const parts: Json[] = [];
    for (const part of openAIParts(raw.content)) {
      // Gemini parts carry no `type` field — the real API rejects it
      // (the make.fun simulator tolerated it; googleapis does not).
      if (part.type === 'text' && typeof part.text === 'string') parts.push({ text: part.text });
      else if (isRecord(part.source) && part.source.type === 'base64') {
        parts.push({ inlineData: { mimeType: part.source.media_type, data: part.source.data } });
      } else if (isRecord(part.source) && part.source.type === 'url') {
        parts.push({ fileData: { fileUri: part.source.url } });
      }
    }
    if (role === 'model' && Array.isArray(raw.tool_calls)) {
      for (const call of raw.tool_calls) {
        if (!isRecord(call) || !isRecord(call.function)) continue;
        let args: Json = {};
        try {
          const parsed: unknown = JSON.parse(String(call.function.arguments ?? '{}'));
          if (isRecord(parsed)) args = parsed;
        } catch {
          args = {};
        }
        parts.push({ functionCall: { name: call.function.name, args } });
      }
    }
    if (parts.length > 0) contents.push({ role, parts });
  }
  return contents;
}

function geminiRequest(model: string, contents: Json[], system: string, body: Json, stream: boolean): Json {
  const out: Json = { model, contents };
  if (system !== '') out.systemInstruction = { parts: [{ text: system }] };
  const generation: Json = {};
  if (typeof body.max_tokens === 'number') generation.maxOutputTokens = body.max_tokens;
  if (typeof body.temperature === 'number') generation.temperature = body.temperature;
  if (typeof body.top_p === 'number') generation.topP = body.top_p;
  if (Array.isArray(body.stop) && body.stop.length > 0) generation.stopSequences = body.stop;
  if (isRecord(body.response_format) && body.response_format.type === 'json_object') generation.responseMimeType = 'application/json';
  if (isRecord(body.output_config) && isRecord(body.output_config.format) && body.output_config.format.type === 'json') {
    generation.responseMimeType = 'application/json';
  }
  if (Object.keys(generation).length > 0) out.generationConfig = generation;
  const tools = functionTools(body, 'tools');
  if (tools.length > 0) out.tools = [{ functionDeclarations: tools }];
  // NOTE: `stream` is NOT a Gemini body field — streaming is selected by
  // the :streamGenerateContent endpoint in main.ts. The real API rejects
  // an unknown "stream" field with HTTP 400.
  void stream;
  return out;
}

/** An OpenAI request in Gemini generateContent wire format. */
export function openAIToGemini(body: Json, model: string, stream: boolean): Json {
  const source = Array.isArray(body.messages) ? body.messages : [];
  const systemParts: string[] = [];
  const messages = source.filter((raw) => {
    if (!isRecord(raw) || (raw.role !== 'system' && raw.role !== 'developer')) return true;
    const value = textOf(raw.content);
    if (value !== '') systemParts.push(value);
    return false;
  });
  const system = systemParts.join('\n');
  return geminiRequest(model, geminiContents(messages), system, body, stream);
}

/** An Anthropic request in Gemini generateContent wire format. */
export function anthropicToGemini(body: Json, model: string, stream: boolean): Json {
  const converted: Json = {
    messages: Array.isArray(body.messages) ? body.messages.map((raw) => {
      if (!isRecord(raw)) return raw;
      const role = raw.role === 'assistant' ? 'model' : 'user';
      const blocks = Array.isArray(raw.content) ? raw.content : [{ type: 'text', text: raw.content }];
      const parts: Json[] = [];
      for (const block of blocks) {
        if (!isRecord(block)) continue;
        if (block.type === 'text' && typeof block.text === 'string') parts.push({ text: block.text });
        if (block.type === 'image' && isRecord(block.source)) {
          if (block.source.type === 'base64') {
            parts.push({ inlineData: { mimeType: block.source.media_type, data: block.source.data } });
          } else if (block.source.type === 'url') {
            parts.push({ fileData: { fileUri: block.source.url } });
          }
        }
        if (block.type === 'tool_use') parts.push({ functionCall: { name: block.name, args: block.input } });
        if (block.type === 'tool_result') parts.push({ functionResponse: { name: block.tool_use_id, response: { content: toolResultText(block.content) } } });
      }
      return { role, content: parts };
    }) : [],
  };
  if (Array.isArray(body.tools)) {
    converted.tools = body.tools.map((raw) => {
      if (!isRecord(raw)) return raw;
      return { name: raw.name, description: raw.description, parameters: raw.input_schema };
    });
  }
  if (typeof body.max_tokens === 'number') converted.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number') converted.temperature = body.temperature;
  if (typeof body.top_p === 'number') converted.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences)) converted.stop = body.stop_sequences;
  if (isRecord(body.output_config) && isRecord(body.output_config.format) && body.output_config.format.type === 'json') {
    converted.response_format = { type: 'json_object' };
  }
  const content = Array.isArray(converted.messages)
    ? converted.messages.flatMap((raw) => {
        if (!isRecord(raw) || !Array.isArray(raw.content)) return [];
        return [{ role: raw.role === 'model' ? 'model' : 'user', parts: raw.content as Json[] }];
      })
    : [];
  const system = textOf(body.system);
  return geminiRequest(model, content, system, converted, stream);
}

function sseData(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n\n').flatMap((frame) => {
    const lines = frame.split('\n').filter((line) => line.startsWith('data:'));
    if (lines.length === 0) return [];
    const data = lines.map((line) => line.slice(5).trim()).join('\n');
    return data === '[DONE]' ? [] : [data];
  });
}

async function responsePayload(resp: Response): Promise<{ json: unknown[]; stream: boolean } | null> {
  try {
    const type = resp.headers.get('content-type') ?? '';
    const stream = type.includes('text/event-stream');
    const text = await resp.text();
    if (stream) {
      const json: unknown[] = [];
      for (const data of sseData(text)) {
        try {
          json.push(JSON.parse(data));
        } catch {
          return null;
        }
      }
      return { json, stream: true };
    }
    return { json: [JSON.parse(text)], stream: false };
  } catch {
    return null;
  }
}

function answerText(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const choices = Array.isArray(value.choices) ? value.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : isRecord(choice.delta) ? choice.delta : {};
  return typeof message.content === 'string' ? message.content : null;
}

/** Parse a fetched OpenAI JSON or SSE response to its text and exact provider usage. */
export async function parseOpenAIAnswer(resp: Response): Promise<Answer | null> {
  const payload = await responsePayload(resp);
  if (payload === null || payload.json.length === 0) return null;
  let text = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let foundText = false;
  for (const item of payload.json) {
    const piece = answerText(item);
    if (piece !== null) {
      foundText = true;
      text += piece;
    }
    if (!isRecord(item)) continue;
    if (isRecord(item.usage)) {
      inputTokens = numberOrZero(item.usage.prompt_tokens);
      outputTokens = numberOrZero(item.usage.completion_tokens);
    }
  }
  if (!foundText) return null;
  return { text, inputTokens, outputTokens };
}

function anthropicText(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (typeof value.type === 'string' && value.type === 'content_block_delta' && isRecord(value.delta)) {
    return typeof value.delta.text === 'string' ? value.delta.text : null;
  }
  if (Array.isArray(value.content)) {
    return value.content.flatMap((part) => isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('');
  }
  return null;
}

/** Parse a fetched Anthropic JSON or SSE response to its text and exact provider usage. */
export async function parseAnthropicAnswer(resp: Response): Promise<Answer | null> {
  const payload = await responsePayload(resp);
  if (payload === null || payload.json.length === 0) return null;
  let text = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let foundText = false;
  const updateUsage = (usage: Record<string, unknown>) => {
    if (typeof usage.input_tokens === 'number' && Number.isFinite(usage.input_tokens)) {
      inputTokens = usage.input_tokens;
    }
    if (typeof usage.output_tokens === 'number' && Number.isFinite(usage.output_tokens)) {
      outputTokens = usage.output_tokens;
    }
  };
  for (const item of payload.json) {
    const piece = anthropicText(item);
    if (piece !== null) {
      foundText = true;
      text += piece;
    }
    if (!isRecord(item)) continue;
    if (item.type === 'message_start' && isRecord(item.message) && isRecord(item.message.usage)) {
      updateUsage(item.message.usage);
    }
    if (isRecord(item.usage)) {
      updateUsage(item.usage);
    }
    if (isRecord(item.message) && isRecord(item.message.usage)) {
      updateUsage(item.message.usage);
    }
  }
  if (!foundText) return null;
  return { text, inputTokens, outputTokens };
}

function geminiText(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const candidates = Array.isArray(value.candidates) ? value.candidates : [];
  const candidate = isRecord(candidates[0]) ? candidates[0] : {};
  const content = isRecord(candidate.content) ? candidate.content : {};
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const texts = parts.flatMap((part) => isRecord(part) && typeof part.text === 'string' ? [part.text] : []);
  return texts.length > 0 ? texts.join('') : null;
}

/** Parse a fetched Gemini JSON or SSE response to its text and exact provider usage. */
export async function parseGeminiAnswer(resp: Response): Promise<Answer | null> {
  const payload = await responsePayload(resp);
  if (payload === null || payload.json.length === 0) return null;
  let text = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let foundText = false;
  for (const item of payload.json) {
    const piece = geminiText(item);
    if (piece !== null) {
      foundText = true;
      text += piece;
    }
    if (isRecord(item) && isRecord(item.usageMetadata)) {
      inputTokens = numberOrZero(item.usageMetadata.promptTokenCount);
      outputTokens = numberOrZero(item.usageMetadata.candidatesTokenCount);
    }
  }
  if (!foundText) return null;
  return { text, inputTokens, outputTokens };
}

function renderHeaders(stream: boolean): Record<string, string> {
  return stream
    ? { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' }
    : { 'content-type': 'application/json; charset=utf-8' };
}

/** Render a buffered answer in OpenAI Chat Completions JSON or SSE form. */
export function renderOpenAI(answer: Answer, model: string, stream: boolean): {
  status: number;
  headers: Record<string, string>;
  body: Json | string;
} {
  if (!stream) {
    return {
      status: 200,
      headers: renderHeaders(false),
      body: {
        id: 'chatcmpl-aggregator',
        object: 'chat.completion',
        created: FIXED_OPENAI_CREATED,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: answer.text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: answer.inputTokens, completion_tokens: answer.outputTokens, total_tokens: answer.inputTokens + answer.outputTokens },
      },
    };
  }
  const id = 'chatcmpl-aggregator';
  const created = FIXED_OPENAI_CREATED;
  const chunks = [
    sseEvent(null, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }),
  ];
  for (let start = 0; start < answer.text.length; start += 32) {
    chunks.push(sseEvent(null, {
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: { content: answer.text.slice(start, start + 32) }, finish_reason: null }],
    }));
  }
  chunks.push(sseEvent(null, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
  chunks.push(sseEvent(null, {
    id, object: 'chat.completion.chunk', created, model, choices: [],
    usage: { prompt_tokens: answer.inputTokens, completion_tokens: answer.outputTokens, total_tokens: answer.inputTokens + answer.outputTokens },
  }));
  chunks.push('data: [DONE]\n\n');
  return { status: 200, headers: renderHeaders(true), body: chunks.join('') };
}

/** Render a buffered answer in Anthropic Messages JSON or SSE form. */
export function renderAnthropic(answer: Answer, model: string, stream: boolean): {
  status: number;
  headers: Record<string, string>;
  body: Json | string;
} {
  if (!stream) {
    return {
      status: 200,
      headers: renderHeaders(false),
      body: {
        id: 'msg_aggregator', type: 'message', role: 'assistant', model,
        content: [{ type: 'text', text: answer.text }],
        stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: answer.inputTokens, output_tokens: answer.outputTokens },
      },
    };
  }
  const events = [
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_aggregator', type: 'message', role: 'assistant', model, content: [],
        stop_reason: null, stop_sequence: null,
        usage: { input_tokens: answer.inputTokens, output_tokens: 0 },
      },
    }),
    sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  ];
  for (let start = 0; start < answer.text.length; start += 32) {
    events.push(sseEvent('content_block_delta', {
      type: 'content_block_delta', index: 0,
      delta: { type: 'text_delta', text: answer.text.slice(start, start + 32) },
    }));
  }
  events.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }));
  events.push(sseEvent('message_delta', {
    type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: answer.outputTokens },
  }));
  events.push(sseEvent('message_stop', { type: 'message_stop' }));
  return { status: 200, headers: renderHeaders(true), body: events.join('') };
}
