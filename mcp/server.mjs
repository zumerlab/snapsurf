/**
 * snapdom-agent MCP server — F1 del PLAN: el oráculo como tools nativas de
 * cualquier cliente MCP (Claude Code, Claude Desktop, otros agentes).
 *
 * Arquitectura: traductor fino sobre el daemon de browse.mjs (HTTP :8377) — hereda
 * TODO lo endurecido en el lab: logs JSONL por sesión, políticas --readonly/--allow,
 * selectores único-o-ausente, negativos fieles, settle adaptativo. Si el daemon no
 * está corriendo, lo levanta (repo o instalación global ~/.claude/snapdom-agent).
 *
 * Protocolo MCP stdio implementado a mano (JSON-RPC 2.0, un mensaje por línea):
 * cero dependencias. stdout es SOLO protocolo; todo log va a stderr.
 *
 * Registro (una vez):  claude mcp add --scope user snapdom-agent -- node <ruta>/server.mjs
 *
 * NOT FOR PUBLICATION — packages/agent privado.
 */
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { readFile, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = 8377
const log = (...a) => console.error('[snapdom-agent-mcp]', ...a)

// ── Daemon: localizar y auto-levantar ────────────────────────────────────────────────
async function browsePath() {
  const candidates = [
    join(HERE, '..', 'tools', 'browse.mjs'),                       // repo (agent-lab)
    join(process.env.HOME || '', '.claude', 'snapdom-agent', 'browse.mjs'), // global
  ]
  for (const p of candidates) {
    try { await access(p); return p } catch { /* siguiente */ }
  }
  throw new Error('browse.mjs no encontrado (¿rama agent-lab o install-global corrido?)')
}

async function cmd(name, args = []) {
  const res = await fetch(`http://127.0.0.1:${PORT}/cmd`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd: name, args }),
  })
  const text = (await res.text()).trim()
  if (!res.ok) throw new Error(text)
  return text
}

async function ensureDaemon() {
  try { await cmd('status'); return } catch { /* levantar */ }
  const p = await browsePath()
  log('levantando daemon:', p)
  spawn(process.execPath, [p, 'serve'], { detached: true, stdio: 'ignore' }).unref()
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try { await cmd('status'); return } catch { /* aún no */ }
  }
  throw new Error('el daemon no respondió tras 20s')
}

// ── Tools ────────────────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'browser_open',
    description: 'Navega a una URL y devuelve el DIGEST semántico (~2-3KB): regiones landmark con ids, títulos con sección, y top-15 actionables rankeados con href. Los ids (n_xxx) caducan con cada nueva observación.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'URL (https implícito; acepta file:/data:)' } }, required: ['url'] },
    run: async ({ url }) => cmd('open', [url]),
  },
  {
    name: 'browser_find',
    description: 'Busca texto en TODA la página (no solo lo visible) y devuelve matches RANKEADOS: id clickeable, role, texto completo, bbox y href navegable. La herramienta correcta para localizar algo puntual en páginas largas — no pidas el outline entero.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    run: async ({ text }) => cmd('find', text.split(/\s+/)),
  },
  {
    name: 'browser_act',
    description: 'Actúa en la página: click (por id del digest/find, o "x,y"), type (texto en el elemento enfocado — click antes), o enter. El click hace scroll automático y CONFIRMA role/name del elemento resuelto: leé el echo antes de continuar. Después de actuar, llamá browser_verify.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['click', 'type', 'enter'] },
        target: { type: 'string', description: 'id n_xxx o "x,y" (solo click)' },
        text: { type: 'string', description: 'texto a tipear (solo type)' },
      },
      required: ['action'],
    },
    run: async ({ action, target, text }) => {
      if (action === 'click') {
        if (!target) throw new Error('click requiere target (id o "x,y")')
        return cmd('click', [target])
      }
      if (action === 'type') {
        if (!text) throw new Error('type requiere text')
        return cmd('type', text.split(/\s+/))
      }
      return cmd('enter')
    },
  },
  {
    name: 'browser_verify',
    description: 'QUÉ CAMBIÓ desde la última observación — la verificación de tu acción. Devuelve changed (un negativo fiel: si tu click no hizo nada, dice "sin cambios" en vez de dejarte creer que actuaste), la lista de cambios con kind (added/removed/state/style/moved) role y nombre, y qué quedó tapado o visible. Usalo después de CADA acción en vez de comparar screenshots.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => cmd('look'),
  },
  {
    name: 'browser_checkpoint',
    description: 'Guarda el estado observado actual como baseline con nombre (antes de una acción riesgosa). NO es undo: es un punto de comparación para browser_diff.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    run: async ({ name }) => cmd('cp', ['save', name]),
  },
  {
    name: 'browser_diff',
    description: 'Diff del estado actual contra un checkpoint guardado con browser_checkpoint: todo lo que cambió desde ese punto conocido. Ojo: el baseline del próximo browser_verify pasa a ser el estado actual.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    run: async ({ name }) => cmd('cp', ['diff', name]),
  },
  {
    name: 'browser_text',
    description: 'Texto visible completo de UN nodo (por id) — para extraer números, títulos o valores exactos sin interpretar píxeles.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: async ({ id }) => cmd('text', [id]),
  },
  {
    name: 'browser_page',
    description: 'Vistas ampliadas de la observación actual cuando el digest no alcanza: outline (estructura completa recortada a 12KB) o map con offset (pagina los actionables más allá del top). Escalación explícita — el digest primero.',
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: ['outline', 'map'] },
        offset: { type: 'number', description: 'solo map: desde qué índice' },
      },
      required: ['view'],
    },
    run: async ({ view, offset }) => view === 'outline' ? cmd('outline') : cmd('map', [String(offset || 0)]),
  },
  {
    name: 'browser_screenshot',
    description: 'Píxeles como ESCALACIÓN, no como default: render snapdom del viewport, o de un elemento (scrolleado al centro) si pasás id. Usalo solo cuando la duda sea genuinamente visual (layout, color, solapamiento) — para saber qué cambió está browser_verify.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'opcional: elemento a centrar' } } },
    run: async ({ id }) => {
      const file = `/tmp/snapdom-mcp-${Date.now()}.png`
      const out = await cmd('snap', id ? [id, file] : [file])
      const data = (await readFile(file)).toString('base64')
      return { text: out, image: { data, mimeType: 'image/png' } }
    },
  },
]

// ── MCP stdio (JSON-RPC 2.0, un mensaje por línea) ───────────────────────────────────
const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const reply = (id, result) => write({ jsonrpc: '2.0', id, result })
const replyErr = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } })

const rl = createInterface({ input: process.stdin, terminal: false })
rl.on('line', async (line) => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  const { id, method, params } = msg

  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'snapdom-agent', version: '0.1.0' },
    })
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return
  if (method === 'ping') return reply(id, {})
  if (method === 'tools/list') {
    return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name)
    if (!tool) return replyErr(id, -32602, `tool desconocida: ${params?.name}`)
    try {
      await ensureDaemon()
      const out = await tool.run(params?.arguments || {})
      const content = typeof out === 'string'
        ? [{ type: 'text', text: out }]
        : [{ type: 'text', text: out.text }, { type: 'image', data: out.image.data, mimeType: out.image.mimeType }]
      return reply(id, { content })
    } catch (e) {
      return reply(id, { content: [{ type: 'text', text: String(e.message || e) }], isError: true })
    }
  }
  if (id !== undefined) replyErr(id, -32601, `método no soportado: ${method}`)
})

log('listo (stdio)')
