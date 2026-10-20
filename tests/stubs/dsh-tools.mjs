/**
 * A stand-in for `@deepseek-ai/dsh-tools`, used only by `scripts/verify-apply.mjs`.
 *
 * The real module lives inside the harness and cannot be imported outside a DSH
 * install, which would otherwise make `apply()` untestable on a dev machine. The
 * stub keeps the parts this plugin depends on — the option shape and the fact
 * that `defineTool` returns a callable tool object — and validates enough of it
 * to catch a typo in a tool definition.
 */

const PARAM_TYPES = new Set(['string', 'integer', 'number', 'boolean', 'array', 'object'])

export function defineTool(options) {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('defineTool: options must be an object')
  }
  if (typeof options.name !== 'string' || options.name.length === 0) {
    throw new TypeError('defineTool: name is required')
  }
  if (typeof options.description !== 'string' || options.description.length === 0) {
    throw new TypeError(`defineTool(${options.name}): description is required`)
  }
  if (typeof options.execute !== 'function') {
    throw new TypeError(`defineTool(${options.name}): execute must be a function`)
  }

  const parameters = options.parameters ?? {}
  for (const [key, spec] of Object.entries(parameters)) {
    if (spec === null || typeof spec !== 'object') {
      throw new TypeError(`defineTool(${options.name}): parameter "${key}" must be an object`)
    }
    if (!PARAM_TYPES.has(spec.type)) {
      throw new TypeError(`defineTool(${options.name}): parameter "${key}" has unsupported type "${spec.type}"`)
    }
  }

  const output = options.output
  if (output !== undefined) {
    if (output.schema === null || typeof output.schema !== 'object') {
      throw new TypeError(`defineTool(${options.name}): output.schema must be an object`)
    }
    if (typeof output.render !== 'function') {
      throw new TypeError(`defineTool(${options.name}): output.render must be a function`)
    }
  }

  return {
    name: options.name,
    description: options.description,
    parameters,
    output,
    execute: options.execute
  }
}

export default { defineTool }
