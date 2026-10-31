/** Pulls a JSON value out of model text that may include reasoning tags, code fences or chatter around it. */

/** Removes <think>…</think> blocks some reasoning models emit before the answer. */
export function stripReasoning(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '')
}

/** Finds the first complete top-level JSON object or array in `text` and parses it. Returns undefined if none. */
export function extractJson(text: string): unknown {
  const cleaned = stripReasoning(text).trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    // keep looking
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(cleaned)
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim())
    } catch {
      // keep looking
    }
  }
  for (let start = 0; start < cleaned.length; start++) {
    const open = cleaned[start]
    if (open !== '{' && open !== '[') continue
    const end = matchingBracket(cleaned, start)
    if (end < 0) continue
    try {
      return JSON.parse(cleaned.slice(start, end + 1))
    } catch {
      // try the next candidate
    }
  }
  return undefined
}

function matchingBracket(text: string, start: number): number {
  const stack: string[] = []
  let inString = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']')
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return -1
      if (stack.length === 0) return i
    }
  }
  return -1
}
